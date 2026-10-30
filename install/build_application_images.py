#!/usr/bin/env python3
"""Bake current web and official application code into independent ARM64 images.

Existing development images can contain several historical static roots. This
builder uses the maintained Dockerfiles and a clean Node dependency image, then
checks the bytes at their canonical runtime paths. It never deploys a service.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import uuid

from offline_common import digest, need, run, write_json

PLUGINS = ('messaging', 'team-drive', 'drawing', 'ocr', 'asr', 'translation',
           'virtual-phones', 'virtual-computers', 'wireless-casting')
PACKAGES = ('plugin-sdk', 'ui-system', 'application-plugin-runtime')
DESKTOP_ASSETS = {'guacamole-common-js/all.min.js': 'all.min.js',
                  'META-INF/LICENSE': 'LICENSE.txt', 'META-INF/NOTICE': 'NOTICE.txt'}


def desktop_asset_hashes(image):
    script = ('cd /tmp && jar xf /opt/guacamole/webapp/guacamole.war '
              + ' '.join(DESKTOP_ASSETS) + ' && sha256sum ' + ' '.join(DESKTOP_ASSETS))
    output = run(['docker', 'run', '--rm', '--network', 'none', '--pull', 'never', '--read-only',
                  '--tmpfs', '/tmp', '--entrypoint', 'sh', image, '-c', script])
    values = {name: sha for sha, name in (line.split() for line in output.splitlines())}
    need(set(values) == set(DESKTOP_ASSETS) and all(re.fullmatch('[0-9a-f]{64}', v) for v in values.values()),
         'Guacamole browser dependency or license is missing')
    prefix = '/opt/teamaibox/apps/virtual-computers-plugin/src/public/guacamole-common-js/'
    return {prefix + DESKTOP_ASSETS[name]: sha for name, sha in values.items()}


def files(repository, directory, target):
    result = {}
    for path in sorted((repository / directory).rglob('*')):
        relative = path.relative_to(repository / directory)
        if any(p in ('node_modules', '__pycache__') for p in relative.parts):
            continue
        if path.name.endswith('.pyc') or path.name == '.env' or path.name.startswith('.env.'):
            continue
        need(not path.is_symlink(), 'application source symlink: ' + str(path))
        if path.is_file():
            result[target + '/' + relative.as_posix()] = digest(path)
    need(result, 'application source is empty: ' + directory)
    return result


def expected_files(repository, role):
    if role == 'web':
        result = files(repository, 'apps/web/dist', '/opt/teamaibox/web')
        result['/opt/teamaibox/server/web-boundary.mjs'] = digest(repository / 'apps/web/server/web-boundary.mjs')
        return result
    need(role in {p + '-plugin' for p in PLUGINS}, 'unknown application role')
    result = files(repository, 'apps/' + role, '/opt/teamaibox/apps/' + role)
    for package in PACKAGES:
        result.update(files(repository, 'packages/' + package, '/opt/teamaibox/packages/' + package))
    return result


def build(repository, base, output, guacamole):
    repository, output = repository.resolve(), output.absolute()
    need(not output.exists(), 'application image report already exists')
    need(re.fullmatch('sha256:[0-9a-f]{64}', base), 'exact clean Node image ID required')
    actual = json.loads(run(['docker', 'image', 'inspect', base]))[0]
    need(actual['Id'] == base and actual['Architecture'] == 'arm64' and actual['Os'] == 'linux', 'ARM64 Node image required')
    need(re.fullmatch('sha256:[0-9a-f]{64}', guacamole), 'exact Guacamole image ID required')
    desktop = json.loads(run(['docker', 'image', 'inspect', guacamole]))[0]
    need(desktop['Id'] == guacamole and desktop['Architecture'] == 'arm64' and desktop['Os'] == 'linux', 'ARM64 Guacamole image required')
    desktop_files = desktop_asset_hashes(guacamole)
    # The existing asset verifier checks HTML imports and complete JS/CSS chunks.
    run(['docker', 'run', '--rm', '--network', 'none', '--pull', 'never', '--read-only',
         '--mount', 'type=bind,src=' + str(repository / 'apps/web') + ',dst=/source,readonly',
         '--workdir', '/source', '--entrypoint', 'node', base, 'tools/verify-bundle.mjs', 'dist'])
    commit = run(['git', '-C', repository, 'rev-parse', 'HEAD']).strip()
    output.mkdir(parents=True)
    build_id = str(uuid.uuid4())
    alias = 'teamaibox-offline-node:' + build_id
    run(['docker', 'image', 'tag', base, alias])
    desktop_alias = 'teamaibox-offline-desktop-assets:' + build_id
    run(['docker', 'image', 'tag', guacamole, desktop_alias])
    report = dict(status='building', sourceCommit=commit, nodeBase=base, images={}, sourceFiles={},
                  desktopBase=guacamole, desktopAssetFiles=desktop_files, verifiedRuntimeFiles={}, deployed=False)
    verifier = """const fs=require('node:fs'),c=require('node:crypto');
const paths=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(Object.fromEntries(paths.map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))));"""
    for role in ('web', *(p + '-plugin' for p in PLUGINS)):
        expected = expected_files(repository, role)
        source_expected = dict(expected)
        if role == 'virtual-computers-plugin':
            expected.update(desktop_files)
        dockerfile = 'deploy/images/web-prebuilt.Dockerfile' if role == 'web' else 'deploy/appliance/' + role + '.Dockerfile'
        tag = 'teamaibox-offline-application:' + build_id + '-' + role
        args = ['docker', 'build', '--network=none', '--pull=false', '--platform=linux/arm64',
                '--build-arg', 'NODE_IMAGE=' + alias, '--build-arg', 'IMAGE_REVISION=' + commit,
                '--label', 'org.opencontainers.image.revision=' + commit,
                '-f', repository / dockerfile, '-t', tag, repository]
        if role != 'web':
            args[2:2] = ['--label', 'com.teamaibox.plugin.id=official.' + role.removesuffix('-plugin')]
        if role == 'virtual-computers-plugin':
            args[2:2] = ['--build-arg', 'GUACAMOLE_IMAGE=' + desktop_alias]
        with (output / (role + '.log')).open('xb') as log:
            done = subprocess.run([str(a) for a in args], stdout=log, stderr=subprocess.STDOUT, timeout=600)
        need(done.returncode == 0, 'application build failed: ' + role)
        image = json.loads(run(['docker', 'image', 'inspect', tag]))[0]
        check = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--pull', 'never', '--read-only',
                                '--entrypoint', 'node', '-i', image['Id'], '-e', verifier],
                               input=json.dumps(list(expected)), text=True, capture_output=True, timeout=60)
        need(check.returncode == 0 and json.loads(check.stdout) == expected, 'image source bytes differ: ' + role)
        need(expected_files(repository, role) == source_expected, 'source changed during application build: ' + role)
        if role == 'web':
            need('WEB_STATIC_ROOT=/opt/teamaibox/web' in image['Config']['Env'], 'web static root is not canonical')
        report['images'][role] = image['Id']
        report['sourceFiles'][role] = expected
        report['verifiedRuntimeFiles'][role] = len(expected)
        write_json(output / 'images.json', report)
        print(role + ': built and source bytes verified', flush=True)
    report['status'] = 'built-not-deployed'
    write_json(output / 'images.json', report, 0o644)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--node-base', required=True)
    parser.add_argument('--guacamole-image', required=True, help='exact offline Guacamole server image; supplies browser client and license')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = build(args.repository, args.node_base, args.output, args.guacamole_image)
    print(json.dumps({k: result[k] for k in ('status', 'images', 'verifiedRuntimeFiles', 'deployed')}, indent=2))
