from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from tools.validate_hunyuanocr_license_review import REVIEW, validate


class HunyuanOcrLicenseReviewTests(unittest.TestCase):
    def mutation(self, value: dict) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "review.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            return validate(path)

    def test_pending_review_packet_is_valid_and_fail_closed(self) -> None:
        result = validate()
        self.assertTrue(result["valid"])
        self.assertFalse(result["licenseApproved"])
        self.assertFalse(result["certificationApproved"])
        self.assertFalse(result["releaseDistributionApproved"])
        self.assertFalse(result["task18_6Complete"])
        self.assertEqual(result["requiredDecisionCount"], 12)

    def test_pending_packet_cannot_claim_approval(self) -> None:
        value = json.loads(REVIEW.read_text(encoding="utf-8"))
        value["decision"]["licenseApproved"] = True
        with self.assertRaisesRegex(ValueError, "contains an approval"):
            self.mutation(value)

    def test_release_gate_cannot_be_weakened(self) -> None:
        value = json.loads(REVIEW.read_text(encoding="utf-8"))
        value["failClosed"]["shippingModelWeightsBlocked"] = False
        with self.assertRaisesRegex(ValueError, "not fail closed"):
            self.mutation(value)

    def test_exact_model_revision_and_license_digest_are_bound(self) -> None:
        value = json.loads(REVIEW.read_text(encoding="utf-8"))
        value["subject"]["revision"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "subject drifted"):
            self.mutation(value)

        value = json.loads(REVIEW.read_text(encoding="utf-8"))
        value["license"]["textDigest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "license digest drifted"):
            self.mutation(value)


if __name__ == "__main__":
    unittest.main()
