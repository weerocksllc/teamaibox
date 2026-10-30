from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CurrentLeaseReconciliationQualificationSourceTests(unittest.TestCase):
    def test_product_probe_covers_transaction_fencing_dispatch_and_recovery(self) -> None:
        source = (ROOT / "deploy/application-catalog-e2e/current-lease-reconciliation-probe.mjs").read_text()
        for marker in (
            "PostgresLeaseRepository", "stale_node_generation", "acquisition_key_conflict",
            "active_job_lease_exists", "stale_lease_fence", "duplicate_dispatch",
            "acknowledgeDispatch", "manual_reconcile", "retryFenceIncreased",
            "job_cancelled", "aes-256-gcm",
        ):
            self.assertIn(marker, source)
        self.assertNotIn("docker run", source)

    def test_predispatch_cancellation_fix_is_deployed_and_regressed(self) -> None:
        repository = (ROOT / "apps/platform-api/src/compute/postgres-durable-job-repository.mjs").read_text()
        test = (ROOT / "apps/platform-api/test/postgres-durable-job-repository.test.mjs").read_text()
        self.assertIn('status === "cancelled" && current.currentAttemptId', repository)
        self.assertIn('releaseReason: "job_cancelled"', repository)
        self.assertIn("pre-dispatch cancellation atomically finalizes", test)


if __name__ == "__main__":
    unittest.main()
