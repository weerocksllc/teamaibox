"""Offline configuration checks, not container or product acceptance."""
from copy import deepcopy
import json
from pathlib import Path
import unittest

from tools.casting_browser_only_container import media_payload, verify_media_container, successor_configuration


class BrowserOnlyContainerTest(unittest.TestCase):
    def setUp(self):
        self.args = dict(run_id="casting-browser-only-20260909-a1", image_id="sha256:" + "a" * 64,
                        credential_directory="/run/teamaibox/casting/casting-browser-only-20260909-a1/media")
        payload = media_payload(**self.args)
        self.inspect = {"Image": self.args["image_id"], "Config": payload, "HostConfig": payload["HostConfig"],
                        "Mounts": [{"Type": "bind", "Source": self.args["credential_directory"],
                                    "Destination": "/run/teamaibox/credentials", "RW": False, "Propagation": "rprivate"}]}

    def test_explicit_runtime_and_no_devices_never_claim_acceptance(self):
        result = verify_media_container(self.inspect, **self.args)
        self.assertFalse(result["productAccepted"])
        self.assertFalse(result["readinessPassed"])
        self.assertEqual(self.inspect["HostConfig"]["Runtime"], "runc")
        self.assertIn("SSL_CERT_FILE=/run/teamaibox/credentials/ca.crt", self.inspect["Config"]["Env"])

    def test_rejects_default_nvidia_runtime_device_injection_or_added_privilege(self):
        cases = {"Runtime": "nvidia", "Devices": [{"PathOnHost": "/dev/dri/card1"}],
                 "DeviceRequests": [{"Driver": "nvidia", "Count": -1}], "Privileged": True,
                 "CapAdd": ["SYS_ADMIN"], "Binds": ["/dev:/dev"], "DeviceCgroupRules": ["a *:* rwm"],
                 "VolumesFrom": ["other"], "PidMode": "host", "IpcMode": "host"}
        for key, value in cases.items():
            with self.subTest(key=key):
                row = deepcopy(self.inspect)
                row["HostConfig"][key] = value
                with self.assertRaises(ValueError): verify_media_container(row, **self.args)

    def test_rejects_extra_sound_display_or_persistent_mounts(self):
        for target in ("/dev/snd", "/dev/dri", "/tmp/.X11-unix", "/run/dbus", "/var/run/docker.sock", "/data"):
            with self.subTest(target=target):
                row = deepcopy(self.inspect)
                row["Mounts"].append({"Type": "bind", "Source": target, "Destination": target, "RW": True})
                with self.assertRaisesRegex(ValueError, "media_mount_changed"): verify_media_container(row, **self.args)

    def test_rejects_mutable_image_foreign_credentials_missing_inspect_and_env_override(self):
        for args in (dict(self.args, image_id="media:latest"), dict(self.args, credential_directory="/run/other")):
            with self.assertRaises(ValueError): media_payload(**args)
        with self.assertRaisesRegex(ValueError, "media_inspect_incomplete"): verify_media_container({}, **self.args)
        self.inspect["Config"]["Env"].append("NVIDIA_VISIBLE_DEVICES=all")
        with self.assertRaisesRegex(ValueError, "media_environment_changed"): verify_media_container(self.inspect, **self.args)

    def test_private_config_conversion_keeps_original_and_unrelated_values(self):
        runtime = {"schemaVersion": 2, "hdmi": {"card": "/dev/dri/card1"}, "sfu": {"keyFile": "sfu.key"}}
        resources = {"schemaVersion": 1, "nodeId": "synthetic", "nodeGeneration": 1}
        old = deepcopy((runtime, resources))
        converted, config = successor_configuration(runtime, resources)
        self.assertEqual((runtime, resources), old)
        self.assertNotIn("hdmi", converted)
        self.assertEqual(converted["sfu"], runtime["sfu"])
        self.assertEqual(config,resources)

    def test_committed_policy_matches_no_display_no_gpu_contract(self):
        root = Path(__file__).resolve().parents[2]
        policy = json.loads((root / "deploy/casting/trusted-media-browser-only-policy.v1.json").read_text())
        self.assertEqual(policy["supportedOutputs"], ["browser"])
        self.assertEqual(policy["container"]["containerRuntime"], "runc")
        for key in ("accepted", "gnomeManagedByCasting", "sharedNvidiaDriverChangesAllowed", "kernelGpuResetAllowed"):
            self.assertIs(policy[key], False)
        for key in ("physicalDisplayReservations", "localAudioReservations"):
            self.assertEqual(policy[key], 0)


if __name__ == "__main__": unittest.main()
