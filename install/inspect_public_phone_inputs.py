#!/usr/bin/env python3
"""Inspect publicly downloaded Google components against the clean AOSP base.

No third-party installer is executed and no phone is started. This inspection
does not grant redistribution rights or certify Google Play compatibility.
"""
import argparse
import json
from pathlib import Path
import subprocess
from build_public_android import acquire
from offline_common import need, read_json, write_json

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--tools-image', required=True)
    a = p.parse_args()
    cache, output = a.cache.absolute(), a.output.absolute()
    need(not output.exists(), 'choose a new output directory')
    lock = read_json(ROOT / 'deploy/android/cuttlefish/gapps.inputs.lock.json')
    acquire(lock['url'], lock['sha256'], cache / lock['asset'])
    write_json(cache / 'input.json', lock, 0o644)
    output.mkdir(parents=True)
    with (output / 'inspect.log').open('xb') as log:
        r = subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only',
            '--tmpfs', '/tmp:size=2g', '--user', '0:0', '--entrypoint', 'python3',
            '--mount', 'type=bind,src=' + str(ROOT) + ',dst=/build,readonly',
            '--mount', 'type=bind,src=' + str(cache) + ',dst=/input,readonly',
            '--mount', 'type=bind,src=' + str(output) + ',dst=/work',
            a.tools_image, '/build/deploy/android/cuttlefish/gapps_inspect.py'],
            stdout=log, stderr=subprocess.STDOUT)
    need(r.returncode == 0, 'input inspection failed; see inspect.log')
    report = read_json(output / 'inspection.json')
    need(report['allSelectedComponentSignaturesVerified'], 'input signatures not verified')
    print(json.dumps(dict(status='inspected', components=len(report['components']), deployed=False)))
