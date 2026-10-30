import datetime as dt
import unittest

from tools.capture_spark_inventory import (
    RemoteInventoryError,
    TARGETS,
    default_evidence_path,
    validate_report,
)


class CaptureSparkInventoryTests(unittest.TestCase):
    def test_only_the_local_appliance_can_be_selected(self):
        self.assertEqual(
            TARGETS,
            {
                "dgx-spark-dev-01": "operator@10.64.0.20",
            },
        )
        with self.assertRaisesRegex(RemoteInventoryError, "not allowlisted"):
            default_evidence_path("unknown-worker")
        with self.assertRaisesRegex(RemoteInventoryError, "not allowlisted"):
            default_evidence_path("dgx-spark-worker-02")

    def test_default_evidence_path_identifies_target_without_putting_addresses_in_the_report(self):
        path = default_evidence_path("dgx-spark-dev-01", dt.date(2026, 10, 16))
        self.assertTrue(path.as_posix().endswith("evidence/hardware/dgx-spark-dev-01/inventory-2026-10-16.json"))

    def test_report_must_be_read_only_and_sanitized(self):
        report = {
            "schema_version": "1.0",
            "collector": {"read_only": True},
            "platform": {"architecture": {"status": "ok", "value": "aarch64"}},
        }
        self.assertIs(validate_report(report), report)
        with self.assertRaisesRegex(RemoteInventoryError, "sanitization"):
            validate_report({**report, "network": {"ip": "redacted"}})


if __name__ == "__main__":
    unittest.main()
