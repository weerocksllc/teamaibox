from __future__ import annotations

import unittest

from tools.spark_telemetry_probe import (
    _cpu_delta,
    _parse_cpu_stat,
    _parse_diskstats,
    _parse_host_memory,
    _parse_memory_pressure,
    _parse_status_memory,
    assert_sanitized,
)


class SparkTelemetryProbeTests(unittest.TestCase):
    def test_cpu_stat_and_delta(self) -> None:
        before = _parse_cpu_stat("cpu 10 0 5 80 5 0 0 0 0 0\n")
        after = _parse_cpu_stat("cpu 20 0 10 150 10 0 0 0 0 0\n")
        self.assertIsNotNone(before)
        self.assertIsNotNone(after)
        value = _cpu_delta(before or {}, after or {})
        self.assertEqual(value, {"busy_percent": 16.67, "total_jiffies": 90, "idle_jiffies": 75})

    def test_process_memory_is_allowlisted_and_converted(self) -> None:
        parsed = _parse_status_memory(
            "Name:\tprivate\nVmSize:\t100 kB\nVmRSS:\t25 kB\nRssAnon:\t20 kB\n"
        )
        self.assertEqual(
            parsed,
            {"virtual_bytes": 102400, "resident_bytes": 25600, "anonymous_resident_bytes": 20480},
        )

    def test_host_unified_memory_is_allowlisted_and_validated(self) -> None:
        parsed = _parse_host_memory(
            "MemTotal:       1000 kB\nMemFree: 50 kB\nMemAvailable: 400 kB\n"
            "SwapTotal: 200 kB\nSwapFree: 125 kB\nPrivate: 999 kB\n"
        )
        self.assertEqual(parsed, {
            "total_bytes": 1_024_000,
            "available_bytes": 409_600,
            "swap_total_bytes": 204_800,
            "swap_free_bytes": 128_000,
        })
        self.assertIsNone(_parse_host_memory("MemTotal: 1 kB\nMemAvailable: 2 kB\n"))

    def test_memory_pressure_parses_only_psi_aggregates(self) -> None:
        parsed = _parse_memory_pressure(
            "some avg10=0.12 avg60=0.34 avg300=0.56 total=1234\n"
            "full avg10=0.01 avg60=0.02 avg300=0.03 total=99\n"
        )
        self.assertEqual(parsed, {
            "some": {"avg10": 0.12, "avg60": 0.34, "avg300": 0.56, "total": 1234},
            "full": {"avg10": 0.01, "avg60": 0.02, "avg300": 0.03, "total": 99},
        })

    def test_diskstats_aggregates_only_selected_devices(self) -> None:
        text = (
            "259 0 nvme0n1 10 1 20 3 30 4 40 5 2 7 8\n"
            "7 0 loop0 99 1 99 3 99 4 99 5 9 9 9\n"
        )
        self.assertEqual(
            _parse_diskstats(text, {"nvme0n1"}),
            {
                "device_count": 1,
                "reads_completed": 10,
                "sectors_read": 20,
                "writes_completed": 30,
                "sectors_written": 40,
                "io_in_progress": 2,
                "io_time_milliseconds": 7,
            },
        )

    def test_sanitizer_rejects_identity_and_addresses(self) -> None:
        for report in ({"hostname": "private"}, {"value": "10.0.0.1"}, {"mac_address": "hidden"}):
            with self.subTest(report=report), self.assertRaises(ValueError):
                assert_sanitized(report)


if __name__ == "__main__":
    unittest.main()
