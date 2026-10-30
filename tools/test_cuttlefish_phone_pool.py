import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('phone_file_pool', ROOT/'deploy/android/cuttlefish/phone_file_pool.py')
pool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pool)
PLAN = dict(
    schemaVersion=2, poolId='11111111-1111-4111-8111-111111111111',
    capacityBytes=96*1024**3, phoneQuotaBytes=24*1024**3,
    authorization=dict(filePoolCreationApproved=True, physicalDiskEraseApproved=False,
                       repartitionApproved=False, nodeRebootApproved=False),
    appliance=dict(hostname='local-appliance',
                   rootFilesystemUUID='22222222-2222-4222-8222-222222222222'),
    keyStore=dict(encryptedRoot='/srv/appliance-data',
                  filesystemUUID='33333333-3333-4333-8333-333333333333',
                  mapper='appliance-data'),
)


class PhoneFilePoolTests(unittest.TestCase):
    def test_authorized_paths_are_regular_file_not_block_device(self):
        base, data, mount, mapper = pool.paths(PLAN)
        self.assertEqual(str(data), '/var/lib/teamaibox/phone-pools/'+PLAN['poolId']+'/pool.luks2')
        self.assertEqual(base, data.parent)
        self.assertTrue(str(mount).startswith('/srv/teamaibox/phone-pools/'))
        self.assertEqual(mapper, 'teamaibox-phone-'+PLAN['poolId'])
        self.assertEqual(PLAN['authorization'], dict(filePoolCreationApproved=True, physicalDiskEraseApproved=False,
                                                   repartitionApproved=False, nodeRebootApproved=False))

    def test_existing_pool_refuses_before_any_format(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            with (patch.object(pool, 'host_check'), patch.object(pool, 'paths', return_value=(base, base/'pool.luks2', base/'mount', 'none')),
                  patch.object(pool, 'command') as command):
                with self.assertRaisesRegex(pool.PoolError, 'pool_already_exists'):
                    pool.prepare(PLAN)
                command.assert_not_called()

    def test_symlink_at_any_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            (base/'real').mkdir()
            (base/'alias').symlink_to(base/'real')
            with self.assertRaisesRegex(pool.PoolError, 'path_symlink_rejected'):
                pool.no_links(base/'alias'/'new')

    def test_key_store_refuses_unmounted_local_volume_before_create(self):
        with (patch.object(pool, 'host_check'), patch.object(pool, 'no_links'), patch.object(pool, 'command', return_value=''),
              patch.object(pool, 'private_dir') as mkdir):
            with self.assertRaisesRegex(pool.PoolError, 'local_encrypted_key_store_unavailable'):
                pool.key_store_root(PLAN)
            mkdir.assert_not_called()

    def test_root_identity_change_refuses(self):
        with patch.object(pool.socket, 'gethostname', return_value='local-appliance'), patch.object(pool, 'command', return_value='other'):
            with self.assertRaisesRegex(pool.PoolError, 'root_filesystem_identity_changed'):
                pool.host_check(PLAN)

    def test_local_plan_is_valid_and_old_remote_plan_is_rejected(self):
        self.assertEqual(pool.validate_plan(PLAN), PLAN)
        for field in ('node', 'custody', 'sshTarget', 'primaryHost'):
            with self.assertRaisesRegex(pool.PoolError, 'local_plan_required'):
                pool.validate_plan({**PLAN, field: 'foreign-target'})

    def test_close_does_not_touch_nonempty_pool(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            (base/'volumes').mkdir()
            (base/'volumes'/'owned').mkdir()
            with (patch.object(pool, 'paths', return_value=(base, base/'pool.luks2', base, 'none')),
                  patch.object(pool, 'inspect_pool', return_value={}), patch.object(pool, 'command') as command):
                with self.assertRaisesRegex(pool.PoolError, 'pool_in_use'):
                    pool.close_empty(PLAN)
                command.assert_not_called()

    def test_crypto_uses_only_approved_file_and_ephemeral_fd(self):
        for verb in ('format', 'open'):
            with patch.object(pool.os, 'lseek'), patch.object(pool, 'command') as command:
                pool.crypt(PLAN, verb, 77)
                argv = command.call_args.args[0]
                self.assertIn(str(pool.paths(PLAN)[1]), argv)
                self.assertIn('/proc/self/fd/77', argv)
                self.assertFalse(any(x.startswith(('/dev/sd', '/dev/nvme')) for x in argv))
                self.assertEqual(command.call_args.kwargs['pass_fds'], (77,))

    def test_declarations_cannot_overwrite_failure_or_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve()/'identity.json'
            pool.exclusive_json(path, {'first': True})
            with self.assertRaises(FileExistsError):
                pool.exclusive_json(path, {'second': True})
            self.assertEqual(json.loads(path.read_text()), {'first': True})


if __name__ == '__main__':
    unittest.main()
