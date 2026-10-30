import tempfile
import unittest
from pathlib import Path

from tools import generate_ocr_quality_corpus as corpus


class OcrQualityCorpusTest(unittest.TestCase):
    def test_case_templates_are_content_safe_and_complete(self):
        for key in ("clean-print", "scan-photo", "multilingual"):
            _, annotation = corpus.text_case(key, 0)
            self.assertTrue(annotation["referenceText"])
            self.assertIsNone(annotation["tableHtml"])
        _, complex_annotation = corpus.complex_case(0)
        self.assertEqual(len(complex_annotation["blocks"]), 30)
        _, table_annotation = corpus.table_case(0)
        self.assertEqual(len(table_annotation["blocks"]), 3)
        self.assertIn("<table>", table_annotation["tableHtml"])

    def test_one_case_per_slice_is_deterministic(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            a = corpus.generate(Path(first), 1)
            b = corpus.generate(Path(second), 1)
            self.assertEqual(a["caseCount"], 5)
            self.assertEqual(a["corpusDigest"], b["corpusDigest"])
            self.assertEqual(a["sliceCounts"], {key: 1 for key in corpus.SLICE_ORDER})


if __name__ == "__main__":
    unittest.main()
