from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from tools.validate_luks2_migration_runbook import POLICY, ROOT, digest_bytes, review_policy_digest, validate


class Luks2MigrationRunbookTests(unittest.TestCase):
    def test_unreviewed_active_media_migration_is_complete_but_blocked(self) -> None:
        result = validate()
        self.assertTrue(result["valid"])
        self.assertFalse(result["executionAllowed"])
        self.assertEqual(result["reviewStatus"], "pending")
        self.assertEqual(result["requiredEvidenceCount"], 9)

    def mutation(self, value: dict, *, reviewed: bool = False) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "review.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            return validate(path, reviewed=reviewed)

    def reviewed_fixture(self) -> dict:
        value = json.loads(POLICY.read_text(encoding="utf-8"))
        runbook = ROOT / value["runbook"]
        value["reviewStatus"] = "approved"
        value["runbookReview"] = {
            "reviewerId": "independent-reviewer-01",
            "role": "independent_reviewer",
            "decision": "approved",
            "reviewedAt": "2026-08-12T00:00:00Z",
            "runbookDigest": digest_bytes(runbook.read_bytes()),
            "reviewPolicyDigest": review_policy_digest(value),
        }
        return value

    def test_reviewed_runbook_remains_non_executable_without_an_appliance_plan(self) -> None:
        result = self.mutation(self.reviewed_fixture(), reviewed=True)
        self.assertEqual(result["reviewStatus"], "approved")
        self.assertFalse(result["executionAllowed"])

    def test_review_attestation_cannot_survive_runbook_or_policy_drift(self) -> None:
        policy_drift = self.reviewed_fixture()
        policy_drift["requiredEvidence"].pop()
        with self.assertRaisesRegex(ValueError, "evidence gate|policy digest"):
            self.mutation(policy_drift, reviewed=True)

        forged = self.reviewed_fixture()
        forged["runbookReview"]["runbookDigest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "runbook review digest"):
            self.mutation(forged, reviewed=True)

    def test_pending_template_cannot_satisfy_the_human_review_gate(self) -> None:
        with self.assertRaisesRegex(ValueError, "has not received"):
            validate(reviewed=True)


if __name__ == "__main__":
    unittest.main()
