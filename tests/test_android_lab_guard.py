import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools'))
from android_lab_guard import create_args, owned, pressure_reason, GIB


class GuardTests(unittest.TestCase):
    def test_limits_and_no_broad_privilege(self):
        argv = create_args('android-lab-control-20260911-a1', 'sha256:'+'a'*64, 1, '/bin/sh', ['-c', 'true'])
        for forbidden in ('--privileged', '--pid=host', '--network=host', '--gpus'):
            self.assertNotIn(forbidden, argv)
        self.assertEqual(argv[argv.index('--memory')+1], argv[argv.index('--memory-swap')+1])

    def test_device_scope(self):
        with self.assertRaises(ValueError):
            create_args('android-lab-control-20260911-a1', 'sha256:'+'a'*64, 1, 'sh', [], ['/dev/sda'])

    def test_minimal_capability_allowlist(self):
        with self.assertRaisesRegex(ValueError, 'capability'):
            create_args('android-lab-control-20260911-a1', 'sha256:'+'a'*64, 1, 'sh', [], capabilities=['SYS_MODULE'])
        argv = create_args('android-lab-control-20260911-a1', 'sha256:'+'a'*64, 1, 'sh', [], capabilities=['NET_ADMIN'])
        self.assertIn('NET_ADMIN', argv)
        self.assertNotIn('SYS_ADMIN', argv)

    def test_cleanup_ownership(self):
        state = {'Id': 'id1', 'Image': 'img1', 'Name': '/run1', 'Config.Labels': {'com.teamaibox.android-lab.run': 'run1'}}
        self.assertTrue(owned(state, 'id1', 'run1', 'img1'))
        self.assertFalse(owned(state, 'id2', 'run1', 'img1'))
        self.assertFalse(owned(state, 'id1', 'run1', 'img2'))

    def test_pressure(self):
        samples = [{'monotonic': n, 'availableBytes': 30*GIB, 'psiSomeAvg10': 6, 'pswpout': 0} for n in range(12)]
        self.assertEqual(pressure_reason(samples), 'memory-pressure')
        for s in samples:
            s['psiSomeAvg10'] = 0
            s['pswpout'] = int(s['monotonic'])*300
        self.assertEqual(pressure_reason(samples), 'sustained-swap-out')
        samples[-1]['availableBytes'] = 15*GIB
        self.assertEqual(pressure_reason(samples), 'memory-margin')


if __name__ == '__main__':
    unittest.main()
