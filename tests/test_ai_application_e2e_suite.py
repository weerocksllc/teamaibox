from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from tools.run_ai_application_e2e_suite import (
    AiApplicationSuiteError,
    CATALOG,
    EXPECTED_APPLICATIONS,
    EXPECTED_SCENARIOS,
    validate_browser_input,
    validate_catalog,
)
from tools.run_security_release_gate import canonical_bytes, digest_bytes


class AiApplicationE2eSuiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = json.loads(Path(CATALOG).read_text(encoding="utf-8"))

    def test_catalog_covers_every_application_and_exact_shared_scenario(self) -> None:
        value = validate_catalog(self.catalog)
        self.assertEqual([item["key"] for item in value["applications"]], EXPECTED_APPLICATIONS)
        self.assertEqual(value["requiredScenarios"], EXPECTED_SCENARIOS)
        for application in value["applications"]:
            self.assertEqual(list(application["scenarioEvidence"]), EXPECTED_SCENARIOS)
            self.assertTrue(all("application" in sources for sources in application["scenarioEvidence"].values()))

    def test_catalog_rejects_missing_application_scenario_and_path_escape(self) -> None:
        missing = copy.deepcopy(self.catalog)
        missing["applications"].pop()
        with self.assertRaisesRegex(AiApplicationSuiteError, "coverage"):
            validate_catalog(missing)
        scenario = copy.deepcopy(self.catalog)
        scenario["applications"][0]["scenarioEvidence"].pop("model_unload_reload")
        with self.assertRaisesRegex(AiApplicationSuiteError, "scenario evidence"):
            validate_catalog(scenario)
        escaping = copy.deepcopy(self.catalog)
        escaping["applications"][0]["command"][-1] = "../outside.test.mjs"
        with self.assertRaisesRegex(AiApplicationSuiteError, "path"):
            validate_catalog(escaping)

    def test_committed_browser_evidence_has_mobile_coverage_for_every_ai_application(self) -> None:
        value = validate_browser_input(validate_catalog(self.catalog))
        self.assertEqual(value["status"], "passed")
        self.assertEqual(value["applicationCount"], len(EXPECTED_APPLICATIONS))
        self.assertEqual(value["mobileCombinationCountPerApplication"], 4)
        self.assertFalse(value["releaseEvidenceEligible"])

    def test_historical_evidence_is_not_current_single_appliance_acceptance(self) -> None:
        path = Path("evidence/validation/journeys/ai-applications-20260811-development-a1.json")
        evidence = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(evidence["suiteId"], self.catalog["suiteId"])
        self.assertEqual(evidence["status"], "passed")
        self.assertEqual(evidence["failedCheckKeys"], [])
        self.assertNotEqual(evidence["source"]["catalogDigest"], digest_bytes(canonical_bytes(self.catalog)))
        self.assertEqual([item["key"] for item in evidence["applications"] if item["key"] in EXPECTED_APPLICATIONS], EXPECTED_APPLICATIONS)
        self.assertTrue(all(item["status"] == "passed" and item["command"]["exitCode"] == 0 for item in evidence["applications"]))
        self.assertTrue(all(item["status"] == "passed" and item["command"]["exitCode"] == 0 for item in evidence["sharedChecks"]))
        self.assertFalse(evidence["commandOutputRetained"])
        serialized = json.dumps(evidence)
        self.assertNotIn('"stdout"', serialized)
        self.assertNotIn('"stderr"', serialized)


if __name__ == "__main__":
    unittest.main()
