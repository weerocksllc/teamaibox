"""Pure argument tests; never contacts Docker, SSH or an appliance."""
import argparse
import unittest

from tools.maintenance_build_inputs import container_id, image_id, staging_directory, staging_root


class MaintenanceBuildInputsTests(unittest.TestCase):
    def test_staging_is_explicit_dedicated_and_child_scoped(self):
        root = '/var/tmp/synthetic-maintenance-builds'
        self.assertEqual(staging_root(root), root)
        self.assertEqual(staging_directory(root, 'synthetic-run-a1'), root + '/synthetic-run-a1')

    def test_ambiguous_or_injectable_staging_paths_fail_closed(self):
        for root in ('/', '/tmp', 'relative', '/srv/builds/', '/srv/../builds', '/srv//builds', '/srv/builds,readonly', '/srv/builds\nother'):
            with self.subTest(root=root), self.assertRaises(argparse.ArgumentTypeError):
                staging_root(root)
        for name in ('../other', '/other', 'with space', 'x,y', ''):
            with self.subTest(name=name), self.assertRaises(ValueError):
                staging_directory('/srv/synthetic-builds', name)

    def test_only_explicit_content_and_container_ids_are_accepted(self):
        self.assertEqual(container_id('1' * 64), '1' * 64)
        self.assertEqual(image_id('sha256:' + '2' * 64), 'sha256:' + '2' * 64)
        for value in ('latest', 'container-name', '1' * 12, '', '--option'):
            with self.subTest(value=value):
                with self.assertRaises(argparse.ArgumentTypeError):
                    container_id(value)
                with self.assertRaises(argparse.ArgumentTypeError):
                    image_id(value)


if __name__ == '__main__':
    unittest.main()
