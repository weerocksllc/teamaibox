import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'deploy/android/cuttlefish'))
spec = importlib.util.spec_from_file_location('windows_lab_storage', ROOT/'deploy/windows-arm64/lab_storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageTests(unittest.TestCase):
    def test_only_owned_file_paths(self):
        base, backing, target, mapper = storage.paths('windows-arm64-storage-20260921-a1')
        self.assertEqual(backing.parent, base)
        self.assertTrue(str(backing).startswith('/var/lib/teamaibox/windows-lab/'))
        self.assertTrue(str(target).startswith('/srv/teamaibox/windows-lab/'))
        self.assertNotIn('phone', mapper)

    def test_path_injection_rejected(self):
        for value in ('../../dev/sda', 'windows-arm64-storage-20260921-a0', 'windows-arm64-storage-20260921-a1;true'):
            with self.assertRaises(RuntimeError):
                storage.paths(value)

    def test_wrong_host_rejected_before_mutation(self):
        with patch.object(storage.socket, 'gethostname', return_value='spark-19'), patch.object(storage, 'command') as cmd:
            with self.assertRaises(RuntimeError):
                storage.node('windows-arm64-storage-20260921-a1', 'prepare')
            cmd.assert_not_called()

    def test_existing_volume_never_formatted(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            with patch.object(storage.socket, 'gethostname', return_value='spark-23'), \
                 patch.object(storage, 'command', return_value=storage.NODE_UUID) as cmd, \
                 patch.object(storage, 'paths', return_value=(base, base/'storage.luks2', base/'mount', 'test')):
                with self.assertRaisesRegex(RuntimeError, 'lab_exists'):
                    storage.node('windows-arm64-storage-20260921-a1', 'prepare')
                self.assertEqual(cmd.call_count, 1)

    def test_no_close_with_guest_data(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            (base/'guest').mkdir()
            (base/'guest/system.qcow2').touch()
            with patch.object(storage.socket, 'gethostname', return_value='spark-23'), \
                 patch.object(storage, 'command', return_value=storage.NODE_UUID) as cmd, \
                 patch.object(storage, 'inspect'), \
                 patch.object(storage, 'paths', return_value=(base, base/'storage.luks2', base, 'test')):
                with self.assertRaisesRegex(RuntimeError, 'guest_data_exists'):
                    storage.node('windows-arm64-storage-20260921-a1', 'close-empty')
                self.assertEqual(cmd.call_count, 1)


if __name__ == '__main__':
    unittest.main()
