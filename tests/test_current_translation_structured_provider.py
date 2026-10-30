from __future__ import annotations

import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "services/translation-provider-adapter/main.go"
RUNNER = ROOT / "tools/deploy_current_translation_structured_provider.py"
VALIDATOR = ROOT / "tools/validate_current_translation_structured_provider.py"


class CurrentTranslationStructuredProviderSourceTests(unittest.TestCase):
    def test_adapter_enforces_exact_alignment_without_touching_platform(self) -> None:
        source = ADAPTER.read_text(encoding="utf-8")
        self.assertIn('"type": "json_schema"', source)
        self.assertIn('"minItems": segmentCount, "maxItems": segmentCount', source)
        self.assertIn('"additionalProperties": false', source)
        self.assertIn("ConstantTimeCompare", source)
        self.assertIn("proxyAligned", source)
        self.assertIn("alignedCompletion", source)
        self.assertNotIn("apps/platform-api", source)

if __name__ == "__main__":
    unittest.main()
