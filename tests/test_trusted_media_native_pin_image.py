"""Offline ARM64 binary checks; no sender, mDNS LAN or display acceptance."""
import json
import os
import subprocess
import unittest
import uuid


IMAGE = os.environ.get("TEAMAIBOX_TEST_MEDIA_IMAGE", "")


@unittest.skipUnless(IMAGE, "set an exact local candidate image to run Docker checks")
class NativePinImageTest(unittest.TestCase):
    def setUp(self):
        inspected = subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True, check=True, timeout=15)
        info, = json.loads(inspected.stdout)
        self.assertEqual(info["Architecture"], "arm64")
        self.assertEqual(info["Config"]["User"], "65532:65532")
        self.image_id = info["Id"]

    def invoke(self, payload):
        name = "teamaibox-native-pin-probe-" + uuid.uuid4().hex
        command = ["docker", "run", "--rm", "-i", "--name", name,
                   "--label", "com.teamaibox.native-pin-probe=" + name,
                   "--network", "none", "--read-only", "--no-healthcheck",
                   "--memory", "256m", "--memory-swap", "256m", "--cpus", "1",
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", "--entrypoint", "/usr/bin/uxplay",
                   self.image_id, "-n", "Team-AI-0123456789", "-nh", "-m",
                   # This binary-only check has no display or sound device.
                   # Match production's software decoding; never let UxPlay's
                   # desktop auto-sinks attempt to initialize a headless GPU.
                   "-srgb", "no", "-vd", "avdec_h264", "-vs", "fakesink", "-as", "fakesink"]
        try:
            return subprocess.run(command, input=payload, capture_output=True, timeout=12)
        finally:
            inspected = subprocess.run(["docker", "container", "inspect", name], capture_output=True, timeout=10)
            if inspected.returncode == 0:
                info, = json.loads(inspected.stdout)
                self.assertEqual(info["Config"]["Labels"]["com.teamaibox.native-pin-probe"], name)
                self.assertEqual(info["Image"], self.image_id)
                subprocess.run(["docker", "rm", "-f", info["Id"]], capture_output=True, check=True, timeout=10)

    def test_invalid_pin_exits_before_network_advertisement(self):
        for payload in (b"", b"123456\n", b"0000\n", b"1234\nextra"):
            with self.subTest(payload_length=len(payload)):
                result = self.invoke(payload)
                self.assertEqual(result.returncode, 64)
                self.assertIn(b"cast_receiver_pin_delivery_failed", result.stderr)
                self.assertNotIn(b"1234", result.stdout + result.stderr)

    def test_valid_pipe_reaches_receiver_without_exposing_pin(self):
        result = self.invoke(b"1234\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(result.returncode, 64)
        self.assertNotEqual(result.returncode, 125)  # Docker startup failure is not receiver acceptance.
        self.assertNotIn(b"cast_receiver_pin_delivery_failed", result.stdout + result.stderr)
        self.assertNotIn(b"1234", result.stdout + result.stderr)
        # Network-none has no Avahi daemon. This intentionally does not assert
        # successful receiver advertisement or a supported sender protocol.
        # Upstream reports missing DNS-SD with exit 0. Assert the reached stage
        # and the explicit offline failure instead of treating that exit as
        # successful advertisement.
        self.assertIn(b"Initialized server socket(s)", result.stdout + result.stderr)
        self.assertIn(b"No DNS-SD Server found", result.stdout + result.stderr)

    def test_pin_log_format_is_absent_from_final_binary(self):
        result = subprocess.run(["docker", "run", "--rm", "--network", "none", "--read-only",
                                 "--entrypoint", "grep", self.image_id, "-a", "-q",
                                 "CLIENT MUST NOW ENTER PIN", "/usr/bin/uxplay"],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)


if __name__ == "__main__":
    unittest.main()
