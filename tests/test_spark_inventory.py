from __future__ import annotations

import unittest

from tools.spark_inventory import (
    CommandOutput,
    _parse_csv_rows,
    _mount_roles,
    _parse_os_release,
    _safe_float,
    assert_sanitized,
)


class SparkInventorySanitizationTests(unittest.TestCase):
    def test_accepts_allowlisted_report(self) -> None:
        assert_sanitized(
            {
                "platform": {"architecture": "aarch64"},
                "network": {"interfaces": [{"name": "enP7s7", "speed_mbps": 10000}]},
                "driver_version": "580.159.03",
            }
        )

    def test_rejects_forbidden_keys(self) -> None:
        for key in ("hostname", "machine-id", "boot_id", "serial", "uuid", "token"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                assert_sanitized({key: "redacted"})

    def test_rejects_mac_and_ipv4_values(self) -> None:
        for value in ("aa:bb:cc:dd:ee:ff", "address=10.64.0.20"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                assert_sanitized({"value": value})

    def test_unknown_mountpoints_are_not_returned(self) -> None:
        self.assertEqual(_mount_roles(["/", "/home/private-user", "/media/secret"]), ["root"])

    def test_os_release_is_allowlisted(self) -> None:
        parsed = _parse_os_release(
            "ID=ubuntu\nVERSION_ID=24.04\nPRETTY_NAME=Ubuntu\nSECRET=value\n"
        )
        self.assertEqual(
            parsed,
            {
                "status": "ok",
                "id": "ubuntu",
                "version_id": "24.04",
                "pretty_name": "Ubuntu",
            },
        )

    def test_command_failure_shape_does_not_include_stderr(self) -> None:
        failure = CommandOutput(
            status="unsupported",
            reason="command-returned-nonzero",
            returncode=1,
        )
        self.assertFalse(hasattr(failure, "stderr"))

    def test_nvidia_na_memory_is_not_numeric(self) -> None:
        rows = _parse_csv_rows(
            "0, [N/A], [N/A], [N/A]",
            ["index", "memory.total", "memory.used", "memory.free"],
        )
        self.assertEqual(len(rows), 1)
        self.assertIsNone(_safe_float(rows[0]["memory.total"]))


if __name__ == "__main__":
    unittest.main()
