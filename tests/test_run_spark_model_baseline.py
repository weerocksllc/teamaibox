import json
import pathlib
import subprocess
import unittest

from tools import run_spark_model_baseline as runner


class SparkModelBaselineRunnerTest(unittest.TestCase):
    def test_catalog_is_exactly_pinned_and_fingerprint_is_stable(self):
        catalog, profile = runner.catalog_profile()
        self.assertEqual(catalog["runtimeImage"]["platformDigest"], runner.IMAGE.split("@", 1)[1])
        self.assertTrue(profile["scheduling"]["nodeExclusive"])
        left = runner.canonical_digest({"runtimeImage": catalog["runtimeImage"], "profile": profile})
        right = runner.canonical_digest({"profile": profile, "runtimeImage": catalog["runtimeImage"]})
        self.assertEqual(left, right)

    def test_evidence_tail_redacts_secret_shaped_output(self):
        result = runner.Result(1, "authorization=visible\nnormal", "token: leaked")
        tail = "\n".join(runner.safe_tail(result))
        self.assertNotIn("visible", tail)
        self.assertNotIn("leaked", tail)
        self.assertIn("[REDACTED]", tail)

    def test_nvfp4_kernel_observations_record_the_official_marlin_fallback(self):
        _catalog, profile = runner.catalog_profile("llm.qwen36-35b-a3b.nvfp4.spark-32k.v1")
        logs = runner.Result(0, "\n".join([
            "Selected FlashInferFP8ScaledMMLinearKernel for ModelOptFp8LinearMethod",
            "Using 'MARLIN' NvFp4 MoE backend out of potential backends",
            "Using AttentionBackendEnum.FLASHINFER backend.",
            "Weight-only FP4 compression will be used leveraging the Marlin kernel.",
        ]), "")
        observed = runner.runtime_kernel_observations(logs, profile)
        self.assertEqual(observed["nvfp4MoeBackend"], "marlin")
        self.assertEqual(observed["fp8LinearKernel"], "flashinfer_scaled_mm")
        self.assertFalse(observed["nativeFp4ComputationObserved"])
        self.assertTrue(observed["weightOnlyFallbackObserved"])

    def test_engine_core_cuda_failure_is_terminal_before_readiness_timeout(self):
        fatal = runner.Result(0, "EngineCore failed to start", "torch.AcceleratorError: CUDA error: an illegal instruction was encountered")
        self.assertTrue(runner.fatal_runtime_startup(fatal))
        self.assertFalse(runner.fatal_runtime_startup(runner.Result(0, "loading weights", "")))

    def test_validation_profile_is_conservative_and_deterministic(self):
        _catalog, profile = runner.catalog_profile()
        manifest = {
            "artifactDigest": "sha256:" + "a" * 64, "totalBytes": 71_923_435_103,
            "files": [{"path": "config.json", "digest": "sha256:" + "b" * 64}],
        }
        declaration = runner.build_profile_declaration(
            profile, manifest, "sha256:" + "c" * 64, "sha256:" + "d" * 64,
        )
        self.assertEqual(declaration["precision"], "bf16")
        self.assertIsNone(declaration["quantizationRecipe"])
        self.assertTrue(declaration["exclusive"])
        self.assertEqual(declaration["dataPolicy"]["externalProcessing"], "forbidden")
        self.assertEqual(declaration["resourceEnvelope"]["unifiedMemoryBytes"], 104 * 1024**3)
        expected = runner.canonical_digest(declaration)
        completed = subprocess.run(
            ["node", "--input-type=module", "-e", (
                "import { modelProfileFingerprintV1 } from './apps/platform-api/src/models/model-profile-registration-service.mjs';"
                "let body=''; for await (const chunk of process.stdin) body+=chunk;"
                "process.stdout.write(modelProfileFingerprintV1(JSON.parse(body)));"
            )],
            cwd=pathlib.Path(__file__).resolve().parents[1], input=json.dumps(declaration),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, expected)

    def test_nvfp4_profile_is_publisher_pinned_and_registration_valid(self):
        _catalog, profile = runner.catalog_profile("llm.qwen36-35b-a3b.nvfp4.spark-32k.v1")
        manifest = {
            "artifactDigest": "sha256:" + "1" * 64, "totalBytes": 23_462_477_790,
            "files": [{"path": "config.json", "digest": "sha256:" + "2" * 64}],
        }
        declaration = runner.build_profile_declaration(
            profile, manifest, "sha256:" + "3" * 64, "sha256:" + "4" * 64,
        )
        self.assertEqual(declaration["precision"], "nvfp4")
        self.assertEqual(declaration["quantizationRecipe"]["scheme"], "nvfp4")
        self.assertEqual(declaration["source"]["model"], "nvidia/Qwen3.6-35B-A3B-NVFP4")
        self.assertEqual(declaration["resourceEnvelope"]["unifiedMemoryBytes"], 64 * 1024**3)
        completed = subprocess.run(
            ["node", "--input-type=module", "-e", (
                "import { modelProfileFingerprintV1 } from './apps/platform-api/src/models/model-profile-registration-service.mjs';"
                "let body=''; for await (const chunk of process.stdin) body+=chunk;"
                "process.stdout.write(modelProfileFingerprintV1(JSON.parse(body)));"
            )],
            cwd=pathlib.Path(__file__).resolve().parents[1], input=json.dumps(declaration),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, runner.canonical_digest(declaration))


if __name__ == "__main__":
    unittest.main()
