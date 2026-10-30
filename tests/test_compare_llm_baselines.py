import copy
import json
import pathlib
import unittest

from tools import compare_llm_baselines as comparison


ROOT = pathlib.Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "evidence" / "validation" / "models" / "baseline-20260811-bf16-a4.json"


def synthetic_candidate(reference):
    catalog = json.loads(comparison.CATALOG_PATH.read_text(encoding="utf-8"))
    profile = next(item for item in catalog["profiles"] if item["profileKey"] == comparison.CANDIDATE_PROFILE)
    deployment_fingerprint = comparison.canonical_digest({"runtimeImage": catalog["runtimeImage"], "profile": profile})
    result = copy.deepcopy(reference)
    result["runId"] = "baseline-20260811-nvfp4-test"
    result["profileKey"] = profile["profileKey"]
    result["deploymentFingerprint"] = deployment_fingerprint
    declaration = result["profileDeclaration"]
    declaration["profileKey"] = profile["profileKey"]
    declaration["precision"] = "nvfp4"
    declaration["quantizationRecipe"] = next(
        item["quantizationRecipe"] for item in catalog["artifactValidation"]
        if item["candidateId"] == profile["candidateId"]
    )
    declaration["engine"]["configurationDigest"] = deployment_fingerprint
    profile_fingerprint = comparison.canonical_digest(declaration)
    result["profileFingerprint"] = profile_fingerprint
    result["probe"]["profileFingerprint"] = profile_fingerprint
    result["probe"]["deploymentFingerprint"] = deployment_fingerprint
    result.pop("evidenceDigest", None)
    result["evidenceDigest"] = comparison.canonical_digest(result)
    return result


class LlmBaselineComparisonTest(unittest.TestCase):
    def setUp(self):
        self.reference = comparison.read_evidence(REFERENCE)
        self.candidate = synthetic_candidate(self.reference)

    def test_identical_workload_comparison_is_lineage_bound_and_deterministic(self):
        report = comparison.compare(self.reference, self.candidate)
        self.assertEqual(report["outcome"], "passed")
        self.assertFalse(report["certificationClaimEligible"])
        self.assertEqual(report["comparability"]["workload"]["seed"], 1337)
        self.assertEqual(len(report["performance"]["scenarios"]), 4)
        self.assertEqual(report["performance"]["coldLoadTimeMsMedian"]["percent"], 0)
        digest = report.pop("evidenceDigest")
        self.assertEqual(digest, comparison.canonical_digest(report))

    def test_evidence_tampering_is_rejected(self):
        tampered = json.loads(REFERENCE.read_text(encoding="utf-8"))
        tampered["probe"]["stability"]["failed"] = 1
        temporary = ROOT / "evidence" / "validation" / "models" / ".tampered-comparison-test.json"
        try:
            temporary.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaises(comparison.ComparisonError):
                comparison.read_evidence(temporary)
        finally:
            temporary.unlink(missing_ok=True)

    def test_workload_or_environment_drift_fails_closed(self):
        drifted = copy.deepcopy(self.candidate)
        drifted["probe"]["benchmarks"][0]["outputTokenLimit"] += 1
        with self.assertRaisesRegex(comparison.ComparisonError, "corpus, warmup"):
            comparison.compare(self.reference, drifted)
        drifted = copy.deepcopy(self.candidate)
        drifted["preflight"]["environmentDigest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(comparison.ComparisonError, "environment differs"):
            comparison.compare(self.reference, drifted)


if __name__ == "__main__":
    unittest.main()
