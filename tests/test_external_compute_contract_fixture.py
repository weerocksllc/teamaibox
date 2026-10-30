from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tools/external_compute_contract_fixture.go"


class ExternalComputeContractFixtureTests(unittest.TestCase):
    def test_native_fixture_builds_and_self_describes_without_hardware_claims(self) -> None:
        with tempfile.TemporaryDirectory(prefix="teamaibox-fixture-test-") as directory:
            binary = Path(directory) / "fixture"
            subprocess.run(
                ["go", "build", "-trimpath", "-o", str(binary), str(SOURCE)],
                cwd=ROOT, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            completed = subprocess.run(
                [str(binary), "--self-test"], check=True, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
        result = json.loads(completed.stdout)
        self.assertTrue(result["valid"])
        self.assertEqual(result["model"], "contract/giant-llm")
        self.assertFalse(result["hardware_metrics_supported"])
        self.assertEqual(result["scenarios"], ["success", "overload", "timeout", "partial-output"])

    def test_fixture_cross_compiles_as_a_static_linux_arm64_binary(self) -> None:
        with tempfile.TemporaryDirectory(prefix="teamaibox-fixture-arm64-") as directory:
            binary = Path(directory) / "fixture"
            environment = {**os.environ, "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "arm64"}
            subprocess.run(
                ["go", "build", "-trimpath", "-ldflags=-s -w", "-o", str(binary), str(SOURCE)],
                cwd=ROOT, env=environment, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            header = binary.read_bytes()[:20]
        self.assertEqual(header[:4], b"\x7fELF")
        self.assertEqual(int.from_bytes(header[18:20], "little"), 183)  # EM_AARCH64

    def test_fixture_has_bounded_tls_auth_failure_and_replay_contracts(self) -> None:
        source = SOURCE.read_text(encoding="utf-8")
        for path in (
            "/health/live", "/health/ready", "/v1/models", "/v1/responses",
            "/fixture/v1/state", "/fixture/v1/accounting",
        ):
            self.assertIn(path, source)
        for contract in (
            "ListenAndServeTLS", "subtle.ConstantTimeCompare", "Idempotency-Key",
            "provider_overloaded", "provider_timeout", "response.output_text.delta",
            "MaxHeaderBytes", "io.LimitReader", "hardware_metrics_supported",
        ):
            self.assertIn(contract, source)
        self.assertNotIn("log.Printf", source)
        self.assertNotIn("fmt.Printf", source)


if __name__ == "__main__":
    unittest.main()
