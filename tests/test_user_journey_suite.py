from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from tools.run_security_release_gate import canonical_bytes, digest_bytes
from tools.run_user_journey_suite import CATALOG, EXPECTED_KEYS, UserJourneySuiteError, validate_catalog


class UserJourneySuiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = json.loads(Path(CATALOG).read_text(encoding="utf-8"))

    def test_catalog_has_every_required_full_journey_and_exact_test_file(self) -> None:
        validated = validate_catalog(self.catalog)
        self.assertEqual([item["key"] for item in validated["journeys"]], EXPECTED_KEYS)
        self.assertEqual(validated["maximumFailures"], 0)
        self.assertFalse(validated["retainCommandOutput"])
        self.assertTrue(all(len(item["command"]) >= 5 for item in validated["journeys"]))

    def test_catalog_rejects_missing_journey_duplicate_test_and_path_escape(self) -> None:
        missing = copy.deepcopy(self.catalog)
        missing["journeys"].pop()
        with self.assertRaisesRegex(UserJourneySuiteError, "coverage"):
            validate_catalog(missing)
        duplicate = copy.deepcopy(self.catalog)
        duplicate["journeys"][0]["command"].append(duplicate["journeys"][0]["command"][-1])
        with self.assertRaisesRegex(UserJourneySuiteError, "repeats"):
            validate_catalog(duplicate)
        escaping = copy.deepcopy(self.catalog)
        escaping["journeys"][0]["command"][-1] = "../outside.test.mjs"
        with self.assertRaisesRegex(UserJourneySuiteError, "path"):
            validate_catalog(escaping)

    def test_historical_evidence_is_not_current_single_appliance_acceptance(self) -> None:
        path = Path("evidence/validation/journeys/journeys-20260811-development-a1.json")
        evidence = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(evidence["suiteId"], self.catalog["suiteId"])
        self.assertEqual(evidence["status"], "passed")
        self.assertEqual(evidence["failedJourneyKeys"], [])
        self.assertFalse(evidence["commandOutputRetained"])
        self.assertNotEqual(evidence["source"]["catalogDigest"], digest_bytes(canonical_bytes(self.catalog)))
        self.assertNotEqual([item["key"] for item in evidence["journeys"]], EXPECTED_KEYS)
        self.assertTrue(all(item["status"] == "passed" and item["command"]["exitCode"] == 0 for item in evidence["journeys"]))
        serialized = json.dumps(evidence)
        self.assertNotIn('"stdout"', serialized)
        self.assertNotIn('"stderr"', serialized)


if __name__ == "__main__":
    unittest.main()
