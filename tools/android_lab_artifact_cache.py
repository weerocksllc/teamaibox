#!/usr/bin/env python3
"""Release only inactive Android-lab artifact file cache, never global drop_caches."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--volume', action='append', required=True,
                        help='Exact inactive lab artifact volume; repeat for each volume')
    volumes = parser.parse_args().volume
    if len(set(volumes)) != len(volumes) or not all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value) for value in volumes):
        raise ValueError('explicit_unique_volume_names_required')
    running = subprocess.check_output(['docker', 'ps', '-q', '--filter',
        'label=com.teamaibox.android-lab.run'], text=True).strip()
    if running:
        raise RuntimeError('refusing to alter cache while an Android lab run is active')
    count = size = 0
    for volume in volumes:
        record = json.loads(subprocess.check_output(['docker', 'volume', 'inspect', volume], text=True))[0]
        if record['Labels'].get('com.teamaibox.android-lab') != 'true':
            raise RuntimeError('volume ownership mismatch')
        root = Path(record['Mountpoint'])
        for directory, _, files in os.walk(root, followlinks=False):
            for name in files:
                path = Path(directory)/name
                if path.is_symlink() or not path.is_file():
                    continue
                with path.open('rb', buffering=0) as stream:
                    os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
                    count += 1
                    size += os.fstat(stream.fileno()).st_size
    print(json.dumps({'filesAdvised': count, 'artifactBytes': size, 'contentsChanged': False,
                      'globalCachesTouched': False, 'productionVolumesTouched': False}))


if __name__ == '__main__':
    main()
