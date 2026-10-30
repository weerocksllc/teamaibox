import json
import pathlib
import tempfile
import unittest

from tools import model_baseline_probe as probe


class ModelBaselineProbeTest(unittest.TestCase):
    def test_percentile_and_canonical_digest_are_deterministic(self):
        self.assertEqual(probe.percentile([4, 1, 3, 2], 0.5), 2.5)
        self.assertEqual(probe.canonical_digest({"b": 2, "a": 1}), probe.canonical_digest({"a": 1, "b": 2}))
        self.assertRegex(probe.canonical_digest({"a": 1}), r"^sha256:[a-f0-9]{64}$")

    def test_parses_aggregate_host_counters_without_identifiers(self):
        memory = probe.parse_meminfo("MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\n")
        self.assertEqual(memory, {"totalBytes": 1024000, "availableBytes": 409600, "usedBytes": 614400})
        before = probe.parse_cpu_stat("cpu 10 0 5 85 0 0 0 0 0 0\n")
        after = probe.parse_cpu_stat("cpu 20 0 10 170 0 0 0 0 0 0\n")
        self.assertEqual(probe.cpu_busy_percent(before, after), 15.0)
        self.assertEqual(probe.parse_netdev("a\nb\n eth0: 100 0 0 0 0 0 0 0 200 0 0 0\n lo: 10 0 0 0 0 0 0 0 20 0 0 0\n"), (110, 220))
        disk = " 259 0 nvme0n1 1 0 8 0 1 0 16 0 0 0 0 0\n 259 1 nvme0n1p1 1 0 100 0 1 0 100 0 0 0 0 0\n"
        self.assertEqual(probe.parse_diskstats(disk), (4096, 8192))

    def test_public_result_removes_model_text_but_retains_digest(self):
        result = probe.public_result({"outcome": "completed", "responseText": "private reasoning", "responseDigest": "sha256:" + "a" * 64})
        self.assertNotIn("responseText", result)
        self.assertIn("responseDigest", result)

    def test_json_quality_check_and_arguments_fail_closed(self):
        self.assertTrue(probe._json_equals('{"count":3,"ok":true}', {"ok": True, "count": 3}))
        self.assertFalse(probe._json_equals("```json", {"ok": True}))
        args = type("Args", (), {
            "run_id": "baseline-run-001",
            "profile_fingerprint": "sha256:" + "a" * 64,
            "deployment_fingerprint": "sha256:" + "b" * 64,
            "base_url": "http://127.0.0.1:19000",
            "model": "qwen/qwen-test",
        })()
        probe.validate_args(args)
        args.base_url = "http://teamaibox-model-qwen36-bf16:8000"
        probe.validate_args(args)
        args.base_url = "http://0.0.0.0:19000"
        with self.assertRaises(probe.ProbeError):
            probe.validate_args(args)


if __name__ == "__main__":
    unittest.main()
