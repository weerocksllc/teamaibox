import unittest

from tools.generate_drawing_quality_corpus import generate


class DrawingQualityCorpusTest(unittest.TestCase):
    def test_full_corpus_has_exact_required_coverage(self):
        value = generate()
        self.assertEqual(value["caseCount"], 240)
        self.assertEqual(value["sliceCounts"], {
            "composition": 60, "style": 60, "text-rendering": 40,
            "people-hands": 40, "zh-prompts": 40,
        })
        self.assertEqual(len({item["caseId"] for item in value["cases"]}), 240)
        self.assertTrue(all(item["slices"] == ["overall", item["slice"]] for item in value["cases"]))


if __name__ == "__main__":
    unittest.main()
