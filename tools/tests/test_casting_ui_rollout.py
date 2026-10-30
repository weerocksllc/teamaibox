"""Offline safety tests; these fixtures never become deployment evidence."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("rollout", Path(__file__).parents[1] / "rollout_casting_ui_platform.py")
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)


class RolloutTests(unittest.TestCase):
    def parent(self):
        return {"Id": rollout.PARENT_ID, "Image": rollout.PARENT_IMAGE,
                "Config": {"Image": rollout.PARENT_IMAGE, "Env": ["KEEP=fixture", "PLATFORM_CASTING_AVAILABILITY_FILE=old"],
                           "Labels": {"old": "keep"}, "Cmd": ["server"], "Healthcheck": {"Test": ["CMD", "node"]}},
                "HostConfig": {"Privileged": False, "ReadonlyRootfs": True,
                               "Mounts": [{"Source": "fixture", "ReadOnly": True}], "RestartPolicy": {"Name": "unless-stopped"}},
                "NetworkSettings": {"Networks": {"fixture-network": {"Aliases": ["platform-api"]}}}}

    def test_clone_preserves_existing_configuration_and_isolates_candidate_alias(self):
        parent = self.parent()
        original = copy.deepcopy(parent)
        result = rollout.clone_payload(parent, "sha256:" + "a" * 64, "fixture-run")
        self.assertEqual(parent, original)
        self.assertEqual(result["HostConfig"]["Mounts"], parent["HostConfig"]["Mounts"])
        self.assertIn("KEEP=fixture", result["Env"])
        self.assertEqual(result["Cmd"], parent["Config"]["Cmd"])
        self.assertEqual(result["NetworkingConfig"]["EndpointsConfig"]["fixture-network"]["Aliases"], ["fixture-run"])
        self.assertEqual(result["HostConfig"]["RestartPolicy"]["Name"], "no")

    def test_refuses_changed_parent_and_device_access(self):
        for key, value in [("Privileged", True), ("ReadonlyRootfs", False), ("Devices", ["fixture"]), ("DeviceRequests", ["fixture"])]:
            parent = self.parent()
            parent["HostConfig"][key] = value
            with self.assertRaises(RuntimeError):
                rollout.clone_payload(parent, "new", "fixture-run")
        parent = self.parent()
        parent["Id"] = "different"
        with self.assertRaises(RuntimeError):
            rollout.clone_payload(parent, "new", "fixture-run")


if __name__ == "__main__":
    unittest.main()
