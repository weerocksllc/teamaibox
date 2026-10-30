#!/usr/bin/env python3
"""Fetch the official AArch64-only pair into an owned, bounded lab volume."""
import hashlib
import json
from pathlib import Path
import subprocess

FILES = (
    ('system', 'VANILLA', 728517282, 'c3cf6ab5ded7496761bae4a49fe1a6f691923c5b84818755790f3ae4e239127b'),
    ('vendor', 'MAINLINE', 77349347, 'bad5e84a2a47b877d8a85f6a212720f5562e3eeb26696bfd0e2de50dab1ec3ba'),
)

def main():
    root = Path('/lab/waydroid64-20260403')
    root.mkdir(mode=0o700)
    records = []
    for component, flavor, size, digest in FILES:
        filename = f'lineage-20.0-20260403-{flavor}-waydroid_arm64_only-{component}.zip'
        branch = 'system/lineage' if component == 'system' else 'vendor'
        ota = f'https://ota.waydro.id/{branch}/waydroid_arm64_only/{flavor}.json'
        metadata = subprocess.run(['curl', '-fLsS', '--max-time', '30', ota],
                                  check=True, capture_output=True, text=True).stdout
        entries = json.loads(metadata)['response']
        entry = next(x for x in entries if x.get('filename') == filename)
        if entry['id'] != digest or entry['size'] != size:
            raise ValueError('official metadata no longer matches pinned input')
        with (root/(component+'-ota.json')).open('x') as out:
            out.write(metadata)
        path = root/(component+'.zip')
        subprocess.run(['curl', '-fL', '--retry', '2', '--connect-timeout', '15',
                        '--max-time', '600', '-o', str(path), entry['url']], check=True)
        h = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(8*1024*1024), b''):
                h.update(chunk)
        if path.stat().st_size != size or h.hexdigest() != digest:
            raise ValueError('download did not match pinned input')
        records.append({'component':component, 'filename':filename, 'size':size,
                        'sha256':digest, 'source':entry['url']})
        print(json.dumps(records[-1]), flush=True)
    with (root/'verified.json').open('x') as out:
        json.dump({'status':'passed', 'architecture':'arm64_only', 'files':records}, out, indent=2)

if __name__ == '__main__':
    main()
