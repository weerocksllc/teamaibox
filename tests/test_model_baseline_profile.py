import hashlib
import json
import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PROFILE = ROOT / "models" / "profiles" / "qwen36-35b-a3b-bf16-spark-reference-32k.v1.json"
EVIDENCE = ROOT / "evidence" / "validation" / "models" / "baseline-20260811-bf16-a4.json"
EXPECTED_FINGERPRINT = "sha256:e6dddee0e8b22a27867cdc10860b1a08667d5ccfcf0e21f6e23b32e7c83813b7"


class ModelBaselineProfileTest(unittest.TestCase):
    def setUp(self):
        self.profile = json.loads(PROFILE.read_text(encoding="utf-8"))
        self.evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))

    def test_registered_declaration_and_live_probe_use_the_same_fingerprint(self):
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
        self.assertEqual(self.evidence["profileDeclaration"], self.profile)
        self.assertEqual(self.evidence["profileFingerprint"], EXPECTED_FINGERPRINT)
        self.assertEqual(self.evidence["probe"]["profileFingerprint"], EXPECTED_FINGERPRINT)

    def test_evidence_digest_covers_the_complete_immutable_payload(self):
        payload = dict(self.evidence)
        claimed = payload.pop("evidenceDigest")
        canonical = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        actual = f"sha256:{hashlib.sha256(canonical).hexdigest()}"
        self.assertEqual(claimed, actual)

    def test_exact_snapshot_and_runtime_are_pinned(self):
        artifact = self.evidence["artifact"]
        self.assertEqual(artifact["fileCount"], 36)
        self.assertEqual(artifact["totalBytes"], 71_923_435_103)
        self.assertEqual(sum(item["sizeBytes"] for item in artifact["files"]), artifact["totalBytes"])
        self.assertEqual(artifact["artifactDigest"], self.profile["artifactDigest"])
        self.assertEqual(len([item for item in artifact["files"] if item["path"].endswith(".safetensors")]), 26)
        self.assertEqual(self.profile["engine"]["imageDigest"], "sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2")

    def test_live_baseline_passed_without_overstating_certification(self):
        self.assertEqual(self.evidence["outcome"], "passed")
        self.assertFalse(self.evidence["certificationClaimEligible"])
        self.assertEqual(len(self.evidence["coldStartRuns"]), 3)
        self.assertTrue(all(item["coreServices"]["webHealthPassed"] for item in self.evidence["coldStartRuns"]))
        self.assertTrue(self.evidence["probe"]["quality"]["passed"])
        self.assertEqual(self.evidence["probe"]["stability"]["failed"], 0)
        self.assertTrue(self.evidence["probe"]["summary"]["longContextMinimumReached"])
        reserve = 12 * 1024**3
        self.assertTrue(all(item["minimumHostAvailableMemoryBytes"] >= reserve for item in self.evidence["coldStartRuns"]))
        self.assertGreaterEqual(self.evidence["probe"]["resources"]["minimumHostAvailableMemoryBytes"], reserve)
        self.assertEqual(self.evidence["residual"]["remainingContainers"], [])
        self.assertTrue(self.evidence["residual"]["stagingRemoved"])
        self.assertTrue(self.evidence["coreServicesAfter"]["webHealthPassed"])


if __name__ == "__main__":
    unittest.main()
