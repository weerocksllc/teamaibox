#!/usr/bin/env python3
"""Render an isolated factory-core fixture for the real Compose parser.

This does not create containers, networks, accounts or guest instances. The
generated file is a validation fixture, NOT a complete installation recipe.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import uuid

from factory_bootstrap import expand
from factory_core import core_templates, validate_compose
from offline_common import need, write_json


def prepare(repository, output, full=False):
    need(not output.exists(), 'use a new verification directory')
    compose, secrets, directories = core_templates(repository)
    if full:
        from factory_recipe import assemble
        recipe = assemble(repository)
        compose = next(r['value'] for r in recipe['templates'] if r['output'] == recipe['composeFile'])
        secrets, directories = recipe['secrets'], recipe['directories']
    identity = str(uuid.uuid4())
    tokens = set(re.findall(r'@@([A-Za-z0-9_.-]+)@@', json.dumps(compose)))
    values = {token: 'sha256:' + hashlib.sha256(token.encode()).hexdigest()
              for token in tokens if token.startswith('IMAGE.')}
    values.update(ROOT='/srv/teamaibox/factory-validation-' + identity,
                  DATA='/srv/teamaibox/factory-validation-' + identity + '/data',
                  RUNTIME='/srv/teamaibox/factory-validation-' + identity + '/runtime',
                  INSTALLATION_ID=identity, NODE_ID=str(uuid.uuid4()), RELEASE_ID='factory-validation-only',
                  DOCKER_GID=987, CONFIGURATION_DIGEST='sha256:' + hashlib.sha256(identity.encode()).hexdigest())
    values.update({token: '{}' for token in tokens if token.startswith('GUEST_JSON.')})
    values.update({token: token.split('.', 1)[1] for token in tokens if token.startswith('NETWORK_NAME.')})
    values.update({token: 'true' for token in tokens if token.startswith('CAMERA.')})
    if full:
        values.update({token: 'fixture-only' for token in tokens if token not in values})
        values.update({'CASTING.platformAddress': '172.31.70.10', 'CASTING.root': '/run/teamaibox/casting/fixture',
                       'OFFICE_SET_ID': 'factory-office-' + identity})
    rendered = expand(compose, values)
    validate_compose(rendered, [value for key, value in values.items() if key.startswith('IMAGE.')])
    output.mkdir(parents=True)
    write_json(output / 'core.json', rendered, 0o644)
    write_json(output / 'verification.json', dict(status='rendered', completeInstaller=False,
        services=len(rendered['services']), independentSecrets=len(secrets), dataDirectories=len(directories),
        sourceFiles=['deploy/compose/core.yaml', 'deploy/appliance/compose.yaml', 'deploy/appliance/applications.compose.yaml'],
        productionStateRead=False, containersCreated=0), 0o644)
    return output / 'core.json'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--full', action='store_true', help='Parse all factory services, not just the foundation')
    args = parser.parse_args()
    print(prepare(args.repository.resolve(), args.output.resolve(), args.full))
