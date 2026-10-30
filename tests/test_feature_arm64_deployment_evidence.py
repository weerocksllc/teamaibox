from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from tools.validate_feature_arm64_deployment_evidence import (
    FeatureDeploymentEvidenceError,
    validate_cleanup,
    validate_deployment,
)


ROOT = Path(__file__).resolve().parents[1]
DEPLOYMENT = ROOT / "evidence" / "validation" / "feature-deployments" / "runner-smoke-20260812-a4.json"
CLEANUP = ROOT / "evidence" / "validation" / "feature-deployments" / "runner-smoke-20260812-cleanup-a2.json"
PLAN = ROOT / "deploy" / "feature-runner-canary" / "plan-20260812-a4.json"


class FeatureArm64DeploymentEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.deployment = json.loads(DEPLOYMENT.read_text(encoding="utf-8"))
        self.cleanup = json.loads(CLEANUP.read_text(encoding="utf-8"))
        self.plan = json.loads(PLAN.read_text(encoding="utf-8"))

    def test_exact_a4_arm64_deployment_and_a2_cleanup_pass(self) -> None:
        deployed = validate_deployment(self.deployment, self.plan)
        cleaned = validate_cleanup(self.cleanup, self.deployment)
        self.assertEqual(deployed["stepCount"], 10)
        self.assertEqual(deployed["imageCount"], 1)
        self.assertEqual(cleaned["parentRunId"], "runner-smoke-20260812-a4")

    def test_runner_source_image_and_step_tampering_fail_closed(self) -> None:
        runner = copy.deepcopy(self.deployment)
        runner["runnerDigest"] = "sha256:" + "a" * 64
        with self.assertRaisesRegex(FeatureDeploymentEvidenceError, "runner digest"):
            validate_deployment(runner, self.plan)

        source = copy.deepcopy(self.deployment)
        source["sourceDigest"] = "mutable"
        with self.assertRaisesRegex(FeatureDeploymentEvidenceError, "source archive attestation"):
            validate_deployment(source, self.plan)

        image = copy.deepcopy(self.deployment)
        image["imageBindings"][0]["imageId"] = "mutable"
        with self.assertRaisesRegex(FeatureDeploymentEvidenceError, "measured ARM64 digest"):
            validate_deployment(image, self.plan)

        step = copy.deepcopy(self.deployment)
        step["steps"][0]["passed"] = False
        with self.assertRaisesRegex(FeatureDeploymentEvidenceError, "did not pass"):
            validate_deployment(step, self.plan)

    def test_cleanup_cannot_claim_unowned_resources_or_changed_parent(self) -> None:
        container = copy.deepcopy(self.cleanup)
        container["containersRemoved"].append("somebody-elses-container")
        with self.assertRaisesRegex(FeatureDeploymentEvidenceError, "container ownership"):
            validate_cleanup(container, self.deployment)

        image = copy.deepcopy(self.cleanup)
        image["imagesRemoved"][0]["tag"] = "teamaibox/product:current"
        with self.assertRaisesRegex(FeatureDeploymentEvidenceError, "unowned image"):
            validate_cleanup(image, self.deployment)

        parent = copy.deepcopy(self.cleanup)
        parent["parentEvidence"][0]["digest"] = "sha256:" + "b" * 64
        with self.assertRaisesRegex(FeatureDeploymentEvidenceError, "parent digest"):
            validate_cleanup(parent, self.deployment)


if __name__ == "__main__":
    unittest.main()
