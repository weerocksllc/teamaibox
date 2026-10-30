import json
import unittest
from unittest.mock import patch
import restore_existing_business_volumes as storage


class StorageIOTests(unittest.TestCase):
    def probe(self, direct, configure, foreign=False):
        calls = []
        volume = dict(source='/srv/new/volume/data.img', keyFile='/srv/new/key', mountPoint='/srv/new/data',
                      mapper='new-data', fsUuid='filesystem', directIO=True)
        def run(args):
            calls.append(args)
            if args[:2] == ['cryptsetup', 'status']: return 'device: /dev/loop22'
            if args[0] == 'blkid': return 'filesystem'
            if '--direct-io=on' in args: return ''
            return json.dumps(dict(loopdevices=[{'back-file': '/foreign' if foreign else volume['source'], 'dio': direct}]))
        with patch.object(storage, 'run', run):
            storage.verify_mapper(volume, configure=configure)
        return calls

    def test_only_exact_registered_loop_is_configured(self):
        calls = self.probe(True, True)
        self.assertIn(['losetup', '--direct-io=on', '/dev/loop22'], calls)
        with self.assertRaisesRegex(RuntimeError, 'mapper_backing_file_mismatch'):
            self.probe(True, True, foreign=True)

    def test_check_never_changes_loop_and_detects_missing_policy(self):
        self.assertFalse(any('--direct-io=on' in c for c in self.probe(True, False)))
        with self.assertRaisesRegex(RuntimeError, 'volume_direct_io_not_enabled'):
            self.probe(False, False)


if __name__ == '__main__': unittest.main()
