from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import tools.ensure_spark_model_soak_finalized as finalizer


class EnsureSparkModelSoakFinalizedTests(unittest.TestCase):
    def arguments(self) -> list[str]:
        return ["--run-id", finalizer.RUN_ID, "--profile-key", finalizer.PROFILE_KEY]

    def validated(self) -> dict:
        return {
            "reports": [{
                "runId": finalizer.RUN_ID,
                "profileKey": finalizer.PROFILE_KEY,
                "evidenceDigest": "sha256:" + "a" * 64,
            }],
        }

    def test_existing_valid_report_is_reused_without_remote_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(finalizer, "REPORT", Path(directory) / "report.json"), \
                patch.object(finalizer, "validate_soak", return_value=self.validated()), \
                patch.object(finalizer.subprocess, "run") as run:
            finalizer.REPORT.write_text("{}", encoding="utf-8")
            self.assertEqual(finalizer.main(self.arguments()), 0)
            run.assert_not_called()

    def test_existing_invalid_report_fails_closed_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(finalizer, "REPORT", Path(directory) / "report.json"), \
                patch.object(finalizer, "validate_soak", side_effect=ValueError("invalid")), \
                patch.object(finalizer.subprocess, "run") as run:
            finalizer.REPORT.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid"):
                finalizer.main(self.arguments())
            run.assert_not_called()

    def test_missing_report_executes_the_exact_resume_once_and_revalidates(self) -> None:
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(finalizer, "REPORT", Path(directory) / "report.json"), \
                patch.object(finalizer, "validate_soak", return_value=self.validated()) as validate, \
                patch.object(finalizer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(finalizer.main(self.arguments()), 0)
            run.assert_called_once()
            command = run.call_args.args[0]
            self.assertEqual(command[-5:], ["--profile-key", finalizer.PROFILE_KEY, "--run-id", finalizer.RUN_ID, "--resume"])
            validate.assert_called_once()

    def test_unallowlisted_identity_is_rejected_before_execution(self) -> None:
        with patch.object(finalizer.subprocess, "run") as run:
            with self.assertRaisesRegex(finalizer.SoakFinalizationError, "not allowlisted"):
                finalizer.main(["--run-id", "soak-other", "--profile-key", finalizer.PROFILE_KEY])
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
