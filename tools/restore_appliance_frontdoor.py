#!/usr/bin/env python3
"""Start the configured existing front-door containers in dependency order.

No images, volumes, guests or databases are created, replaced or removed.
Only explicitly retired web containers are stopped. Configuration is maintained
by the deployment; healthy current containers are never restarted.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time


def validate(config):
    if set(config) != {'retired', 'ordered'} or not config['ordered']:
        raise ValueError('invalid_frontdoor_configuration')
    entries = config['retired'] + config['ordered']
    for row in entries:
        if set(row) != {'name', 'id'} or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]+', row['name']) \
                or not re.fullmatch(r'[a-f0-9]{64}', row['id']):
            raise ValueError('invalid_frontdoor_identity')
    if len({r['id'] for r in entries}) != len(entries) or len({r['name'] for r in entries}) != len(entries):
        raise ValueError('duplicate_frontdoor_identity')


class Docker:
    monotonic = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)

    def run(self, *args):
        return subprocess.check_output(['docker', *args], text=True, timeout=45)

    def inspect(self, row):
        value = json.loads(self.run('inspect', row['id']))[0]
        if value['Name'].lstrip('/') != row['name'] or value['Id'] != row['id']:
            raise RuntimeError('frontdoor_container_changed:' + row['name'])
        return value


def factory_order(services):
    order, visiting, completed = [], set(), set()
    def visit(name):
        if name == 'database-migrate' or name in completed:
            return
        if name not in services or name in visiting:
            raise ValueError('invalid_factory_service_dependency:' + name)
        visiting.add(name)
        spec = services[name]
        dependencies = set(spec.get('depends_on', ()))
        namespace = spec.get('network_mode', '')
        if namespace.startswith('service:'):
            dependencies.add(namespace.split(':', 1)[1])
        for dependency in sorted(dependencies):
            visit(dependency)
        visiting.remove(name)
        completed.add(name)
        order.append(name)
    for name in sorted(services):
        visit(name)
    return order


def factory_config(config, installation, docker, root):
    path = Path(config['factoryCompose'])
    if config['ordered'] or config['retired'] or path != root / 'config/core.json' or str(path) != installation['references']['composeFile']:
        raise ValueError('factory_compose_recovery_config_mismatch')
    stat = path.lstat()
    if path.resolve() != path or not path.is_file() or stat.st_uid != 0 or stat.st_mode & 0o022:
        raise ValueError('unsafe_factory_compose_recovery_config')
    if not os.path.ismount(root / 'data'):
        raise RuntimeError('factory_encrypted_storage_not_mounted')
    services = json.loads(path.read_text())['services']
    identity = installation['installationId']
    project = 'teamaibox-' + identity[:12]
    rows = []
    from appliance_installation import resolve
    for name in factory_order(services):
        service = services[name]
        role = service['labels']['com.teamaibox.service-role']
        owner = {'com.teamaibox.installation-id': identity, 'com.teamaibox.service-role': role}
        # Some factory services declare the legacy managed label, others only
        # carry the installation and service-role labels. Match the recipe,
        # then pin unregistered roles by Compose project, service and image.
        managed = service['labels'].get('com.teamaibox.managed')
        if managed is not None:
            owner['com.teamaibox.managed'] = managed
        if role in installation['services']:
            current = resolve(installation, role)
        else:
            owner.update({'com.docker.compose.project': project, 'com.docker.compose.service': name})
            args = [value for k, v in owner.items() for value in ('--filter', 'label=' + k + '=' + v)]
            ids = docker.run('ps', '-aq', '--no-trunc', *args).split()
            if len(ids) != 1 or not re.fullmatch(r'[a-f0-9]{64}', ids[0]):
                raise ValueError('factory_service_identity_ambiguous:' + role)
            documents = json.loads(docker.run('inspect', ids[0]))
            if len(documents) != 1 or documents[0]['Id'] != ids[0] or documents[0]['Image'] != service['image']:
                raise ValueError('factory_service_image_or_identity_changed:' + role)
            current = documents[0]
        labels = current['Config'].get('Labels') or {}
        if any(labels.get(k) != v for k, v in owner.items()):
            raise ValueError('factory_service_owner_changed:' + role)
        rows.append({'name': current['Name'].lstrip('/'), 'id': current['Id']})
    return {'ordered': rows, 'retired': []}


def recover(config, docker, timeout=120):
    if config.get('installationFile'):
        from appliance_installation import load, resolve
        installation = load(config['installationFile'])
        def current(row):
            if set(row) == {'role'}:
                c = resolve(installation, row['role'])
                return {'name': c['Name'].lstrip('/'), 'id': c['Id']}
            return row
        if 'factoryCompose' in config:
            config = factory_config(config, installation, docker, Path(config['installationFile']).parent)
        else:
            config = {'retired': config['retired'], 'ordered': [current(row) for row in config['ordered']]}
    validate(config)
    # Validate every identity before making any change.
    for row in config['retired'] + config['ordered']:
        docker.inspect(row)
    for row in config['retired']:
        value = docker.inspect(row)
        if value['HostConfig']['RestartPolicy']['Name'] != 'no':
            docker.run('update', '--restart=no', row['id'])
        if value['State']['Running']:
            docker.run('stop', '--timeout', '15', row['id'])
    started = []
    for row in config['ordered']:
        state = docker.inspect(row)['State']
        if not state['Running'] and not state.get('Restarting'):
            docker.run('start', row['id'])
            started.append(row['name'])
        deadline = docker.monotonic() + timeout
        while True:
            state = docker.inspect(row)['State']
            if not state['Running'] and not state.get('Restarting'):
                raise RuntimeError('frontdoor_container_stopped:' + row['name'])
            if state['Running'] and not state.get('Restarting') and state.get('Health', {}).get('Status', 'healthy') == 'healthy':
                break
            if docker.monotonic() >= deadline:
                raise RuntimeError('frontdoor_readiness_timeout:' + row['name'])
            docker.sleep(2)
    return {'status': 'ready', 'started': started, 'retired': [r['name'] for r in config['retired']]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configuration', required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.configuration.read_text())
    print(json.dumps(recover(config, Docker())))


if __name__ == '__main__':
    main()
