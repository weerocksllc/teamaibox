from __future__ import annotations

from pathlib import Path
import unittest

from tools.run_current_translation_composition_closure import PARENTS, coverage


ROOT = Path(__file__).resolve().parents[1]


class CurrentTranslationCompositionClosureTests(unittest.TestCase):
    def test_every_task_18_8_requirement_is_named_and_closed(self) -> None:
        value = coverage()
        self.assertEqual(len(value), 14)
        self.assertTrue(all(value.values()))
        for key in ("textComposition", "imageOcrComposition", "audioAsrComposition",
                    "intermediateProvenance", "alignedResultAndExport", "capacityBoundary",
                    "errorBoundary", "cancellation", "permissionBoundary", "restartPersistence"):
            self.assertIn(key, value)

    def test_exact_current_parents_exist(self) -> None:
        self.assertEqual(set(PARENTS), {"development", "capacity"})
        self.assertTrue(all(path.is_file() and path.is_relative_to(ROOT) for path in PARENTS.values()))

    def test_release_claims_remain_outside_technical_closure(self) -> None:
        runner = (ROOT / "tools/run_current_translation_composition_closure.py").read_text(encoding="utf-8")
        self.assertIn('"translationProfileCertification": "experimental"', runner)
        self.assertIn('"productAccepted": False', runner)
        self.assertIn('"independentHumanAcceptance": False', runner)


if __name__ == "__main__":
    unittest.main()
