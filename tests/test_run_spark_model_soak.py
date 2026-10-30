import unittest

from tools import run_spark_model_soak as runner


class SparkModelSoakRunnerTests(unittest.TestCase):
    def test_names_are_exact_and_profile_selection_is_pinned(self):
        run_id = "soak-20260811-smoke-a1"
        self.assertEqual(runner.probe_name(run_id), "teamaibox-model-soak-probe-" + run_id)
        self.assertEqual(runner.evidence_volume(run_id), "teamaibox-model-soak-evidence-" + run_id)
        self.assertEqual(runner.runtime_volume(run_id), "teamaibox-model-soak-runtime-" + run_id)
        suite = runner.validate_soak_suite()
        self.assertEqual(suite["selectedProfileKey"], "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1")
        self.assertEqual(suite["requiredDurationSeconds"], 86400)

    def test_soak_uses_no_external_network_and_retains_no_text(self):
        source = (runner.ROOT / "tools/model_soak_probe.py").read_text(encoding="utf-8")
        orchestrator = (runner.ROOT / "tools/run_spark_model_soak.py").read_text(encoding="utf-8")
        self.assertIn('"retainPromptOrOutputText": False', source)
        self.assertIn('"--network", NETWORK', orchestrator)
        self.assertNotIn('"--network", "host"', orchestrator)


if __name__ == "__main__":
    unittest.main()
