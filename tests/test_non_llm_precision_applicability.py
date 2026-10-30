import copy
import json
import pathlib
import unittest

from tools.validate_non_llm_precision_applicability import ApplicabilityError, validate


ROOT = pathlib.Path(__file__).resolve().parents[1]
EVALUATION = json.loads((ROOT / "models" / "non-llm-precision-applicability.v1.json").read_text(encoding="utf-8"))
MATRIX = json.loads((ROOT / "models" / "candidate-matrix.v1.json").read_text(encoding="utf-8"))


class NonLlmPrecisionApplicabilityTest(unittest.TestCase):
    def test_committed_evaluation_covers_every_non_llm_candidate_without_artifacts(self):
        result = validate(EVALUATION, MATRIX)
        self.assertEqual(result, {"candidates": 6, "paths": 12, "applicable": 0, "not_applicable": 8, "failed": 4})

    def test_candidate_matrix_or_coverage_drift_fails_closed(self):
        matrix = copy.deepcopy(MATRIX)
        matrix["candidates"][0]["role"] = "changed"
        with self.assertRaisesRegex(ApplicabilityError, "digest drifted"):
            validate(EVALUATION, matrix)
        evaluation = copy.deepcopy(EVALUATION)
        evaluation["evaluations"].pop()
        with self.assertRaisesRegex(ApplicabilityError, "cover every"):
            validate(evaluation, MATRIX)

    def test_unsupported_nvfp4_cannot_be_forced_into_applicable(self):
        evaluation = copy.deepcopy(EVALUATION)
        ocr = next(item for item in evaluation["evaluations"] if item["candidateId"] == "paddleocr-vl-1.5-bf16")
        nvfp4 = next(item for item in ocr["paths"] if item["precision"] == "nvfp4")
        nvfp4["outcome"] = "applicable"
        nvfp4["exactRecipeAvailable"] = True
        nvfp4["recipe"] = {"scheme": "invented"}
        nvfp4["nextTask"] = "7.15"
        with self.assertRaisesRegex(ApplicabilityError, "forced an unsupported"):
            validate(evaluation, MATRIX)

    def test_download_conversion_and_production_claims_are_rejected(self):
        for key, value in (("artifactDownloaded", True), ("conversionAttempted", True), ("productionEligible", True)):
            evaluation = copy.deepcopy(EVALUATION)
            evaluation["evaluations"][1]["paths"][0][key] = value
            with self.assertRaises(ApplicabilityError):
                validate(evaluation, MATRIX)



if __name__ == "__main__":
    unittest.main()
