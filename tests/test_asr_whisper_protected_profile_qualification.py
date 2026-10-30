from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "deploy/compute/asr-whisper-main-protected-profile.v1.json"
RUNNER = ROOT / "tools/run_asr_whisper_protected_profile_qualification.py"
VALIDATOR = ROOT / "tools/validate_asr_whisper_protected_profile_qualification.py"
PROBE = ROOT / "tools/asr_whisper_protected_profile_probe.py"
WORKER = ROOT / "services/realtime-asr-worker/server.py"


class AsrWhisperProtectedProfileQualificationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config = json.loads(CONFIG.read_text(encoding="utf-8"))
        self.runner = RUNNER.read_text(encoding="utf-8")
        self.validator = VALIDATOR.read_text(encoding="utf-8")
        self.probe = PROBE.read_text(encoding="utf-8")
        self.worker = WORKER.read_text(encoding="utf-8")

    def test_profile_retains_exact_certified_identity_on_main_box(self) -> None:
        self.assertEqual(self.config["profileId"], "b7cf5644-5558-5c62-bbf9-f1da597caae9")
        self.assertEqual(self.config["profileKey"], "asr.whisper-small.ct2-int8.spark-local.realtime.v1")
        self.assertEqual(self.config["target"]["nodeAddress"], "10.64.0.20")
        self.assertEqual(self.config["placementClass"], "protected-resident")

    def test_profile_is_warm_and_cannot_be_ordinarily_drained(self) -> None:
        runtime = self.config["runtime"]
        self.assertTrue(runtime["warm"])
        self.assertFalse(runtime["idleUnload"])
        self.assertFalse(runtime["ordinaryDrainAllowed"])
        self.assertEqual(runtime["restartPolicy"], "unless-stopped")
        self.assertEqual(runtime["probeCycles"], 2)

    def test_cpu_profile_has_bounded_concurrency_and_no_kv_cache(self) -> None:
        self.assertEqual(self.config["runtime"]["maximumConcurrentRequests"], 1)
        self.assertEqual(self.config["precision"]["kvCache"], "not-applicable")
        self.assertIn("admission = asyncio.Semaphore(1)", self.worker)
        self.assertIn('"maximum_concurrent_requests": 1', self.worker)
        self.assertIn("simultaneousRequestCount", self.probe)

    def test_profile_uses_observed_two_gib_slot_not_standalone_admission_gate(self) -> None:
        self.assertEqual(self.config["runtime"]["hardMemoryBytes"], 4 * 1024**3)
        self.assertEqual(self.config["runtime"]["memoryReservationBytes"], 1024**3)
        self.assertIn("<= 2 * 1024**3", self.runner)
        self.assertNotIn("96 * 1024**3", self.runner)

    def test_runner_revalidates_without_rewriting_profile_or_replacing_container(self) -> None:
        self.assertIn("historicalSourceLineageReplacedByFreshLiveQualification", self.runner)
        self.assertIn('"restart", "--time", "15", CONTAINER', self.runner)
        self.assertNotIn("UPDATE compute.model_profiles", self.runner)
        self.assertNotIn("DELETE FROM compute.model_profiles", self.runner)
        self.assertNotIn('"docker", "rm", CONTAINER', self.runner)

    def test_validator_rechecks_live_protocol_artifact_database_and_rootfs(self) -> None:
        for token in (
            "execute_probe(value[\"runId\"] + \"-strict\")",
            "artifact_manifest()",
            "runtime_snapshot()",
            "query(",
            'certified_image["rootfsLayers"] == runtime_image["rootfsLayers"]',
        ):
            self.assertIn(token, self.validator)

    def test_claim_boundary_does_not_close_aggregate_tasks(self) -> None:
        claim = self.config["claimBoundary"]
        self.assertTrue(claim["standaloneProtectedPlacementQualificationOnly"])
        self.assertFalse(claim["aggregateManifestUpdated"])
        self.assertFalse(claim["protectedOfficeSetDeployed"])
        self.assertFalse(claim["task21_3Complete"])
        self.assertFalse(claim["task21_4Complete"])


if __name__ == "__main__":
    unittest.main()
