from pathlib import Path
import unittest

from tools.run_drawing_candidate_selection import MEMORY_BUDGET, PARENTS, RUN_ID, SOURCES


ROOT = Path(__file__).resolve().parents[1]


class DrawingCandidateSelectionTests(unittest.TestCase):
    def test_exact_identity_and_inputs(self):
        self.assertIsNotNone(RUN_ID.fullmatch("drawing-candidate-selection-20260901-a1"))
        self.assertIsNone(RUN_ID.fullmatch("../drawing-candidate-selection-20260901-a1"))
        self.assertTrue(all(path.is_file() for path, _validator, _timeout in PARENTS.values()))
        self.assertTrue(all(path.is_file() for path in SOURCES))

    def test_selection_is_bounded_and_fail_closed(self):
        self.assertEqual(MEMORY_BUDGET, {"workerHardLimitGiB": 80, "coreServiceReserveGiB": 32,
            "transientMarginGiB": 16, "minimumAvailableAfterDrainGiB": 96})
        source = (ROOT / "tools/run_drawing_candidate_selection.py").read_text(encoding="utf-8")
        for expected in ("external-overflow-only", "manual-only", "selectedLocalProfiles",
                         '"task7_21Complete": True', '"profilesDeployed": False'):
            self.assertIn(expected, source)


if __name__ == "__main__":
    unittest.main()
