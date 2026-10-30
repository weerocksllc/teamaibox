"""Build clean core/guest factory templates from the maintained Compose files.

This module is used on the packaging machine (PyYAML is build-time only).
The resulting JSON is rendered by the standard-library-only target installer.
It does not read .env files, Docker inspect environments or a live database.
"""
from copy import deepcopy
import json
from pathlib import Path
import re

from offline_common import need


SOURCES = ('deploy/compose/core.yaml', 'deploy/appliance/compose.yaml',
           'deploy/appliance/applications.compose.yaml')
SUBSTITUTION = re.compile(r'\$\{([A-Z][A-Z0-9_]*)(?:(:-|:\?)([^}]*))?\}')


def merge(base, addition, key=''):
    """Compose fragments used here: maps merge, mounts keyed by container path.

    A generic concatenation would silently keep the old plugin route mount and
    duplicate environment secrets. Unsupported list conflicts are rejected.
    """
    if isinstance(base, dict) and isinstance(addition, dict):
        result = deepcopy(base)
        for name, value in addition.items():
            result[name] = merge(result[name], value, name) if name in result else deepcopy(value)
        return result
    if isinstance(base, list) and isinstance(addition, list):
        if key in ('command', 'entrypoint', 'test', 'ports', 'networks'):
            return deepcopy(addition)
        if key in ('volumes', 'configs', 'secrets'):
            def identity(item):
                if isinstance(item, dict):
                    return item.get('target', item.get('source'))
                return item.split(':')[1] if key == 'volumes' and ':' in item else item
            result = {identity(v): deepcopy(v) for v in base}
            result.update({identity(v): deepcopy(v) for v in addition})
            return list(result.values())
        need(base == addition, 'unsupported Compose list merge: ' + key)
    return deepcopy(addition)


def substitute(value, environment):
    if isinstance(value, dict):
        return {k: substitute(v, environment) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, environment) for v in value]
    if not isinstance(value, str):
        return value
    def replacement(match):
        key, operator, default = match.groups()
        if key in environment:
            return str(environment[key])
        if operator == ':-':
            return default
        raise ValueError('factory Compose variable is not bound: ' + key)
    return SUBSTITUTION.sub(replacement, value)


def core_templates(repository):
    import yaml
    migrations = json.loads((repository / 'packages/persistence/migrations/manifest.json').read_text())['migrations']
    versions = [row['version'] for row in migrations]
    need(versions == list(range(1, len(versions) + 1)), 'factory migration catalog must be contiguous')
    schema_version = str(versions[-1])
    combined = {}
    for name in SOURCES:
        document = yaml.safe_load((repository / name).read_text())
        combined = merge(combined, {k: v for k, v in document.items() if not k.startswith('x-')})
    combined.pop('name', None)
    # YAML anchors intentionally share mappings; binding a role/secret to one
    # service must not mutate every other service using the same anchor.
    combined['services'] = {name: deepcopy(value) for name, value in combined['services'].items()}
    services = combined['services']
    # Setup authority is generated per installation, never an account/password.
    api = services['platform-api']
    api['environment'].pop('PLATFORM_API_BOOTSTRAP_FILE')
    api['environment']['PLATFORM_API_SETUP_TOKEN_FILE'] = '/run/secrets/owner_setup_token'
    api['secrets'].remove('appliance_owner_bootstrap')
    api['secrets'].append('owner_setup_token')
    combined['secrets'].pop('appliance_owner_bootstrap')
    combined['secrets']['owner_setup_token'] = {'file': '@@ROOT@@/secrets/owner-setup-token'}
    combined['secrets'].pop('web_tls_certificate', None)
    combined['secrets'].pop('web_tls_private_key', None)
    # Consume templates directly, not an operator-supplied .env full of old IDs.
    api.pop('env_file', None)
    api['environment'].update({
        'PLATFORM_API_PUBLIC_ORIGIN': 'https://teamaibox.local',
        'PLATFORM_AI_BOOT_STATUS_FILE': '/run/config/appliance/ai-startup.json',
        'PLATFORM_VIRTUAL_PHONES_ENABLED': 'true',
        'PLATFORM_VIRTUAL_PHONE_NODES_JSON': '@@GUEST_JSON.approvedPhones@@',
        'PLATFORM_VIRTUAL_PHONE_SYSTEM_RELEASES_JSON': '@@GUEST_JSON.phoneSystems@@',
        'PLATFORM_VIRTUAL_PHONE_CAMERA_ENABLED': 'true',
        'PLATFORM_VIRTUAL_PHONE_USB_CAMERA_ENABLED': '@@CAMERA.usb@@',
        'PLATFORM_VIRTUAL_PHONE_UDP_CAMERA_ENABLED': '@@CAMERA.udp@@',
        'PLATFORM_VIRTUAL_COMPUTERS_CONFIG_JSON': '@@GUEST_JSON.computerApi@@',
    })
    api['secrets'].append('desktop_json_key')
    combined['secrets']['desktop_json_key'] = {'file': '@@ROOT@@/secrets/desktop-json-key'}
    # All secret mounts have a dedicated group; no credential is world-readable.
    for service in services.values():
        groups = service.setdefault('group_add', [])
        if '10001' not in groups:
            groups.append('10001')
    combined['configs'] = {
        'nats_config': {'file': '@@RUNTIME@@/deploy/compose/nats.conf'},
        'empty_plugin_routes': {'file': '@@ROOT@@/public/plugin-routes.json'},
        'built_in_applications': {'file': '@@ROOT@@/config/built-in-applications.json'},
        'agent_model_aliases': {'file': '@@RUNTIME@@/deploy/compose/agent-model-aliases.v1.json'},
    }
    for name in ('platform-api', 'compute-gateway'):
        services[name].setdefault('configs', []).append({
            'source': 'agent_model_aliases', 'target': '/run/config/agent-model-aliases.json'})
    values = {
        'TEAMAIBOX_WEB_PUBLIC_ORIGIN': 'https://teamaibox.local',
        'TEAMAIBOX_RELEASE_ID': '@@RELEASE_ID@@',
        'TEAMAIBOX_WEB_TLS_DIRECTORY': '@@ROOT@@/https',
        'PLATFORM_APPLIANCE_NODE_ID': '@@NODE_ID@@',
        'TEAMAIBOX_APPLIANCE_PUBLIC_CONFIG_DIR': '@@ROOT@@/public',
        'TEAMAIBOX_GUEST_CONFIG_DIR': '@@ROOT@@/config/guests',
        'TEAMAIBOX_GUEST_DATA_ROOT': '@@DATA@@',
        'TEAMAIBOX_GUEST_CONTROL_ROOT': '@@DATA@@/guests/control',
        'TEAMAIBOX_GUEST_MEDIA_ROOT': '@@DATA@@/guests/media',
        'TEAMAIBOX_GUEST_ASSETS_ROOT': '@@DATA@@/assets',
        'TEAMAIBOX_GUEST_RUNTIME_DIR': '@@ROOT@@/guest-runtime',
        'TEAMAIBOX_COMMAND_KEY_ID': 'factory-command-v1',
        'TEAMAIBOX_DOCKER_SOCKET_GID': '@@DOCKER_GID@@',
        'TEAMAIBOX_APPLIANCE_IMAGE_DIGEST': '@@IMAGE.node-agent@@',
        'TEAMAIBOX_APPLIANCE_CONFIGURATION_DIGEST': '@@CONFIGURATION_DIGEST@@',
        'TEAMAIBOX_DATA_ROOT': '@@DATA@@',
        'TEAMAIBOX_APPLIANCE_SCHEDULER_KEY_FILE': '@@ROOT@@/secrets/scheduler.key',
        'TEAMAIBOX_APPLIANCE_GATEWAY_TLS_KEY_FILE': '@@ROOT@@/secrets/gateway.key',
    }
    for name, service in services.items():
        role = 'postgres' if name == 'database-migrate' else name
        service['image'] = '@@IMAGE.' + role + '@@'
        service['pull_policy'] = 'never'
        service.setdefault('labels', {}).update({
            'com.teamaibox.installation-id': '@@INSTALLATION_ID@@',
            'com.teamaibox.service-role': name,
            'com.teamaibox.managed': 'true',
            'com.teamaibox.core-service-key': name,
        })
        if 'TEAMAIBOX_REQUIRED_SCHEMA_VERSION' in service.get('environment', {}):
            service['environment']['TEAMAIBOX_REQUIRED_SCHEMA_VERSION'] = schema_version
    rows = []
    for name, definition in combined['secrets'].items():
        file = definition['file']
        match = SUBSTITUTION.fullmatch(file)
        if name in ('appliance_scheduler_key', 'appliance_gateway_tls_key'):
            continue
        secret_name = name.replace('_', '-')
        if name == 'owner_setup_token':
            secret_name = 'owner-setup-token'
        if name == 'desktop_json_key':
            secret_name = 'desktop-json-key'
        path = 'secrets/' + secret_name
        if match:
            values[match[1]] = '@@ROOT@@/' + path
        else:
            definition['file'] = '@@ROOT@@/' + path
        rows.append(dict(name=secret_name, path=path, format='hex' if name == 'desktop_json_key' else 'base64' if name == 'node_agent_command_key' else 'base64url',
                         bytes=16 if name == 'desktop_json_key' else 32, uid=0, gid=10001, mode='0440'))
    # No implicit named data volume may hide a new plaintext store elsewhere.
    directories = []
    combined['volumes']['object_data']['driver_opts']['device'] = '@@DATA@@/objects'
    for name, volume in combined['volumes'].items():
        need(volume and volume.get('driver_opts', {}).get('o') == 'bind', 'unbound factory data volume: ' + name)
        source = substitute(volume['driver_opts']['device'], values)
        need(source.startswith('@@DATA@@/'), 'factory data volume leaves encrypted storage')
        uid = 999 if name == 'postgres_data' else 65534 if name == 'event_bus_data' else 10001 if name.startswith(('node_', 'object_', 'compute_')) else 1000
        directories.append(dict(path=source.removeprefix('@@DATA@@/'), uid=uid, gid=uid, mode='0750'))
    directories += [dict(path=p, uid=10001, gid=10001, mode='0750')
                    for p in ('guests/control/phones', 'guests/control/computers', 'guests/media', 'assets')]
    combined = substitute(combined, values)
    # The API/Agent must see the guest control network and protected workers.
    for role in ('plugin-ingress', 'compute-internal', 'phone-control'):
        combined['networks'][role] = {'external': True, 'name': '@@NETWORK_NAME.' + role + '@@'}
    services = combined['services']
    services['platform-api']['networks'] = ['edge', 'control', 'data', 'plugin-ingress', 'compute-internal', 'phone-control']
    services['node-agent']['environment']['TEAMAIBOX_NODE_STATE_DIR'] = '/var/lib/teamaibox/node-agent'
    services['node-agent']['devices'] = ['/dev/kvm:/dev/kvm:rw']
    services['node-agent']['group_add'].append('@@KVM_GID@@')
    services['node-agent']['environment'].update(TEAMAIBOX_PHONE_BASELINE_ENABLED='true',
        TEAMAIBOX_HOST_PROC_ROOT='/host/proc',
        TEAMAIBOX_HOST_SYS_ROOT='/host/sys',
        TEAMAIBOX_HOST_STORAGE_ANCHOR='@@DATA@@',
        TEAMAIBOX_NODE_METRICS_ENABLED='true',
        TEAMAIBOX_NODE_GENERATION_FILE='/var/lib/teamaibox/node-agent/generation')
    services['node-agent']['volumes'].append({
        'type': 'bind', 'source': '/sys', 'target': '/host/sys',
        'read_only': True, 'bind': {'create_host_path': False}})
    services['node-agent']['volumes'].append({
        'type': 'bind', 'source': '/proc', 'target': '/host/proc',
        'read_only': True, 'bind': {'create_host_path': False}})
    services['node-agent']['volumes'].append({
        'type': 'bind', 'source': '@@RUNTIME@@/deploy/android/cuttlefish/phone-seccomp.json',
        'target': '@@RUNTIME@@/deploy/android/cuttlefish/phone-seccomp.json',
        'read_only': True, 'bind': {'create_host_path': False}})
    services['node-agent']['volumes'].append({
        'type': 'bind', 'source': '@@ROOT@@/public', 'target': '@@ROOT@@/public',
        'read_only': True, 'bind': {'create_host_path': False}})
    for service in services.values():
        mounts = []
        for mount in service.get('volumes', []):
            if isinstance(mount, str) and mount.startswith(('/', '@@')):
                parts = mount.split(':')
                need(len(parts) in (2, 3), 'invalid factory host mount')
                mount = dict(type='bind', source=parts[0], target=parts[1],
                             read_only=len(parts) == 3 and parts[2] == 'ro')
            if isinstance(mount, dict) and mount.get('type') == 'bind':
                mount.setdefault('bind', {})['create_host_path'] = False
            mounts.append(mount)
        if 'volumes' in service:
            service['volumes'] = mounts
    return combined, rows, directories


def validate_compose(value, release_images):
    """Validate rendered Compose before any `up` or global registration."""
    images = set(release_images)
    names = set(value['services'])
    for name, service in value['services'].items():
        need(service.get('image') in images and service.get('pull_policy') == 'never', 'unbound service image: ' + name)
        need('build' not in service, 'target-side builds are forbidden')
        for dependency in service.get('depends_on', {}):
            need(dependency in names, 'service dependency missing: ' + dependency)
        for mount in service.get('volumes', []):
            if isinstance(mount, dict) and mount.get('type') == 'bind':
                need(mount.get('bind', {}).get('create_host_path') is False,
                     'bind mounts must not silently create missing assets: ' + name)
        need(service.get('labels', {}).get('com.teamaibox.installation-id'), 'service ownership missing')
    raw = json.dumps(value)
    need('@@' not in raw and '${' not in raw, 'unresolved factory configuration')
    need('PLATFORM_API_BOOTSTRAP_FILE' not in raw, 'fixed account bootstrap forbidden')
    need(not re.search(r'192\.168\.10\.(?:10|19|20|23)\b', raw), 'development address in factory configuration')
    need('BACKUP_' not in raw, 'retired backup configuration in factory configuration')
