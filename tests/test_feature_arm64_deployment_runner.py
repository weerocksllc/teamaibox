from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools.run_feature_arm64_deployment import (
    ROOT,
    FeatureDeploymentError,
    CommandResult,
    execute_plan,
    load_policy,
    remote_command,
    validate_plan,
    write_runtime_environment,
)


PLAN = ROOT / "deploy" / "feature-runner-canary" / "plan-20260812-a1.json"
IMAGE_ID = "sha256:" + "a" * 64


class FakeRemote:
    def __init__(self, fail_contains: str | None = None) -> None:
        self.fail_contains = fail_contains
        self.commands: list[tuple[str, ...]] = []
        self.copies: list[tuple[str, str]] = []

    def run(self, command, timeout=30):
        values = tuple(str(item) for item in command)
        self.commands.append(values)
        joined = " ".join(values)
        if self.fail_contains and self.fail_contains in joined:
            return CommandResult(1, "", "controlled failure")
        if values[:4] == ("docker", "version", "--format", "{{.Server.Arch}}"):
            return CommandResult(0, "arm64\n", "")
        if values[:4] == ("docker", "image", "inspect", "--format"):
            return CommandResult(0, f"arm64 {IMAGE_ID}\n", "")
        if values[:2] == ("docker", "ps"):
            if "--quiet" in values:
                return CommandResult(0, "", "")
            project = values[values.index("--filter") + 1].rsplit("=", 1)[1]
            return CommandResult(0, project + "\n", "")
        return CommandResult(0, "ok\n", "")

    def copy(self, local_path, remote_path, timeout=60):
        self.copies.append((Path(local_path).name, remote_path))
        return CommandResult(0, "", "")


class FeatureArm64DeploymentRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.plan = json.loads(PLAN.read_text(encoding="utf-8"))

    def mutation(self) -> dict:
        return copy.deepcopy(self.plan)

    def test_canary_plan_is_closed_allowlisted_and_digest_oriented(self) -> None:
        value = validate_plan(self.plan)
        self.assertEqual(value["target"], "dgx-spark-dev-01")
        self.assertEqual(value["dependencyServices"], ["state"])
        self.assertEqual(load_policy()["architecture"], "linux/arm64/v8")

    def test_plan_rejects_unknown_target_mutable_build_and_sensitive_environment(self) -> None:
        target = self.mutation()
        target["target"] = "d@10.0.0.1"
        with self.assertRaisesRegex(FeatureDeploymentError, "not allowlisted"):
            validate_plan(target)

        mutable = self.mutation()
        mutable["images"][0]["buildTag"] = "teamaibox/canary:latest"
        with self.assertRaisesRegex(FeatureDeploymentError, "run-scoped"):
            validate_plan(mutable)

        secret = self.mutation()
        secret["environment"]["DATABASE_PASSWORD"] = "plaintext"
        with self.assertRaisesRegex(FeatureDeploymentError, "sensitive"):
            validate_plan(secret)

        health = self.mutation()
        health["healthChecks"][0]["command"] = ["curl", "http://localhost"]
        with self.assertRaisesRegex(FeatureDeploymentError, "through Docker"):
            validate_plan(health)

    def test_runtime_environment_uses_measured_image_id_and_secret_file_reference(self) -> None:
        plan = self.mutation()
        plan["environment"]["CANARY_MODE"] = "validation"
        plan["secrets"]["CANARY_TOKEN_FILE"] = "/run/secrets/canary-token"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.env"
            digest = write_runtime_environment(plan, {"feature-runner-canary": IMAGE_ID}, path)
            content = path.read_text()
            self.assertIn(f"TEAMAIBOX_FEATURE_CANARY_IMAGE={IMAGE_ID}\n", content)
            self.assertIn("CANARY_TOKEN_FILE=/run/secrets/canary-token\n", content)
            self.assertNotIn("plaintext", content)
            self.assertTrue(digest.startswith("sha256:"))

    def test_sanitized_staged_repository_root_is_an_allowed_build_context(self) -> None:
        plan = self.mutation()
        plan["images"][0]["context"] = "."
        self.assertEqual(validate_plan(plan)["images"][0]["context"], ".")
        escaped = self.mutation()
        escaped["images"][0]["context"] = "../outside"
        with self.assertRaisesRegex(FeatureDeploymentError, "escapes"):
            validate_plan(escaped)

    def test_build_arguments_are_explicit_bounded_and_non_sensitive(self) -> None:
        plan = self.mutation()
        plan["images"][0]["buildArgs"] = {"NODE_IMAGE": "localhost:15000/base/node@" + IMAGE_ID}
        self.assertEqual(validate_plan(plan)["images"][0]["buildArgs"]["NODE_IMAGE"], plan["images"][0]["buildArgs"]["NODE_IMAGE"])
        plan["images"][0]["buildArgs"] = {"REGISTRY_TOKEN": "forbidden"}
        with self.assertRaisesRegex(FeatureDeploymentError, "sensitive"):
            validate_plan(plan)

    def test_compose_checks_resolve_relative_bind_sources_from_the_staged_repository_root(self) -> None:
        command = remote_command(
            ["docker", "compose", "run", "--rm", "platform-api", "node", "check.mjs"],
            "/tmp/teamaibox-feature-run",
            "teamaibox_feature_run",
            ["deploy/application-catalog-e2e/compose.yaml", "deploy/application-catalog-e2e/agent.compose.yaml"],
            "deploy/application-catalog-e2e/catalog.env",
        )
        project_index = command.index("--project-directory")
        run_index = command.index("run")
        self.assertEqual(command[project_index + 1], "/tmp/teamaibox-feature-run/source")
        self.assertLess(project_index, run_index)

    def test_success_path_builds_arm64_deploys_migrates_replays_and_writes_immutable_evidence(self) -> None:
        remote = FakeRemote()
        with tempfile.TemporaryDirectory(dir=ROOT / "evidence") as directory:
            output = Path(directory) / "runner-success.json"
            result = execute_plan(self.plan, remote=remote, evidence_path=output)
            self.assertEqual(result["status"], "passed")
            self.assertTrue(result["idempotentReplayPassed"])
            self.assertTrue(result["stagingCleanupPassed"])
            self.assertTrue(result["deploymentRootRetained"])
            self.assertTrue(result["deploymentMaterialCheckPassed"])
            self.assertEqual(result["deploymentRoot"], "/var/lib/teamaibox-feature-deployments/" + self.plan["runId"])
            self.assertEqual(result["imageBindings"][0]["imageId"], IMAGE_ID)
            self.assertTrue(output.is_file())
            commands = [" ".join(command) for command in remote.commands]
            self.assertTrue(any("buildx build --platform linux/arm64/v8 --network host" in command for command in commands))
            self.assertEqual(sum("up --detach --wait --remove-orphans" in command for command in commands), 2)
            self.assertTrue(any("run --rm --no-deps canary node migrate.mjs" in command for command in commands))
            self.assertTrue(any("sudo --non-interactive install --directory" in command for command in commands))
            self.assertTrue(any("durable-deployment-material" == step["key"] for step in result["steps"]))

    def test_offline_reuse_requires_exact_parent_and_materializes_only_the_declared_image(self) -> None:
        plan = self.mutation()
        component = plan["images"][0]["component"]
        parent = ROOT / "evidence" / "validation" / "feature-runner-reuse-unit.json"
        payload = {
            "imageBindings": [{"component": component, "imageId": IMAGE_ID, "platform": "linux/arm64/v8"}],
            "steps": [{"key": f"build-{component}", "passed": True}],
        }
        encoded = json.dumps(payload, sort_keys=True).encode()
        parent.write_bytes(encoded)
        try:
            plan["images"][0]["reuse"] = {
                "imageId": IMAGE_ID,
                "parentEvidence": parent.relative_to(ROOT).as_posix(),
                "parentEvidenceDigest": "sha256:" + hashlib.sha256(encoded).hexdigest(),
            }
            remote = FakeRemote()
            with tempfile.TemporaryDirectory(dir=ROOT / "evidence") as directory:
                result = execute_plan(plan, remote=remote, evidence_path=Path(directory) / "reuse.json")
            commands = [" ".join(command) for command in remote.commands]
            self.assertEqual(result["steps"][1]["key"], f"reuse-{component}")
            self.assertTrue(any(f"docker image tag {IMAGE_ID}" in command for command in commands))
            self.assertFalse(any("buildx build" in command for command in commands))
            plan["images"][0]["reuse"]["parentEvidenceDigest"] = "sha256:" + "0" * 64
            with self.assertRaisesRegex(FeatureDeploymentError, "parentEvidenceDigest changed"):
                validate_plan(plan)
        finally:
            parent.unlink(missing_ok=True)

    def test_failure_path_rolls_back_exact_project_cleans_stage_and_never_overwrites_evidence(self) -> None:
        remote = FakeRemote(fail_contains="exec -T canary node probe.mjs")
        with tempfile.TemporaryDirectory(dir=ROOT / "evidence") as directory:
            output = Path(directory) / "runner-failure.json"
            with self.assertRaisesRegex(FeatureDeploymentError, "evidence"):
                execute_plan(self.plan, remote=remote, evidence_path=output)
            value = json.loads(output.read_text())
            self.assertEqual(value["status"], "failed")
            self.assertTrue(value["rollbackAttempted"])
            self.assertTrue(value["rollbackPassed"])
            self.assertTrue(value["stagingCleanupPassed"])
            self.assertFalse(value["deploymentRootRetained"])
            self.assertFalse(value["deploymentMaterialCheckPassed"])
            self.assertFalse(value["credentialsRetained"])
            self.assertTrue(any("down --volumes --remove-orphans" in " ".join(command) for command in remote.commands))
            with self.assertRaisesRegex(FeatureDeploymentError, "already exists"):
                execute_plan(self.plan, remote=FakeRemote(), evidence_path=output)


if __name__ == "__main__":
    unittest.main()
