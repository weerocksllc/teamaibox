from __future__ import annotations

import unittest

from tools.run_drawing_model_portfolio_qualification import RUN_ID, SOURCES


class DrawingModelPortfolioQualificationTests(unittest.TestCase):
    def test_run_identity_is_bounded_and_immutable(self) -> None:
        self.assertIsNotNone(RUN_ID.fullmatch("drawing-model-portfolio-20260831-a1"))
        self.assertIsNone(RUN_ID.fullmatch("../drawing-model-portfolio-20260831-a1"))
        self.assertIsNone(RUN_ID.fullmatch("drawing-model-portfolio-latest"))

    def test_all_qualification_sources_exist(self) -> None:
        self.assertEqual(len(SOURCES), 6)
        self.assertTrue(all(path.is_file() for path in SOURCES))


if __name__ == "__main__":
    unittest.main()
