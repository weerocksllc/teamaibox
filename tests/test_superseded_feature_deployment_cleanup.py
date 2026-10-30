from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from tools.cleanup_superseded_feature_deployment import execute_cleanup
from tools.spark_validation import CommandResult


ROOT = Path(__file__).resolve().parents[1]
PARENT = ROOT / "evidence/validation/feature-deployments/runner-smoke-20260812-a4.json"


class FakeRemote:
    def __init__(self, deployment: dict, *, shared: bool) -> None:
        self.deployment = deployment
        self.shared = shared
        self.cleaned = False
        self.tag_present = True

    def run(self, command, timeout=30):
        values = tuple(str(item) for item in command)
        project = self.deployment["composeProject"]
        binding = self.deployment["imageBindings"][0]
        if values[:3] == ("docker", "ps", "--all") and any(item.startswith("ancestor=") for item in values):
            suffix = "other-project" if self.shared else project
            return CommandResult(0, f"consumer-1|{suffix}\n", "")
        if values[:3] == ("docker", "ps", "--all"):
            return CommandResult(0, "" if self.cleaned else f"{project}-canary-1\n", "")
        if values[:3] == ("docker", "volume", "ls"):
            return CommandResult(0, "" if self.cleaned else f"{project}_state\n", "")
        if values[:3] == ("docker", "network", "ls"):
            return CommandResult(0, "" if self.cleaned else f"{project}_default\n", "")
        if values[:4] == ("docker", "image", "inspect", "--format"):
            return CommandResult(0 if self.tag_present else 1, binding["imageId"] + "\n" if self.tag_present else "", "")
        if values[:3] == ("docker", "image", "inspect"):
            return CommandResult(0 if self.tag_present else 1, "", "")
        if values[:2] == ("docker", "rm"):
            self.cleaned = True
            return CommandResult(0, "", "")
        if values[:3] in {("docker", "volume", "rm"), ("docker", "network", "rm")}:
            return CommandResult(0, "", "")
        if values[:3] == ("docker", "image", "rm"):
            self.tag_present = False
            return CommandResult(0, "", "")
        if values[:3] in {("rm", "-r", "--"), ("test", "!", "-e")}:
            return CommandResult(0, "", "")
        return CommandResult(1, "", "unexpected command")


class SupersededFeatureCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.deployment = json.loads(PARENT.read_text(encoding="utf-8"))

    def run_cleanup(self, *, shared: bool) -> dict:
        with tempfile.TemporaryDirectory(dir=ROOT / "evidence") as directory:
            output = Path(directory) / "cleanup.json"
            return execute_cleanup(PARENT, "superseded-cleanup-unit-test", output,
                                   remote=FakeRemote(self.deployment, shared=shared))

    def test_retains_exact_tag_when_an_external_container_uses_the_image(self) -> None:
        result = self.run_cleanup(shared=True)
        self.assertEqual(result["imagesRemoved"], [])
        self.assertEqual(result["sharedImagesRetained"][0]["externalConsumers"][0]["composeProject"],
                         "other-project")
        self.assertEqual(result["residualProjectResourceCounts"],
                         {"containers": 0, "volumes": 0, "networks": 0})

    def test_removes_tag_when_only_the_owned_stack_uses_the_image(self) -> None:
        result = self.run_cleanup(shared=False)
        self.assertEqual(result["sharedImagesRetained"], [])
        self.assertEqual(result["imagesRemoved"][0]["imageId"], self.deployment["imageBindings"][0]["imageId"])

    def test_encryption_fixture_cleanup_can_stage_a_digest_checked_missing_helper(self) -> None:
        source = (ROOT / "tools/cleanup_superseded_encryption_fixture.py").read_text(encoding="utf-8")
        self.assertIn("if not helper_present:", source)
        self.assertIn("replacement LUKS volume helper staging", source)
        self.assertIn("replacement helper identity drifted", source)
        self.assertIn("remote.copy(LUKS_UNLOCK_HELPER", source)


if __name__ == "__main__":
    unittest.main()
