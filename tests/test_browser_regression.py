from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest

from tools.validate_browser_regression import EVIDENCE, validate


class BrowserRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.evidence = json.loads(Path(EVIDENCE).read_text(encoding="utf-8"))

    def mutation(self, value: dict) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "browser.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            return validate(path)

    def test_committed_evidence_covers_the_full_matrix_and_release_boundary(self) -> None:
        self.assertEqual(validate(), {
            "valid": True,
            "combinationCount": 8,
            "pluginCombinationCount": 48,
            "surfaceCount": 11,
            "scenarioCount": 12,
            "screenshotCount": 8,
            "releaseEvidenceEligible": False,
        })

    def test_rejects_missing_or_wrong_viewport_matrix_evidence(self) -> None:
        missing = copy.deepcopy(self.evidence)
        missing["workbenchMatrix"].pop()
        with self.assertRaisesRegex(ValueError, "workbench matrix"):
            self.mutation(missing)
        width = copy.deepcopy(self.evidence)
        width["workbenchMatrix"][4]["actualWidth"] = 1280
        with self.assertRaisesRegex(ValueError, "declared viewport"):
            self.mutation(width)

    def test_rejects_weakened_scenarios_and_local_release_claims(self) -> None:
        scenario = copy.deepcopy(self.evidence)
        scenario["scenarioCoverage"].pop()
        with self.assertRaisesRegex(ValueError, "scenario coverage"):
            self.mutation(scenario)
        release = copy.deepcopy(self.evidence)
        release["releaseEvidenceEligible"] = True
        with self.assertRaisesRegex(ValueError, "cannot become release evidence"):
            self.mutation(release)

    def test_rejects_invalid_screenshot_digest(self) -> None:
        value = copy.deepcopy(self.evidence)
        value["screenshots"]["items"][0]["digest"] = "sha256:invalid"
        with self.assertRaisesRegex(ValueError, "screenshot digest"):
            self.mutation(value)


if __name__ == "__main__":
    unittest.main()
