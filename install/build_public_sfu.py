#!/usr/bin/env python3
"""Build the LiveKit forwarding service from its verified public source."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid
from build_public_android import acquire
from offline_common import need, read_json, run, write_json


def build_transport():
    proxy = os.environ.get('TEAMAIBOX_GO_BUILD_PROXY')
    if not proxy:
        return []
    match = re.fullmatch(r'127\.0\.0\.1:([1-9][0-9]{0,4})', proxy)
    need(match and int(match[1]) <= 65535, 'Go build proxy must use an explicit IPv4 loopback port')
    # Per-build CONNECT only: Go retains its normal TLS and module checksums.
    return ['--network=host', '--build-arg', 'HTTPS_PROXY=http://'+proxy]


def build(repository, cache, output):
    repository, cache, output = repository.resolve(), cache.absolute(), output.absolute()
    need(not output.exists(), 'use a new build output directory')
    output.mkdir(parents=True)
    lock = read_json(repository / 'deploy/casting/airplay-compatible-stack.lock.v3.json')
    source = lock['separateBrowserDelivery']['sfuSource']
    archive = acquire(source['archiveUrl'], source['archiveSha256'].removeprefix('sha256:'),
                      cache / 'livekit-v1.13.10.tar.gz')
    tag = 'teamaibox-public-sfu:' + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix='context-', dir=output) as temporary:
        context = Path(temporary)
        shutil.copyfile(archive, context / archive.name)
        shutil.copyfile(repository / 'deploy/casting/LiveKitServerSecurityFix.arm64.Dockerfile', context / 'Dockerfile')
        with (output / 'build.log').open('xb') as log:
            result = subprocess.run(['docker', 'build', '--platform=linux/arm64', '--pull=true',
                                     *build_transport(), '-t', tag, str(context)],
                                    stdout=log, stderr=subprocess.STDOUT)
        need(result.returncode == 0, 'SFU build failed; inspect build.log')
    image = json.loads(run(['docker', 'image', 'inspect', tag]))[0]
    need(image['Architecture'] == 'arm64', 'wrong image architecture')
    report = dict(status='selected-images-built', images={'casting-sfu': image['Id']},
                  references={'casting-sfu': tag}, source=source, deployed=False)
    write_json(output / 'images.json', report, 0o644)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--cache', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(build(a.repository, a.cache, a.output), indent=2))
