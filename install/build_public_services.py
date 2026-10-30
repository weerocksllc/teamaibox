#!/usr/bin/env python3
"""Build application/control-plane images from the public tree and upstream OCI.

Never substitutes an installed product image for missing build inputs. Produces
a partial image map for prepare-release.py; this is not a full offline bundle.
"""
import argparse
import json
from pathlib import Path
import subprocess
import uuid
from offline_common import IMAGE_ROLES, digest, need, run, write_json

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ('messaging', 'team-drive', 'drawing', 'ocr', 'asr', 'translation',
           'virtual-phones', 'virtual-computers', 'wireless-casting')
NODE_SERVICES = {
    'agent-bridge': '/opt/teamaibox/services/agent-bridge/server/dynamic-sandbox-main.mjs',
    'object-service': '/opt/teamaibox/services/object-service/src/internal-rpc-server.mjs',
    'messaging': '/opt/teamaibox/services/messaging/src/server.mjs',
    **{role: '/opt/teamaibox/deploy/runtime/production-service.mjs'
       for role in ('scheduler', 'plugin-runtime', 'observability')},
}
ALIASES = {'embedding-worker':'assistant-worker', 'batch-asr-worker':'asr-worker',
           'casting-media':'casting-receiver'}
UPSTREAM_IMAGES = {'translation-worker':'nvcr.io/nvidia/vllm@sha256:654e563e727be1968487d453de0733fb074cb59adf424c779d0f9e7cfcb2b6b6'}
RECIPES = {
    'platform-api': 'deploy/images/platform-api.Dockerfile',
    'web': 'deploy/images/web.Dockerfile',
    'postgres': 'deploy/images/postgres.Dockerfile',
    'event-bus': 'deploy/images/event-bus.Dockerfile',
    'node-agent': 'deploy/images/node-agent-source.Dockerfile',
    'compute-gateway': 'deploy/images/compute-gateway.Dockerfile',
    'appliance-gateway': 'deploy/images/appliance-gateway.Dockerfile',
    'maintenance-controller': 'deploy/images/maintenance-controller.Dockerfile',
    'source-gateway': 'deploy/agent/SourceGateway.Dockerfile',
    'agent-sandbox': 'deploy/agent/AgentSandbox.Dockerfile',
    'computer-runtime': 'deploy/windows-computer/Public.Dockerfile',
    'desktop-gateway': 'deploy/windows-computer/desktop-gateway/Dockerfile',
    'casting-receiver': 'deploy/casting/Public.Dockerfile',
    'ocr-worker': 'services/ocr-worker/Public.Dockerfile',
    'asr-worker': 'deploy/images/realtime-asr-cpu-worker.Dockerfile',
    'assistant-worker': 'deploy/images/office-vllm-public.Dockerfile',
    'drawing-worker': 'deploy/images/drawing-public.Dockerfile',
    'speaker-diarization-worker': 'services/speaker-diarization-worker/Public.Dockerfile',
    **{role: 'deploy/images/public-node-service.Dockerfile' for role in NODE_SERVICES},
    **{role + '-plugin': 'deploy/appliance/' + role + '-plugin.Dockerfile' for role in PLUGINS},
}


def public_image(value):
    import re
    import ipaddress
    need(isinstance(value, str) and re.fullmatch(r'[a-z0-9.-]+/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}', value),
         'upstream image must be fully qualified and digest pinned')
    host = value.split('/')[0]
    need(host not in ('localhost', '127.0.0.1') and '.' in host, 'local image registry is not a public input')
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    need(address is None or address.is_global, 'non-public registry address')
    return value


def build(repository, output, roles, guacamole=None, guacd=None, network='default'):
    repository, output = repository.resolve(), output.absolute()
    supported = set(RECIPES) | set(ALIASES) | set(UPSTREAM_IMAGES) | {'desktop-proxy'}
    need(set(roles) <= supported and len(set(roles)) == len(roles), 'unknown or duplicate build role')
    need(not output.exists(), 'use a new output directory')
    if set(roles) & {'desktop-gateway', 'virtual-computers-plugin'}:
        public_image(guacamole)
    if 'desktop-proxy' in roles:
        public_image(guacd)
    roles = list(roles)
    for role in list(roles):
        if role in ALIASES:
            parent = ALIASES[role]
            if parent not in roles:
                roles.insert(0,parent)
            elif roles.index(parent)>roles.index(role):
                roles.remove(parent); roles.insert(0,parent)
    if set(roles) & set(NODE_SERVICES):
        roles = ['platform-api'] + [r for r in roles if r != 'platform-api']
    output.mkdir(parents=True)
    source_commit = run(['git', '-C', repository, 'rev-parse', 'HEAD']).strip()
    report = dict(status='building', sourceCommit=source_commit,
                  candidate=bool(run(['git', '-C', repository, 'status', '--porcelain']).strip()),
                  images={}, references={}, failures=[], completeFactoryImages=False, deployed=False)
    prefix = 'teamaibox-public-source:' + uuid.uuid4().hex
    for role in roles:
        try:
            if role in ALIASES:
                need(ALIASES[role] in report['references'], 'shared runtime failed to build')
                tag = report['references'][ALIASES[role]]
            elif role in UPSTREAM_IMAGES:
                tag = public_image(UPSTREAM_IMAGES[role])
                run(['docker','pull','--platform=linux/arm64',tag],timeout=1200)
            elif role == 'desktop-proxy':
                run(['docker', 'pull', '--platform=linux/arm64', guacd], timeout=1200)
                tag = guacd
            else:
                tag = prefix + '-' + role
                arguments = {'IMAGE_REVISION': source_commit}
                if role in NODE_SERVICES:
                    need('platform-api' in report['references'], 'platform API dependency did not build')
                    arguments.update(API_IMAGE=report['references']['platform-api'], SERVICE_NAME=role,
                                     ENTRYPOINT_PATH=NODE_SERVICES[role])
                if role == 'postgres':
                    arguments['MIGRATION_MANIFEST_SHA256'] = digest(repository / 'packages/persistence/migrations/manifest.json')
                if role in ('desktop-gateway', 'virtual-computers-plugin'):
                    arguments['GUACAMOLE_IMAGE'] = guacamole
                command = ['docker', 'build', '--platform=linux/arm64', '--network=' + network,
                           '--pull=' + str(role not in NODE_SERVICES).lower(),
                           '--label', 'org.opencontainers.image.revision=' + source_commit,
                           '-f', str(repository / RECIPES[role]), '-t', tag]
                if role.endswith('-plugin'):
                    command += ['--label', 'com.teamaibox.plugin.id=official.' + role.removesuffix('-plugin')]
                for key, value in arguments.items():
                    command += ['--build-arg', key + '=' + value]
                context = repository / 'deploy/windows-computer/desktop-gateway' if role == 'desktop-gateway' else repository
                with (output / (role + '.log')).open('xb') as log:
                    result = subprocess.run([*command, str(context)], stdout=log, stderr=subprocess.STDOUT)
                need(result.returncode == 0, 'build failed; see ' + role + '.log')
            image = json.loads(run(['docker', 'image', 'inspect', tag]))[0]
            need(image['Architecture'] == 'arm64' and image['Os'] == 'linux', 'image architecture mismatch')
            report['images'][role] = image['Id']
            report['references'][role] = tag
            print(role + ': built', flush=True)
        except Exception as error:
            report['failures'].append(dict(role=role, error=str(error)))
            print(role + ': failed (see build report)', flush=True)
        report['missingFactoryRoles'] = sorted(IMAGE_ROLES - set(report['images']))
        write_json(output / 'images.json', report)
    report['status'] = 'failed' if report['failures'] else 'selected-images-built'
    write_json(output / 'images.json', report, 0o644)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repository', type=Path, default=ROOT)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--roles', nargs='+', required=True, choices=sorted(set(RECIPES) | set(ALIASES) | set(UPSTREAM_IMAGES) | {'desktop-proxy'}))
    p.add_argument('--guacamole-image', help='public guacamole/guacamole image with digest')
    p.add_argument('--guacd-image', help='public guacamole/guacd image with digest')
    p.add_argument('--network', choices=['default', 'host'], default='default', help='build network only; does not configure runtime networks')
    a = p.parse_args()
    result = build(a.repository, a.output, a.roles, a.guacamole_image, a.guacd_image, a.network)
    print(json.dumps(result, indent=2))
    raise SystemExit(bool(result['failures']))
