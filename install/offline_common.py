"""Standard-library-only release contract shared by builder and offline installer."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile


class InstallError(RuntimeError):
    pass


IMAGE_ROLES = {
    'postgres', 'event-bus', 'platform-api', 'web', 'node-agent', 'scheduler',
    'object-service', 'messaging', 'compute-gateway', 'appliance-gateway',
    'maintenance-controller', 'plugin-runtime', 'agent-bridge', 'agent-sandbox',
    'source-gateway', 'observability', 'messaging-plugin', 'team-drive-plugin',
    'drawing-plugin', 'ocr-plugin', 'asr-plugin', 'translation-plugin',
    'virtual-phones-plugin', 'virtual-computers-plugin', 'wireless-casting-plugin',
    'assistant-worker', 'drawing-worker', 'ocr-worker', 'asr-worker',
    'translation-worker', 'embedding-worker', 'batch-asr-worker', 'speaker-diarization-worker',
    'phone-runtime', 'phone-google-runtime', 'computer-runtime', 'desktop-gateway', 'desktop-proxy',
    'casting-receiver', 'casting-media', 'casting-sfu',
}
ASSET_ROLES = {
    'assistant-model', 'drawing-model', 'ocr-model', 'asr-model',
    'translation-model', 'embedding-model', 'android-standard', 'android-google',
    'computer-firmware', 'computer-drivers', 'guest-host-tools', 'factory-configuration', 'drawing-runtime',
}
PHASES = ('storage', 'configuration', 'core', 'catalog', 'recovery', 'workers')
SHA = re.compile(r'[0-9a-f]{64}')
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,100}')


def need(condition, reason):
    if not condition:
        raise InstallError(reason)


def relative(value):
    need(isinstance(value, str) and value and '\\' not in value and '\n' not in value
         and '\r' not in value and '\x00' not in value, 'invalid relative path')
    p = PurePosixPath(value)
    need(not p.is_absolute() and '..' not in p.parts and p.as_posix() == value
         and value != '.', 'unsafe relative path: ' + value)
    return value


def within(root, value):
    p = Path(root) / relative(value)
    # Reject symlinks in every ancestor, including a missing leaf's ancestors.
    for part in (p, *p.parents):
        need(not part.is_symlink(), 'symlink not permitted: ' + str(part))
        if part == Path(root):
            break
    need(p.resolve().is_relative_to(Path(root).resolve()), 'path escapes root')
    return p


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    with open(path, encoding='utf-8') as stream:
        return json.load(stream)


def write_json(path, value, mode=0o600):
    atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode(), mode)


def atomic(path, raw, mode=0o600):
    path = Path(path)
    need(not path.is_symlink(), 'refusing symlink destination')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(args, *, timeout=120, env=None, stdout=None):
    result = subprocess.run([str(a) for a in args], text=True, stdout=stdout or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, env=env)
    # Avoid leaking environment values, tokens or SQL in diagnostics.
    need(result.returncode == 0, 'command failed: ' + str(args[0]) +
         ' (exit ' + str(result.returncode) + ')')
    return result.stdout or ''


def validate_release(value, built=False):
    need(value.get('schemaVersion') == 1, 'unsupported release schema')
    need(ID.fullmatch(value.get('releaseId', '')), 'invalid releaseId')
    need(re.fullmatch('[0-9a-f]{40}', value.get('sourceCommit', '')), 'sourceCommit must be a full Git commit')
    need(value.get('architecture') == 'arm64', 'release must target arm64')
    need(re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', value.get('agentVersion', '')),
         'Agent release version required')
    systems = value.get('guestSystems', {})
    need(systems.get('androidBaseBuildId') == '16102939' and systems.get('androidVersion') == '17',
         'supported Android release declaration required')
    kinds = systems.get('cameraSources', [])
    need(isinstance(kinds, list) and kinds and len(kinds) == len(set(kinds))
         and set(kinds) <= {'image', 'browser', 'video', 'usb', 'udp'}, 'camera source declaration invalid')
    host = value.get('host', {})
    need(host.get('os') and all(isinstance(v, str) for v in host['os']), 'supported factory OS versions required')
    need(isinstance(host.get('commands'), list) and set(('docker', 'python3', 'openssl')).issubset(host['commands']),
         'host command requirements incomplete')
    need(type(host.get('freeReserveBytes')) is int and host['freeReserveBytes'] >= 0, 'free space reserve required')
    images = value.get('images', [])
    roles = [v.get('role') for v in images]
    need(len(set(roles)) == len(roles), 'duplicate image role')
    need(IMAGE_ROLES.issubset(roles), 'missing image roles: ' + ', '.join(sorted(IMAGE_ROLES - set(roles))))
    for row in images:
        need(ID.fullmatch(row['role']), 'invalid image role')
        need(re.fullmatch('sha256:[0-9a-f]{64}', row.get('imageId', '')), 'image content ID required: ' + row['role'])
        need(row.get('architecture') == 'arm64', 'wrong image architecture: ' + row['role'])
        if built:
            relative(row['archive'])
        else:
            need(isinstance(row.get('reference'), str) and row['reference'] and 'replace' not in row['reference']
                 and 'example.invalid' not in row['reference'], 'image reference missing: ' + row['role'])
    assets = value.get('assets', [])
    roles = [v.get('role') for v in assets]
    need(len(set(roles)) == len(roles), 'duplicate asset role')
    need(ASSET_ROLES.issubset(roles), 'missing assets: ' + ', '.join(sorted(ASSET_ROLES - set(roles))))
    destinations = []
    for row in assets:
        need(ID.fullmatch(row['role']), 'invalid asset role')
        relative(row['destination'])
        destinations.append(row['destination'])
        files = row.get('files', [])
        need(files, 'asset file inventory required: ' + row['role'])
        names = []
        for item in files:
            names.append(relative(item['path']))
            need(SHA.fullmatch(item.get('sha256', '')), 'asset checksum required')
            need(type(item.get('size')) is int and item['size'] >= 0, 'asset size required')
            need(item.get('mode', 0o644) in (0o644, 0o755), 'asset mode must be readable data or executable code')
        need(len(set(names)) == len(names), 'duplicate asset file')
    for i, path in enumerate(destinations):
        need(not any(path == other or path.startswith(other + '/') or other.startswith(path + '/')
                     for other in destinations[:i]), 'overlapping asset destinations')
    runtime = value.get('runtimeFiles', [])
    need(runtime and len(set(runtime)) == len(runtime), 'runtime source files required')
    for path in runtime:
        relative(path)
        need(path.startswith(('tools/', 'deploy/', 'install/')) and '.local.' not in path
             and not path.endswith(('.key', '.pem', '.env', '.sqlite', '.qcow2')),
             'not a distributable runtime file: ' + path)
    steps = value.get('steps', [])
    need([s.get('phase') for s in steps] == list(PHASES), 'installation phases incomplete or out of order')
    for step in steps:
        for action in ('apply', 'check'):
            command = step.get(action)
            need(isinstance(command, list) and len(command) >= 2 and command[0] == 'python3',
                 'phase must use a bundled Python entry point: ' + step['phase'])
            script = relative(command[1])
            need(script in runtime, 'phase script is not packaged: ' + script)
            need(all(isinstance(v, str) and '\x00' not in v for v in command), 'invalid phase arguments')
        need(type(step.get('timeoutSeconds')) is int and step['timeoutSeconds'] > 0, 'phase timeout required')
    need(value.get('readiness'), 'component readiness inventory required')
    for row in value['readiness']:
        need(ID.fullmatch(row['role']) and row['role'] in IMAGE_ROLES, 'invalid readiness role')
        need(row.get('containerRole', row['role']) == ('sfu' if row['role'] == 'casting-sfu' else row['role']),
             'readiness container role differs from product contract')
        need(type(row.get('timeoutSeconds')) is int and row['timeoutSeconds'] > 0, 'readiness timeout required')
    required = {'platform-api', 'web', 'node-agent', 'assistant-worker', 'drawing-worker',
                'ocr-worker', 'asr-worker', 'translation-worker', 'embedding-worker'}
    need(required.issubset({r['role'] for r in value['readiness']}), 'required component readiness missing')
    return value


def verify_package(root):
    root = Path(root).resolve()
    manifest = read_json(root / 'release.json')
    validate_release(manifest, built=True)
    records = manifest.get('files', {})
    need(records and {'install.sh', 'installer.py', 'offline_common.py', 'offline_host_packages.py'}.issubset(records), 'package file list incomplete')
    referenced = {v['archive'] for v in manifest['images']}
    referenced.update('runtime/' + v for v in manifest['runtimeFiles'])
    for asset in manifest['assets']:
        relative(asset['packagePath'])
        for item in asset['files']:
            name = asset['packagePath'] + '/' + item['path']
            referenced.add(name)
            need(name in records and records[name]['size'] == item['size']
                 and records[name]['sha256'] == item['sha256']
                 and records[name]['mode'] == item.get('mode', 0o644), 'asset inventory does not match package: ' + name)
    referenced.update(v['path'] for v in manifest.get('hostPackages', []))
    need(referenced.issubset(records), 'release refers to files not present in package')
    for name, info in records.items():
        path = within(root, name)
        need(path.is_file(), 'package file missing: ' + name)
        need(path.stat().st_size == info['size'] and digest(path) == info['sha256'], 'package file damaged: ' + name)
        need(path.stat().st_mode & 0o777 == info['mode'], 'package file mode changed: ' + name)
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if not p.is_dir()}
    need(actual == set(records) | {'release.json', 'checksums.sha256'}, 'unexpected or missing package files')
    for path in root.rglob('*'):
        need(not path.is_symlink(), 'package symlink forbidden')
    checks = ''.join(f"{records[n]['sha256']}  {n}\n" for n in sorted(records)) + f'{digest(root / "release.json")}  release.json\n'
    need((root / 'checksums.sha256').read_text() == checks, 'manifest checksum mismatch')
    return manifest


def validate_factory(value, files, runtime_files):
    """A packable factory recipe must describe actual integration, not no-op phases."""
    need(value.get('schemaVersion') == 1, 'unsupported factory recipe')
    for field in ('directories', 'secrets', 'templates'):
        need(isinstance(value.get(field), list) and value[field], 'factory recipe missing ' + field)
    outputs = set()
    for row in value['templates']:
        need(relative(row['input']) in files, 'factory template input missing')
        output = relative(row['output'])
        need(output not in outputs, 'duplicate factory output')
        outputs.add(output)
        need(row['format'] in ('json', 'env'), 'unsupported factory template format')
        need(type(row.get('runtimeMutable', False)) is bool, 'runtimeMutable must be boolean')
        if row.get('runtimeMutable'):
            need(output in ('public/appliance-addresses.json', 'public/phone-media-state.json',
                            'public/ai-startup.json'), 'only runtime status files may be mutable')
    need(relative(value['composeFile']) in outputs, 'factory compose template missing')
    need(relative(value['composeEnvironment']) in outputs, 'factory compose environment missing')
    references = value.get('references', {})
    required = {'composeFile', 'composeEnvironment', 'phones', 'publicAddresses', 'frontdoor', 'networkIdentity'}
    need(required.issubset(references), 'factory configuration references incomplete')
    for path in references.values():
        need(relative(path) in outputs, 'factory reference has no template: ' + path)
    for row in value['directories']:
        relative(row['path'])
        need(type(row['uid']) is int and row['uid'] >= 0 and type(row['gid']) is int and row['gid'] >= 0,
             'directory ownership required')
        need(re.fullmatch('0[0-7]{3}', row['mode']), 'directory mode required')
    secret_names = set()
    for row in value['secrets']:
        relative(row['path'])
        need(ID.fullmatch(row['name']) and row['name'] not in secret_names, 'duplicate or invalid secret name')
        secret_names.add(row['name'])
        need(row['format'] in ('hex', 'base64', 'base64url', 'ed25519'), 'unsupported secret format')
        need(type(row['bytes']) is int and (32 <= row['bytes'] <= 128
             or row['name'] == 'desktop-json-key' and row['format'] == 'hex' and row['bytes'] == 16),
             'secret size must match service contract')
        need(row.get('mode', '0600') in ('0400', '0600', '0440', '0640'), 'private secret permissions required')
        for field in ('uid', 'gid'):
            need(type(row.get(field, 0)) is int and row.get(field, 0) >= 0, 'invalid secret ownership')
    # Office workers use the maintained Node Agent start-spec normalizer and
    # recovery adapter, not a second, loosely equivalent Compose definition.
    for phase in ('core',):
        definition = value['services'][phase]
        need(definition.get('names') and definition.get('roles') and definition.get('timeoutSeconds', 0) > 0,
             'factory service startup incomplete: ' + phase)
        need(all(ID.fullmatch(n) for n in definition['names']), 'invalid compose service name')
        need(set(definition['roles'].values()).issubset(definition['names']), 'service role not started')
    need(value.get('officeDefinition') in files, 'office definition missing')
    for phase in ('catalog', 'recovery'):
        definition = value[phase]
        need(definition.get('timeoutSeconds', 0) > 0, 'factory adapter timeout required')
        for action in ('apply', 'check'):
            need(definition.get(action), 'factory adapter missing: ' + phase + '/' + action)
            for command in definition[action]:
                need(len(command) > 1 and command[0] == 'python3' and command[1] in runtime_files,
                     'factory adapter is not a bundled script')
    return value
