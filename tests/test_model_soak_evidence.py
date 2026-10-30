import unittest
from pathlib import Path

from tools.validate_model_soak_evidence import (
    ROOT,
    SUITE,
    load,
    validate_formal_report_coverage,
    validate_report,
)


class ModelSoakEvidenceTests(unittest.TestCase):
    def test_latest_smoke_is_integral_but_not_formal_evidence(self):
        report = ROOT / "evidence/validation/models/soak-20260811-nvfp4-smoke-a6.json"
        result = validate_report(report, load(SUITE), allow_smoke=True)
        self.assertTrue(result["smoke"])
        self.assertEqual(result["completedJobs"], 32)
        self.assertGreater(result["minimumHostAvailableMemoryBytes"], 12 * 1024**3)
        self.assertLessEqual(result["peakTemperatureCelsius"], 90)

    def test_smoke_cannot_satisfy_formal_gate(self):
        report = Path(ROOT / "evidence/validation/models/soak-20260811-nvfp4-smoke-a6.json")
        with self.assertRaisesRegex(ValueError, "smoke evidence"):
            validate_report(report, load(SUITE))

    def test_every_selected_profile_requires_one_exact_formal_report(self):
        first = "llm.first.v1"
        second = "llm.second.v1"
        reports = {first: Path("first.json")}
        with self.assertRaisesRegex(ValueError, "exactly cover selected profiles"):
            validate_formal_report_coverage([first, second], reports)
        with self.assertRaisesRegex(ValueError, "exactly cover selected profiles"):
            validate_formal_report_coverage([first], {first: Path("first.json"), second: Path("second.json")})
        validate_formal_report_coverage([first], reports)


if __name__ == "__main__":
    unittest.main()
