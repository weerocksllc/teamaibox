"""The standalone Design AI profile. No production Docker socket or model service."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import uuid

from factory_services import bind, service
from offline_common import digest, need, run, validate_release, within

AI_IMAGES = frozenset({'agent-sandbox', 'assistant-worker'})
AI_SERVICES = frozenset({'agent-bridge', 'compute-gateway', 'assistant-worker'})
DYNAMIC_LABEL = 'com.teamaibox.dynamic-agent-owner'


def engine_binding(directory):
    """Only an explicitly supplied, private, separately rooted local daemon."""
    if directory is None:
        return None
    root = directory.absolute()
    need(root == root.resolve() and root.is_dir() and root.stat().st_uid == 0
         and root.stat().st_mode & 0o077 == 0, 'dedicated engine root must be a private root-owned directory')
    socket = within(root, 'docker.sock')
    need(socket.exists() and stat.S_ISSOCK(socket.stat().st_mode) and socket.stat().st_uid == 0,
         'dedicated engine Unix socket is unavailable')
    default = Path('/var/run/docker.sock')
    need(not default.exists() or not socket.samefile(default), 'production Docker socket is not a dedicated engine')
    info = json.loads(run(['docker', '--host', 'unix://' + str(socket), 'info', '--format', '{{json .}}']))
    need(info.get('DockerRootDir') == str(within(root, 'docker-data')) and bool(info.get('ID')),
         'dedicated engine data-root identity mismatch')
    return dict(root=str(root), socket=str(socket), id=info['ID'], nvidia='nvidia' in info.get('Runtimes', {}))


def checked_model(manifest, expected, root, *, deployed_source=None):
    from artifact_validation import validate_asset
    need(manifest is not None and manifest.name == 'release.json' and not manifest.is_symlink()
         and re.fullmatch(r'[a-f0-9]{64}', expected or ''), 'verified assistant model release manifest is required')
    raw = manifest.read_bytes()
    need(hashlib.sha256(raw).hexdigest() == expected, 'assistant model release checksum mismatch')
    release = validate_release(json.loads(raw), built=True)
    row, = [v for v in release['assets'] if v['role'] == 'assistant-model']
    source = deployed_source or within(manifest.absolute().parent, row['destination'])
    target = within(root, 'assets/assistant-model')
    names = {entry['path'] for entry in row['files']}

    def inventory(directory, *, verify):
        need(directory.is_dir(), 'missing assistant model directory')
        actual = set()
        for item in directory.rglob('*'):
            need(not item.is_symlink() and (item.is_dir() or item.is_file()), 'unsafe assistant model input')
            if item.is_file():
                actual.add(item.relative_to(directory).as_posix())
        need(actual == names, 'unexpected assistant model input')
        validate_asset(row, directory)
        if verify:
            for entry in row['files']:
                path = within(directory, entry['path'])
                need(path.stat().st_size == entry['size'] and digest(path) == entry['sha256'],
                     'assistant model file checksum mismatch')

    # Release directories can be operator-owned mode 0700. Don't loosen
    # their modes or mount mutable external inputs into the worker.
    if not target.exists():
        inventory(source, verify=False)
        target.parent.mkdir(mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='model-stage-', dir=target.parent) as temp:
            stage = Path(temp)
            for name in sorted(names):
                dest = within(stage, name)
                dest.parent.mkdir(parents=True, exist_ok=True)
                run(['cp', '--reflink=auto', '--', within(source, name), dest], timeout=600)
            inventory(stage, verify=True)
            for item in [stage, *stage.rglob('*')]:
                os.chown(item, 0, 65532)
                item.chmod(0o750 if item.is_dir() else 0o440)
            stage.rename(target)
    else:
        inventory(target, verify=True)
    return target


def configure(services, templates):
    """Retain the factory controller and sandbox config, on the dedicated socket."""
    api, agent, mcp = (services[name] for name in ('platform-api', 'agent-bridge', 'penpot-mcp'))
    api['environment'].update(ASSISTANT_AGENT_BRIDGES_FILE='/run/config/agent-routes.json',
                              ASSISTANT_AGENT_CONTROLLER_ORIGIN='http://agent-bridge:8080',
                              ASSISTANT_AGENT_CONTROLLER_TOKEN_FILE='/run/secrets/dynamic_controller_token',
                              PLATFORM_PENPOT_MCP_KEY_FILE='/run/secrets/penpot_mcp')
    api['secrets'] += ['dynamic_controller_token', 'penpot_mcp']
    api['volumes'].append(bind('@@ROOT@@/config/agent-routes.json', '/run/config/agent-routes.json'))
    api['networks'].append('agent-control')
    mcp['networks'].append('agent-control')
    agent['image'] = '@@IMAGE.platform-api@@'
    agent['volumes'] = [bind('@@DESIGN_ENGINE_SOCKET@@', '/var/run/docker.sock', False)
                        if isinstance(v, dict) and v['target'] == '/var/run/docker.sock' else v for v in agent['volumes']]
    agent['configs'] = []
    agent['networks'].append('agent-egress-proxy')
    # The signing key uses the exact filename expected by the existing controller.
    office = templates['config/office-definition.json']
    worker = office['workers']['assistant']
    gateway = service('platform-api', user='1000:1000', memory='512m')
    gateway.update(entrypoint=['node', '/opt/teamaibox/services/compute-gateway/server/main.mjs'],
                   environment=dict(AGENT_COMPUTE_LOCAL_ORIGIN='http://assistant-worker:8000',
                       AGENT_MODEL_SIGNING_KEY_FILE='/run/secrets/agent_model_signing_key',
                       AGENT_MODEL_ALIAS_MAP_FILE='/run/config/design-model-aliases.json'),
                   secrets=['agent_model_signing_key'], networks=['agent-control', 'design-model'],
                   volumes=[bind('@@ROOT@@/config/design-model-aliases.json', '/run/config/design-model-aliases.json')],
                   healthcheck=dict(test=['CMD','node','-e',"fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                                    interval='10s', timeout='5s', retries=9))
    model = service('assistant-worker', user=f"{worker['user']}:{worker['user']}", memory=worker['memoryBytes'])
    model.update(entrypoint=worker['entrypoint'], command=worker['command'], environment=worker['environment'],
                 cpus=worker['cpuQuotaMicros']/100000, pids_limit=worker['pidsLimit'], shm_size=worker['sharedMemoryBytes'],
                 tmpfs=[f"/tmp:rw,exec,nosuid,nodev,size={worker['ephemeralBytes']}"],
                 networks=['design-model'], volumes=[bind('@@DESIGN_MODEL@@', '/model')],
                 deploy={'resources': {'reservations': {'devices': [{'driver':'nvidia','count':'all','capabilities':['gpu']}]}}},
                 healthcheck=dict(test=worker['healthCheck']['test'], interval='10s', timeout='5s', retries=12, start_period='900s'))
    services.update({'compute-gateway': gateway, 'assistant-worker': model})
    return {'config/agent-controller.json': templates['config/agent-controller.json'],
            'config/agent-routes.json': templates['config/agent-routes.json'],
            'config/design-model-aliases.json': dict(schemaVersion=1, aliases={'agent.default':office['profiles']['assistant']['servedModel']})}


def dynamic_resources(root, compose):
    """Accept only this controller's immutable, least-privileged sandbox shape."""
    from offline_common import read_json
    cfg = read_json(within(root,'config/agent-controller.json'))
    expected = compose['volumes']['factory_agent_state']
    need(cfg['volume'] == expected['name'] and expected['driver_opts']['device'] == str(root/'data/agent/dynamic')
         and cfg['networks'] == [compose['networks'][key]['name'] for key in ('agent-control','agent-egress-proxy')],
         'Design controller storage or networks do not match this generation')
    ids = run(['docker','ps','-aq','--filter','label='+DYNAMIC_LABEL]).split()
    if not ids:
        return []
    rows = json.loads(run(['docker','container','inspect',*ids]))
    for row in rows:
        identity = (row['Config']['Labels'] or {}).get(DYNAMIC_LABEL)
        key = hashlib.sha256(str(uuid.UUID(identity)).encode()).hexdigest()[:32]
        host = row['HostConfig']
        mounts = host.get('Mounts') or []
        need(row['Name'] == '/teamaibox-agent-'+key and row['Image'] == cfg['image']
             and row['Config']['User'] == '65532:65532' and host['ReadonlyRootfs'] and not host['Privileged']
             and not host.get('Binds') and not host.get('Devices') and host['CapDrop'] == ['ALL']
             and set(row['NetworkSettings']['Networks']) <= set(cfg['networks']) and len(mounts) == 3,
             'unrecognized container on dedicated Design engine')
        for target, leaf in (('/workspace','workspace'),('/run/teamaibox','runtime'),('/run/secrets','model')):
            matches = [m for m in mounts if m['Target']==target]
            need(len(matches)==1 and matches[0]['Type']=='volume' and matches[0]['Source']==cfg['volume']
                 and matches[0]['VolumeOptions']['Subpath']==key+'/'+leaf
                 and bool(matches[0].get('ReadOnly'))==(leaf!='workspace'), 'unexpected Design sandbox storage')
    return rows
