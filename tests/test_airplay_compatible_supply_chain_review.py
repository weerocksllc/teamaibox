from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest

from tools.validate_airplay_compatible_supply_chain_review import (
    LOCK,
    REVIEW,
    validate,
    validate_lock,
)


class AirPlayCompatibleSupplyChainReviewTest(unittest.TestCase):
    def setUp(self) -> None:
        self.lock = json.loads(LOCK.read_text(encoding="utf-8"))
        self.review = json.loads(REVIEW.read_text(encoding="utf-8"))

    def validate_temporary_review(self, review: dict[str, object]) -> dict[str, object]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "review.json"
            path.write_text(json.dumps(review), encoding="utf-8")
            return validate(path)

    def test_committed_successor_records_simplified_open_source_scope_without_technical_closure(self) -> None:
        result = validate()
        self.assertTrue(result["valid"])
        self.assertEqual(result["componentCount"], 15)
        self.assertEqual(result["requiredHumanDecisionCount"], 5)
        self.assertEqual(result["approvedHumanDecisionCount"], 5)
        self.assertEqual(result["pendingHumanDecisionCount"], 0)
        self.assertTrue(result["allRequiredHumanDecisionsApproved"])
        self.assertEqual(result["mandatoryAutomatedGateCount"], 6)
        self.assertEqual(result["optionalAssuranceCount"], 4)
        self.assertFalse(result["automatedReleaseVerificationComplete"])
        self.assertFalse(result["releaseEligible"])
        self.assertFalse(result["task22_1Complete"])

    def test_human_approval_cannot_fabricate_technical_release_completion(self) -> None:
        review = copy.deepcopy(self.review)
        review["decision"]["releaseEligible"] = True
        with self.assertRaisesRegex(ValueError, "overclaims technical completion"):
            self.validate_temporary_review(review)

    def test_human_approval_inheritance_requires_all_five_decisions(self) -> None:
        review = copy.deepcopy(self.review)
        review["humanDecisionInheritance"]["approved"] = 4
        with self.assertRaisesRegex(ValueError, "inheritance drifted"):
            self.validate_temporary_review(review)

    def test_scope_decision_does_not_fabricate_authority_channel(self) -> None:
        review = copy.deepcopy(self.review)
        review["scopeDecision"]["captureChannel"] = "external-signature"
        with self.assertRaisesRegex(ValueError, "authority record drifted"):
            self.validate_temporary_review(review)

    def test_playfair_legal_gate_cannot_be_removed(self) -> None:
        lock = copy.deepcopy(self.lock)
        lock["receiver"]["bundledCode"][0]["humanLegalReviewRequired"] = False
        with self.assertRaisesRegex(ValueError, "PlayFair legal gate"):
            validate_lock(lock)

    def test_forbidden_codec_boundary_cannot_expand(self) -> None:
        lock = copy.deepcopy(self.lock)
        lock["pipelinePolicy"]["browserEgress"]["h264EncodeEnabled"] = True
        with self.assertRaisesRegex(ValueError, "H.264 browser encoding"):
            validate_lock(lock)

    def test_component_and_arm64_digest_drift_is_rejected(self) -> None:
        lock = copy.deepcopy(self.lock)
        livekit = next(
            component
            for component in lock["components"]
            if component["name"] == "LiveKit server"
        )
        livekit["arm64Image"] = "docker.io/livekit/livekit-server:latest"
        with self.assertRaisesRegex(ValueError, "ARM64 image digest"):
            validate_lock(lock)

    def test_unexecuted_signature_check_cannot_be_claimed(self) -> None:
        lock = copy.deepcopy(self.lock)
        lock["verificationPolicy"]["builtImageSignatureVerified"] = True
        with self.assertRaisesRegex(ValueError, "unexecuted verification"):
            validate_lock(lock)

    def test_browser_client_cannot_claim_an_unverified_controlled_bundle(self) -> None:
        lock = copy.deepcopy(self.lock)
        client = next(component for component in lock["components"]
                      if component["name"] == "LiveKit browser client")
        client["controlledTarballVerified"] = True
        with self.assertRaisesRegex(ValueError, "improperly marked release verified"):
            validate_lock(lock)

    def test_required_non_certification_and_drm_copy_is_exact(self) -> None:
        review = copy.deepcopy(self.review)
        review["productBoundary"]["productCopyEnglish"] = "Official AirPlay receiver"
        with self.assertRaisesRegex(ValueError, "open-source product-copy or DRM boundary drifted"):
            self.validate_temporary_review(review)

    def test_enterprise_only_controls_are_explicitly_optional(self) -> None:
        review = copy.deepcopy(self.review)
        review["optionalAssuranceNotRequired"].remove("two-byte-identical-independent-builds")
        with self.assertRaisesRegex(ValueError, "optional assurance boundary drifted"):
            self.validate_temporary_review(review)

    def test_recording_dump_hevc_and_inherited_config_options_stay_blocked(self) -> None:
        lock = copy.deepcopy(self.lock)
        authentication = lock["pipelinePolicy"]["sessionAuthentication"]
        authentication["forbiddenOptions"].remove("-vdmp")
        with self.assertRaisesRegex(ValueError, "forbidden UxPlay"):
            validate_lock(lock)
        lock = copy.deepcopy(self.lock)
        lock["pipelinePolicy"]["sessionAuthentication"]["uxplayrcEnvironmentAllowed"] = True
        with self.assertRaisesRegex(ValueError, "bypass"):
            validate_lock(lock)


if __name__ == "__main__":
    unittest.main()
