from __future__ import annotations

import copy
import json
import unittest

from tools.validate_drawing_model_portfolio import PORTFOLIO, PortfolioError, validate


class DrawingModelPortfolioTests(unittest.TestCase):
    def setUp(self) -> None:
        self.portfolio = json.loads(PORTFOLIO.read_text(encoding="utf-8"))

    def candidate(self, candidate_id: str) -> dict:
        return next(item for item in self.portfolio["localCandidates"] if item["candidateId"] == candidate_id)

    def route(self, alias: str) -> dict:
        return next(item for item in self.portfolio["routingRules"]["aliases"] if item["alias"] == alias)

    def test_committed_portfolio_is_complete_and_fail_closed(self) -> None:
        self.assertEqual(validate(self.portfolio), {
            "aliases": 8, "localCandidates": 10, "externalCandidates": 2, "plannedCandidates": 9,
        })
        self.assertTrue(all(not item["lifecycle"]["automaticEligible"]
                            for item in self.portfolio["localCandidates"] + self.portfolio["externalCandidates"]))

    def test_rejects_mutable_source_revision(self) -> None:
        self.candidate("z-image-turbo")["source"]["revision"] = "main"
        with self.assertRaisesRegex(PortfolioError, "not immutable"):
            validate(self.portfolio)

    def test_rejects_candidate_without_artifact_manifest_digest(self) -> None:
        self.candidate("glm-image")["source"]["artifactManifestDigest"] = "pending"
        with self.assertRaisesRegex(PortfolioError, "artifact manifest is not pinned"):
            validate(self.portfolio)

    def test_rejects_generation_only_model_from_edit_route(self) -> None:
        self.route("drawing.edit")["localCandidates"].append("z-image-turbo")
        with self.assertRaisesRegex(PortfolioError, "generation-only"):
            validate(self.portfolio)

    def test_rejects_legacy_sdxl_from_automatic_route(self) -> None:
        self.route("drawing.automatic")["localCandidates"].append("sdxl-base-1.0-fp16")
        with self.assertRaisesRegex(PortfolioError, "exclude legacy SDXL"):
            validate(self.portfolio)

    def test_rejects_candidate_promoted_without_evidence(self) -> None:
        self.candidate("flux2-klein-4b-nvfp4")["lifecycle"] = copy.deepcopy(
            self.candidate("sdxl-base-1.0-fp16")["lifecycle"]
        )
        self.candidate("flux2-klein-4b-nvfp4")["lifecycle"]["automaticEligible"] = True
        with self.assertRaisesRegex(PortfolioError, "cannot be auto-routed before evidence"):
            validate(self.portfolio)

    def test_qwen_image_turbo_is_not_invented_as_a_candidate(self) -> None:
        identifiers = {item["candidateId"] for item in self.portfolio["localCandidates"]}
        self.assertNotIn("qwen-image-turbo", identifiers)
        self.assertIn("qwen-image-2512-lightning", identifiers)


if __name__ == "__main__":
    unittest.main()
