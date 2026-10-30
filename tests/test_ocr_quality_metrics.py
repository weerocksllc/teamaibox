import unittest

from tools.ocr_quality_metrics import (bbox_iou, layout_scores, levenshtein, normalize_text,
                                       parse_table, teds, text_error_counts, word_tokens)


class OcrQualityMetricsTest(unittest.TestCase):
    def test_text_metrics_cover_latin_and_han_tokens(self):
        self.assertEqual(levenshtein("kitten", "sitting"), 3)
        self.assertEqual(normalize_text("**Team**   AI"), "team ai")
        self.assertEqual(word_tokens("团队 Box-12"), ["团", "队", "box-12"])
        self.assertEqual(text_error_counts("Team 盒", "Team 合")["characterErrors"], 1)

    def test_layout_f1_and_order(self):
        reference = [
            {"label": "text", "bbox": [0, 0, 100, 100], "order": 0},
            {"label": "text", "bbox": [0, 110, 100, 210], "order": 1},
        ]
        prediction = [
            {"block_label": "text", "block_bbox": [0, 0, 100, 100], "reading_order": 0},
            {"block_label": "text", "block_bbox": [0, 110, 100, 210], "reading_order": 1},
        ]
        value = layout_scores(reference, prediction)
        self.assertEqual(value["f1"], 1)
        self.assertEqual(value["readingOrderAccuracy"], 1)
        self.assertEqual(bbox_iou(reference[0]["bbox"], prediction[0]["block_bbox"]), 1)

    def test_pubtabnet_style_teds(self):
        table = "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>"
        self.assertIsNotNone(parse_table(table))
        self.assertEqual(teds(table, table), 1)
        changed = table.replace("D", "X")
        self.assertGreater(teds(table, changed), 0.8)
        structural = table.replace("<td>C</td>", "")
        self.assertLess(teds(table, structural), 1)
        self.assertGreaterEqual(teds(table, structural), 0)


if __name__ == "__main__":
    unittest.main()
