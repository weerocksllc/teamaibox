import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import tools.check_spark_model_soak as checker
from tools.check_spark_model_soak import check, validate_checkpoint
from tools.run_spark_model_baseline import canonical_digest


class CheckSparkModelSoakTests(unittest.TestCase):
    def fixture(self):
        launch = {
            "runId": "soak-test-24h",
            "durationSeconds": 86400,
            "profileFingerprint": "sha256:profile",
            "deploymentFingerprint": "sha256:deployment",
            "suiteDigest": "sha256:suite",
            "configurationDigest": "sha256:configuration",
            "probeSourceDigest": "sha256:source",
            "configuration": {"coreReserveBytes": 12 * 1024**3},
        }
        checkpoint = {
            "runId": launch["runId"],
            "startedAt": "2026-08-11T00:00:00Z",
            "checkpointAt": "2026-08-11T01:00:00Z",
            "deadlineAt": "2026-08-12T00:00:00Z",
            "jobs": {"submitted": 721, "completed": 721, "failed": 0, "incomplete": 0},
            "sampleCount": 61,
            "minimumHostAvailableMemoryBytes": 64 * 1024**3,
        }
        for field in ("profileFingerprint", "deploymentFingerprint", "suiteDigest", "configurationDigest", "probeSourceDigest"):
            checkpoint[field] = launch[field]
        checkpoint["checkpointDigest"] = canonical_digest(checkpoint)
        return launch, checkpoint

    def test_valid_checkpoint_reports_progress(self):
        launch, checkpoint = self.fixture()
        result = validate_checkpoint(launch, checkpoint, dt.datetime(2026, 8, 11, 1, 0, 10, tzinfo=dt.timezone.utc))
        self.assertEqual(result["jobs"]["completed"], 721)
        self.assertEqual(result["progressFraction"], round(1 / 24, 6))

    def test_tampered_checkpoint_fails_closed(self):
        launch, checkpoint = self.fixture()
        tampered = copy.deepcopy(checkpoint)
        tampered["jobs"]["failed"] = 1
        with self.assertRaisesRegex(ValueError, "digest drifted"):
            validate_checkpoint(launch, tampered, dt.datetime(2026, 8, 11, 1, 0, 10, tzinfo=dt.timezone.utc))

    def test_finalized_evidence_is_validated_without_remote_container_inspection(self):
        launch, _ = self.fixture()
        launch["profileKey"] = "llm.test.v1"
        launch["launchDigest"] = canonical_digest(launch)
        report = {
            "launchDigest": launch["launchDigest"],
            "probe": {"startedAt": "2026-08-11T00:00:00Z", "finishedAt": "2026-08-12T00:00:01Z"},
        }
        validated = {
            "runId": launch["runId"],
            "durationSeconds": 86400,
            "completedJobs": 100,
            "sampleCount": 1441,
            "minimumHostAvailableMemoryBytes": 64 * 1024**3,
            "peakTemperatureCelsius": 70,
            "evidenceDigest": "sha256:" + "a" * 64,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / f"{launch['runId']}-launch.json").write_text(json.dumps(launch), encoding="utf-8")
            report_path = root / f"{launch['runId']}.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            with (
                patch.object(checker, "EVIDENCE_ROOT", root),
                patch.object(checker, "SOAK_SUITE", root / "suite.json"),
                patch.object(checker, "validate_formal_soak_report", return_value=validated) as validator,
                patch.object(checker, "Spark", side_effect=AssertionError("remote inspection must not run")),
            ):
                (root / "suite.json").write_text("{}", encoding="utf-8")
                result = check(launch["runId"])
        self.assertEqual(result["state"], "finalized")
        self.assertEqual(result["container"], {"state": "cleaned-after-finalization"})
        self.assertFalse(result["runtimeResourcesRetained"])
        validator.assert_called_once_with(report_path, {})


if __name__ == "__main__":
    unittest.main()
