import json
from pathlib import Path
import re
import unittest
import uuid

from factory_applications import statements
from factory_bootstrap import expand
from factory_recipe import assemble
from offline_common import InstallError


class ApplicationsTests(unittest.TestCase):
    def setUp(self):
        recipe = assemble(Path(__file__).resolve().parents[1])
        self.compose = next(r['value'] for r in recipe['templates'] if r['output'] == 'config/core.json')
        value = next(r['value'] for r in recipe['templates'] if r['output'] == 'config/application-catalog.json')
        self.rows = expand(value, {k: 'sha256:' + 'a'*64 for k in re.findall(r'@@([^@]+)@@', json.dumps(value))})['applications']

    def test_all_shipped_apps_have_resolved_unsigned_package_manifests(self):
        self.assertEqual(len(self.rows), 9)
        for row in self.rows:
            self.assertEqual(row['manifest']['id'], 'official.' + row['role'].removesuffix('-plugin'))
            self.assertNotIn('signature', row['manifest'])
        self.assertNotIn('__RELEASE_PIPELINE', json.dumps(self.rows))

    def test_catalog_registration_is_insert_only_with_conflict_assertions(self):
        identity = str(uuid.uuid4())
        sql = statements(identity, self.rows)
        self.assertEqual(sql, statements(identity, self.rows))
        self.assertNotEqual(sql, statements(str(uuid.uuid4()), self.rows))
        self.assertNotIn('DO UPDATE', sql)
        self.assertNotIn('DELETE', sql)
        self.assertIn("AND lifecycle_state='discovered' AND current_version_id IS NULL", sql)
        self.assertNotIn('INSERT', statements(identity, self.rows, True))
        with self.assertRaises(InstallError):
            statements(identity, self.rows[:-1])

    def test_core_observations_have_explicit_keys_without_developer_project(self):
        agent = self.compose['services']['node-agent']
        self.assertEqual(agent['environment']['TEAMAIBOX_NODE_METRICS_ENABLED'], 'true')
        self.assertEqual(agent['devices'], ['/dev/kvm:/dev/kvm:rw'])
        self.assertIn('@@KVM_GID@@', agent['group_add'])
        self.assertEqual(agent['environment']['TEAMAIBOX_HOST_STORAGE_ANCHOR'], '@@DATA@@')
        self.assertTrue(any(m.get('source') == '/sys' and m.get('target') == '/host/sys'
            and m.get('read_only') for m in agent['volumes'] if isinstance(m, dict)))
        for name, service in self.compose['services'].items():
            if name in ('platform-api', 'scheduler', 'object-service', 'messaging', 'event-bus'):
                self.assertEqual(service['labels']['com.teamaibox.core-service-key'], name)
                self.assertEqual(service['labels']['com.teamaibox.managed'], 'true')


if __name__ == '__main__':
    unittest.main()
