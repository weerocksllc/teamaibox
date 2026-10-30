"""Real GStreamer pipe transport in the candidate; not Apple/HDMI/SFU proof.

Only dedicated generated video and tones are used. Raw media remains inside
anonymous container pipes, never Docker stdout/logs or a persistent file.
"""
import json
import os
import re
import shlex
import subprocess
import unittest
from uuid import uuid4

from services.trusted_media_service.native_receiver_process import (
    AUDIO_SINK_PIPELINE, VIDEO_SINK_PIPELINE,
)

IMAGE = os.environ.get("TEAMAIBOX_TEST_MEDIA_IMAGE", "")


@unittest.skipUnless(IMAGE, "set an exact local ARM64 candidate image")
class GdpTransportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(["docker", "image", "inspect", IMAGE],
                                capture_output=True, check=True, timeout=15)
        info, = json.loads(result.stdout)
        if info["Architecture"] != "arm64" or info["Config"]["User"] != "65532:65532":
            raise AssertionError("unexpected candidate architecture/user")
        cls.image_id = info["Id"]

    def invoke(self, script):
        name = "teamaibox-gdp-transport-" + uuid4().hex
        try:
            return subprocess.run([
                "docker", "run", "--rm", "--name", name,
                "--label", "com.teamaibox.gdp-transport=" + name,
                "--network", "none", "--read-only", "--no-healthcheck",
                "--log-driver", "none", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--memory", "256m", "--cpus", "1",
                "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
                "--env", "GST_REGISTRY=/tmp/gstreamer-registry.bin",
                "--env", "GST_DEBUG=0", "--entrypoint", "/bin/bash",
                self.image_id, "-o", "pipefail", "-c", script,
            ], capture_output=True, timeout=30)
        finally:
            result = subprocess.run(["docker", "inspect", name], capture_output=True, timeout=10)
            if result.returncode == 0:
                info, = json.loads(result.stdout)
                self.assertEqual(info["Image"], self.image_id)
                self.assertEqual(info["Config"]["Labels"]["com.teamaibox.gdp-transport"], name)
                subprocess.run(["docker", "rm", "-f", info["Id"]],
                               capture_output=True, check=True, timeout=10)

    def transport(self, source, caps, expected_caps=None, slow=False):
        video = source == "videotestsrc"
        # Reuse the *exact* private FD sink expression supplied to UxPlay.
        # Redirection maps that FD to the anonymous shell pipe; stdout is
        # separately discarded so native diagnostics cannot become media.
        sink = VIDEO_SINK_PIPELINE if video else AUDIO_SINK_PIPELINE
        fd = 4 if video else 5
        producer = shlex.join(["gst-launch-1.0", "-q", source, "num-buffers=12",
                              "!", caps, "!"] + shlex.split(sink))
        # Verbose output is used ONLY by this dedicated synthetic test, never
        # by receiver authentication or production readiness. fakesink's
        # metadata proves that actual nonempty buffers crossed GDP; exit 0
        # alone also occurs for a short/empty stream with no decoded buffers.
        consumer = shlex.join(["gst-launch-1.0", "-v", "fdsrc", "fd=0", "!",
                               "gdpdepay", "!", expected_caps or caps, "!"]
                              + (["identity", "sleep-time=20000", "!"] if slow else [])
                              + ["fakesink", "sync=false", "silent=false", "dump=false"])
        return self.invoke(f"{producer} {fd}>&1 1>/dev/null | {consumer}")

    def assert_transported(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        samples = re.findall(rb"last-message = chain[^\n]+\(([0-9]+) bytes,[^\n]+pts: ([0-9:.]+),", result.stdout)
        self.assertEqual(len(samples), 12)
        self.assertTrue(all(int(size) > 0 for size, _ in samples))
        timestamps = [stamp for _, stamp in samples]
        self.assertEqual(len(set(timestamps)), 12)
        self.assertEqual(timestamps, sorted(timestamps))
        self.assertIn(b"Got EOS from element", result.stdout)

    def test_landscape_1080p30(self):
        result = self.transport("videotestsrc", "video/x-raw,format=I420,width=1920,height=1080,framerate=30/1")
        self.assert_transported(result)

    def test_portrait_caps_survive_pipe(self):
        result = self.transport("videotestsrc", "video/x-raw,format=I420,width=1080,height=1920,framerate=30/1")
        self.assert_transported(result)

    def test_audio_caps_survive_pipe(self):
        result = self.transport("audiotestsrc", "audio/x-raw,format=S16LE,rate=48000,channels=2")
        self.assert_transported(result)

    def test_bounded_slow_consumer(self):
        result = self.transport("videotestsrc", "video/x-raw,format=I420,width=1920,height=1080,framerate=30/1", slow=True)
        self.assert_transported(result)

    def test_downstream_incompatible_caps_are_not_accepted(self):
        result = self.transport("videotestsrc", "video/x-raw,format=I420,width=320,height=240,framerate=30/1",
                                expected_caps="audio/x-raw,format=S16LE,rate=48000,channels=2")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(result.returncode, (125, 126, 127))
        self.assertNotIn(b"last-message = chain", result.stdout)
        self.assertIn(b"not-negotiated", result.stderr)

    def test_empty_stream_exit_zero_is_not_frame_acceptance(self):
        result = self.invoke("printf 'not-a-gdp-packet' | gst-launch-1.0 -v fdsrc fd=0 ! gdpdepay ! fakesink silent=false dump=false")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn(b"last-message = chain", result.stdout)
        with self.assertRaises(AssertionError):
            self.assert_transported(result)

    def test_malformed_gdp_header_is_rejected_without_media_output(self):
        result = self.invoke("printf '\\0%.0s' {1..128} | gst-launch-1.0 -v fdsrc fd=0 ! gdpdepay ! fakesink silent=false dump=false")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(result.returncode, (125, 126, 127))
        self.assertNotIn(b"last-message = chain", result.stdout)


if __name__ == "__main__":
    unittest.main()
