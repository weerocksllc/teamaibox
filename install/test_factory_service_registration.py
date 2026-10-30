"""Synthetic registration regression for the API network-namespace cohort."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import factory_bootstrap
import appliance_installation


class NamespaceRegistrationTests(unittest.TestCase):
    def test_factory_records_desktop_dependents_for_safe_api_upgrades(self):
        installation = '00000000-0000-4000-8000-000000000001'
        roles = ('platform-api', 'node-agent', 'appliance-gateway',
                 'desktop-proxy', 'desktop-gateway', 'maintenance-controller')
        record = dict(version=1, installationId=installation,
                      nodeId='00000000-0000-4000-8000-000000000002',
                      services={}, references={}, networks={})
        containers = {role: dict(Id=f'{index:064x}', Image='sha256:' + 'a' * 64,
            State=dict(Running=True, Health=dict(Status='healthy')),
            Config=dict(Labels={'com.teamaibox.installation-id': installation,
                                'com.teamaibox.service-role': role}))
            for index, role in enumerate(roles, 1)}
        by_id = {value['Id']: value for value in containers.values()}
        recipe = dict(services=dict(core=dict(names=list(roles),
                      roles={role: role for role in roles}, timeoutSeconds=120)))
        saved = []

        def run(args, **kwargs):
            if args[:3] == ['docker', 'compose', 'ps']:
                return containers[args[-1]]['Id'] + '\n'
            if args[:2] == ['docker', 'inspect']:
                return json.dumps([by_id[args[-1]]])
            return ''

        def save(path, value):
            appliance_installation.validate(value)
            saved.append(copy.deepcopy(value))

        with patch.object(factory_bootstrap, 'factory', return_value=(None, recipe)), \
             patch.object(factory_bootstrap, 'compose', return_value=['docker', 'compose']), \
             patch.object(factory_bootstrap, 'read_json', return_value=record), \
             patch.object(factory_bootstrap, 'run', side_effect=run), \
             patch.object(appliance_installation, 'save', side_effect=save):
            factory_bootstrap.services(Path('/synthetic-installation'), 'core')
        self.assertEqual(len(saved), 2)
        self.assertEqual(set(saved[-1]['services']), set(roles))
        for role in roles:
            self.assertEqual(saved[-1]['services'][role]['containerId'], containers[role]['Id'])


if __name__ == '__main__':
    unittest.main()
