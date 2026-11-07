#!/usr/bin/env python3
"""Fetch pinned Android kernel build inputs, never installed host headers."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
from build_public_android import acquire
from offline_common import read_json, write_json

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--cache', type=Path, help='separate cache; every file is checked against the Android lock')
    a = p.parse_args()
    lock = read_json(Path(__file__).resolve().parents[1] / 'deploy/android/cuttlefish/camera-input/kernel.lock.json')
    def fetch(item):
        dest = a.output / item['name']
        source = acquire(lock['artifactBaseUrl'] + item['name'], item['sha256'], (a.cache or a.output) / item['name'])
        if a.cache:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
            return acquire(lock['artifactBaseUrl'] + item['name'], item['sha256'], dest)
        return source
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(fetch, lock['artifacts']))
    write_json(a.output / 'inputs.json', lock, 0o644)
    print('Verified public Android kernel inputs')
