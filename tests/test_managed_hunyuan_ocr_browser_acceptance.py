from __future__ import annotations

import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "tools/run_managed_hunyuan_ocr_browser_acceptance.py"
RUNNER = ROOT / "tools/run_managed_hunyuan_ocr_browser_acceptance.mjs"
VALIDATOR = ROOT / "tools/validate_managed_hunyuan_ocr_browser_acceptance.py"


class ManagedHunyuanOcrBrowserAcceptanceSourceTests(unittest.TestCase):
    def test_runner_covers_truthful_hunyuan_capabilities_and_restoration(self) -> None:
        source = RUNNER.read_text(encoding="utf-8")
        for term in (
            "HunyuanOCR DFlash",
            "markdownTableVisible",
            "geometryUnavailableDisclosed",
            "confidenceUnavailableDisclosed",
            "idleUnloadAndWorkerRestore",
            "waitParentRestored",
            "HunyuanOCR experimental disclosure",
            "systemTrustOnly",
        ):
            self.assertIn(term, source)

    def test_validator_keeps_release_gates_fail_closed(self) -> None:
        source = VALIDATOR.read_text(encoding="utf-8")
        ast.parse(source)
        self.assertIn('"browserAccepted": True', source)
        self.assertIn('"licenseApproved": False', source)
        self.assertIn('"releaseSoakPassed": False', source)
        self.assertIn('"task18_6Complete": False', source)
        self.assertIn("model-license-review", source)
        self.assertIn("release-candidate-8-or-24-hour-soak", source)


if __name__ == "__main__":
    unittest.main()
