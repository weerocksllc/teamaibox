#!/usr/bin/env python3
"""Focused tests for the redacted legacy protected-office inventory."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


collector = load_module(
    "legacy_protected_office_inventory",
    "tools/collect_legacy_protected_office_inventory.py",
)


def inspect_document(name: str, index: int, *, network_mode: str = "bridge") -> dict:
    label_key = next(
        key
        for slot, _, container_name in collector.TARGETS
        if container_name == name
        for key in collector.LABEL_ALLOWLIST[slot]
    ) if name != collector.OCR_PROVIDER else collector.LABEL_ALLOWLIST["ocr-hunyuan-provider"][0]
    return {
        "Id": format(index, "x") * 64,
        "Name": "/" + name,
        "Image": "sha256:" + format(index, "x") * 64,
        "Config": {
            "Image": f"registry.local/legacy/{name}:exact",
            "User": "10001:10001",
            "Env": ["Z_LAST=two", "PRIVATE_API_TOKEN=never-emit", "A_FIRST=one&<\u2028"],
            "Entrypoint": ["python3", "/app/server.py"],
            "Cmd": ["--serve"],
            "Healthcheck": {
                "Test": ["CMD-SHELL", "test -r /proc/1/status"],
                "Interval": 10_000_000_000,
                "Timeout": 2_000_000_000,
                "StartPeriod": 30_000_000_000,
                "Retries": 3,
            },
            "Labels": {
                label_key: "public-profile-key",
                "private.example": "never-emit-private-label",
            },
            "ExposedPorts": {"8000/tcp": {}},
        },
        "HostConfig": {
            "NetworkMode": network_mode,
            "IpcMode": "private",
            "PidMode": "",
            "ShmSize": 67_108_864,
            "ReadonlyRootfs": True,
            "Privileged": False,
            "CapDrop": ["NET_RAW", "ALL"],
            "SecurityOpt": ["no-new-privileges:true"],
            "PidsLimit": 512,
            "Memory": 2 << 30,
            "MemorySwap": 2 << 30,
            "CpuPeriod": 100_000,
            "CpuQuota": 400_000,
            "PortBindings": {"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18000"}]},
            "Tmpfs": {"/tmp": "rw,noexec,nosuid,size=64m"},
            "Ulimits": [{"Name": "nofile", "Soft": 4096, "Hard": 4096}],
            "DeviceRequests": [{"Driver": "nvidia", "Count": -1, "Capabilities": [["gpu"]]}],
            "RestartPolicy": {"Name": "unless-stopped"},
        },
        "NetworkSettings": {"Networks": {"bridge": {"IPAddress": "172.17.0.2"}}},
        "Mounts": [{
            "Type": "volume",
            "Name": f"legacy-{index}-model",
            "Source": f"/var/lib/docker/volumes/legacy-{index}-model/_data",
            "Destination": "/model",
            "RW": False,
            "Propagation": "",
        }],
        "State": {"Status": "running", "Running": True, "Health": {"Status": "healthy"}},
    }


def documents() -> list[dict]:
    values = [inspect_document(name, index) for index, (_, _, name) in enumerate(collector.TARGETS, 1)]
    ocr_id = values[2]["Id"]
    values.append(inspect_document(collector.OCR_PROVIDER, 7, network_mode="container:" + ocr_id))
    return values


def go_contract_document() -> dict:
    """Exact JSON fixture shared with legacy_protected_set_test.go."""
    return {
        "Id": "1" + "0" * 63,
        "Name": "/legacy-office-worker",
        "Image": "sha256:" + "a" * 64,
        "Mounts": [{
            "Type": "volume", "Name": "legacy-office-model",
            "Source": "/var/lib/docker/volumes/legacy-office-model/_data",
            "Destination": "/model", "RW": False, "Propagation": "",
        }],
        "State": {"Status": "running", "Health": {"Status": "healthy"}},
        "Config": {
            "Image": "legacy.local/office:exact", "User": "10001:10001",
            "Env": ["MODEL=/model"], "Cmd": ["serve"], "Entrypoint": ["/entrypoint"],
            "Labels": {"legacy.teamaibox.slot": "embedding"},
            "Healthcheck": {
                "Test": ["CMD-SHELL", "test -r /proc/1/status"],
                "Interval": 10_000_000_000, "Timeout": 2_000_000_000,
                "StartPeriod": 30_000_000_000, "Retries": 3,
            },
        },
        "HostConfig": {
            "NetworkMode": "bridge", "IpcMode": "private", "PidMode": "",
            "ShmSize": 64 << 20, "ReadonlyRootfs": True, "Privileged": False,
            "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
            "PidsLimit": 128, "Memory": 1 << 30, "MemorySwap": 1 << 30,
            "CpuPeriod": 100_000, "CpuQuota": 100_000,
            "Tmpfs": {"/tmp": "rw,noexec"},
            "Ulimits": [{"Name": "nofile", "Soft": 4096, "Hard": 4096}],
            "RestartPolicy": {"Name": "no"},
        },
        "NetworkSettings": {"Networks": {"bridge": {"IPAddress": "172.17.0.2"}}},
    }


class LegacyProtectedOfficeInventoryTests(unittest.TestCase):
    def test_inventory_is_exact_ordered_read_only_and_redacted(self) -> None:
        inventory = collector.build_inventory(documents())
        self.assertEqual([item["slot"] for item in inventory["targets"]],
                         [item[0] for item in collector.TARGETS])
        self.assertEqual(inventory["inspectionMode"], "read-only")
        self.assertFalse(inventory["sourceMutationPerformed"])
        self.assertFalse(inventory["modelLoadPerformed"])
        serialized = json.dumps(inventory, sort_keys=True)
        self.assertNotIn("never-emit", serialized)
        self.assertNotIn("PRIVATE_API_TOKEN", serialized)
        self.assertNotIn("private.example", serialized)
        for target in inventory["targets"]:
            identities = [target["legacyPreviousTarget"]["primary"],
                          *target["legacyPreviousTarget"].get("dependentContainers", [])]
            for identity in identities:
                for key in ("requiredRuntimeDigest", "requiredEnvironmentDigest",
                            "requiredCommandDigest", "requiredHealthcheckDigest"):
                    self.assertRegex(identity[key], r"^sha256:[0-9a-f]{64}$")
        ocr = inventory["targets"][2]["legacyPreviousTarget"]
        self.assertEqual(ocr["dependentContainers"][0]["requiredNetworkMode"],
                         "container:" + ocr["primary"]["containerId"])

    def test_digest_encoding_matches_go_html_and_line_separator_rules(self) -> None:
        self.assertEqual(
            collector.go_json({"value": "a&<b>\u2028\u2029"}),
            b'{"value":"a\\u0026\\u003cb\\u003e\\u2028\\u2029"}',
        )
        # Regression values bind field order, nil handling, and redacted full
        # runtime hashing.  They are intentionally independent of output JSON.
        document = documents()[0]
        self.assertEqual(collector.environment_digest(document["Config"]),
                         "sha256:377381891c85df4e309e5969ecbb821acb13b7fa40edd41c7127eaf9e28c2d6e")
        self.assertEqual(collector.runtime_digest(document),
                         "sha256:0cae806bbf087a68a5ec06bbff4ef87ca4df50f491971606bf8fef6973a1d0b2")

    def test_digests_match_the_shared_go_contract_fixture(self) -> None:
        document = go_contract_document()
        self.assertEqual(collector.environment_digest(document["Config"]),
                         "sha256:727c6e64e6b64cb8c81d4e2165dba343eaf1ff92a4f2d779b3eb17509acd4b36")
        self.assertEqual(collector.command_digest(document["Config"]),
                         "sha256:060cc74915c00e668b008f9af2cd8572519148ef35bebe265b00fd2b3084845b")
        self.assertEqual(collector.healthcheck_digest(document["Config"]),
                         "sha256:1538cfe07355c7c33318e6444c0b8117d48eb9b703d45dfe9b9bfe36341a2a74")
        self.assertEqual(collector.runtime_digest(document),
                         "sha256:9db8cd861a80cc4bf999d403c01226d6102daa0bf3a5644d55bcf2dbca4f4578")

    def test_runtime_digest_binds_network_membership_not_runtime_address(self) -> None:
        document = documents()[0]
        original = collector.runtime_digest(document)

        reassigned = copy.deepcopy(document)
        reassigned["NetworkSettings"]["Networks"]["bridge"]["IPAddress"] = "172.17.0.99"
        reassigned["NetworkSettings"]["Networks"]["bridge"]["Gateway"] = "172.17.0.1"
        self.assertEqual(collector.runtime_digest(reassigned), original)

        different_membership = copy.deepcopy(document)
        network = different_membership["NetworkSettings"]["Networks"].pop("bridge")
        different_membership["NetworkSettings"]["Networks"]["compute-internal"] = network
        self.assertNotEqual(collector.runtime_digest(different_membership), original)

    def test_inventory_fails_closed_on_set_health_and_namespace_drift(self) -> None:
        cases = []
        missing = documents()
        missing.pop()
        cases.append(missing)
        unhealthy = documents()
        unhealthy[0]["State"]["Health"]["Status"] = "unhealthy"
        cases.append(unhealthy)
        wrong_namespace = documents()
        wrong_namespace[-1]["HostConfig"]["NetworkMode"] = "container:" + "f" * 64
        cases.append(wrong_namespace)
        duplicate_env = documents()
        duplicate_env[0]["Config"]["Env"].append("Z_LAST=duplicate")
        cases.append(duplicate_env)
        for case in cases:
            with self.subTest():
                with self.assertRaises(collector.InventoryError):
                    collector.build_inventory(case)

    def test_ssh_collector_uses_only_exact_read_only_inspect_argv(self) -> None:
        payload = json.dumps(documents()).encode()
        completed = subprocess.CompletedProcess([], 0, stdout=payload, stderr=b"secret-stderr")
        with mock.patch.object(collector.subprocess, "run", return_value=completed) as run:
            values = collector.inspect_over_ssh("operator@10.64.0.20")
        self.assertEqual(len(values), 7)
        args = run.call_args.args[0]
        self.assertEqual(args[:2], ["ssh", "-o"])
        self.assertEqual(args[-12:], [
            "operator@10.64.0.20", "docker", "inspect", "--type", "container",
            *[item[2] for item in collector.TARGETS], collector.OCR_PROVIDER,
        ])
        self.assertNotIn("sudo", args)
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_ssh_failure_does_not_disclose_remote_output(self) -> None:
        completed = subprocess.CompletedProcess([], 1, stdout=b"secret-stdout", stderr=b"secret-stderr")
        with mock.patch.object(collector.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(collector.InventoryError, "inspection failed") as raised:
                collector.inspect_over_ssh("operator@10.64.0.20")
        self.assertNotIn("secret", str(raised.exception))

    def test_immutable_writer_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = (Path(directory) / "inventory.json").resolve()
            collector.immutable_write(path, {"schemaVersion": 1})
            with self.assertRaises(FileExistsError):
                collector.immutable_write(path, {"schemaVersion": 2})
            self.assertEqual(json.loads(path.read_text()), {"schemaVersion": 1})

    def test_node_identity_requires_a_canonical_uuid(self) -> None:
        with self.assertRaises(collector.InventoryError):
            collector.build_inventory(documents(), node_id="f" * 36)


if __name__ == "__main__":
    unittest.main()
