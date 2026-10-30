"""Regression contract for the dependency-cancelled AI startup job."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'deploy' / 'host'


class DependencyRecoveryTests(unittest.TestCase):
    def test_no_hard_dependency_or_ineffective_reset(self):
        for name in ('teamaibox-existing-office-workers.service',
                     'office-frontdoor-order.conf', 'office-independent-recovery.conf'):
            source = (ROOT / name).read_text()
            self.assertFalse(any(line.startswith(('Requires=', 'Requisite=', 'BindsTo='))
                                 for line in source.splitlines()), name)

    def test_prerequisites_checked_individually_inside_retryable_service(self):
        source = (ROOT / 'teamaibox-existing-office-workers.service').read_text()
        self.assertIn('ExecStartPre=/usr/bin/systemctl is-active --quiet docker.service', source)
        self.assertIn('ExecStartPre=/usr/bin/systemctl is-active --quiet teamaibox-existing-business-volumes.service', source)
        self.assertIn('Restart=on-failure', source)
        self.assertIn('StartLimitIntervalSec=0', source)
        self.assertIn('RemainAfterExit=yes', source)
        self.assertNotIn('ExecStop=', source)

    def test_frontdoor_failure_is_not_a_model_readiness_requirement(self):
        source = (ROOT / 'office-frontdoor-order.conf').read_text()
        self.assertIn('Wants=teamaibox-frontdoor.service', source)
        self.assertNotIn('ExecStartPre=', source)


if __name__ == '__main__':
    unittest.main()
