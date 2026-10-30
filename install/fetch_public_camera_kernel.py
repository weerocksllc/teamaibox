#!/usr/bin/env python3
"""Fetch pinned Android kernel build inputs, never installed host headers."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from build_public_android import acquire
from offline_common import read_json, write_json

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    lock = read_json(Path(__file__).resolve().parents[1] / 'deploy/android/cuttlefish/camera-input/kernel.lock.json')
    def fetch(item):
        return acquire(lock['artifactBaseUrl'] + item['name'], item['sha256'], a.output / item['name'])
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(fetch, lock['artifacts']))
    write_json(a.output / 'inputs.json', lock, 0o644)
    print('Verified public Android kernel inputs')
