import hashlib
import json
import unittest

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class OcrQualitySuitePolicyTest(unittest.TestCase):
    def test_evaluator_sources_and_thresholds_are_bound(self):
        value = json.loads((ROOT / "models/ocr-quality-suite.synthetic.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(value["suiteKey"], "quality.ocr.text-layout")
        self.assertFalse(value["supersedesThresholdPolicy"]["thresholdsChanged"])
        for item in value["evaluator"]["implementation"]:
            actual = "sha256:" + hashlib.sha256((ROOT / item["path"]).read_bytes()).hexdigest()
            self.assertEqual(item["sha256"], actual)
        self.assertEqual({item["metricKey"] for item in value["metrics"]}, {
            "character-error-rate", "word-error-rate", "layout-block-f1",
            "table-structure-teds", "reading-order-accuracy"})

    def test_corpus_has_no_third_party_or_user_documents(self):
        value = json.loads((ROOT / "models/ocr-quality-corpus.synthetic.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(value["caseCount"], 400)
        self.assertEqual(set(value["slices"].values()), {80})
        self.assertFalse(value["contentPolicy"]["userContent"])
        self.assertFalse(value["contentPolicy"]["thirdPartyDocumentImages"])


if __name__ == "__main__":
    unittest.main()
