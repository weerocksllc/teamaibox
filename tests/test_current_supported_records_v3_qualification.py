from __future__ import annotations

import unittest

from tools.run_current_supported_records_v3_qualification import BROWSER, CATALOG, MATRIX, REVIEW, artifact


class CurrentSupportedRecordsV3QualificationTests(unittest.TestCase):
    def test_exact_current_records_and_runtime_are_bound(self) -> None:
        matrix, _ = artifact(MATRIX, "matrixId", "teamaibox.supported-environment.v3")
        catalog, _ = artifact(CATALOG, "catalogId", "teamaibox.feature-acceptance.v15")
        review, _ = artifact(REVIEW, "reviewId", "teamaibox.final-acceptance.v3")
        browser, _ = artifact(BROWSER, "runnerId", "teamaibox.current-catalog-browser-smoke.v1")
        self.assertTrue(matrix["gatePolicy"]["task20_5Satisfied"])
        self.assertEqual(catalog["technicalClosure"]["productAcceptedCount"], 40)
        self.assertEqual(review["technicalClosure"]["pendingPrerequisiteCount"], 2)
        self.assertTrue(browser["claimBoundary"]["currentPostTranslationPlatformBound"])


if __name__ == "__main__":
    unittest.main()
