from __future__ import annotations

import json
from pathlib import Path
import unittest

from tools.run_lmt4_protected_profile_qualification import aggregate_peak_memory


ROOT = Path(__file__).resolve().parents[1]


class Lmt4ProtectedProfileQualificationTest(unittest.TestCase):
    def test_profile_is_bounded_and_protected(self) -> None:
        value = json.loads((ROOT / "deploy/compute/lmt4-protected-profile.v1.json").read_text())
        self.assertEqual(value["placementClass"], "protected-resident")
        self.assertEqual(value["runtime"]["kvCacheBytes"], 2 * 1024**3)
        self.assertEqual(value["runtime"]["maximumConcurrentRequests"], 4)
        self.assertEqual(value["runtime"]["hardMemoryBytes"], 12 * 1024**3)
        self.assertFalse(value["runtime"]["idleUnload"])
        self.assertFalse(value["runtime"]["ordinaryDrainAllowed"])
        self.assertEqual(value["runtime"]["runtimeEnvironment"]["HOME"], "/tmp")
        self.assertEqual(value["runtime"]["runtimeEnvironment"]["USER"], "teamaibox")
        self.assertTrue(value["runtime"]["jitCache"]["executable"])
        self.assertTrue(value["runtime"]["jitCache"]["ephemeral"])

    def test_runner_uses_exact_hardened_successor_and_rollback(self) -> None:
        source = (ROOT / "tools/run_lmt4_protected_profile_qualification.py").read_text()
        for token in ("--kv-cache-memory-bytes", '"2G"', "--max-num-seqs", '"4"',
                      '"--read-only"', '"--cap-drop", "ALL"', '"no-new-privileges"',
                      '"--memory", "12g"', '"--memory-reservation", "8g"',
                      '"/tmp:rw,exec,nosuid,nodev,size=512m"',
                      '"HOME=/tmp"', '"USER=teamaibox"', '"TORCHINDUCTOR_CACHE_DIR=/tmp/torchinductor"',
                      "rollback", "previousRuntimeRestored", "protected-resident"):
            self.assertIn(token, source)
        self.assertNotIn('/tmp:rw,noexec', source)
        self.assertIn('/tmp:rw,exec', source)

    def test_registry_document_uses_the_required_profile_shape(self) -> None:
        source = (ROOT / "tools/run_lmt4_protected_profile_qualification.py").read_text()
        for field in ("executionKind", "artifacts", "artifactDigest", "quantizationRecipe",
                      "apiContracts", "limits", "resourceEnvelope", "coldStart",
                      "dataPolicy", "knownLimitations", "validationEvidence",
                      "certification", "createdAt"):
            self.assertIn(f'"{field}"', source)
        self.assertIn('"executionKind": "local_worker"', source)
        self.assertIn('"externalProcessing": "forbidden"', source)
        self.assertIn("$created${document['createdAt']}$created$::timestamptz", source)

    def test_probe_is_parallel_aligned_and_content_free(self) -> None:
        source = (ROOT / "tools/lmt4_protected_profile_probe.py").read_text()
        self.assertIn("ThreadPoolExecutor(max_workers=4)", source)
        self.assertIn('"parallelRequestCount": len(results)', source)
        self.assertIn('"contentRetained": False', source)
        self.assertNotIn('"outputs": outputs', source)

    def test_validator_rechecks_live_identity_and_claim_boundary(self) -> None:
        source = (ROOT / "tools/validate_lmt4_protected_profile_qualification.py").read_text()
        for token in ("live[\"containerId\"]", "live[\"imageId\"] == IMAGE_ID",
                      "productCapabilityParentPassed", '"task21_3Complete": False',
                      "live LMT4 OpenAI protocol probe failed"):
            self.assertIn(token, source)

    def test_peak_memory_recomputes_conservative_sum_across_cycles(self) -> None:
        peak = aggregate_peak_memory(
            {"nvidiaAllocatedBytes": 100, "containerCurrentBytes": 60,
             "conservativeCombinedBytes": 160},
            {"nvidiaAllocatedBytes": 90, "containerCurrentBytes": 70,
             "conservativeCombinedBytes": 160},
        )
        self.assertEqual(peak, {
            "nvidiaAllocatedBytes": 100,
            "containerCurrentBytes": 70,
            "conservativeCombinedBytes": 170,
        })


if __name__ == "__main__":
    unittest.main()
