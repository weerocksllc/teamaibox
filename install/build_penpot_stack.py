#!/usr/bin/env python3
"""Prepare/build the protected Penpot candidate. Never install or replace services."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import uuid

from offline_common import need, read_json, write_json
from source_download import file_hash
from prepare_penpot_source import prepare
from apply_penpot_patches import apply as patch_identity
from apply_penpot_mcp_binding_patch import apply as patch_mcp
from penpot_download_patch import patch as patch_download

ROOT = Path(__file__).resolve().parents[1]
ROLES = {
    'penpot-backend': ('penpot-editor-source.Dockerfile', 'backend-runtime',
                       ('backend', 'common', 'docker/images/files', 'LICENSE', 'CHANGES.md')),
    'penpot-frontend': ('penpot-editor-source.Dockerfile', 'frontend-runtime',
                        ('frontend', 'common', 'render-wasm', 'plugins', 'mcp', 'docker/images/files', 'LICENSE', 'CHANGES.md')),
    'penpot-exporter': ('penpot-editor-source.Dockerfile', 'exporter-runtime',
                        ('exporter', 'common', 'docker/images/files', 'LICENSE')),
    'penpot-mcp': ('penpot-mcp-source.Dockerfile', None, ('mcp',)),
}
PATCH_INPUTS = ('apply_penpot_patches.py', 'apply_penpot_mcp_binding_patch.py',
                'penpot_plugin_execution_patch.py', 'penpot_svg_target_patch.py',
                'penpot-patches/teamaibox_auth.clj', 'penpot-patches/teamaibox_teams.clj', 'penpot-patches/drive-import.clj',
                'penpot-patches/DesignCallAuthority.ts',
                'penpot-patches/TargetBoundApi.ts', 'penpot-patches/ProtectedExecuteCode.ts',
                'penpot-patches/svg-target-functions.cljs', 'penpot_download_patch.py',
                'penpot-patches/ProtectedDownloadURL.mjs')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def tree_digest(root, names=('.',)):
    """Content/mode/link identity; never follow a source symlink outside its tree."""
    root = Path(root)
    records = {}

    def visit(path):
        mode = path.lstat().st_mode
        name = path.relative_to(root).as_posix()
        if stat.S_ISLNK(mode):
            target = os.readlink(path)
            need(path.resolve().is_relative_to(root.resolve()), 'source symlink escapes build tree')
            records[name] = ['link', target]
        elif stat.S_ISDIR(mode):
            for child in sorted(path.iterdir()):
                visit(child)
        else:
            need(stat.S_ISREG(mode), 'unsupported source entry')
            records[name] = ['file', bool(mode & 0o111), file_hash(path)]
    for name in names:
        visit(root / name)
    return fingerprint(records)


def safe_output(path):
    path = Path(path).absolute()
    need(not any(p.is_symlink() for p in (path, *path.parents)), 'symlink in candidate output')
    need(not path.resolve().is_relative_to(ROOT.resolve()), 'candidate output must be outside checkout')
    need(not ROOT.resolve().is_relative_to(path.resolve()), 'candidate output cannot contain checkout')
    need(path.parent != path and len(path.parts) >= 4, 'use a dedicated candidate directory')
    return path


def prepare_candidate(cache, output, state, archive=None):
    lock = read_json(ROOT / 'deploy/penpot-source.lock.json')
    inputs = {'source': lock, 'patches': {name: file_hash(ROOT / 'install' / name) for name in PATCH_INPUTS}}
    key = fingerprint(inputs)
    target = output / 'sources' / key
    saved = state['sources'].get(key)
    if saved:
        need(target.is_dir() and tree_digest(target) == saved['treeSha256'],
             'prepared source changed; preserved for inspection, refusing cached build')
        return target, key
    need(not target.exists(), 'unrecorded prepared source preserved; use a new output to inspect/recover')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='penpot-prepare-', dir=target.parent) as temporary:
        stage = Path(temporary)
        original = prepare(ROOT, cache, stage / 'original', archive)
        identity = patch_identity(original, stage / 'identity')
        combined = patch_mcp(identity, stage / 'combined')
        patch_download(combined)
        write_json(combined / 'teamaibox-integration-inputs.json', inputs)
        shutil.copyfile(combined / 'LICENSE', combined / 'mcp/LICENSE.penpot')
        write_json(combined / 'mcp/teamaibox-integration-inputs.json', inputs)
        combined.rename(target)
    state['sources'][key] = {'inputs': inputs, 'treeSha256': tree_digest(target)}
    write_json(output / 'state.json', state)
    return target, key


def role_input(source, role):
    recipe, target, paths = ROLES[role]
    inputs = {'role': role, 'platform': 'linux/arm64', 'target': target,
              'sourceSha256': tree_digest(source, paths),
              'recipeSha256': file_hash(ROOT / 'install/images' / recipe)}
    return inputs, fingerprint(inputs)


def inspect_image(reference, expected_key):
    result = subprocess.run(['docker', 'image', 'inspect', reference], capture_output=True, text=True)
    if result.returncode:
        return None
    image = json.loads(result.stdout)[0]
    need(image['Architecture'] == 'arm64' and image['Os'] == 'linux', 'candidate image architecture mismatch')
    need(image.get('Config', {}).get('Labels', {}).get('com.teamaibox.penpot.input') == expected_key,
         'candidate image input identity mismatch')
    return image['Id']


def build_transport():
    import os
    import re
    proxy = os.environ.get('TEAMAIBOX_PENPOT_BUILD_PROXY')
    if not proxy:
        return ['--network=default']
    match = re.fullmatch(r'127\.0\.0\.1:([1-9][0-9]{0,4})', proxy)
    need(match and int(match[1]) <= 65535, 'Design build proxy must use an explicit IPv4 loopback port')
    return ['--network=host', '--build-arg', 'HTTPS_PROXY=http://'+proxy]


def build_roles(source, source_key, output, state, roles):
    report = {'status': 'building', 'deployed': False, 'releaseAccepted': False,
              'sourceKey': source_key, 'images': {}, 'references': {}, 'reused': [], 'failures': []}
    for role in roles:
        inputs, key = role_input(source, role)
        saved = state['images'].get(key)
        if saved and inspect_image(saved['imageId'], key) == saved['imageId']:
            report['images'][role] = saved['imageId']
            report['references'][role] = saved['imageId']
            report['reused'].append(role)
            print(role + ': verified cache', flush=True)
            continue
        attempt = output / 'attempts' / (role + '-' + uuid.uuid4().hex)
        attempt.mkdir(parents=True)
        tag = 'teamaibox-penpot-candidate:' + attempt.name
        write_json(attempt / 'inputs.json', {'inputs': inputs, 'sourceKey': source_key, 'tag': tag})
        recipe, target, _ = ROLES[role]
        command = ['docker', 'build', '--platform=linux/arm64', *build_transport(),
                   '--label', 'com.teamaibox.purpose=penpot-source-candidate',
                   '--label', 'com.teamaibox.penpot.input=' + key,
                   '--tag', tag, '--file', str(ROOT / 'install/images' / recipe)]
        if target:
            command += ['--target', target]
        context = source / 'mcp' if role == 'penpot-mcp' else source
        try:
            with (attempt / 'build.log').open('xb') as log:
                result = subprocess.run([*command, str(context)], stdout=log, stderr=subprocess.STDOUT)
            need(result.returncode == 0, 'candidate build failed; see ' + str(attempt / 'build.log'))
            image_id = inspect_image(tag, key)
            need(image_id, 'built image missing')
            state['images'][key] = {'inputs': inputs, 'imageId': image_id, 'reference': tag,
                                    'attempt': attempt.relative_to(output).as_posix()}
            write_json(output / 'state.json', state)
            report['images'][role], report['references'][role] = image_id, tag
            print(role + ': built', flush=True)
        except Exception as error:
            report['failures'].append({'role': role, 'reason': str(error)})
            report['status'] = 'failed'
            write_json(output / 'images.json', report)
            raise
        write_json(output / 'images.json', report)
    report['status'] = 'selected-candidates-built-not-release-accepted'
    write_json(output / 'images.json', report)
    return report


def build(cache, output, roles, archive=None, prepare_only=False):
    need(roles and len(roles) == len(set(roles)) and set(roles) <= set(ROLES), 'invalid or duplicate Penpot role')
    output = safe_output(output)
    for leaf in ('state.json', 'sources', 'attempts'):
        need(not (output / leaf).is_symlink(), 'symlink in candidate build state')
    if output.exists():
        need((output / 'state.json').is_file(), 'existing unrelated output is preserved')
    else:
        output.mkdir(parents=True)
        write_json(output / 'state.json', {'schema': 'penpot-candidate-build-v1', 'sources': {}, 'images': {}})
    fd = os.open(output / '.build.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lease:
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('This Penpot candidate build is already running') from None
        state = read_json(output / 'state.json')
        need(state.get('schema') == 'penpot-candidate-build-v1', 'unrecognized build state')
        source, key = prepare_candidate(cache, output, state, archive)
        if prepare_only:
            return {'status': 'source-prepared-only', 'source': str(source), 'sourceKey': key, 'deployed': False}
        return build_roles(source, key, output, state, roles)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--roles', nargs='+', choices=sorted(ROLES), default=list(ROLES))
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    print(json.dumps(build(args.cache, args.output, args.roles, args.archive, args.prepare_only), indent=2))
