from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from tools.validate_hunyuanocr_license_approval import APPROVAL, validate


class HunyuanOcrLicenseApprovalTests(unittest.TestCase):
    def mutation(self, value: dict) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "approval.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            return validate(path)

    def test_exact_approval_successor_is_valid(self) -> None:
        result = validate()
        self.assertTrue(result["valid"])
        self.assertTrue(result["licenseApproved"])
        self.assertTrue(result["releaseDistributionApproved"])
        self.assertTrue(result["releaseCandidateSoakRequired"])
        self.assertFalse(result["task18_6Complete"])

    def test_territory_boundary_cannot_be_removed(self) -> None:
        value = json.loads(APPROVAL.read_text(encoding="utf-8"))
        value["approvedUse"]["territoryPolicy"]["excluded"].remove("European Union")
        with self.assertRaisesRegex(ValueError, "territory"):
            self.mutation(value)

    def test_distribution_condition_cannot_be_waived(self) -> None:
        value = json.loads(APPROVAL.read_text(encoding="utf-8"))
        value["approvedUse"]["distributionConditions"]["fullLicenseDelivered"] = False
        with self.assertRaisesRegex(ValueError, "conditions"):
            self.mutation(value)

    def test_technical_soak_gate_remains_fail_closed(self) -> None:
        value = json.loads(APPROVAL.read_text(encoding="utf-8"))
        value["remainingTechnicalGates"]["releaseCandidateSoakRequired"] = False
        with self.assertRaisesRegex(ValueError, "technical release gate"):
            self.mutation(value)


if __name__ == "__main__":
    unittest.main()
