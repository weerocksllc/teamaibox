import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from validate_windows_arm64_ppi_runtime import validate, SIGNER


class PpiValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        paths = ['deploy/windows-arm64-ppi/Dockerfile', 'deploy/windows-arm64-ppi/probe_ppi.py',
                 'tools/build_windows_arm64_ppi_runtime.py', 'tools/collect_windows_arm64_inventory.py',
                 'tools/build_windows_arm64_crb_runtime.py', 'tools/build_windows_arm64_runtime.py']
        sources = {}
        for path in paths:
            target = self.root/path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'fixture')
            sources[path] = hashlib.sha256(b'fixture').hexdigest()
        workloads = [{'id': 'existing', 'name': 'office', 'image': 'original'}]
        self.data = {'runId': 'windows-arm64-ppi-runtime-20260922-a2', 'status': 'passed',
                     'windowsTpmAccepted': False, 'image': 'sha256:'+'a'*64,
                     'budget': {'buildGiB': 2, 'cpus': 2, 'hostReserveGiB': 16},
                     'admission': {'eligibleForBoundedLab': True}, 'sources': sources,
                     'before': {'containersBefore': workloads}, 'after': {'containersAfter': copy.deepcopy(workloads)},
                     'existingWorkloadIdentitiesUnchanged': True,
                     'probe': {'status': 'passed', 'windowsTpmAccepted': False, 'sourceVersion': '11.1.1',
                               'sourceSha256': 'b'*64, 'releaseSignerFingerprint': SIGNER,
                               'query-kvm': {'enabled': True, 'present': True},
                               'query-tpm': [{'model': 'tpm-tis'}], 'qom-get': True,
                               'query-vnc': {'enabled': True, 'host': '127.0.0.1'}}}

    def test_diskless_pass_is_not_windows_acceptance(self):
        self.assertTrue(validate(self.data, self.root))
        self.data['windowsTpmAccepted'] = True
        with self.assertRaises(AssertionError): validate(self.data, self.root)

    def test_requires_actual_ppi_and_kvm(self):
        for field in ('qom-get', 'query-kvm'):
            data = copy.deepcopy(self.data)
            data['probe'][field] = False
            with self.assertRaises(AssertionError): validate(data, self.root)

    def test_rejects_workload_replacement(self):
        self.data['after']['containersAfter'][0]['id'] = 'replacement'
        with self.assertRaises(AssertionError): validate(self.data, self.root)

    def test_rejects_source_drift(self):
        (self.root/'deploy/windows-arm64-ppi/Dockerfile').write_bytes(b'changed')
        with self.assertRaises(AssertionError): validate(self.data, self.root)


if __name__ == '__main__':
    unittest.main()
