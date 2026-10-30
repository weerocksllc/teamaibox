from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from factory_owner import apply
from offline_common import InstallError


class FactoryOwnerTests(unittest.TestCase):
    def test_existing_owner_is_read_only_and_never_needs_default_password(self):
        with tempfile.TemporaryDirectory() as tmp, patch('factory_database.query', return_value='1') as query:
            root = Path(tmp)
            for check in (False, True):
                self.assertEqual(apply(root, check), dict(status='preserved', usersCreated=0))
            self.assertEqual(list(root.iterdir()), [])
            self.assertEqual(query.call_count, 2)

    def test_check_never_creates_an_owner_or_recovery_file(self):
        with tempfile.TemporaryDirectory() as tmp, patch('factory_database.query', return_value='0'):
            with self.assertRaisesRegex(InstallError, 'not been initialized'):
                apply(Path(tmp), True)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_inconsistent_existing_identities_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp, patch('factory_database.query', side_effect=['0', '1']):
            with self.assertRaisesRegex(InstallError, 'existing identities'):
                apply(Path(tmp))
            self.assertEqual(list(Path(tmp).iterdir()), [])
