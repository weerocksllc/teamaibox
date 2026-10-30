"""Per-appliance references, not developer names or a second secret store."""
import json
import os
import re
import subprocess
import uuid
from pathlib import Path
from appliance_network_identity import atomic_write

DEFAULT = Path('/etc/teamaibox/installation.json')
ROLES = {'platform-api', 'web', 'node-agent', 'postgres', 'sfu', 'casting-media',
         'appliance-gateway', 'maintenance-controller', 'desktop-proxy', 'desktop-gateway'}


def execute(args, *, data=None, timeout=90):
    p = subprocess.run(args, input=data, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError('installation_command_failed:' + args[0])
    return p.stdout


def load(path=DEFAULT):
    path = Path(path)
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('installation_configuration_owner_or_mode')
    value = json.loads(path.read_text())
    validate(value)
    return value


def validate(value):
    if value.get('version') != 1:
        raise ValueError('installation_version')
    uuid.UUID(value['installationId']); uuid.UUID(value['nodeId'])
    for role, service in value.get('services', {}).items():
        if role not in ROLES or not re.fullmatch('[0-9a-f]{64}', service['containerId']):
            raise ValueError('installation_service_identity')
    for key, path in value.get('references', {}).items():
        if not isinstance(path, str) or not Path(path).is_absolute() or '..' in Path(path).parts or path == '/':
            raise ValueError('installation_reference_invalid:' + key)
    return value


def inspect(container):
    rows = json.loads(execute(['docker', 'inspect', container]))
    if len(rows) != 1:
        raise ValueError('installation_service_ambiguous')
    return rows[0]


def resolve(record, role):
    pinned = record['services'][role]
    current = inspect(pinned['containerId'])
    if current['Id'] != pinned['containerId'] or current['Image'] != pinned['imageId']:
        raise ValueError('installation_service_identity_changed:' + role)
    for k, v in pinned['labels'].items():
        if (current['Config'].get('Labels') or {}).get(k) != v:
            raise ValueError('installation_service_owner_changed:' + role)
    return current


def host_path(container, path):
    matches = [m for m in container['Mounts'] if path == m['Destination'] or path.startswith(m['Destination'].rstrip('/') + '/')]
    if not matches:
        raise ValueError('installation_mount_not_found')
    matches.sort(key=lambda m: len(m['Destination']), reverse=True)
    if len(matches) > 1 and matches[0]['Destination'] == matches[1]['Destination']:
        raise ValueError('installation_mount_ambiguous')
    mount = matches[0]
    return str(Path(mount['Source']) / path.removeprefix(mount['Destination']).lstrip('/'))


def service_record(c):
    labels = c['Config'].get('Labels') or {}
    if labels.get('com.teamaibox.kind') in ('android-phone', 'virtual-computer', 'windows-computer'):
        raise ValueError('guest_is_not_replaceable_service')
    owner = {k: v for k, v in labels.items() if k in ('com.teamaibox.managed', 'com.teamaibox.core-service-key', 'com.teamaibox.component', 'com.docker.compose.project', 'com.docker.compose.service', 'com.teamaibox.installation-id', 'com.teamaibox.service-role', 'org.teamaibox.casting.role')}
    if not owner:
        raise ValueError('installation_service_owner_required')
    return dict(containerId=c['Id'], imageId=c['Image'], labels=owner)


def imported(node_id, services, previous=None):
    uuid.UUID(node_id)
    if previous:
        if previous['nodeId'] != node_id or set(previous['services']) != set(services):
            raise ValueError('installation_import_identity_conflict')
        for role, c in services.items():
            if previous['services'][role]['containerId'] != c['Id']:
                raise ValueError('installation_import_service_conflict')
        return previous
    if len({c['Id'] for c in services.values()}) != len(services):
        raise ValueError('installation_roles_ambiguous')
    record = dict(version=1, installationId=str(uuid.uuid4()), nodeId=node_id,
                  services={r: service_record(c) for r, c in services.items()}, references={}, networks={})
    api = services.get('platform-api')
    agent = services.get('node-agent')
    if api:
        env = dict(e.split('=', 1) for e in api['Config']['Env'])
        if env.get('PLATFORM_APPLIANCE_NODE_ID') != node_id:
            raise ValueError('installation_node_identity_mismatch')
        for field, key in [('publicAddresses', 'PLATFORM_APPLIANCE_ADDRESSES_FILE'), ('applicationRoutes', 'PLATFORM_APPLICATION_ROUTES_FILE')]:
            if env.get(key): record['references'][field] = host_path(api, env[key])
    if agent:
        env = dict(e.split('=', 1) for e in agent['Config']['Env'])
        for field, key in [('phones', 'TEAMAIBOX_PHONES_CONFIG_FILE')]:
            if env.get(key): record['references'][field] = host_path(agent, env[key])
    # Capture references only. No keys, tokens, passwords, or complete env.
    return validate(record)


def save(path, record):
    validate(record)
    Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    atomic_write(path, (json.dumps(record, indent=2) + '\n').encode(), 0o600)


def inventory(excluded=()):
    ids = execute(['docker', 'ps', '-aq', '--no-trunc']).split()
    rows = json.loads(execute(['docker', 'inspect', *ids])) if ids else []
    selected = []
    for c in rows:
        if c['Id'] in excluded: continue
        labels = c['Config'].get('Labels') or {}
        kind = labels.get('com.teamaibox.kind', '')
        if not c['State']['Running'] and kind not in ('android-phone', 'virtual-computer', 'windows-computer'): continue
        selected.append(dict(id=c['Id'], imageId=c['Image'], running=c['State']['Running'], startedAt=c['State']['StartedAt'],
                             labels={k: v for k, v in labels.items() if k.startswith('com.teamaibox.')},
                             mounts=sorted([{k: m.get(k) for k in ('Type', 'Source', 'Destination', 'RW')} for m in c['Mounts']],key=lambda m:m['Destination'])))
    return sorted(selected, key=lambda c: c['id'])
