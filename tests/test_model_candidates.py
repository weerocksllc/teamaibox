from __future__ import annotations

import copy
import json
import unittest

from tools.validate_model_candidates import MATRIX, ModelCandidateError, validate


class ModelCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.matrix = json.loads(MATRIX.read_text(encoding="utf-8"))

    def candidate(self, candidate_id: str) -> dict:
        return next(item for item in self.matrix["candidates"] if item["candidateId"] == candidate_id)

    def test_committed_candidate_matrix_is_complete_and_pre_download(self) -> None:
        summary = validate(self.matrix)
        self.assertEqual(summary, {
            "candidates": 10, "coverage": 6, "allowedDownloads": 7, "blockedDownloads": 3,
        })
        self.assertTrue(all(item["artifactDecision"]["downloadState"] == "not_downloaded" for item in self.matrix["candidates"]))

    def test_rejects_missing_workload_coverage(self) -> None:
        self.matrix["coverage"].remove("ocr")
        with self.assertRaisesRegex(ModelCandidateError, "every required"):
            validate(self.matrix)

    def test_rejects_download_before_approved_license(self) -> None:
        self.candidate("qwen36-35b-a3b-nvfp4")["license"]["reviewStatus"] = "conditional"
        with self.assertRaisesRegex(ModelCandidateError, "approved usable license"):
            validate(self.matrix)

    def test_rejects_gated_download_without_human_acceptance(self) -> None:
        candidate = self.candidate("flux1-schnell-bf16")
        candidate["artifactDecision"] = copy.deepcopy(self.candidate("sdxl-base-1.0-fp16")["artifactDecision"])
        candidate["selection"]["status"] = "planned"
        with self.assertRaisesRegex(ModelCandidateError, "gated source"):
            validate(self.matrix)

    def test_rejects_mxfp4_reported_as_nvfp4(self) -> None:
        self.candidate("gpt-oss-120b-mxfp4")["precision"]["nvfp4Applicability"] = "official-prequantized"
        with self.assertRaisesRegex(ModelCandidateError, "applicability disagrees"):
            validate(self.matrix)

    def test_rejects_mutable_model_revision(self) -> None:
        self.candidate("madlad400-3b-mt-bf16")["source"]["revision"] = "main"
        with self.assertRaisesRegex(ModelCandidateError, "not immutable"):
            validate(self.matrix)

    def test_rejects_artifact_download_during_discovery(self) -> None:
        self.candidate("whisper-large-v3-fp16")["artifactDecision"]["downloadState"] = "downloaded"
        with self.assertRaisesRegex(ModelCandidateError, "during discovery"):
            validate(self.matrix)

    def test_noncommercial_candidate_remains_rejected(self) -> None:
        candidate = self.candidate("nllb-200-1.3b-noncommercial")
        candidate["license"]["reviewStatus"] = "approved"
        candidate["artifactDecision"] = copy.deepcopy(self.candidate("madlad400-3b-mt-bf16")["artifactDecision"])
        candidate["selection"]["status"] = "planned"
        with self.assertRaisesRegex(ModelCandidateError, "approved usable license"):
            validate(self.matrix)


if __name__ == "__main__":
    unittest.main()
