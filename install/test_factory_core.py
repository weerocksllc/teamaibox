import json
from pathlib import Path
import re
import unittest
import uuid

from factory_bootstrap import expand
from factory_core import core_templates, merge, substitute, validate_compose
from offline_common import InstallError

REPO = Path(__file__).resolve().parents[1]


class CoreFactoryTests(unittest.TestCase):
    def setUp(self):
        self.compose, self.secrets, self.directories = core_templates(REPO)

    def render(self, installation):
        raw = json.dumps(self.compose)
        tokens = set(re.findall(r'@@([A-Za-z0-9_.-]+)@@', raw))
        values = {v: 'sha256:' + 'a' * 64 for v in tokens if v.startswith('IMAGE.')}
        values.update(ROOT='/srv/teamaibox/' + installation, DATA='/srv/teamaibox/' + installation + '/data',
                      RUNTIME='/srv/teamaibox/' + installation + '/runtime', INSTALLATION_ID=installation,
                      NODE_ID=str(uuid.uuid5(uuid.UUID(installation), 'node')), RELEASE_ID='candidate-test',
                      DOCKER_GID=987, KVM_GID=988, CONFIGURATION_DIGEST='sha256:' + 'b' * 64)
        values.update({v: '{}' for v in tokens if v.startswith('GUEST_JSON.')})
        values.update({v: v.split('.', 1)[1] for v in tokens if v.startswith('NETWORK_NAME.')})
        values.update({v: 'true' for v in tokens if v.startswith('CAMERA.')})
        return expand(self.compose, values)

    def test_full_core_render_has_no_developer_state_or_downloads(self):
        result = self.render(str(uuid.uuid4()))
        validate_compose(result, ['sha256:' + 'a' * 64])
        self.assertEqual(len(result['services']), 24)
        self.assertNotIn('PLATFORM_API_BOOTSTRAP_FILE', result['services']['platform-api']['environment'])
        expected_schema = str(json.loads((REPO / 'packages/persistence/migrations/manifest.json').read_text())['migrations'][-1]['version'])
        self.assertTrue(all(service['environment']['TEAMAIBOX_REQUIRED_SCHEMA_VERSION'] == expected_schema
                            for service in result['services'].values()
                            if 'TEAMAIBOX_REQUIRED_SCHEMA_VERSION' in service.get('environment', {})))
        self.assertTrue(all(v['pull_policy'] == 'never' for v in result['services'].values()))
        self.assertEqual({n: v['labels']['com.teamaibox.service-role'] for n, v in result['services'].items()},
                         {n: n for n in result['services']})

    def test_two_installations_do_not_share_identity_or_data(self):
        first, second = [self.render(str(uuid.uuid4())) for _ in range(2)]
        key = 'PLATFORM_APPLIANCE_NODE_ID'
        self.assertNotEqual(first['services']['platform-api']['environment'][key], second['services']['platform-api']['environment'][key])
        self.assertNotEqual(first['volumes']['postgres_data'], second['volumes']['postgres_data'])
        self.assertTrue(all(row.get('driver_opts', {}).get('o') == 'bind' for row in first['volumes'].values()))

    def test_missing_variable_is_not_silently_emptied(self):
        with self.assertRaisesRegex(ValueError, 'not bound'):
            substitute('${REQUIRED_VALUE:?set it}', {})
        self.assertEqual(substitute('${OPTIONAL_VALUE:-default}', {}), 'default')

    def test_config_mounts_merge_by_target_not_position(self):
        result = merge({'configs': [{'source': 'old', 'target': '/config'}]},
                       {'configs': [{'source': 'new', 'target': '/config'}]})
        self.assertEqual(result['configs'], [{'source': 'new', 'target': '/config'}])

    def test_credentials_match_existing_service_encodings(self):
        by_name = {v['name']: v for v in self.secrets}
        self.assertEqual(by_name['node-agent-command-key']['format'], 'base64')
        self.assertEqual(by_name['appliance-gateway-signing-key']['format'], 'base64url')
        self.assertEqual(by_name['desktop-json-key']['bytes'], 16)
        self.assertEqual(by_name['owner-setup-token']['format'], 'base64url')
        self.assertTrue(all(v['mode'] == '0440' for v in self.secrets))

    def test_refuse_online_images_fixed_accounts_and_unresolved_paths(self):
        for mutation in ('tag', 'account', 'unresolved'):
            value = self.render(str(uuid.uuid4()))
            if mutation == 'tag':
                value['services']['web']['image'] = 'web:latest'
            elif mutation == 'account':
                value['services']['platform-api']['environment']['PLATFORM_API_BOOTSTRAP_FILE'] = '/owner.json'
            else:
                value['services']['web']['environment']['WEB_TLS_CERT_FILE'] = '@@MISSING@@'
            with self.subTest(mutation=mutation), self.assertRaises(InstallError):
                validate_compose(value, ['sha256:' + 'a' * 64])


if __name__ == '__main__':
    unittest.main()
