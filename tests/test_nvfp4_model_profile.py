import hashlib
import json
import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PROFILE = ROOT / "models" / "profiles" / "qwen36-35b-a3b-nvfp4-spark-32k.v1.json"
EVIDENCE = ROOT / "evidence" / "validation" / "models" / "baseline-20260811-nvfp4-a3.json"
COMPARISON = ROOT / "evidence" / "validation" / "models" / "comparison-20260811-qwen36-nvfp4-vs-bf16-a3.json"
CLEANUP = ROOT / "evidence" / "validation" / "models" / "lab-artifact-cleanup-20260811-a1.json"
EXPECTED_FINGERPRINT = "sha256:f95cd3962a6f0c4a97487def9d61cd16bab96ff60fe95c6ba26362f84dda13e0"


def canonical_digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


class Nvfp4ModelProfileTest(unittest.TestCase):
    def setUp(self):
        self.profile = json.loads(PROFILE.read_text(encoding="utf-8"))
        self.evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))
        self.comparison = json.loads(COMPARISON.read_text(encoding="utf-8"))
        self.cleanup = json.loads(CLEANUP.read_text(encoding="utf-8"))

    def test_declaration_is_exactly_the_profile_exercised_on_spark(self):
        self.assertEqual(self.evidence["profileDeclaration"], self.profile)
        self.assertEqual(canonical_digest(self.profile), EXPECTED_FINGERPRINT)
        self.assertEqual(self.evidence["profileFingerprint"], EXPECTED_FINGERPRINT)
        self.assertEqual(self.evidence["probe"]["profileFingerprint"], EXPECTED_FINGERPRINT)
        completed = subprocess.run(
            ["node", "--input-type=module", "-e", (
                "import { modelProfileFingerprintV1 } from './apps/platform-api/src/models/model-profile-registration-service.mjs';"
                "let body=''; for await (const chunk of process.stdin) body+=chunk;"
                "process.stdout.write(modelProfileFingerprintV1(JSON.parse(body)));"
            )],
            cwd=ROOT, input=json.dumps(self.profile), text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, EXPECTED_FINGERPRINT)

    def test_artifact_recipe_and_runtime_kernels_are_not_overstated(self):
        artifact = self.evidence["artifact"]
        self.assertEqual(artifact["fileCount"], 14)
        self.assertEqual(artifact["totalBytes"], 23_457_714_000)
        self.assertEqual(artifact["artifactDigest"], self.profile["artifactDigest"])
        self.assertEqual(self.profile["precision"], "nvfp4")
        self.assertEqual(self.profile["quantizationRecipe"]["scheme"], "nvfp4")
        for cold in self.evidence["coldStartRuns"]:
            observed = cold["runtimeKernelObservations"]
            self.assertEqual(observed["nvfp4MoeBackend"], "marlin")
            self.assertEqual(observed["fp8LinearKernel"], "flashinfer_scaled_mm")
            self.assertEqual(observed["attentionBackend"], "flashinfer")
            self.assertFalse(observed["nativeFp4ComputationObserved"])
            self.assertTrue(observed["weightOnlyFallbackObserved"])

    def test_run_and_identical_workload_comparison_passed_with_clean_cleanup(self):
        for evidence in (self.evidence, self.comparison):
            payload = dict(evidence)
            claimed = payload.pop("evidenceDigest")
            self.assertEqual(claimed, canonical_digest(payload))
            self.assertEqual(evidence["outcome"], "passed")
            self.assertFalse(evidence["certificationClaimEligible"])
        self.assertTrue(self.evidence["probe"]["quality"]["passed"])
        self.assertEqual(self.evidence["probe"]["stability"]["failed"], 0)
        self.assertTrue(self.evidence["probe"]["summary"]["longContextMinimumReached"])
        self.assertTrue(all(item["minimumHostAvailableMemoryBytes"] >= 12 * 1024**3 for item in self.evidence["coldStartRuns"]))
        self.assertGreaterEqual(self.evidence["probe"]["resources"]["minimumHostAvailableMemoryBytes"], 12 * 1024**3)
        self.assertEqual(self.evidence["residual"]["remainingContainers"], [])
        self.assertTrue(self.evidence["residual"]["stagingRemoved"])
        self.assertTrue(self.evidence["coreServicesAfter"]["webHealthPassed"])
        self.assertEqual(self.comparison["comparability"]["workload"]["seed"], 1337)
        self.assertEqual(self.comparison["quality"]["candidatePassedCases"], 4)

    def test_plaintext_lab_material_was_removed_after_comparison(self):
        payload = dict(self.cleanup)
        claimed = payload.pop("evidenceDigest")
        self.assertEqual(claimed, canonical_digest(payload))
        self.assertEqual(self.cleanup["outcome"], "passed")
        self.assertTrue(self.cleanup["volumeAbsenceVerified"])
        self.assertEqual(self.cleanup["remainingValidationContainers"], [])
        self.assertTrue(self.cleanup["webHealthPassed"])
        self.assertEqual(set(self.cleanup["removedVolumes"]), {
            "teamaibox-model-lab-qwen36-bf16-995ad96e",
            "teamaibox-model-lab-qwen36-nvfp4-491c2f1e",
            "teamaibox-model-runtime-cache-vllm-2605",
        })


if __name__ == "__main__":
    unittest.main()
