from __future__ import annotations

import copy
import json
import unittest

from tools.validate_deployment import (
    IMAGE_LOCK,
    RESOURCE_POLICY,
    DeploymentError,
    validate_image_lock,
    validate_resource_policy,
    validate_docker_socket_mount,
)


class DeploymentFoundationTests(unittest.TestCase):
    def test_committed_image_lock_is_arm64_and_digest_pinned(self) -> None:
        validate_image_lock(json.loads(IMAGE_LOCK.read_text(encoding="utf-8")))

    def test_rejects_mutable_image_reference(self) -> None:
        lock = json.loads(IMAGE_LOCK.read_text(encoding="utf-8"))
        lock["images"]["nats"]["reference"] = "docker.io/library/nats:latest"
        with self.assertRaisesRegex(DeploymentError, "digest pinned"):
            validate_image_lock(lock)

    def test_committed_resource_policy_preserves_all_core_services(self) -> None:
        validate_resource_policy(json.loads(RESOURCE_POLICY.read_text(encoding="utf-8")))

    def test_rejects_floor_below_reservations(self) -> None:
        policy = copy.deepcopy(json.loads(RESOURCE_POLICY.read_text(encoding="utf-8")))
        policy["applianceFloor"]["unifiedMemoryBytes"] = 1
        with self.assertRaisesRegex(DeploymentError, "below service reservations"):
            validate_resource_policy(policy)

    def test_rejects_unclassified_service(self) -> None:
        policy = copy.deepcopy(json.loads(RESOURCE_POLICY.read_text(encoding="utf-8")))
        policy["resourceClasses"]["core-standard"]["services"].remove("web")
        with self.assertRaisesRegex(DeploymentError, "classified"):
            validate_resource_policy(policy)

    def test_rejects_missing_survival_domain_or_io_floor(self) -> None:
        policy = copy.deepcopy(json.loads(RESOURCE_POLICY.read_text(encoding="utf-8")))
        del policy["serviceSurvivalDomains"]["queue"]
        with self.assertRaisesRegex(DeploymentError, "seven core-service"):
            validate_resource_policy(policy)
        policy = copy.deepcopy(json.loads(RESOURCE_POLICY.read_text(encoding="utf-8")))
        policy["applianceFloor"]["diskWriteBytesPerSecond"] = 0
        with self.assertRaisesRegex(DeploymentError, "diskWriteBytesPerSecond"):
            validate_resource_policy(policy)

    def test_only_node_agent_receives_the_exact_read_only_docker_socket(self) -> None:
        mount = {
            "type": "bind",
            "source": "/var/run/docker.sock",
            "target": "/var/run/docker.sock",
            "read_only": True,
        }
        self.assertTrue(validate_docker_socket_mount("node-agent", mount))
        with self.assertRaisesRegex(DeploymentError, "unexpectedly mounts"):
            validate_docker_socket_mount("plugin-runtime", mount)
        with self.assertRaisesRegex(DeploymentError, "exact read-only"):
            validate_docker_socket_mount("node-agent", {**mount, "read_only": False})
        with self.assertRaisesRegex(DeploymentError, "exact read-only"):
            validate_docker_socket_mount("node-agent", {**mount, "target": "/tmp/docker.sock"})


if __name__ == "__main__":
    unittest.main()
