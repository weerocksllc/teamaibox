import json
import pathlib
import unittest


from tools import run_spark_model_faults as faults
from tools import run_spark_model_baseline as baseline


class SparkModelFaultRunnerTests(unittest.TestCase):
    def test_every_release_candidate_has_a_bounded_fault_run_identity(self):
        catalog = json.loads(baseline.CATALOG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(len(catalog["profiles"]), 2)
        for profile in catalog["profiles"]:
            self.assertTrue(profile["validationPlan"]["certificationEligible"] is False)
            self.assertTrue(profile["scheduling"]["nodeExclusive"])
            self.assertGreater(profile["scheduling"]["maximumWorkerMemoryBytes"], faults.OOM_MEMORY_BYTES)
            self.assertRegex(baseline.server_name(profile), r"^teamaibox-model-[a-z0-9-]+$")

    def test_node_agent_restart_evidence_is_exact_and_passing(self):
        document = json.loads(faults.NODE_AGENT_EVIDENCE.read_text(encoding="utf-8"))
        self.assertEqual(document["cleanup"], "passed")
        self.assertTrue(document["nodeAgentRestart"]["readyAfterRestart"])
        self.assertTrue(document["nodeAgentRestart"]["replayedStartSameContainer"])
        self.assertRegex(faults.file_digest(faults.NODE_AGENT_EVIDENCE), r"^sha256:[a-f0-9]{64}$")

    def test_fault_probe_is_staged_from_the_repository(self):
        source = pathlib.Path(faults.ROOT / "tools" / "model_fault_probe.py")
        self.assertTrue(source.is_file())
        text = source.read_text(encoding="utf-8")
        for required in ("malformedInput", "timeout", "cancellation", "cachePressure", "resultIntegrity"):
            self.assertIn(required, text)


if __name__ == "__main__":
    unittest.main()
