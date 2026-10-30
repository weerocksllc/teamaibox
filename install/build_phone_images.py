#!/usr/bin/env python3
"""Offline successor layers for two explicitly selected clean Android ROMs."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid
from offline_common import need, read_json, run, digest, write_json

def build(repository, bases, output):
    repository, output = repository.resolve(), output.absolute()
    need(set(bases) == {'phone-runtime', 'phone-google-runtime'}, 'exactly two phone bases required')
    need(not output.exists(), 'build output exists; preserved')
    for role, value in bases.items():
        need(re.fullmatch(r'sha256:[a-f0-9]{64}', value), 'exact clean ROM image ID required')
        image = json.loads(run(['docker', 'image', 'inspect', value]))[0]
        need(image['Id'] == value and image['Os'] == 'linux' and image['Architecture'] == 'arm64', 'phone base mismatch')
    output.mkdir(parents=True)
    build_id = str(uuid.uuid4())
    report = dict(bases=bases, images={}, sourceFileSha256=digest(repository / 'deploy/android/cuttlefish/phone_network.py'),
                  status='building', deployed=False)
    for role, value in bases.items():
        alias, tag = 'teamaibox-offline-phone-base:' + build_id + '-' + role, 'teamaibox-offline-phone:' + build_id + '-' + role
        run(['docker', 'tag', value, alias])
        with tempfile.TemporaryDirectory(prefix='teamaibox-phone-build-') as tmp, (output / (role + '.log')).open('xb') as log:
            shutil.copyfile(repository / 'deploy/android/cuttlefish/phone_network.py', Path(tmp) / 'phone_network.py')
            command=['docker', 'build', '--network=none', '--pull=false', '--platform=linux/arm64',
                 '--build-arg', 'BASE_IMAGE=' + alias, '-f', repository / 'install/images/PhoneNetwork.Dockerfile',
                 '-t', tag, tmp]
            result=subprocess.run([str(v) for v in command], stdout=log, stderr=subprocess.STDOUT, timeout=1800)
            need(result.returncode == 0, 'phone build failed; see ' + str(output / (role + '.log')))
        report['images'][role] = json.loads(run(['docker', 'image', 'inspect', tag]))[0]['Id']
        write_json(output / 'images.json', report)
    report['status'] = 'built-not-deployed';write_json(output / 'images.json', report, 0o644)
    return report

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--bases', type=Path, required=True);p.add_argument('--output', type=Path, required=True)
    a=p.parse_args();print(json.dumps(build(a.repository, read_json(a.bases), a.output)))
