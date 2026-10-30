import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tpm_migration', Path(__file__).resolve().parents[1]/'deploy/windows-arm64-crb/migrate_guest.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def test_same_interface_is_rejected(self):
        with self.assertRaises(ValueError):
            migration.migrate(Path('/not-used'), 'test', 'crb', 'crb')

    def test_reverse_migration_keeps_guest_and_tpm_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            guest = root/'guest'
            (guest/'tpm').mkdir(parents=True)
            identity = {'schemaVersion': 1, 'diskGiB': 96, 'diskBus': 'nvme', 'firmware': 'ms', 'tpm': 'crb'}
            (guest/'identity.json').write_text(json.dumps(identity))
            for name in ('system.qcow2', 'VARS.fd', 'tpm/state'):
                (guest/name).write_bytes(('original-'+name).encode())
            def copy(args, **kwargs):
                migration.shutil.copy2(args[-2], args[-1])
            with patch.object(Path, 'is_mount', return_value=True), patch.object(migration.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)), patch.object(migration.subprocess, 'run', side_effect=copy), patch.object(migration.os, 'sync', create=True):
                result = migration.migrate(root, 'reverse', 'crb', 'tis')
            self.assertEqual(result['newIdentity']['tpm'], 'tis')
            self.assertFalse(result['tpmStateReset'])
            self.assertEqual(json.loads((root/'backup-reverse/identity.json').read_text()), identity)
            for name in ('system.qcow2', 'VARS.fd', 'tpm/state'):
                self.assertEqual((guest/name).read_bytes(), ('original-'+name).encode())
                self.assertEqual((root/'backup-reverse'/name).read_bytes(), (guest/name).read_bytes())

    def test_missing_mount_is_rejected_without_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, 'mount is unavailable'):
                migration.migrate(root, 'test')
            self.assertEqual(list(root.iterdir()), [])

    def test_wrong_identity_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'guest').mkdir()
            identity = root/'guest/identity.json'
            identity.write_text('{"tpm":"crb"}')
            with patch.object(Path, 'is_mount', return_value=True):
                with self.assertRaisesRegex(RuntimeError, 'expected original TIS'):
                    migration.migrate(root, 'test')
            self.assertEqual(identity.read_text(), '{"tpm":"crb"}')

    def test_failed_backup_never_switches_interface(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            guest = root/'guest'
            (guest/'tpm').mkdir(parents=True)
            identity = {'schemaVersion': 1, 'diskGiB': 96, 'diskBus': 'nvme', 'firmware': 'ms', 'tpm': 'tis'}
            (guest/'identity.json').write_text(json.dumps(identity))
            for name in ('system.qcow2', 'VARS.fd', 'tpm/state'):
                (guest/name).write_bytes(b'original')
            with patch.object(Path, 'is_mount', return_value=True), patch.object(migration.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)), patch.object(migration.subprocess, 'run', side_effect=RuntimeError('copy failed')):
                with self.assertRaisesRegex(RuntimeError, 'copy failed'):
                    migration.migrate(root, 'test')
            self.assertEqual(json.loads((guest/'identity.json').read_text()), identity)
            self.assertEqual((guest/'system.qcow2').read_bytes(), b'original')


if __name__ == '__main__':
    unittest.main()
