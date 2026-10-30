import datetime as dt
import tempfile
from pathlib import Path
import unittest

from tools import model_soak_probe as probe


class ModelSoakProbeTests(unittest.TestCase):
    def test_journal_is_durable_gap_free_and_rejects_duplicate_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "jobs.sqlite3"
            journal = probe.Journal(path, "soak-test-a1", probe.utc_now())
            identity = probe.job_id("soak-test-a1", 0)
            journal.submit(0, identity)
            result = {
                "outcome": "completed", "latencyMs": 10.0, "promptTokens": 4,
                "completionTokens": 1, "contentDigest": probe.digest_bytes(b"OK"),
                "providerResponseId": "response-0",
            }
            journal.complete(0, result)
            self.assertEqual(journal.counts(), {"submitted": 1, "completed": 1, "failed": 0, "incomplete": 0})
            integrity = journal.integrity("soak-test-a1")
            self.assertEqual(integrity["expectedJobSequenceDigest"], integrity["completedJobSequenceDigest"])
            self.assertEqual(integrity["lostJobs"], 0)
            with self.assertRaisesRegex(probe.SoakError, "duplicated or lost"):
                journal.complete(0, result)
            journal.close()
            resumed = probe.Journal(path, "soak-test-a1", probe.utc_now())
            self.assertEqual(resumed.next_index(), 1)
            resumed.close()

    def test_analysis_accepts_stable_memory_thermal_throughput_and_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            started = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=60)).isoformat().replace("+00:00", "Z")
            journal = probe.Journal(Path(directory) / "jobs.sqlite3", "soak-analysis-a1", started)
            for index in range(10):
                journal.submit(index, probe.job_id("soak-analysis-a1", index))
                journal.complete(index, {
                    "outcome": "completed", "latencyMs": 100.0, "promptTokens": 8,
                    "completionTokens": 1, "contentDigest": probe.digest_bytes(b"OK"),
                    "providerResponseId": f"response-{index}",
                })
            now = dt.datetime.now(dt.timezone.utc)
            samples = []
            for ordinal in range(3):
                observed = now - dt.timedelta(seconds=60 - ordinal * 30)
                samples.append({
                    "observedAt": observed.isoformat().replace("+00:00", "Z"),
                    "memory": {"totalBytes": 128 * 1024**3, "availableBytes": 64 * 1024**3, "usedBytes": 64 * 1024**3},
                    "nvidia": {"status": "measured", "utilizationPercent": 50, "temperatureCelsius": 65, "powerWatts": 90},
                    "healthPassed": True,
                })
            result = probe.analyze(samples, journal, 60, 12 * 1024**3, enforce_long_duration_trends=True)
            self.assertTrue(result["passed"])
            self.assertTrue(all(result["acceptance"].values()))
            self.assertEqual(result["jobs"]["lostJobs"], 0)
            journal.close()

    def test_linear_growth_reports_bytes_per_hour(self):
        now = dt.datetime.now(dt.timezone.utc)
        samples = [
            {"observedAt": (now + dt.timedelta(hours=index)).isoformat().replace("+00:00", "Z"), "memory": {"usedBytes": index * 1000}}
            for index in range(3)
        ]
        self.assertAlmostEqual(probe.linear_memory_growth(samples), 1000.0)


if __name__ == "__main__":
    unittest.main()
