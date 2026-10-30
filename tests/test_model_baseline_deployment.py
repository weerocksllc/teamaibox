import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
CATALOG = ROOT / "deploy" / "compute" / "model-baseline-deployments.v1.json"
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")


class ModelBaselineDeploymentTest(unittest.TestCase):
    def setUp(self):
        self.catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

    def test_runtime_and_model_are_exactly_pinned(self):
        self.assertEqual(self.catalog["schemaVersion"], 1)
        runtime = self.catalog["runtimeImage"]
        self.assertEqual(runtime["platform"], "linux/arm64/v8")
        self.assertRegex(runtime["platformDigest"], DIGEST)
        self.assertRegex(runtime["imageIdObservedOnSpark"], DIGEST)
        self.assertNotIn(":latest", json.dumps(self.catalog))
        self.assertEqual({item["source"]["precision"] for item in self.catalog["profiles"]}, {"bf16", "nvfp4"})
        for profile in self.catalog["profiles"]:
            self.assertRegex(profile["source"]["revision"], r"^[a-f0-9]{40}$")

    def test_baseline_is_exclusive_and_preserves_the_control_plane(self):
        for profile in self.catalog["profiles"]:
            scheduling = profile["scheduling"]
            self.assertTrue(scheduling["nodeExclusive"])
            self.assertGreaterEqual(scheduling["coreServiceReserveBytes"], 12 * 1024**3)
            self.assertLessEqual(scheduling["maximumWorkerMemoryBytes"] + scheduling["coreServiceReserveBytes"], 128 * 1024**3)
            self.assertLessEqual(scheduling["maximumConcurrentRequests"], 2)

    def test_runtime_has_no_lan_port_or_privileged_host_boundary(self):
        for profile in self.catalog["profiles"]:
            network = profile["network"]
            security = profile["security"]
            self.assertEqual(network["runtimeMode"], "isolated-internal")
            self.assertEqual(network["publishedPorts"], [])
            self.assertFalse(security["dockerSocketMounted"])
            self.assertTrue(security["readOnlyRootFilesystem"])
            self.assertTrue(security["noNewPrivileges"])
            self.assertTrue(security["modelArtifactMountReadOnly"])
            self.assertEqual(security["capabilitiesDropped"], ["ALL"])
            self.assertGreater(security["runAsUid"], 0)

    def test_reference_precision_and_workload_are_not_silently_reduced(self):
        required_scenarios = {"warm_single", "dynamic_batch_four", "concurrency_two", "long_context"}
        for profile in self.catalog["profiles"]:
            arguments = profile["engineArguments"]
            self.assertEqual(arguments[arguments.index("--max-model-len") + 1], "32768")
            self.assertIn("--language-model-only", arguments)
            self.assertEqual(arguments[arguments.index("--mm-processor-cache-gb") + 1], "0")
            self.assertNotIn("--quantization", arguments)
            self.assertEqual(arguments[arguments.index("--tool-call-parser") + 1], "qwen3_xml")
            self.assertIn("--enable-auto-tool-choice", arguments)
            self.assertEqual(set(profile["validationPlan"]["benchmarkScenarios"]), required_scenarios)
            self.assertGreaterEqual(profile["validationPlan"]["coldStartRuns"], 3)
            self.assertFalse(profile["validationPlan"]["certificationEligible"])

        by_precision = {item["source"]["precision"]: item for item in self.catalog["profiles"]}
        bf16 = by_precision["bf16"]["engineArguments"]
        nvfp4 = by_precision["nvfp4"]["engineArguments"]
        self.assertEqual(bf16[bf16.index("--dtype") + 1], "bfloat16")
        self.assertNotIn("--kv-cache-dtype", bf16)
        self.assertEqual(nvfp4[nvfp4.index("--dtype") + 1], "auto")
        self.assertEqual(nvfp4[nvfp4.index("--kv-cache-dtype") + 1], "fp8")
        self.assertEqual(nvfp4[nvfp4.index("--attention-backend") + 1], "flashinfer")
        self.assertEqual(nvfp4[nvfp4.index("--moe-backend") + 1], "marlin")
        for precision_profile in by_precision.values():
            self.assertEqual(precision_profile["validationPlan"], by_precision["bf16"]["validationPlan"])
            self.assertEqual(precision_profile["engineArguments"][precision_profile["engineArguments"].index("--seed") + 1], "1337")

    def test_artifact_validation_is_exactly_one_to_one_with_profiles(self):
        artifact_by_candidate = {item["candidateId"]: item for item in self.catalog["artifactValidation"]}
        self.assertEqual(len(artifact_by_candidate), len(self.catalog["artifactValidation"]))
        self.assertEqual(set(artifact_by_candidate), {item["candidateId"] for item in self.catalog["profiles"]})
        nvfp4 = artifact_by_candidate["qwen36-35b-a3b-nvfp4"]
        self.assertEqual(nvfp4["maximumBytes"], 26_000_000_000)
        self.assertEqual(nvfp4["quantizationRecipe"]["scheme"], "nvfp4")
        self.assertRegex(nvfp4["quantizationRecipe"]["recipeDigest"], DIGEST)


if __name__ == "__main__":
    unittest.main()
