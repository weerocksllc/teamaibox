from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from tools import run_qwen38_main_protected_profile_qualification as qualification
from tools.run_qwen38_main_protected_profile_qualification import (
    CONFIG,
    REPLICATION_PARENT,
    aggregate_memory,
    build_profile_document,
    launch_command,
    load_config,
    profile_package,
    registration_preflight,
    registration_sql,
    validate_replication_parent_payload,
)
from tools.run_spark_model_baseline import canonical_digest


ROOT = Path(__file__).resolve().parents[1]


def replication_fixture(config: dict) -> dict:
    manifest = {"files": [], "totalBytes": config["artifact"]["weightsSizeBytes"]}
    value = {
        "schemaVersion": 1,
        "runnerId": "teamaibox.qwen38-main-artifact-replication.v1",
        "runId": config["artifact"]["replicationRunId"],
        "status": "passed",
        "startedAt": "2026-09-04T00:00:00.000Z",
        "completedAt": "2026-09-04T00:01:00.000Z",
        "source": {"ssh": "operator@10.64.0.23", "volume": "source"},
        "target": {
            "ssh": "operator@10.64.0.20", "nodeAddress": "10.64.0.20",
            "nodeRole": "main-box", "volume": config["artifact"]["volume"],
        },
        "parent": {"runId": "synthetic-quantization-parent"},
        "sources": [],
        "runtimeImage": {
            "source": {"imageId": config["engine"]["imageId"], "architecture": "arm64"},
            "target": {"imageId": config["engine"]["imageId"], "architecture": "arm64"},
            "byteIdentity": True,
        },
        "artifact": {
            "sourceManifest": manifest, "targetManifest": manifest,
            "artifactDigest": config["artifact"]["weightsArtifactDigest"], "byteIdentity": True,
        },
        "privacy": {"credentialsRetained": False},
        "claimBoundary": {
            "artifactReplicated": True, "runtimeImageReplicated": True,
            "profileDeployed": False, "task21_3Complete": False,
        },
        "cleanup": {"successfulTargetVolumeRetained": True},
        "failure": None,
    }
    value["evidenceDigest"] = canonical_digest(value)
    return value


class Qwen38MainProtectedProfileQualificationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_config()

    def test_config_is_exact_main_box_protected_resident_without_ordinary_gate(self) -> None:
        self.assertEqual(self.config["target"]["ssh"], "operator@10.64.0.20")
        self.assertEqual(self.config["target"]["nodeRole"], "main-box")
        self.assertEqual(self.config["placementClass"], "protected-resident")
        self.assertEqual(
            self.config["engine"]["imageId"],
            "sha256:f0fc6c02f8d0c6edc6fa7cd10b33cbb5c3faa717a0d2350c760d7999be2daee8",
        )
        self.assertEqual(
            self.config["artifact"]["volume"],
            "teamaibox-qwen38-27b-main-protected-1d4bf0f2",
        )
        runtime = self.config["runtime"]
        self.assertTrue(runtime["warm"])
        self.assertFalse(runtime["idleUnload"])
        self.assertFalse(runtime["ordinaryDrainAllowed"])
        self.assertEqual(runtime["maximumContextTokens"], 32768)
        self.assertEqual(runtime["maximumConcurrentRequests"], 2)
        self.assertEqual(runtime["kvCacheBytes"], 3 * 1024**3)
        self.assertNotIn("minimumAvailableAfterDrainBytes", runtime)
        self.assertNotIn("admissionGiB", runtime)

    def test_future_replication_parent_can_be_checked_with_synthetic_fixture(self) -> None:
        self.assertEqual(
            REPLICATION_PARENT.name,
            "qwen38-main-artifact-replication-20260904-a4.json",
        )
        value = replication_fixture(self.config)
        facts = validate_replication_parent_payload(value, self.config)
        self.assertEqual(facts["runId"], self.config["artifact"]["replicationRunId"])
        self.assertEqual(facts["artifactDigest"], self.config["artifact"]["weightsArtifactDigest"])
        drifted = deepcopy(value)
        drifted["runtimeImage"]["target"]["imageId"] = "sha256:" + "0" * 64
        unsigned = dict(drifted)
        unsigned.pop("evidenceDigest")
        drifted["evidenceDigest"] = canonical_digest(unsigned)
        with self.assertRaisesRegex(Exception, "runtime image drifted"):
            validate_replication_parent_payload(drifted, self.config)

    def test_profile_package_is_stable_and_distinct_from_weight_artifact(self) -> None:
        parent = validate_replication_parent_payload(replication_fixture(self.config), self.config)
        first = profile_package(self.config, parent)
        second = profile_package(self.config, parent)
        self.assertEqual(first, second)
        self.assertNotEqual(first["digest"], self.config["artifact"]["weightsArtifactDigest"])
        self.assertEqual(
            first["document"]["weights"]["digest"],
            self.config["artifact"]["weightsArtifactDigest"],
        )
        self.assertEqual(first["document"]["engine"], self.config["engine"])
        self.assertEqual(first["document"]["precision"], self.config["precision"])

    def test_launch_replaces_port_8001_with_exact_hardened_warm_runtime(self) -> None:
        command = launch_command(
            self.config, "qwen38-main-protected-profile-qualification-20260904-a1"
        )
        joined = " ".join(command)
        for token in (
            "--publish 8001:8000", "--read-only", "--cap-drop ALL",
            "no-new-privileges", "--kv-cache-memory-bytes 3221225472",
            "--kv-cache-dtype fp8", "--max-model-len 32768", "--max-num-seqs 2",
            "com.teamaibox.placement-class=protected-resident",
            "com.teamaibox.ordinary-drain-allowed=false",
            "com.teamaibox.idle-unload=false",
        ):
            self.assertIn(token, joined)
        self.assertNotIn("96", joined)
        self.assertNotIn("minimumAvailableAfterDrain", joined)

    def test_memory_envelope_is_conservative_across_two_cycles(self) -> None:
        value = aggregate_memory((
            {"nvidiaAllocatedBytes": 100, "containerCurrentBytes": 60,
             "conservativeCombinedBytes": 160, "hostMemoryAvailableBytes": 500},
            {"nvidiaAllocatedBytes": 90, "containerCurrentBytes": 70,
             "conservativeCombinedBytes": 160, "hostMemoryAvailableBytes": 450},
        ))
        self.assertEqual(value["observedCombinedPeakBytes"], 160)
        self.assertEqual(value["conservativeComponentEnvelopeBytes"], 170)
        self.assertEqual(value["admissionBytes"], 170)
        self.assertEqual(value["minimumHostMemoryAvailableBytes"], 450)

    def test_profile_document_discloses_package_and_weights_separately(self) -> None:
        parent = validate_replication_parent_payload(replication_fixture(self.config), self.config)
        package = profile_package(self.config, parent)
        runtime = {"containerId": "a" * 64, "coldStartMs": 1}
        memory = {
            "nvidiaAllocatedPeakBytes": 1, "containerCurrentPeakBytes": 1,
            "observedCombinedPeakBytes": 2, "conservativeComponentEnvelopeBytes": 2,
            "admissionBytes": 2, "minimumHostMemoryAvailableBytes": 64 * 1024**3,
        }
        document = build_profile_document(
            self.config, parent, package, runtime, memory,
            "qwen38-main-protected-profile-qualification-20260904-a1",
            "2026-09-04T00:00:00.000Z",
        )
        self.assertEqual(document["artifactDigest"], package["digest"])
        self.assertEqual(document["artifacts"][0]["digest"], self.config["artifact"]["weightsArtifactDigest"])
        self.assertEqual(document["artifacts"][1]["role"], "profile-package")
        self.assertEqual(document["source"]["revision"], self.config["source"]["revision"])
        self.assertEqual(document["engine"]["version"], self.config["engine"]["version"])
        self.assertEqual(document["precision"], "nvfp4")
        self.assertEqual(document["placementClass"], "protected-resident")
        self.assertEqual(document["target"]["nodeRole"], "main-box")

    def test_registration_is_one_final_transaction_with_profile_and_placement(self) -> None:
        parent = validate_replication_parent_payload(replication_fixture(self.config), self.config)
        package = profile_package(self.config, parent)
        memory = {
            "nvidiaAllocatedPeakBytes": 1, "containerCurrentPeakBytes": 1,
            "observedCombinedPeakBytes": 2, "conservativeComponentEnvelopeBytes": 2,
            "admissionBytes": 2, "minimumHostMemoryAvailableBytes": 64 * 1024**3,
        }
        runtime = {"containerId": "a" * 64, "coldStartMs": 1}
        run_id = "qwen38-main-protected-profile-qualification-20260904-a1"
        document = build_profile_document(
            self.config, parent, package, runtime, memory, run_id,
            "2026-09-04T00:00:00.000Z",
        )
        sql = registration_sql(
            self.config, document, "1" * 64, package["digest"], memory,
            {"cycles": 2},
            {"nodeGroupId": self.config["target"]["nodeGroupId"], "maintenanceGeneration": 1},
            run_id,
        )
        self.assertEqual(sql.count("BEGIN;"), 1)
        self.assertEqual(sql.count("COMMIT;"), 1)
        for table in (
            "compute.model_profiles", "compute.model_profile_registrations",
            "compute.model_profile_lifecycle_events",
            "compute.model_profile_placement_revisions",
        ):
            self.assertIn("INSERT INTO " + table, sql)
        self.assertIn(package["digest"], sql)
        self.assertIn(self.config["artifact"]["weightsArtifactDigest"], json.dumps(document))
        runner = (ROOT / "tools/run_qwen38_main_protected_profile_qualification.py").read_text()
        self.assertLess(runner.index("second_protocol = run_probe"), runner.index("query(registration_sql("))
        self.assertLess(runner.index("version = remote"), runner.index("query(registration_sql("))

    def test_registration_preflight_rejects_occupied_identity_before_port_mutation(self) -> None:
        parent = validate_replication_parent_payload(replication_fixture(self.config), self.config)
        package = profile_package(self.config, parent)
        with patch.object(qualification, "query", return_value=["true|true|true|true|true|true"]):
            facts = registration_preflight(self.config, package["digest"], "bounded-run-a1")
        self.assertTrue(all(facts.values()))
        with patch.object(qualification, "query", return_value=["true|false|true|true|true|true"]):
            with self.assertRaisesRegex(Exception, "identity is occupied"):
                registration_preflight(self.config, package["digest"], "bounded-run-a1")
        runner = (ROOT / "tools/run_qwen38_main_protected_profile_qualification.py").read_text()
        self.assertLess(
            runner.index('report["registrationPreflight"] = registration_preflight'),
            runner.index('"sudo", "docker", "stop", "--time", "120"'),
        )

    def test_probe_covers_answer_agent_tool_stream_cancel_and_two_concurrent(self) -> None:
        source = (ROOT / "tools/qwen38_main_protected_profile_probe.py").read_text()
        for token in (
            "answer_probe", "agent_probe", "completedToolLoop", "tool_choice",
            "context_32k_probe", '"alpha beta gamma delta " * 7168',
            '"targetMinimumPromptTokens": 28000', "stream_probe", "cancel_probe",
            "ThreadPoolExecutor(max_workers=2)",
            '"requestCount": len(results)', '"contentRetained": False',
        ):
            self.assertIn(token, source)
        self.assertNotIn('"content": content', source)

    def test_failure_cleanup_is_exact_and_aggregate_manifest_is_out_of_scope(self) -> None:
        runner = (ROOT / "tools/run_qwen38_main_protected_profile_qualification.py").read_text()
        validator = (ROOT / "tools/validate_qwen38_main_protected_profile_qualification.py").read_text()
        self.assertIn('current["containerId"] == worker_id', runner)
        self.assertIn('current["labels"].get("com.teamaibox.run-id") == run_id', runner)
        self.assertIn("failedGemmaPredecessorRestored", runner)
        self.assertIn("predecessor_stopped", runner)
        self.assertIn('"aggregateManifestUpdated": False', runner)
        self.assertIn('"task21_3Complete": False', validator)
        for source in (runner, validator):
            self.assertNotIn("protected-office-profile-set.v1.json", source)
            self.assertNotIn("ADMISSION_GIB", source)
            self.assertNotIn("post-drain MemAvailable", source)


if __name__ == "__main__":
    unittest.main()
