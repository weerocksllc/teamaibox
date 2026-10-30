from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from tools.cleanup_feature_arm64_deployment import (
    FeatureCleanupError,
    execute_cleanup,
)
from tools.spark_validation import CommandResult


ROOT = Path(__file__).resolve().parents[1]
PARENT = ROOT / "evidence" / "validation" / "feature-deployments" / "runner-smoke-20260812-a4.json"


class FakeRemote:
    def __init__(self, deployment: dict, *, changed_image: bool = False) -> None:
        self.deployment = deployment
        self.changed_image = changed_image
        self.commands: list[tuple[str, ...]] = []
        self.cleaned = False

    def run(self, command, timeout=30):
        values = tuple(str(item) for item in command)
        self.commands.append(values)
        project = self.deployment["composeProject"]
        binding = self.deployment["imageBindings"][0]
        if values[:3] == ("docker", "ps", "--all"):
            return CommandResult(0, "" if self.cleaned else f"{project}-canary-1\n", "")
        if values[:3] == ("docker", "volume", "ls"):
            return CommandResult(0, "" if self.cleaned else f"{project}_state\n", "")
        if values[:3] == ("docker", "network", "ls"):
            return CommandResult(0, "" if self.cleaned else f"{project}_default\n", "")
        if values[:4] == ("docker", "image", "inspect", "--format"):
            image_id = "sha256:" + "f" * 64 if self.changed_image else binding["imageId"]
            return CommandResult(0, image_id + "\n", "")
        if values[:3] == ("docker", "image", "inspect"):
            return CommandResult(1 if self.cleaned else 0, "", "not found" if self.cleaned else "")
        if values[:2] == ("docker", "rm"):
            self.cleaned = True
            return CommandResult(0, "", "")
        if values[:3] in {
            ("docker", "volume", "rm"),
            ("docker", "network", "rm"),
            ("docker", "image", "rm"),
        }:
            return CommandResult(0, "", "")
        if values[:3] == ("rm", "-r", "--") or values[:3] == ("test", "!", "-e"):
            return CommandResult(0, "", "")
        if values[:5] == ("sudo", "--non-interactive", "rm", "-r", "--"):
            return CommandResult(0, "", "")
        return CommandResult(1, "", "unexpected command")


class FeatureArm64DeploymentCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.deployment = json.loads(PARENT.read_text(encoding="utf-8"))

    def test_cleanup_removes_only_parent_owned_resources_and_writes_bound_evidence(self) -> None:
        remote = FakeRemote(self.deployment)
        with tempfile.TemporaryDirectory(dir=ROOT / "evidence") as directory:
            output = Path(directory) / "cleanup.json"
            result = execute_cleanup(PARENT, "runner-smoke-20260812-cleanup-test", output, remote=remote)
            self.assertEqual(result["ownedRunIds"], [self.deployment["runId"]])
            self.assertEqual(result["residualContainerCount"], 0)
            self.assertEqual(result["imagesRemoved"][0]["imageId"], self.deployment["imageBindings"][0]["imageId"])
            self.assertTrue(output.is_file())
            self.assertTrue(any(command[:3] == ("docker", "network", "rm") for command in remote.commands))

    def test_cleanup_fails_closed_before_mutation_when_image_identity_changed(self) -> None:
        remote = FakeRemote(self.deployment, changed_image=True)
        with tempfile.TemporaryDirectory(dir=ROOT / "evidence") as directory:
            output = Path(directory) / "cleanup.json"
            with self.assertRaisesRegex(FeatureCleanupError, "image identity changed"):
                execute_cleanup(PARENT, "runner-smoke-20260812-cleanup-tampered", output, remote=remote)
            self.assertFalse(remote.cleaned)
            self.assertFalse(output.exists())

    def test_v2_cleanup_removes_the_exact_durable_deployment_root_after_containers(self) -> None:
        deployment = dict(self.deployment)
        deployment.update({
            "schemaVersion": 2,
            "deploymentRoot": "/var/lib/teamaibox-feature-deployments/" + deployment["runId"],
            "deploymentRootRetained": True,
            "deploymentMaterialCheckPassed": True,
        })
        remote = FakeRemote(deployment)
        with tempfile.TemporaryDirectory(dir=ROOT / "evidence") as directory:
            parent = Path(directory) / "parent-v2.json"
            parent.write_text(json.dumps(deployment), encoding="utf-8")
            output = Path(directory) / "cleanup-v2.json"
            result = execute_cleanup(parent, "runner-smoke-20260812-cleanup-v2-test", output, remote=remote)
        expected = "/var/lib/teamaibox-feature-deployments/" + deployment["runId"]
        self.assertEqual(result["schemaVersion"], 2)
        self.assertEqual(result["deploymentPathsRemoved"], [expected])
        self.assertEqual(result["residualDeploymentPathCount"], 0)
        self.assertTrue(any(command[-1] == expected and command[:2] == ("sudo", "--non-interactive") for command in remote.commands))

    def test_cleanup_refuses_existing_evidence_path(self) -> None:
        remote = FakeRemote(self.deployment)
        with tempfile.TemporaryDirectory(dir=ROOT / "evidence") as directory:
            output = Path(directory) / "cleanup.json"
            output.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(FeatureCleanupError, "new repository file"):
                execute_cleanup(PARENT, "runner-smoke-20260812-cleanup-existing", output, remote=remote)
            self.assertFalse(remote.commands)


if __name__ == "__main__":
    unittest.main()
