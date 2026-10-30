#!/usr/bin/env python3
"""Test collected host packages in a disposable network-disabled container."""
import argparse
import json
from pathlib import Path
import re
import subprocess

from offline_common import digest, need, read_json, run, write_json


SCRIPT = r'''
set -eu
. /etc/os-release
test "$ID:$VERSION_ID" = "$1"
command -v python3
test ! -e /usr/sbin/cryptsetup
test ! -e /usr/bin/v4l2-ctl
dpkg-query -W -f='${Package} ${Version}\n' 'docker*' 'containerd*' '*nvidia*' '*cuda*' 2>/dev/null > /tmp/foundation-before || true
PYTHONPATH=/verification python3 /verification/verify_host_packages.py --inside
cryptsetup --version
mkfs.ext4 -V
qemu-img --version
v4l2-ctl --version
ip -Version
iptables --version
modprobe --version
dpkg-query -W -f='${Package} ${Version}\n' 'docker*' 'containerd*' '*nvidia*' '*cuda*' 2>/dev/null > /tmp/foundation-after || true
cmp /tmp/foundation-before /tmp/foundation-after
printf '%s\n' OFFLINE_HOST_TOOLS_PASSED
'''


def verify(image, directory, runner=run):
    need(re.fullmatch(r'sha256:[0-9a-f]{64}', image), 'exact base image ID required')
    directory = Path(directory).resolve(strict=True)
    collection = read_json(directory / 'collection.json')
    need(collection['status'] == 'collected', 'collection incomplete')
    for row in collection['hostPackages']:
        path = Path(row['source'])
        need(path.parent == directory and path.suffix == '.deb' and digest(path) == row['sha256'], 'collected package damaged')
    text = runner(['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0',
                   '--memory', '2g', '--cpus', '2', '--pids-limit', '256',
                   '--label', 'com.teamaibox.offline-host-tools-test=true',
                   '--mount', 'type=bind,src=' + str(directory) + ',dst=/packages,readonly',
                   '--mount', 'type=bind,src=' + str(Path(__file__).resolve().parent) + ',dst=/verification,readonly',
                   '--entrypoint', '/bin/sh', image, '-ec', SCRIPT, 'verify-host-tools', collection['os']], timeout=900)
    need('OFFLINE_HOST_TOOLS_PASSED' in text, 'offline package verification did not complete')
    result = dict(status='passed', packageCount=len(collection['hostPackages']), network='none',
                  testBaseImage=image, collectionBaseImage=collection['imageId'], os=collection['os'],
                  localPackagesOnly=True, previouslyMissingToolsInstalled=True, foundationUnchanged=True,
                  buildHostPackagesChanged=False, disposableContainer=True)
    write_json(directory / 'offline-test.json', result, 0o644)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-image')
    parser.add_argument('--packages', type=Path)
    parser.add_argument('--inside', action='store_true')
    args = parser.parse_args()
    if args.inside:
        from offline_host_packages import install
        rows = [dict(source=str(p), sha256=digest(p)) for p in Path('/packages').glob('*.deb')]
        def visible_run(command, **kwargs):
            result = subprocess.run([str(v) for v in command], capture_output=True, text=True, **kwargs)
            if result.returncode:
                print((result.stdout + result.stderr)[-6000:], flush=True)
            need(result.returncode == 0, 'offline host tool command failed')
            return result.stdout
        print(json.dumps(install(rows, runner=visible_run)))
    else:
        def visible_run(command, **kwargs):
            result = subprocess.run([str(v) for v in command], capture_output=True, text=True, **kwargs)
            if result.returncode:
                print((result.stdout + result.stderr)[-6000:], flush=True)
            need(result.returncode == 0, 'offline container test failed')
            return result.stdout
        print(json.dumps(verify(args.base_image, args.packages, visible_run), indent=2))
