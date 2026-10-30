from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from tools.validate_feature_browser_acceptance_evidence import (
    BrowserEvidenceError,
    ROOT,
    validate_browser_evidence,
)


EVIDENCE = ROOT / "evidence/validation/browser/features/browser-feature-20260812-canary-a13.json"
PLAN = ROOT / "deploy/browser-runner-canary/browser-plan-20260812-a13.json"


class BrowserEvidenceTests(unittest.TestCase):
    def test_exact_real_browser_evidence_passes(self) -> None:
        result = validate_browser_evidence(EVIDENCE, PLAN)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(len(result["matrix"]), 16)

    def assert_tamper_rejected(self, mutate) -> None:
        value = json.loads(EVIDENCE.read_text(encoding="utf-8"))
        mutate(value)
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".json",
            dir=ROOT,
            encoding="utf-8",
            delete=False,
        ) as handle:
            json.dump(value, handle, ensure_ascii=False)
            temporary = Path(handle.name)
        try:
            with self.assertRaises(BrowserEvidenceError):
                validate_browser_evidence(temporary, PLAN)
        finally:
            temporary.unlink(missing_ok=True)

    def test_failed_status_is_rejected(self) -> None:
        self.assert_tamper_rejected(lambda value: value.update(status="failed"))

    def test_duplicate_matrix_identity_is_rejected(self) -> None:
        def mutate(value):
            value["matrix"][1] = copy.deepcopy(value["matrix"][0])
        self.assert_tamper_rejected(mutate)

    def test_screenshot_digest_tamper_is_rejected(self) -> None:
        self.assert_tamper_rejected(
            lambda value: value["matrix"][0]["screenshot"].update(digest="sha256:" + "0" * 64),
        )

    def test_operation_count_tamper_is_rejected(self) -> None:
        self.assert_tamper_rejected(
            lambda value: value["operations"].update(websocketCount=15),
        )


if __name__ == "__main__":
    unittest.main()
