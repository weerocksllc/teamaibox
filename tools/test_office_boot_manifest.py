import unittest
from restore_existing_office_workers import validate_manifest


class ManifestTests(unittest.TestCase):
    def fixture(self, version=2):
        names = ['teamaibox-worker-'+str(i) for i in range(6)]
        if version == 1:
            names.append('teamaibox-protected-office-ocr-provider-v1')
        return dict(schemaVersion=version, containers=[dict(name=n) for n in names])

    def test_direct_workers_only(self):
        self.assertEqual(len(validate_manifest(self.fixture())), 6)

    def test_rollback_manifest(self):
        self.assertEqual(len(validate_manifest(self.fixture(1))), 7)

    def test_missing_duplicate_or_adapter_rejected(self):
        for action in ('missing', 'duplicate', 'adapter', 'unknown'):
            v=self.fixture()
            if action=='missing':v['containers'].pop()
            if action=='duplicate':v['containers'][0]=v['containers'][1]
            if action=='adapter':v['containers'][0]['name']='teamaibox-protected-office-ocr-provider-v1'
            if action=='unknown':v['schemaVersion']=3
            with self.assertRaises(RuntimeError):validate_manifest(v)


if __name__=='__main__':unittest.main()
