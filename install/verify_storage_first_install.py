#!/usr/bin/env python3
"""Exercise ONLY a fresh disposable installer volume, not the product volume.

Requires root and explicit --output: an empty, newly allocated test directory.
Retains the test image/report but unmounts and closes only its verified mapper.
Does not restart Docker or write global product registration/systemd files.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import uuid

from factory_bootstrap import storage, pool_identity
from offline_common import need, read_json, run, write_json
from restore_existing_business_volumes import verify_mapper, verify_mount, mounted


def verify(root):
    need(os.geteuid() == 0, 'root required')
    root = Path(root)
    need(root.is_absolute() and root.resolve() == root and root.parent == Path('/var/tmp')
         and root.name.startswith('teamaibox-storage-test-') and root.is_dir() and not any(root.iterdir()),
         'explicit new empty /var/tmp/teamaibox-storage-test-* directory required')
    identity = str(uuid.uuid4())
    before_free = shutil.disk_usage(root).free
    volume_bytes = 2 * 1024**3
    need(before_free > volume_bytes + 4 * 1024**3, 'insufficient test space')
    write_json(root / 'install-state.json', dict(installationId=identity))
    write_json(root / 'release.json', dict(host={'freeReserveBytes': before_free - volume_bytes}, assets=[]))
    result = dict(status='incomplete', testRoot=str(root), existingDataChanged=False, dockerRestarted=False)
    volume = None
    try:
        storage(root)
        volume = read_json(root / 'storage-volumes.json')['volumes'][0]
        identity_before = read_json(root / 'data/pool.json')
        key_before = (root / 'volume/automatic.key').read_bytes()
        sentinel = root / 'data/installation-sentinel'
        sentinel.write_bytes(b'new disposable installation data; preserve on retry')
        storage(root)
        storage(root, check=True)
        need(read_json(root / 'data/pool.json') == identity_before, 'pool identity changed')
        need((root / 'volume/automatic.key').read_bytes() == key_before, 'factor changed')
        need(sentinel.read_bytes() == b'new disposable installation data; preserve on retry', 'test data changed')
        mount = mounted(root / 'data')
        verify_mount(volume, mount)
        need('prjquota' in mount['options'].split(','), 'project quota not mounted')
        result.update(status='passed', repeatPreservedData=True, repeatPreservedIdentity=True,
                      repeatPreservedFactor=True, projectQuotaMounted=True, formattedOnlyNewImage=True,
                      luksUuid=volume['luksUuid'], fsUuid=volume['fsUuid'], source=volume['source'])
    finally:
        # Resolve only this test's registration; never search/close other maps.
        record = root / 'storage-volumes.json'
        if record.exists():
            volume = read_json(record)['volumes'][0]
            need(volume['source'] == str(root / 'volume/data.img')
                 and volume['mountPoint'] == str(root / 'data')
                 and volume['mapper'] == 'teamaibox-phone-' + pool_identity(identity),
                 'refuse cleanup of a foreign mapper')
            verify_mapper(volume)
            if mounted(root / 'data'):
                run(['umount', root / 'data'])
            run(['cryptsetup', 'close', volume['mapper']])
            result.update(testUnmounted=True, testMapperClosed=True)
        write_json(root / 'report.json', result, 0o644)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    verify(parser.parse_args().output)
