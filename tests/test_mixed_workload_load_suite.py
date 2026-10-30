from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from tools.run_mixed_workload_load_suite import (
    CATALOG,
    EXPECTED_KEYS,
    MixedLoadSuiteError,
    percentile,
    validate_catalog,
)
from tools.run_security_release_gate import canonical_bytes, digest_bytes


class MixedWorkloadLoadSuiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = json.loads(Path(CATALOG).read_text(encoding="utf-8"))

    def test_catalog_combines_every_required_workload_with_real_concurrency(self) -> None:
        validated = validate_catalog(self.catalog)
        self.assertEqual([item["key"] for item in validated["workloads"]], EXPECTED_KEYS)
        self.assertEqual(sum(item["instances"] for item in validated["workloads"]), 24)
        self.assertEqual(validated["maximumFailures"], 0)
        self.assertFalse(validated["retainCommandOutput"])

    def test_catalog_rejects_missing_workload_weak_concurrency_and_path_escape(self) -> None:
        missing = copy.deepcopy(self.catalog)
        missing["workloads"].pop()
        with self.assertRaisesRegex(MixedLoadSuiteError, "coverage"):
            validate_catalog(missing)
        weak = copy.deepcopy(self.catalog)
        weak["workloads"][0]["instances"] = 1
        with self.assertRaisesRegex(MixedLoadSuiteError, "concurrency"):
            validate_catalog(weak)
        escaping = copy.deepcopy(self.catalog)
        escaping["workloads"][0]["command"][-1] = "../outside.test.mjs"
        with self.assertRaisesRegex(MixedLoadSuiteError, "path"):
            validate_catalog(escaping)

    def test_percentiles_are_nearest_rank_and_never_average_away_a_slow_sample(self) -> None:
        self.assertEqual(percentile([10, 20, 30, 100], 0.50), 20)
        self.assertEqual(percentile([10, 20, 30, 100], 0.95), 100)

    def test_historical_evidence_is_not_current_single_appliance_acceptance(self) -> None:
        path = Path("evidence/validation/load/mixed-load-20260811-development-a1.json")
        evidence = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(evidence["suiteId"], self.catalog["suiteId"])
        self.assertEqual(evidence["status"], "passed")
        self.assertEqual(evidence["failedWorkloadKeys"], [])
        self.assertEqual(evidence["peakDeclaredConcurrency"], 24)
        self.assertLessEqual(evidence["wallDurationMilliseconds"], evidence["maximumSuiteSeconds"] * 1000)
        self.assertNotEqual(evidence["source"]["catalogDigest"], digest_bytes(canonical_bytes(self.catalog)))
        self.assertNotEqual([item["key"] for item in evidence["workloads"]], EXPECTED_KEYS)
        for workload in evidence["workloads"]:
            self.assertEqual(workload["status"], "passed")
            self.assertEqual(workload["failureCount"], 0)
            self.assertLessEqual(workload["latencyMillisecondsP95"], workload["maximumP95Milliseconds"])
        serialized = json.dumps(evidence)
        self.assertNotIn('"stdout"', serialized)
        self.assertNotIn('"stderr"', serialized)


if __name__ == "__main__":
    unittest.main()
