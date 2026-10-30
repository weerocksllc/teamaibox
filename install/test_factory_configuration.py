import os
from pathlib import Path
import tempfile
import unittest

from factory_bootstrap import check_configuration, configuration_receipt
from factory_identity import secret_file
from offline_common import InstallError, write_json


class ConfigurationTests(unittest.TestCase):
    def fixture(self, root):
        row = dict(name='fixture', path='secrets/key', format='base64url', bytes=32,
                   uid=os.geteuid(), gid=os.getegid(), mode='0600')
        recipe = dict(templates=[dict(output='config/compose.json'),
                                dict(output='public/appliance-addresses.json', runtimeMutable=True)], secrets=[row])
        state = dict(installationId='fixture', nodeId='new-node')
        write_json(root / 'config/compose.json', {'services': {}})
        write_json(root / 'public/appliance-addresses.json', {'addresses': []})
        secret_file(row, root)
        write_json(root / 'configuration-complete.json', dict(installationId=state['installationId'],
                                                            files=configuration_receipt(root, recipe)))
        return recipe, state

    def test_check_keeps_credentials_and_all_files_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recipe, state = self.fixture(root)
            before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.rglob('*') if p.is_file()}
            check_configuration(root, recipe, state, state)
            self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.rglob('*') if p.is_file()})

    def test_new_lan_address_does_not_invalidate_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recipe, state = self.fixture(root)
            write_json(root / 'public/appliance-addresses.json', {'addresses': ['10.2.3.4']})
            check_configuration(root, recipe, state, state)

    def test_missing_key_never_rotates_on_check(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recipe, state = self.fixture(root)
            (root / 'secrets/key').unlink()
            with self.assertRaisesRegex(InstallError, 'secret missing'):
                check_configuration(root, recipe, state, state)
            self.assertFalse((root / 'secrets/key').exists())

    def test_changed_config_is_reported_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recipe, state = self.fixture(root)
            write_json(root / 'config/compose.json', {'changed': True})
            with self.assertRaisesRegex(InstallError, 'differs'):
                check_configuration(root, recipe, state, state)
            self.assertEqual((root / 'config/compose.json').read_text().strip(), '{\n  "changed": true\n}')


if __name__ == '__main__':
    unittest.main()
