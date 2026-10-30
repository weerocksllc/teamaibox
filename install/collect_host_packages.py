#!/usr/bin/env python3
"""Prepare host-tool .debs on the build machine, never on the offline target.

Uses an explicitly supplied local ARM64 Ubuntu base image in a disposable
container. Neither the build host's apt database nor Docker/NVIDIA are changed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

from offline_common import digest, need, run, write_json


PACKAGES = ('python3-minimal', 'cryptsetup-bin', 'e2fsprogs', 'util-linux', 'iproute2', 'openssl',
            'usbutils', 'v4l-utils', 'qemu-utils', 'iptables', 'kmod')
FORBIDDEN = ('docker', 'containerd', 'nvidia', 'libnvidia', 'cuda', 'linux-image', 'linux-headers')
# Supplying an empty package status forces apt to collect the complete package
# dependency closure, rather than relying on what the build container has.
SCRIPT = r'''
set -eu
test "$(dpkg --print-architecture)" = arm64
. /etc/os-release
test "$ID:$VERSION_ID" = "$1"
shift
mkdir -p /tmp/closure/archives/partial
touch /tmp/closure/status
apt-get update
apt-get -y --download-only --no-install-recommends \
  -o Dir::State::status=/tmp/closure/status \
  -o Dir::Cache::archives=/tmp/closure/archives install "$@"
for path in /tmp/closure/archives/*.deb; do
  name=$(dpkg-deb -f "$path" Package)
  case "$name" in docker*|containerd*|nvidia*|libnvidia*|cuda*|linux-image*|linux-headers*)
    printf '%s\n' 'Forbidden foundation package in dependency closure' >&2; exit 42;;
  esac
done
cp /tmp/closure/archives/*.deb /out/
'''


def collect(image, output, os_release='ubuntu:24.04', packages=PACKAGES, runner=run, network='bridge'):
    need(re.fullmatch(r'sha256:[0-9a-f]{64}', image), 'explicit local ARM64 base image ID required; no implicit pull')
    actual = json.loads(runner(['docker', 'image', 'inspect', image]))[0]
    need(actual['Id'] == image and actual['Architecture'] == 'arm64' and actual['Os'] == 'linux', 'host package base image mismatch')
    need(re.fullmatch(r'ubuntu:\d+\.\d+', os_release), 'explicit supported Ubuntu release required')
    need(packages and all(re.fullmatch(r'[a-z][a-z0-9+.-]+', v) and not v.startswith(FORBIDDEN) for v in packages), 'invalid host package selection')
    need(network in ('bridge', 'host'), 'unsupported packaging network')
    output = Path(output).absolute()
    need(not output.exists() and not any(v.is_symlink() for v in (output, *output.parents)), 'package output must be a new non-symlink directory')
    output.mkdir(parents=True, mode=0o755)
    write_json(output / 'collection.json', dict(status='collecting', os=os_release, imageId=image, packages=list(packages)))
    # Egress is intentional ONLY during artifact preparation. Installation is
    # separate and uses apt --no-download with all repository sources disabled.
    subprocess.run(['docker', 'run', '--rm', '--pull', 'never', '--platform', 'linux/arm64',
                    '--network', network,
                    '--user', '0:0', '--memory', '2g', '--cpus', '2', '--pids-limit', '256',
                    '--label', 'com.teamaibox.offline-package-builder=true',
                    '--mount', 'type=bind,src=' + str(output) + ',dst=/out',
                    '--entrypoint', '/bin/sh', image, '-ec', SCRIPT, 'collect-host-packages', os_release, *packages], check=True)
    files = sorted(output.glob('*.deb'))
    need(files, 'empty host dependency collection')
    inventory = []
    for path in files:
        # The package builder validates metadata again; list here is an input
        # to release-input.json, not an assertion that this is a full product.
        inventory.append({'source': str(path), 'sha256': digest(path)})
    write_json(output / 'collection.json', dict(status='collected', os=os_release, imageId=image,
                                               packages=list(packages), hostPackages=inventory), 0o644)
    return inventory


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-image', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--os', default='ubuntu:24.04')
    parser.add_argument('--network', choices=('bridge', 'host'), default='bridge', help='Build-time apt access only; never changes host networking')
    args = parser.parse_args()
    print(json.dumps({'hostPackages': collect(args.base_image, args.output, args.os, network=args.network)}, indent=2))
