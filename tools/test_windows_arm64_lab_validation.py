import unittest
from validate_windows_arm64_lab import validate


class RuntimeEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.data = {'status': 'passed', 'windowsBootTested': False,
                     'probe': {'status': 'passed', 'windowsBootTested': False,
                               'query-kvm': {'enabled': True, 'present': True},
                               'firmware': [{'path': '/test/firmware.fd'}]},
                     'before': {'containersBefore': [{'id': 'existing'}]},
                     'after': {'containersAfter': [{'id': 'existing'}]},
                     'image': 'sha256:' + 'a' * 64}

    def test_prerequisite_only(self):
        self.assertTrue(validate(self.data))

    def test_no_tcg_pass(self):
        self.data['probe']['query-kvm']['enabled'] = False
        with self.assertRaises(AssertionError):
            validate(self.data)

    def test_no_workload_restart(self):
        self.data['after']['containersAfter'] = [{'id': 'replacement'}]
        with self.assertRaises(AssertionError):
            validate(self.data)

    def test_no_windows_acceptance_inference(self):
        self.data['windowsBootTested'] = True
        with self.assertRaises(AssertionError):
            validate(self.data)

    def test_no_failed_run_pass(self):
        self.data['status'] = 'failed'
        with self.assertRaises(AssertionError):
            validate(self.data)


if __name__ == '__main__':
    unittest.main()
