#!/usr/bin/env python3
"""Prepare the installer-compatible runtime successors, never deploy them.

Provide five explicit, verified dependency image IDs. Build on ARM64 Docker;
Node Agent is cross-built first using Go on the build machine. Build steps have
network disabled and do not pull or install anything on the target appliance.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

from offline_common import digest, need, read_json, run, write_json

ROLES = ('platform-api', 'node-agent', 'scheduler', 'agent-bridge', 'postgres')


def build(repository, bases, binary, output):
    repository, binary, output = repository.resolve(), binary.resolve(strict=True), output.absolute()
    need(not output.exists(), 'build report already exists; preserved')
    need(set(bases) == set(ROLES), 'provide exactly the five installer runtime bases')
    with binary.open('rb') as stream:
        header = stream.read(20)
    need(header[:6] == b'\x7fELF\x02\x01' and header[18:20] == b'\xb7\x00', 'Node Agent must be Linux ARM64')
    for role, image in bases.items():
        need(re.fullmatch('sha256:[0-9a-f]{64}', image), 'exact base image ID required')
        v = json.loads(run(['docker', 'image', 'inspect', image]))[0]
        need(v['Id'] == image and v['Architecture'] == 'arm64' and v['Os'] == 'linux', 'wrong base image: ' + role)
    output.mkdir(parents=True)
    commit = run(['git', '-C', repository, 'rev-parse', 'HEAD']).strip()
    dirty = bool(run(['git', '-C', repository, 'status', '--porcelain']).strip())
    # A candidate build must not masquerade as the unchanged base Git commit.
    source_files = {}
    for directory in ('apps/platform-api/server', 'apps/platform-api/src', 'services/agent-bridge',
                      'services/scheduler', 'services/plugin-runtime', 'packages/persistence/src',
                      'packages/persistence/migrations', 'install/images'):
        for path in sorted((repository / directory).rglob('*')):
            if path.is_file():
                need(not path.is_symlink(), 'runtime source must not contain symlinks')
                source_files[path.relative_to(repository).as_posix()] = digest(path)
    build_id = str(uuid.uuid4())
    report = dict(status='building', buildId=build_id, sourceCommit=commit, bases=bases, images={},
                  nodeAgentBinarySha256=digest(binary), candidate=dirty,
                  sourceFileSha256=source_files, deployed=False)
    write_json(output / 'images.json', report)
    for role, image in bases.items():
        alias = 'teamaibox-offline-base:' + build_id + '-' + role
        tag = 'teamaibox-offline-runtime:' + build_id + '-' + role
        run(['docker', 'image', 'tag', image, alias])
        dockerfile = 'NodeAgent' if role == 'node-agent' else 'Postgres' if role == 'postgres' else 'NodeRuntime'
        # Never replace any existing checkout's binary or deployed image tag.
        with tempfile.TemporaryDirectory(prefix='teamaibox-agent-build-') as tmp:
            context = repository
            if role == 'node-agent':
                shutil.copyfile(binary, Path(tmp) / 'node-agent')
                context = Path(tmp)
            args = ['docker', 'build', '--network=none', '--pull=false', '--platform=linux/arm64',
                    '--build-arg', 'BASE_IMAGE=' + alias, '--build-arg', 'SOURCE_COMMIT=' + commit,
                    '--build-arg', 'MIGRATION_DIGEST=' + digest(repository / 'packages/persistence/migrations/manifest.json'),
                    '-f', repository / 'install/images' / (dockerfile + '.Dockerfile'), '-t', tag, context]
            with (output / (role + '.log')).open('xb') as log:
                result = subprocess.run([str(a) for a in args], stdout=log, stderr=subprocess.STDOUT, timeout=1800)
            need(result.returncode == 0, 'runtime build failed; see ' + str(output / (role + '.log')))
        v = json.loads(run(['docker', 'image', 'inspect', tag]))[0]
        need(v['Architecture'] == 'arm64' and v['Os'] == 'linux', 'built runtime architecture mismatch')
        report['images'][role] = v['Id']
        write_json(output / 'images.json', report)
    report['status'] = 'built-not-deployed'
    write_json(output / 'images.json', report, 0o644)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--bases', type=Path, required=True)
    p.add_argument('--node-agent-binary', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(build(a.repository, read_json(a.bases), a.node_agent_binary, a.output), indent=2))
