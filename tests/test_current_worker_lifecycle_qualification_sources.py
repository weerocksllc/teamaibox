from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CurrentWorkerLifecycleQualificationSourceTests(unittest.TestCase):
    def test_product_probe_uses_production_lifecycle_and_real_node_agent(self) -> None:
        source = (ROOT / "deploy/application-catalog-e2e/current-worker-lifecycle-probe.mjs").read_text()
        for marker in (
            "createManagedNodeRuntimeFromEnvironment", "PostgresWorkerRepository",
            "ManagedNodeWorkerControlTransport", "PostgresWorkerEventSink",
            "WorkerLifecycleManager", "ensureReady", "bindAttempt", "execute",
            "cancel", "stopIdle", "unload", "recordCrash", "recoverCircuits",
            "worker_circuit_open", "worker_identity_conflict", "aes-256-gcm",
        ):
            self.assertIn(marker, source)
        self.assertNotIn("docker run", source)
        self.assertNotIn("docker rm", source)

    def test_idle_sweep_is_scoped_to_the_run_owned_worker(self) -> None:
        source = (ROOT / "deploy/application-catalog-e2e/current-worker-lifecycle-probe.mjs").read_text()
        self.assertIn("filter((item) => item.workerId === workerId)", source)
        self.assertIn('scope: "run_owned_worker_only"', source)
        self.assertNotIn("baselineWorkerId", source)

    def test_bootstrap_terminalizes_one_real_job_before_resume(self) -> None:
        source = (ROOT / "deploy/application-catalog-e2e/current-worker-lifecycle-bootstrap-probe.mjs").read_text()
        for marker in ("DurableJobService", "LeaseManager", "jobs.submit", "leases.acquire",
                       "jobs.cancel", 'expectedStatus: "cancelled"', "aes-256-gcm"):
            self.assertIn(marker, source)
        self.assertIn('everyOwnedLeaseReleased: true', source)

    def test_worker_identity_excludes_bootstrap_attempt_but_keeps_control_authority_immutable(self) -> None:
        repository = (ROOT / "services/scheduler/src/postgres-worker-repository.mjs").read_text()
        test = (ROOT / "services/scheduler/test/postgres-worker-repository.test.mjs").read_text()
        immutable_block = repository.split('for (const key of [', 1)[1].split(']) {', 1)[0]
        self.assertNotIn('"attemptId"', immutable_block)
        for marker in ('"controlLeaseId"', '"controlFencingToken"'):
            self.assertIn(marker, immutable_block)
        self.assertIn("allowing a new attempt binding", test)
        self.assertIn("control_fencing_token", test)

    def test_crash_revokes_all_bound_attempt_authority(self) -> None:
        manager = (ROOT / "services/scheduler/src/worker-lifecycle-manager.mjs").read_text()
        test = (ROOT / "services/scheduler/test/worker-lifecycle-manager.test.mjs").read_text()
        self.assertIn("...Object.keys(current.attemptBindings ?? {})", manager)
        self.assertIn("current.attemptBindings = {}", manager)
        self.assertIn("revokes bound authority even before the attempt becomes active", test)

if __name__ == "__main__":
    unittest.main()
