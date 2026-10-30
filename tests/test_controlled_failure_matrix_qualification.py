import unittest

from tools.run_controlled_failure_matrix_qualification import (
    ARTIFACT_SPECS,
    REQUIRED_CATEGORIES,
    binding_errors,
    validator_commands,
)


class ControlledFailureMatrixQualificationTests(unittest.TestCase):
    def test_declared_artifacts_cover_every_normative_failure_category(self):
        covered = {
            category
            for declaration in ARTIFACT_SPECS.values()
            for category in declaration["categories"]
        }
        self.assertTrue(REQUIRED_CATEGORIES <= covered)
        self.assertEqual(18, len(ARTIFACT_SPECS))

    def test_every_artifact_has_one_explicit_strict_validator_command(self):
        arguments = {
            declaration["argument"]: f"evidence/{key}.json"
            for key, declaration in ARTIFACT_SPECS.items()
        }
        arguments.update({
            "current-plan": "deploy/current-plan.json",
            "whole-product-failure-plan": "deploy/failure-plan.json",
            "whole-product-failure-cleanup": "evidence/failure-cleanup.json",
        })
        commands = validator_commands(arguments)
        self.assertEqual(set(ARTIFACT_SPECS), set(commands))
        for key, command in commands.items():
            self.assertEqual("python3", command[0])
            self.assertEqual(ARTIFACT_SPECS[key]["validator"], command[1])
            self.assertIn("--evidence", command)

        self.assertIn("--plan", commands["currentDeployment"])
        self.assertIn("--cleanup-evidence", commands["wholeProductFailure"])

    def test_cross_box_artifacts_must_bind_one_current_deployment_node_and_job(self):
        paths = {key: f"evidence/{key}.json" for key in ARTIFACT_SPECS}
        payloads = {
            "storageObservation": {"deployment": {"path": paths["currentDeployment"]}},
            "managedNode": {"controlPlane": {"parentEvidence": paths["currentDeployment"]}},
            "computeJob": {
                "controller": {"deploymentEvidence": paths["currentDeployment"]},
                "managedNode": {"nodeEvidence": paths["managedNode"]},
            },
            "pluginStale": {"parent": {"path": paths["wholeProductFailure"]}},
            "providerRouting": {"gateway": {"path": paths["providerGateway"]}},
            "componentCatalog": {
                "summary": {"componentReadyCount": 44, "productAcceptedCount": 0},
            },
            "warmUnload": {
                "nodeEvidence": {"path": paths["managedNode"]},
                "jobEvidence": {"path": paths["computeJob"]},
            },
        }
        for key in (
            "workerCrash", "nodeLoss", "networkLoss", "cancellation", "capacityReserve",
            "warmReuse", "largeObject",
        ):
            payloads[key] = {"managedNode": {"nodeEvidence": paths["managedNode"]}}
        self.assertEqual([], binding_errors(payloads, paths))

        payloads["networkLoss"]["managedNode"]["nodeEvidence"] = "evidence/stale-node.json"
        self.assertEqual(["networkLoss_node_mismatch"], binding_errors(payloads, paths))


if __name__ == "__main__":
    unittest.main()
