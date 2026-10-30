from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from tools import run_compute_internal_network_deployment as deployment
from tools import validate_compute_internal_network_deployment as validator


RUN_ID = "compute-internal-network-20260905-a1"
NETWORK_ID = "a" * 64


def network(*, run_id: str = RUN_ID, network_id: str = NETWORK_ID,
            driver: str = "bridge", attachable: bool = False) -> dict:
    return {
        "Name": "compute-internal",
        "Id": network_id,
        "Created": "2026-09-05T12:00:00.000000000Z",
        "Scope": "local",
        "Driver": driver,
        "EnableIPv6": False,
        "IPAM": {"Driver": "default", "Options": None, "Config": [{"Subnet": "172.31.0.0/16"}]},
        "Internal": True,
        "Attachable": attachable,
        "Ingress": False,
        "ConfigOnly": False,
        "Options": {},
        "Labels": {
            "com.teamaibox.managed": "true",
            "com.teamaibox.run-id": run_id,
            "com.teamaibox.component": "compute-internal-network",
        },
        # Endpoint inventory is deliberately present in Docker output so the
        # test proves that it is not copied into immutable evidence.
        "Containers": {"b" * 64: {"Name": "must-not-be-retained"}},
    }


class FakeRunner:
    def __init__(self, current: dict | None = None, *, fail_repeat_once: bool = False):
        self.current = deepcopy(current)
        self.commands: list[tuple[list[str], int]] = []
        self.inspect_count = 0
        self.fail_repeat_once = fail_repeat_once

    def run(self, arguments, timeout=30):
        command = list(arguments)
        self.commands.append((command, timeout))
        if command == ["network", "inspect", "compute-internal"]:
            self.inspect_count += 1
            if self.current is None:
                return deployment.CommandResult(1, "", "Error: No such network: compute-internal")
            if self.fail_repeat_once and self.inspect_count == 3:
                bad = deepcopy(self.current)
                bad["Attachable"] = True
                return deployment.CommandResult(0, json.dumps([bad]), "")
            return deployment.CommandResult(0, json.dumps([self.current]), "")
        if command[:2] == ["network", "create"]:
            self.assert_create_command(command)
            run_label = next(item for item in command if item.startswith("com.teamaibox.run-id="))
            self.current = network(run_id=run_label.split("=", 1)[1])
            return deployment.CommandResult(0, NETWORK_ID + "\n", "")
        if command == ["network", "rm", NETWORK_ID]:
            self.current = None
            return deployment.CommandResult(0, NETWORK_ID + "\n", "")
        raise AssertionError(f"unexpected command: {command}")

    def assert_create_command(self, command: list[str]) -> None:
        self_test = unittest.TestCase()
        self_test.assertEqual(command, [
            "network", "create",
            "--driver", "bridge",
            "--internal",
            "--attachable=false",
            "--ipv6=false",
            "--label", "com.teamaibox.managed=true",
            "--label", f"com.teamaibox.run-id={RUN_ID}",
            "--label", "com.teamaibox.component=compute-internal-network",
            "compute-internal",
        ])


class ComputeInternalNetworkDeploymentTests(unittest.TestCase):
    def execute(self, runner: FakeRunner, run_id: str = RUN_ID) -> dict:
        return deployment.execute_deployment(
            run_id,
            runner,
            clock=lambda: "2026-09-05T12:00:00.000Z",
        )

    def test_creates_only_the_exact_internal_non_attachable_bridge(self):
        runner = FakeRunner()
        evidence = self.execute(runner)
        self.assertEqual(evidence["status"], "passed")
        self.assertTrue(evidence["createdByRun"])
        self.assertEqual(evidence["network"]["id"], NETWORK_ID)
        self.assertEqual(evidence["network"]["labels"], {
            "com.teamaibox.managed": "true",
            "com.teamaibox.run-id": RUN_ID,
            "com.teamaibox.component": "compute-internal-network",
        })
        self.assertFalse(evidence["network"]["attachable"])
        self.assertFalse(evidence["network"]["enableIPv6"])
        self.assertTrue(evidence["network"]["internal"])
        self.assertNotIn("Containers", json.dumps(evidence))
        self.assertEqual(evidence["commandAudit"], {
            "networkInspectCount": 4,
            "networkCreateCount": 1,
            "networkRemoveCount": 0,
            "containerCommandCount": 0,
            "otherNetworkCommandCount": 0,
            "allCommandsScopedToComputeInternal": True,
        })
        self.assertEqual([command for command, _ in runner.commands].count(
            ["network", "inspect", "compute-internal"]), 4)
        self.assertTrue(all(command[0] == "network" for command, _ in runner.commands))
        self.assertTrue(all("compute-internal" in command for command, _ in runner.commands))
        result = validator.validate_document(evidence)
        self.assertEqual(result["networkId"], NETWORK_ID)
        self.assertTrue(result["createdByRun"])

    def test_reuses_one_exact_preexisting_network_without_mutation(self):
        owner = "compute-internal-network-20260904-a7"
        runner = FakeRunner(network(run_id=owner))
        evidence = self.execute(runner)
        self.assertEqual(evidence["status"], "passed")
        self.assertFalse(evidence["createdByRun"])
        self.assertEqual(evidence["network"]["ownershipRunId"], owner)
        self.assertEqual(evidence["commandAudit"]["networkCreateCount"], 0)
        self.assertEqual(len(runner.commands), 4)
        self.assertTrue(all(command == ["network", "inspect", "compute-internal"]
                            for command, _ in runner.commands))
        self.assertFalse(validator.validate_document(evidence)["createdByRun"])

    def test_conflicting_existing_network_fails_without_any_mutation(self):
        runner = FakeRunner(network(driver="overlay"))
        evidence = self.execute(runner)
        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["failure"]["code"], "network_identity_conflict")
        self.assertFalse(evidence["createdByRun"])
        self.assertEqual(evidence["commandAudit"]["networkCreateCount"], 0)
        self.assertEqual(evidence["commandAudit"]["networkRemoveCount"], 0)
        self.assertEqual(len(runner.commands), 1)
        with self.assertRaisesRegex(validator.ValidationError, "did not pass"):
            validator.validate_document(evidence)

    def test_failure_after_creation_removes_only_the_exact_owned_network(self):
        runner = FakeRunner(fail_repeat_once=True)
        evidence = self.execute(runner)
        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["failure"]["code"], "network_identity_conflict")
        self.assertEqual(evidence["failureCleanup"], {
            "required": True,
            "attempted": True,
            "removed": True,
            "verifiedAbsent": True,
            "passed": True,
            "networkId": NETWORK_ID,
        })
        self.assertIn((["network", "rm", NETWORK_ID], 30), runner.commands)
        self.assertIsNone(runner.current)
        self.assertTrue(all(command[0] == "network" for command, _ in runner.commands))

    def test_ambiguous_creation_identity_is_never_removed(self):
        class AmbiguousRunner(FakeRunner):
            def run(self, arguments, timeout=30):
                result = super().run(arguments, timeout)
                if list(arguments)[:2] == ["network", "create"]:
                    self.current["Id"] = "b" * 64
                return result

        runner = AmbiguousRunner()
        evidence = self.execute(runner)
        self.assertEqual(evidence["status"], "failed")
        self.assertFalse(evidence["failureCleanup"]["passed"])
        self.assertEqual(evidence["commandAudit"]["networkRemoveCount"], 0)
        self.assertIsNotNone(runner.current)

    def test_non_not_found_inspection_error_cannot_trigger_creation(self):
        class UnavailableRunner:
            def __init__(self):
                self.commands = []

            def run(self, arguments, timeout=30):
                self.commands.append(list(arguments))
                return deployment.CommandResult(1, "", "Cannot connect to Docker daemon")

        runner = UnavailableRunner()
        evidence = self.execute(runner)
        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["failure"]["code"], "network_inspect_failed")
        self.assertEqual(runner.commands, [["network", "inspect", "compute-internal"]])

    def test_validator_rejects_property_command_and_digest_drift(self):
        evidence = self.execute(FakeRunner())
        for mutation, message in [
            (lambda value: value["network"].update({"attachable": True}), "evidence digest drifted"),
            (lambda value: value["commandAudit"].update({"containerCommandCount": 1}), "evidence digest drifted"),
            (lambda value: value.update({"evidenceDigest": "sha256:" + "0" * 64}), "evidence digest drifted"),
        ]:
            changed = deepcopy(evidence)
            mutation(changed)
            with self.assertRaisesRegex(validator.ValidationError, message):
                validator.validate_document(changed)

        changed = deepcopy(evidence)
        changed["network"]["attachable"] = True
        changed["network"]["identityDigest"] = validator.canonical_digest({
            key: item for key, item in changed["network"].items() if key != "identityDigest"
        })
        for name in ("established", "repeatOne", "repeatTwo"):
            changed["inspections"][name]["identityDigest"] = changed["network"]["identityDigest"]
        changed["evidenceDigest"] = validator.canonical_digest({
            key: item for key, item in changed.items() if key != "evidenceDigest"
        })
        with self.assertRaisesRegex(validator.ValidationError, "isolation properties drifted"):
            validator.validate_document(changed)

    def test_immutable_writer_refuses_to_overwrite_existing_evidence(self):
        evidence = self.execute(FakeRunner())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / f"{RUN_ID}.json"
            deployment.immutable_write(path, evidence)
            first = path.read_bytes()
            with self.assertRaises(FileExistsError):
                deployment.immutable_write(path, evidence)
            self.assertEqual(path.read_bytes(), first)

    def test_run_id_and_missing_network_diagnostic_are_bounded(self):
        runner = FakeRunner()
        with self.assertRaisesRegex(deployment.DeploymentError, "run ID is invalid"):
            self.execute(runner, "compute-internal-network-bad")
        self.assertEqual(runner.commands, [])


if __name__ == "__main__":
    unittest.main()
