import unittest

from tools import evaluate_ocr_quality_predictions as evaluator


def case(case_id, slice_key):
    value = {"caseId": case_id, "slice": slice_key, "inputDigest": "sha256:" + "1" * 64,
             "responseDigest": "sha256:" + "2" * 64, "elapsedMilliseconds": 1,
             "pageCount": 1, "blockCount": 1}
    if slice_key in evaluator.TEXT_SLICES:
        value.update(referenceText="Team AI Box", predictionText="Team AI Box")
    elif slice_key == "complex-layout":
        value.update(referenceBlocks=[{"label": "text", "bbox": [0, 0, 100, 100], "order": 0},
                                      {"label": "text", "bbox": [0, 110, 100, 210], "order": 1}],
                     predictionBlocks=[{"block_label": "text", "block_bbox": [0, 0, 100, 100], "reading_order": 0},
                                       {"block_label": "text", "block_bbox": [0, 110, 100, 210], "reading_order": 1}])
    else:
        value.update(referenceTableHtml="<table><tr><td>A</td></tr></table>",
                     predictionTableHtml="<table><tr><td>A</td></tr></table>")
    return value


class OcrQualityEvaluatorTest(unittest.TestCase):
    def test_small_perfect_run_is_diagnostic_only(self):
        cases = [case(key + "-001", key) for key in evaluator.SLICE_ORDER]
        report = evaluator.evaluate({"schemaVersion": 1, "cases": cases})
        self.assertEqual(report["status"], "diagnostic")
        self.assertFalse(report["passed"])
        self.assertTrue(report["measurements"]["character-error-rate"]["slices"]["clean-print"]["thresholdPassed"])
        self.assertFalse(report["measurements"]["character-error-rate"]["slices"]["clean-print"]["sampleCountPassed"])

    def test_full_perfect_run_passes(self):
        cases = []
        for key in evaluator.SLICE_ORDER:
            cases.extend(case(f"{key}-{number:03d}", key) for number in range(1, 81))
        report = evaluator.evaluate({"schemaVersion": 1, "cases": cases})
        self.assertEqual(report["status"], "passed")
        self.assertTrue(report["passed"])
        self.assertEqual(report["caseCount"], 400)


if __name__ == "__main__":
    unittest.main()
