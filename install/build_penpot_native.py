#!/usr/bin/env python3
"""Build the pinned native OpenCode transport without importing user state."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from offline_common import need, read_json, write_json
from apply_opencode_transport_patch import apply as patch, source_tree
from build_penpot_agent import validate_artifact
from build_penpot_stack import safe_output, tree_digest
from source_download import file_hash

ROOT = Path(__file__).resolve().parents[1]


def prepare_original(output, supplied=None):
    """Git handles source symlinks; validate the complete tree, not just HEAD."""
    lock = read_json(ROOT / 'deploy/opencode-penpot-transport.lock.json')
    need(not any(p.is_symlink() for p in (output, *output.parents)), 'native source path cannot use links')
    if output.exists():
        need(source_tree(output).hex() == lock['tree'], 'cached native source changed')
        tree_digest(output)
        return output
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='native-source-', dir=output.parent) as directory:
        stage = Path(directory) / 'source'
        if supplied:
            need(not Path(supplied).is_symlink(), 'supplied native source cannot be a link')
            need(source_tree(supplied).hex() == lock['tree'], 'supplied native source tree mismatch')
            shutil.copytree(supplied, stage, symlinks=True)
        else:
            # No global Git helpers, cookies, SSH credentials or user hooks.
            env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
            env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_TERMINAL_PROMPT='0', GIT_ASKPASS='/usr/bin/false')
            git = ['git', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
                   '-c', 'protocol.file.allow=never', '-c', 'http.followRedirects=false']
            bare = Path(directory) / 'objects.git'
            subprocess.run([*git, 'init', '--bare', str(bare)], check=True, env=env, capture_output=True)
            subprocess.run([*git, '--git-dir='+str(bare), 'fetch', '--depth=1', '--no-tags',
                            lock['repository'], lock['commit']], check=True, env=env)
            tree = subprocess.check_output([*git, '--git-dir='+str(bare), 'rev-parse',
                'FETCH_HEAD^{tree}'], env=env, text=True).strip()
            need(tree == lock['tree'], 'downloaded native Git tree mismatch')
            stage.mkdir()
            subprocess.run([*git, '--git-dir='+str(bare), '--work-tree='+str(stage),
                            'checkout', lock['commit'], '--', '.'], check=True, env=env)
        need(source_tree(stage).hex() == lock['tree'], 'native source content mismatch')
        # Reject links escaping this export before any image build copies it.
        tree_digest(stage)
        stage.rename(output)
    return output


def build(output, source=None):
    output = safe_output(output)
    output.mkdir(parents=True, exist_ok=True)
    fd = os.open(output / '.native-build.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lease:
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            need(False, 'native transport build already running')
        toolchain = read_json(ROOT / 'deploy/opencode-penpot-transport.lock.json')['bunToolchain']
        recipe = ROOT / 'install/images/opencode-penpot-source.Dockerfile'
        recipe_text = recipe.read_text()
        need(toolchain['platform'] == 'linux/arm64'
             and ('ADD --checksum=sha256:' + toolchain['sha256']) in recipe_text
             and toolchain['url'] in recipe_text
             and ('"$(bun --version)" = ' + repr(toolchain['version'])) in recipe_text,
             'Bun build input differs from the pinned public toolchain')
        original = prepare_original(output / 'original', source)
        inputs = {name: file_hash(ROOT / name) for name in (
            'deploy/opencode-penpot-transport.lock.json', 'install/apply_opencode_transport_patch.py',
            'install/images/opencode-penpot-source.Dockerfile')}
        key = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
        saved = output / (key + '.json')
        if saved.exists():
            need(not saved.is_symlink(), 'native checkpoint cannot be a link')
            report = read_json(saved)
            artifact = output / report['artifact']
            need(not any(p.is_symlink() for p in (artifact, *artifact.parents)), 'linked native artifact path')
            need(artifact.resolve().is_relative_to(output.resolve()), 'native artifact escapes checkpoint')
            need(report['inputs'] == inputs, 'native inputs changed')
            validate_artifact(artifact, report['binarySha256'])
            return {**report, 'artifact':str(artifact), 'original':str(original)}
        attempt = output / ('build-' + uuid.uuid4().hex)
        attempt.mkdir()
        patched = patch(original, attempt / 'source')
        artifact = attempt / 'artifact'
        with (attempt / 'build.log').open('xb') as log:
            subprocess.run(['docker', 'build', '--platform=linux/arm64', '--target=artifact',
                '--file', str(recipe),
                '--output', 'type=local,dest='+str(artifact), str(patched)],
                check=True, stdout=log, stderr=subprocess.STDOUT)
        checksum = file_hash(artifact / 'opencode')
        validate_artifact(artifact, checksum)
        report = dict(inputs=inputs, binarySha256=checksum, artifact=artifact.relative_to(output).as_posix())
        write_json(saved, report)
        return {**report, 'artifact':str(artifact), 'original':str(original)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path, help='optional exact public source export; fully verified')
    args = parser.parse_args()
    print(json.dumps(build(args.output, args.source)))
