from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from tools.validate_madlad_runtime_smoke import PROFILE, validate as validate_runtime
from tools.validate_translation_quality_evidence import validate as validate_quality


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "evidence/validation/models/madlad400-runtime-smoke-20260813-a1.json"
QUALITY = ROOT / "evidence/validation/models/translation-quality-20260813-madlad400-bf16-a2.json"


class MadladTranslationEvidenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = json.loads(RUNTIME.read_text(encoding="utf-8"))
        self.profile = json.loads(PROFILE.read_text(encoding="utf-8"))
        self.quality = json.loads(QUALITY.read_text(encoding="utf-8"))

    def test_exact_runtime_and_failed_quality_evidence_validate(self) -> None:
        validate_runtime(self.runtime, self.profile)
        validate_quality(self.quality)

    def test_runtime_profile_or_container_drift_fails_closed(self) -> None:
        drift = copy.deepcopy(self.profile)
        drift["limits"]["maximumBatchSize"] += 1
        with self.assertRaisesRegex(ValueError, "fingerprint drifted"):
            validate_runtime(self.runtime, drift)

    def test_quality_cannot_change_failure_to_certification(self) -> None:
        drift = copy.deepcopy(self.quality)
        drift["certificationClaimEligible"] = True
        with self.assertRaisesRegex(ValueError, "digest drifted"):
            validate_quality(drift)

    def test_wrong_historical_a1_identity_is_rejected(self) -> None:
        drift = copy.deepcopy(self.quality)
        drift["runId"] = "translation-quality-20260813-madlad400-bf16-a1"
        drift.pop("evidenceDigest")
        with self.assertRaisesRegex(ValueError, "digest drifted"):
            validate_quality(drift)


if __name__ == "__main__":
    unittest.main()
