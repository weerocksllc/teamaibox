#!/usr/bin/env python3
"""Add the verified native transport artifact to a source-built Agent image.

This builds a candidate only. No container, user state or deployed image is
replaced. The caller supplies its own public-build base by immutable image ID.
"""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from offline_common import need, read_json, write_json
from source_download import file_hash

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = (
    'services/agent-bridge/src/penpot-runtime-credential.mjs',
    'services/agent-bridge/src/penpot-native-dispatch-plugin.mjs',
    'services/agent-bridge/src/penpot-runtime-config.mjs',
    'services/agent-bridge/src/penpot-credential-transport.mjs',
    'services/agent-bridge/src/penpot-native-activation.mjs',
    'services/agent-bridge/src/opencode-bridge-http-server.mjs',
    'services/agent-bridge/src/workspace-file-operations.mjs',
    'services/agent-bridge/src/opencode-native-activity.mjs',
    'deploy/agent/opencode-bridge-main.mjs',
    'deploy/agent/opencode-agent-sandbox-main.mjs',
)


def validate_artifact(artifact, binary_sha256, repository=ROOT):
    repository = Path(repository).resolve()
    artifact = Path(artifact)
    need(re.fullmatch(r'[a-f0-9]{64}', binary_sha256 or ''), 'expected native binary checksum required')
    for name in ('opencode', 'teamaibox-transport-patch.json', 'LICENSE.opencode'):
        path = artifact / name
        need(path.is_file() and not path.is_symlink(), 'native artifact must contain regular files')
    need(file_hash(artifact / 'opencode') == binary_sha256, 'native binary checksum mismatch')
    lock = read_json(repository / 'deploy/opencode-penpot-transport.lock.json')
    manifest = read_json(artifact / 'teamaibox-transport-patch.json')
    expected = dict(upstreamCommit=lock['commit'], upstreamTree=lock['tree'],
                    upstreamVersion=lock['upstreamVersion'], version=lock['candidateVersion'],
                    patchRevision=lock['patchRevision'], modifiedByPlatform=True,
                    lockSha256=file_hash(repository / 'deploy/opencode-penpot-transport.lock.json'),
                    patcherSha256=file_hash(repository / 'install/apply_opencode_transport_patch.py'))
    need(all(manifest.get(key) == value for key, value in expected.items()), 'native transport source identity mismatch')
    need(set(manifest.get('modified', {})) == {
        'packages/opencode/src/session/tools.ts', 'packages/opencode/src/mcp/catalog.ts',
        'packages/opencode/src/mcp/index.ts', 'packages/plugin/src/index.ts'}, 'native patch file set mismatch')
    need(all(re.fullmatch(r'[a-f0-9]{64}', value) for value in manifest['modified'].values()), 'native patch hashes invalid')
    return manifest


def inspect(reference):
    result = subprocess.run(['docker', 'image', 'inspect', reference], capture_output=True, text=True)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def _build(base, artifact, binary_sha256, output, repository=ROOT):
    repository = Path(repository).resolve()
    need(re.fullmatch(r'sha256:[a-f0-9]{64}', base or ''), 'source-built Agent image ID required')
    image = inspect(base)
    need(image and image['Id'] == base and image['Architecture'] == 'arm64' and image['Os'] == 'linux', 'Agent base architecture or identity mismatch')
    need(image['Config'].get('Entrypoint') == ['node', '/opt/teamaibox/validation/opencode-agent-sandbox-main.mjs'], 'base must be the product Agent runtime')
    artifact, output = Path(artifact), Path(output).absolute()
    native = validate_artifact(artifact, binary_sha256, repository)
    need(not output.resolve().is_relative_to(repository) and not repository.is_relative_to(output.resolve()), 'candidate output must be outside checkout')
    need(not any(p.is_symlink() for p in [output, *output.parents]), 'candidate output cannot use symlinks')
    recipe = repository / 'install/images/agent-penpot-runtime.Dockerfile'
    inputs = dict(baseImage=base, binarySha256=binary_sha256, native=native,
                  recipeSha256=file_hash(recipe), runtime={name: file_hash(repository / name) for name in RUNTIME})
    key = hashlib.sha256(json.dumps(inputs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    tag = 'teamaibox-penpot-agent:' + key
    saved = inspect(tag)
    if saved:
        need(saved['Config'].get('Labels', {}).get('com.teamaibox.penpot.agent-input') == key
             and saved['Config'].get('Labels', {}).get('com.teamaibox.penpot.base-image') == base
             and saved['Architecture'] == 'arm64', 'existing candidate identity conflict')
    else:
        output.mkdir(parents=True, exist_ok=True)
        # BuildKit parses a bare sha256: ID as a registry name in FROM.
        # Give this exact local image a content-addressed, verified alias;
        # never pull a replacement or overwrite an unrelated tag.
        base_tag = 'teamaibox-agent-base:' + base.removeprefix('sha256:')
        alias = inspect(base_tag)
        need(alias is None or alias['Id'] == base, 'Agent base alias conflict')
        if alias is None:
            subprocess.run(['docker', 'tag', base, base_tag], check=True)
        need(inspect(base_tag)['Id'] == base, 'Agent base alias changed')
        with tempfile.TemporaryDirectory(prefix='agent-context-', dir=output) as directory:
            stage = Path(directory)
            (stage / 'artifact').mkdir()
            for name in ('opencode', 'teamaibox-transport-patch.json', 'LICENSE.opencode'):
                shutil.copyfile(artifact / name, stage / 'artifact' / name)
            for name in RUNTIME:
                target = 'validation/' + Path(name).name if name.startswith('deploy/') else name
                path = stage / 'runtime' / target
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(repository / name, path)
            write_json(stage / 'inputs.json', inputs)
            with (output / (key + '.build.log')).open('ab') as log:
                result = subprocess.run(['docker', 'build', '--platform=linux/arm64', '--network=none', '--pull=false',
                    '--build-arg', 'AGENT_BASE=' + base_tag, '--build-arg', 'BINARY_SHA256=' + binary_sha256,
                    '--label', 'com.teamaibox.purpose=penpot-agent-candidate',
                    '--label', 'com.teamaibox.penpot.agent-input=' + key,
                    '--label', 'com.teamaibox.penpot.base-image=' + base,
                    '--label', 'com.teamaibox.opencode.modified-by-platform=true',
                    '--tag', tag, '--file', str(recipe), str(stage)], stdout=log, stderr=subprocess.STDOUT)
            need(result.returncode == 0, 'Agent candidate build failed; inspect its isolated build log')
            need(inspect(base_tag)['Id'] == base, 'Agent base alias changed during build')
        saved = inspect(tag)
        need(saved and saved['Architecture'] == 'arm64', 'Agent candidate did not produce ARM64 image')
    report = dict(schemaVersion=1, role='agent-sandbox', imageId=saved['Id'], inputKey=key,
                  inputs=inputs, modifiedByPlatform=True, deployed=False)
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / (key + '.json'), report)
    return report


def build(base, artifact, binary_sha256, output, repository=ROOT):
    repository, output = Path(repository).resolve(), Path(output).absolute()
    need(not output.resolve().is_relative_to(repository) and not repository.is_relative_to(output.resolve()),
         'candidate output must be outside checkout')
    need(not any(p.is_symlink() for p in [output, *output.parents]), 'candidate output cannot use symlinks')
    output.mkdir(parents=True, exist_ok=True)
    with (output / '.build.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            need(False, 'Agent candidate build already running; do not start a duplicate')
        return _build(base, artifact, binary_sha256, output, repository)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-image', required=True)
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--binary-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.base_image, args.artifact, args.binary_sha256, args.output)))
