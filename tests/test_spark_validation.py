import json
import pathlib
import tarfile
import tempfile
import unittest

from tools.spark_validation import (
    DEFAULT_EVIDENCE_ROOT,
    SPARK_TARGETS,
    SparkValidationError,
    ValidationRun,
    _create_source_archive,
    _safe_tail,
    _write_evidence,
    evidence_path_for_run,
    load_matrix,
    matrix_for_target,
    select_validation,
)


ROOT = pathlib.Path(__file__).resolve().parents[1]


class SparkValidationTests(unittest.TestCase):
    def test_every_validation_container_uses_the_preloaded_locked_image(self) -> None:
        source = (ROOT / "tools" / "spark_validation.py").read_text(encoding="utf-8")
        self.assertIn('"docker", "run", "--pull", "never", "--rm"', source)

    def test_unified_memory_binary_uses_only_the_bounded_exec_tmpfs(self) -> None:
        source = (ROOT / "tools" / "spark_validation.py").read_text(encoding="utf-8")
        self.assertIn('"--tmpfs", "/work:rw,exec,nosuid,nodev,size=64m"', source)
        self.assertIn("/work/smoke", source)
        self.assertNotIn("/tmp/smoke", source)

    def setUp(self):
        self.matrix = load_matrix()

    def test_web_change_selects_arm64_contract_and_http_https_suite(self):
        plan = select_validation(self.matrix, ["apps/web/src/App.tsx"])
        self.assertEqual(plan["riskClasses"], ["web-delivery"])
        self.assertEqual(plan["suites"], ["node-contracts", "web-boundary"])
        self.assertTrue(plan["sparkRequired"])
        checks = self.matrix["suites"]["web-boundary"]["checks"]
        self.assertEqual(self.matrix["suites"]["web-boundary"]["sparkBuildMode"], "full-container-build-host-network")
        self.assertEqual(self.matrix["suites"]["web-boundary"]["buildNetworkScope"], "dependency-build-only-never-runtime")
        self.assertIn("http-health", checks)
        self.assertIn("https-health", checks)

    def test_host_and_gpu_change_deduplicates_host_drift(self):
        plan = select_validation(
            self.matrix,
            ["tools/host_drift.py", "services/node-agent/README.md"],
        )
        self.assertEqual(plan["suites"].count("host-drift"), 1)
        self.assertIn("gpu-injection", plan["suites"])
        self.assertIn("unified-memory", plan["suites"])

    def test_persistence_change_selects_node_contracts_and_disposable_database_smoke(self):
        plan = select_validation(
            self.matrix,
            ["packages/persistence/migrations/000010_storage_pools.up.sql"],
        )
        self.assertEqual(plan["riskClasses"], ["control-plane", "database-schema"])
        self.assertEqual(plan["suites"], ["node-contracts", "database-smoke"])
        database = self.matrix["suites"]["database-smoke"]
        self.assertEqual(database["container"]["network"], "none")
        self.assertTrue(database["container"]["readOnly"])
        validation_source = (ROOT / "tools" / "spark_validation.py").read_text(encoding="utf-8")
        smoke_source = (ROOT / "tools" / "ci_database_smoke.py").read_text(encoding="utf-8")
        self.assertIn('"database-runtime-image"', validation_source)
        self.assertIn('"--pull", "never"', smoke_source)

    def test_core_reserve_change_selects_real_survival_saturation(self):
        plan = select_validation(self.matrix, ["services/scheduler/src/managed-node-scheduling.mjs"])
        self.assertIn("core-service-reserve", plan["riskClasses"])
        self.assertIn("core-service-survival", plan["suites"])
        checks = self.matrix["suites"]["core-service-survival"]["checks"]
        self.assertEqual(set(checks) & {
            "identity", "administration", "files", "messaging",
            "database", "object", "queue",
        }, {
            "identity", "administration", "files", "messaging",
            "database", "object", "queue",
        })
        policy = json.loads((ROOT / "deploy/compose/resource-policy.json").read_text(encoding="utf-8"))
        self.assertEqual(set(policy["serviceObjectives"]), {
            "identity", "administration", "files", "messaging", "database", "object", "queue",
        })
        self.assertTrue(all(value["minimumSuccessRate"] == 1 for value in policy["serviceObjectives"].values()))
        self.assertIn("deploy/compose/core-service-objective.mjs", self.matrix["suites"]["core-service-survival"]["sourcePaths"])
        runner = (ROOT / "tools/spark_validation.py").read_text(encoding="utf-8")
        probe = (ROOT / "tools/core_service_survival_probe.py").read_text(encoding="utf-8")
        self.assertIn('"--run-id", self.run_id', runner)
        self.assertIn('"--target", self.matrix["target"]["key"]', runner)
        self.assertIn('"validationRunLabel": run_id', probe)
        self.assertIn('"workers": 4', probe)
        self.assertIn('"touchedBytes": 536_870_912', probe)

    def test_realtime_capacity_change_selects_arm64_contract_and_database_smoke(self):
        plan = select_validation(
            self.matrix,
            ["services/scheduler/src/realtime-reservation-manager.mjs"],
        )
        self.assertIn("realtime-capacity", plan["riskClasses"])
        self.assertEqual(plan["suites"], ["node-contracts", "database-smoke"])
        self.assertIn(
            "deploy/compose/resource-policy.json",
            self.matrix["suites"]["node-contracts"]["sourcePaths"],
        )

    def test_plugin_runtime_contracts_stage_the_import_policy(self):
        plan = select_validation(
            self.matrix,
            ["services/plugin-runtime/src/plugin-import-service.mjs"],
        )
        self.assertIn("node-contracts", plan["suites"])
        self.assertIn(
            "deploy/plugins",
            self.matrix["suites"]["node-contracts"]["sourcePaths"],
        )

    def test_node_contract_workspace_links_include_every_bare_workspace_import(self):
        source = (ROOT / "tools" / "spark_validation.py").read_text(encoding="utf-8")
        self.assertIn('/@teamaibox/authorization', source)
        self.assertIn('/@teamaibox/plugin-sdk', source)

    def test_sample_plugins_select_arm64_contracts_and_stage_examples(self):
        plan = select_validation(self.matrix, ["examples/plugins/team-notes/manifest.json"])
        self.assertIn("plugin-samples", plan["riskClasses"])
        self.assertEqual(plan["suites"], ["node-contracts"])
        self.assertIn("examples/plugins", self.matrix["suites"]["node-contracts"]["sourcePaths"])

    def test_external_compute_e2e_is_a_bounded_explicit_spark_suite(self):
        suite = self.matrix["suites"]["external-compute-e2e"]
        self.assertTrue(suite["hardwareSensitive"])
        self.assertEqual(suite["imageLock"], "node-runtime")
        self.assertEqual(suite["container"], {
            "network": "none", "readOnly": True, "memory": "512m", "cpus": "1", "pids": 128,
        })
        self.assertIn("services/scheduler/test/external-compute-e2e.test.mjs", suite["sourcePaths"])
        run = ValidationRun(self.matrix, ["external-compute-e2e"], "external-compute-test-a1")
        self.assertEqual(run.suites, ["external-compute-e2e"])

    def test_unified_memory_guard_selects_real_pressure_and_bounded_oom_checks(self):
        plan = select_validation(
            self.matrix,
            ["services/scheduler/src/unified-memory-guard.mjs"],
        )
        self.assertIn("unified-memory-safeguard", plan["riskClasses"])
        self.assertIn("memory-pressure-guard", plan["suites"])
        checks = self.matrix["suites"]["memory-pressure-guard"]["checks"]
        self.assertIn("driver-vram-unavailable", checks)
        self.assertIn("bounded-cgroup-oom", checks)

    def test_maintenance_path_requires_separate_approval(self):
        plan = select_validation(self.matrix, ["deploy/maintenance/luks/migrate.json"])
        self.assertEqual(plan["manualApprovalRequired"], ["maintenance-gated"])
        self.assertTrue(plan["sparkRequired"])

    def test_path_escape_and_unsafe_run_identity_are_rejected(self):
        with self.assertRaises(SparkValidationError):
            select_validation(self.matrix, ["../outside"])
        with self.assertRaises(SparkValidationError):
            ValidationRun(self.matrix, ["host-drift"], "unsafe/value")
        changed = json.loads(json.dumps(self.matrix))
        changed["target"]["ssh"] = "root@unapproved"
        with self.assertRaises(SparkValidationError):
            ValidationRun(changed, ["host-drift"], "safe-run-1234")

    def test_evidence_paths_are_run_scoped_immutable_and_core_specific(self):
        generic = "generic-validation-20990101-a1"
        expected = DEFAULT_EVIDENCE_ROOT / f"2099-01-01-{generic}.json"
        self.assertEqual(
            evidence_path_for_run(generic, ["node-contracts"], date="2099-01-01"),
            expected.resolve(),
        )
        core = "20990101-core-survival-a1"
        core_path = DEFAULT_EVIDENCE_ROOT / "core-service-survival-20990101-a1.json"
        self.assertEqual(
            evidence_path_for_run(core, ["core-service-survival"], core_path),
            core_path.resolve(),
        )
        self.assertEqual(
            evidence_path_for_run(core, ["database-smoke", "core-service-survival"], core_path),
            core_path.resolve(),
        )
        with self.assertRaisesRegex(SparkValidationError, "match its run identity"):
            evidence_path_for_run(core, ["core-service-survival"], DEFAULT_EVIDENCE_ROOT / "latest.json")
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "evidence.json"
            _write_evidence(path, {"runId": generic})
            with self.assertRaisesRegex(SparkValidationError, "will not be overwritten"):
                _write_evidence(path, {"runId": "changed"})
        source = (ROOT / "tools/spark_validation.py").read_text(encoding="utf-8")
        main = source[source.index("def main(") :]
        self.assertLess(main.index("evidence_path_for_run("), main.index("validation.execute()"))

    def test_local_appliance_target_binds_its_inventory_baseline(self):
        selected = matrix_for_target(self.matrix, "dgx-spark-dev-01")
        self.assertEqual(selected["target"], {
            **self.matrix["target"],
            "key": "dgx-spark-dev-01",
            "ssh": "operator@10.64.0.20",
            "architecture": "linux/arm64/v8",
        })
        self.assertEqual(self.matrix["target"]["key"], "dgx-spark-dev-01")
        run = ValidationRun(selected, ["database-smoke"], "appliance-target-test-a1")
        self.assertEqual(run.inventory_path, SPARK_TARGETS["dgx-spark-dev-01"]["inventory"])
        self.assertTrue(run.inventory_path.is_file())
        with self.assertRaisesRegex(SparkValidationError, "unknown Spark validation target"):
            matrix_for_target(self.matrix, "dgx-spark-worker-02")

    def test_unknown_logical_spark_target_is_rejected(self):
        with self.assertRaisesRegex(SparkValidationError, "unknown Spark validation target"):
            matrix_for_target(self.matrix, "unapproved-spark")

    def test_source_archive_is_content_addressed_and_excludes_build_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            first = pathlib.Path(directory) / "first.tar.gz"
            second = pathlib.Path(directory) / "second.tar.gz"
            first_digest, first_count = _create_source_archive(["apps/web"], first)
            second_digest, second_count = _create_source_archive(["apps/web"], second)
            self.assertEqual(first_digest, second_digest)
            self.assertEqual(first_count, second_count)
            with tarfile.open(first, "r:gz") as archive:
                names = archive.getnames()
            self.assertTrue(any(name.endswith("server/web-boundary.mjs") for name in names))
            self.assertFalse(any("/dist/" in "/" + name + "/" for name in names))
            self.assertFalse(any("/node_modules/" in "/" + name + "/" for name in names))

    def test_failure_tail_redacts_secret_shaped_values(self):
        tail = _safe_tail("status ok\nAuthorization: Bearer-secret", "password=do-not-keep")
        serialized = "\n".join(tail)
        self.assertNotIn("Bearer-secret", serialized)
        self.assertNotIn("do-not-keep", serialized)
        self.assertIn("[REDACTED]", serialized)

    def test_matrix_requires_failure_cleanup_and_residual_gates(self):
        policy = self.matrix["claimPolicy"]
        self.assertTrue(policy["blockOnRequiredFailure"])
        self.assertTrue(policy["blockOnResidualState"])
        self.assertFalse(policy["allowStaleHardwareEvidence"])
        for suite in self.matrix["suites"].values():
            self.assertLessEqual(suite["timeoutSeconds"], 1800)


if __name__ == "__main__":
    unittest.main()
