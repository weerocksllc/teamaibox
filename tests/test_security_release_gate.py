from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from tools.run_security_release_gate import (
    CATALOG,
    EXPECTED_KEYS,
    SecurityGateError,
    canonical_bytes,
    digest_bytes,
    run_command,
    validate_catalog,
)


class SecurityReleaseGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = json.loads(Path(CATALOG).read_text(encoding="utf-8"))

    def test_catalog_has_every_required_closed_fail_fast_gate(self) -> None:
        validated = validate_catalog(self.catalog)
        self.assertEqual([item["key"] for item in validated["gates"]], EXPECTED_KEYS)
        self.assertEqual(validated["maximumFailures"], 0)
        self.assertFalse(validated["retainCommandOutput"])

    def test_catalog_rejects_missing_gate_output_retention_and_path_escape(self) -> None:
        missing = copy.deepcopy(self.catalog)
        missing["gates"].pop()
        with self.assertRaisesRegex(SecurityGateError, "coverage"):
            validate_catalog(missing)
        retaining = copy.deepcopy(self.catalog)
        retaining["retainCommandOutput"] = True
        with self.assertRaisesRegex(SecurityGateError, "redact"):
            validate_catalog(retaining)
        escaping = copy.deepcopy(self.catalog)
        escaping["gates"][0]["commands"][0].append("../secrets")
        with self.assertRaisesRegex(SecurityGateError, "escapes"):
            validate_catalog(escaping)

    def test_command_evidence_retains_only_digests_exit_and_timing(self) -> None:
        result = run_command(["python3", "-c", "print('fixture-sensitive-output')"], 10)
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(
            set(result),
            {"argvDigest", "exitCode", "timedOut", "durationMilliseconds", "stdoutDigest", "stderrDigest"},
        )
        self.assertNotIn("fixture-sensitive-output", json.dumps(result))
        self.assertRegex(result["stdoutDigest"], r"^sha256:[a-f0-9]{64}$")

    def test_committed_development_evidence_passes_every_current_gate_without_raw_output(self) -> None:
        path = Path("evidence/validation/security/security-20260811-development-a1.json")
        evidence = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(evidence["suiteId"], self.catalog["suiteId"])
        self.assertEqual(evidence["status"], "passed")
        self.assertEqual(evidence["failedGateKeys"], [])
        self.assertFalse(evidence["commandOutputRetained"])
        self.assertEqual(evidence["source"]["catalogDigest"], digest_bytes(canonical_bytes(self.catalog)))
        self.assertEqual([item["key"] for item in evidence["gates"]], EXPECTED_KEYS)
        self.assertTrue(all(item["status"] == "passed" for item in evidence["gates"]))
        serialized = json.dumps(evidence)
        self.assertNotIn('"stdout"', serialized)
        self.assertNotIn('"stderr"', serialized)


if __name__ == "__main__":
    unittest.main()
