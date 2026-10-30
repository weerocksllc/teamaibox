from __future__ import annotations

from pathlib import Path
import unittest

from tools.run_lmt4_protected_profile_revalidation import aggregate_revalidation_memory


ROOT = Path(__file__).resolve().parents[1]


class Lmt4ProtectedProfileRevalidationTest(unittest.TestCase):
    def test_memory_uses_per_cycle_and_cross_cycle_conservative_views(self) -> None:
        value = aggregate_revalidation_memory([
            {"nvidiaAllocatedBytes": 100, "containerCurrentBytes": 60,
             "conservativeCombinedBytes": 160},
            {"nvidiaAllocatedBytes": 90, "containerCurrentBytes": 70,
             "conservativeCombinedBytes": 160},
        ])
        self.assertEqual(value["observedCombinedPeakBytes"], 160)
        self.assertEqual(value["conservativeComponentEnvelopeBytes"], 170)
        self.assertEqual(value["admissionBytes"], 170)

    def test_runner_never_mutates_the_immutable_registration(self) -> None:
        source = (ROOT / "tools/run_lmt4_protected_profile_revalidation.py").read_text()
        self.assertIn('"immutableRegistrationRewritten": False', source)
        self.assertIn('"registrationRetainedImmutable": True', source)
        self.assertNotIn("UPDATE compute.model_profile_registrations", source)
        self.assertNotIn("DELETE FROM compute.model_profile_registrations", source)

    def test_validator_rechecks_live_service_and_database(self) -> None:
        source = (ROOT / "tools/validate_lmt4_protected_profile_revalidation.py").read_text()
        for token in ("snapshot(CONTAINER)", "artifact_manifest()", "freshWarmProbes",
                      "live LMT4 corrective protocol probe failed", "certificationState"):
            self.assertIn(token, source)

    def test_successor_exposes_main_box_target_and_immutable_profile_document(self) -> None:
        source = (ROOT / "tools/run_lmt4_protected_profile_revalidation.py").read_text()
        self.assertIn('"nodeAddress": "10.64.0.20"', source)
        self.assertIn('"profileDocument": None', source)
        self.assertIn('parent["profileRegistration"]["document"]', source)


if __name__ == "__main__":
    unittest.main()
