import unittest

from factory_database import database_mount_owned


class FactoryDatabaseTests(unittest.TestCase):
    def test_named_bind_volume_resolves_to_registered_encrypted_directory(self):
        expected = '/srv/installation/data/database/postgres'
        mount = dict(Type='volume', Name='owned-postgres', Source='/var/lib/docker/volumes/owned-postgres/_data',
                     Destination='/var/lib/postgresql')
        def inspect(name):
            self.assertEqual(name, 'owned-postgres')
            return dict(Driver='local', Options=dict(type='none', o='bind', device=expected))
        self.assertTrue(database_mount_owned([mount], expected, inspect))
        self.assertFalse(database_mount_owned([mount], expected,
            lambda _: dict(Driver='local', Options=dict(type='none', o='bind', device='/foreign'))))
        self.assertFalse(database_mount_owned([mount], expected, lambda _: dict(Driver='local', Options={})))

    def test_direct_bind_must_match_data_target_and_source(self):
        mount = dict(Type='bind', Source='/owned', Destination='/var/lib/postgresql/data')
        self.assertTrue(database_mount_owned([mount], '/owned', None))
        self.assertFalse(database_mount_owned([mount], '/foreign', None))
        mount['Destination'] = '/unrelated'
        self.assertFalse(database_mount_owned([mount], '/owned', None))
