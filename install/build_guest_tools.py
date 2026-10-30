#!/usr/bin/env python3
"""Cross-build the existing local storage adapter, with no host installation."""
import argparse
import os
from pathlib import Path
import shutil
import struct
import tempfile

from offline_common import need, run, write_json
from package import inventory_asset


def build(repository, output):
    repository, output = Path(repository).resolve(strict=True), Path(output).absolute()
    need(not output.exists() and not any(p.is_symlink() for p in (output, *output.parents)), 'choose a new artifact directory')
    output.mkdir(parents=True)
    env = dict(os.environ, GOOS='linux', GOARCH='arm64', CGO_ENABLED='0')
    import subprocess
    # A system service may have no HOME or XDG_CACHE_HOME. Keep build caches
    # out of the installed asset and do not depend on a developer's login.
    with tempfile.TemporaryDirectory(prefix='teamaibox-guest-build-') as scratch:
        env.setdefault('GOCACHE', str(Path(scratch) / 'cache'))
        env.setdefault('GOPATH', str(Path(scratch) / 'modules'))
        for name in ('phone-storage-helper', 'factory-worker-spec'):
            binary = output / name
            subprocess.run(['go', 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', str(binary),
                            './cmd/' + name], cwd=repository / 'services/node-agent', env=env, check=True)
            with binary.open('rb') as stream:
                header = stream.read(20)
            need(header[:6] == b'\x7fELF\x02\x01' and struct.unpack('<H', header[18:20])[0] == 183,
                 'guest adapter is not a Linux ARM64 ELF binary')
            binary.chmod(0o755)
    return inventory_asset(output, 'guest-host-tools', 'guest-host-tools')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repository', default=str(Path(__file__).resolve().parents[1]))
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    import json
    print(json.dumps(build(args.repository, args.output), indent=2))
