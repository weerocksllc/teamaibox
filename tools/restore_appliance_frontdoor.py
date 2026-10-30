#!/usr/bin/env python3
"""Start the configured existing front-door containers in dependency order.

No images, volumes, guests or databases are created, replaced or removed.
Only explicitly retired web containers are stopped. Configuration is maintained
by the deployment; healthy current containers are never restarted.
"""
import argparse
import json
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


def recover(config, docker, timeout=120):
    if config.get('installationFile'):
        from appliance_installation import load, resolve
        installation = load(config['installationFile'])
        def current(row):
            if set(row) == {'role'}:
                c = resolve(installation, row['role'])
                return {'name': c['Name'].lstrip('/'), 'id': c['Id']}
            return row
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
        if not docker.inspect(row)['State']['Running']:
            docker.run('start', row['id'])
            started.append(row['name'])
        deadline = docker.monotonic() + timeout
        while True:
            state = docker.inspect(row)['State']
            if not state['Running']:
                raise RuntimeError('frontdoor_container_stopped:' + row['name'])
            if state.get('Health', {}).get('Status', 'healthy') == 'healthy':
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
