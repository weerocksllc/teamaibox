from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CurrentUnifiedMemoryAdmissionQualificationSourceTests(unittest.TestCase):
    def test_probe_covers_all_fail_closed_pressure_variants(self) -> None:
        source = (ROOT / "deploy/application-catalog-e2e/current-unified-memory-admission-probe.mjs").read_text()
        for scenario in ("warm", "cold", "insufficient", "psi", "cgroup", "oom", "stale", "recovered"):
            self.assertIn(scenario, source)
        self.assertIn("rejectedBeforeLeaseRepositoryMutation", source)


if __name__ == "__main__":
    unittest.main()
