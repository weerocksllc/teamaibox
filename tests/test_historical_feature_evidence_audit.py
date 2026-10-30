from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.audit_historical_feature_evidence import (
    EVIDENCE_ROOT,
    POLICY,
    HistoricalEvidenceAuditError,
    classify,
    inventory,
    validate,
)


class HistoricalFeatureEvidenceAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = json.loads(POLICY.read_text(encoding="utf-8"))

    def write_policy(self, root: Path, value: dict) -> Path:
        path = root / "audit.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_historical_snapshot_validator_promotes_none(self) -> None:
        with patch('tools.audit_historical_feature_evidence.inventory', return_value=self.policy['inventorySnapshot']):
            result = validate()
        snapshot = self.policy["inventorySnapshot"]
        self.assertEqual(result["jsonFileCount"], snapshot["jsonFileCount"])
        self.assertEqual(result["historicallyPassingCount"], snapshot["historicallyPassingCount"])
        self.assertEqual(result["featureAcceptanceEligibleCount"], 0)
        self.assertEqual(result["retainedPrerequisiteCount"], 15)

    def test_required_false_positive_classes_have_explicit_reasons(self) -> None:
        retained = {item["path"] for item in self.policy["retainedPrerequisites"]}
        self.assertEqual(classify("evidence/platform/workbench-preview.json", {}, retained), "stale-preview")
        self.assertEqual(
            classify("evidence/validation/journeys/ai-applications-20260811-development-a1.json", {}, retained),
            "static-fixture",
        )
        self.assertEqual(classify("evidence/validation/load/mixed.json", {}, retained), "synthetic-service-objective")
        self.assertEqual(classify("evidence/validation/cluster/external-provider-contract.json", {}, retained), "contract-only-provider")
        self.assertEqual(
            classify("evidence/validation/journeys/journeys-20260811-development-a1.json", {}, retained),
            "memory-repository",
        )

    def test_inventory_or_policy_drift_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            changed = copy.deepcopy(self.policy)
            changed["inventorySnapshot"]["jsonFileCount"] -= 1
            with patch('tools.audit_historical_feature_evidence.inventory', return_value=self.policy['inventorySnapshot']):
                with self.assertRaisesRegex(HistoricalEvidenceAuditError, "inventory changed"):
                    validate(self.write_policy(root, changed))

            missing_rule = copy.deepcopy(self.policy)
            missing_rule["disqualificationRules"].pop()
            with self.assertRaisesRegex(HistoricalEvidenceAuditError, "rule coverage"):
                validate(self.write_policy(root, missing_rule))

    def test_new_legacy_json_changes_the_bound_inventory(self) -> None:
        retained = {item["path"] for item in self.policy["retainedPrerequisites"]}
        exclusions = self.policy["currentEvidenceExclusions"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = inventory(root, retained, exclusions)
            path = root / "new.json"
            path.write_text('{"status":"passed"}', encoding="utf-8")
            changed = inventory(root, retained, exclusions)
            self.assertEqual(changed["jsonFileCount"], baseline["jsonFileCount"] + 1)
            self.assertNotEqual(changed["inventoryDigest"], baseline["inventoryDigest"])

    def test_truncated_evidence_is_counted_as_failed_not_dropped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'incomplete.json').write_bytes(b'{')
            result = inventory(root, set())
            self.assertEqual(result['jsonFileCount'], 1)
            self.assertEqual(result['historicallyPassingCount'], 0)
            self.assertEqual(result['featureAcceptanceEligibleCount'], 0)
            self.assertEqual(result['dispositionCounts'], {'failed-or-incomplete': 1})


if __name__ == "__main__":
    unittest.main()
