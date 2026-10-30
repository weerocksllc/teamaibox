"""Real child/anonymous-FD lifecycle; fixture bytes are not Apple media proof."""
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from services.trusted_media_service.native_receiver_process import NativeReceiverProcess, NativeReceiverProcessError

ROOT = Path(__file__).resolve().parents[1]
SESSION = "6cb7a018-aad1-4ea6-a8c2-039ea0291573"


class Callback:
    def __init__(self):
        self.called = threading.Event()
        self.reject = False

    def pair_source(self, **kwargs):
        self.called.set()
        if self.reject:
            raise RuntimeError("private callback detail")
        return {"paired": True, "blocked": False}


@unittest.skipUnless(shutil.which("cc"), "native compiler required")
class NativeReceiverProcessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.executable = Path(cls.temp.name) / "receiver-fixture"
        # Deliberately a native test fixture, not an AirPlay sender or receiver.
        source = r'''
#include <stdbool.h>
#include "session_pin.h"
#include "platform_pairing_ack.h"
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
    uint16_t pin = 0;
    if (!teamaibox_read_session_pin(0, &pin) || pin != 9876) return 65;
    for (int i = 0; i < argc; ++i) if (strstr(argv[i], "9876")) return 66;
    if (getenv("UXPLAYRC") || getenv("GST_DEBUG_DUMP_DOT_DIR")) return 67;
    if (!getenv("HOME") || strcmp(getenv("HOME"), "/nonexistent")) return 68;
    unsigned char key[32]; memset(key, 'k', sizeof(key));
    if (!teamaibox_platform_pairing_ack(3, key)) return 69;
    if (write(4, "fixture-video", 13) != 13 || write(5, "fixture-audio", 13) != 13) return 70;
    for (;;) pause();
}
'''
        subprocess.run(["cc", "-x", "c", "-Wall", "-Wextra", "-Werror", "-I",
                        str(ROOT / "services/trusted_media_service/native"), "-o", str(cls.executable), "-"],
                       input=source, text=True, capture_output=True, check=True, timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.callback = Callback()
        self.receiver = NativeReceiverProcess(callback_client=self.callback, executable=self.executable)
        self.addCleanup(self.receiver.close)

    def start(self, lifetime=30):
        self.receiver.start(session_id=SESSION, receiver_name="Team-AI-0123456789", pin="9876",
                            lifetime_seconds=lifetime)

    def await_closed(self):
        deadline = time.monotonic() + 5
        while self.receiver.running() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertFalse(self.receiver.running())

    def test_real_child_maps_private_pairing_and_two_media_descriptors(self):
        self.start()
        self.assertTrue(self.callback.called.wait(5))
        video, audio = self.receiver.duplicate_media_readers()
        try:
            for fd, expected in ((video, b"fixture-video"), (audio, b"fixture-audio")):
                self.assertTrue(select.select([fd], [], [], 3)[0])
                self.assertEqual(os.read(fd, 64), expected)
            self.receiver.close()
            self.assertFalse(self.receiver.running())
            self.assertIsNotNone(self.receiver._process.poll())
            self.assertEqual(os.read(video, 64), b"")
            self.assertEqual(os.read(audio, 64), b"")
            self.assertEqual(self.receiver._bridge._pin, b"\0" * 4)
        finally:
            os.close(video)
            os.close(audio)

    def test_parent_configuration_environment_is_not_inherited(self):
        from unittest.mock import patch
        with patch.dict(os.environ, {"UXPLAYRC": "/private/record-config",
                                    "GST_DEBUG_DUMP_DOT_DIR": "/private/debug"}):
            self.start()
            self.assertTrue(self.callback.called.wait(5))
            self.assertTrue(self.receiver.running())

    def test_short_lived_request_thread_does_not_stop_owned_receiver(self):
        errors = []
        def request():
            try:
                self.start()
            except Exception as error:
                errors.append(type(error).__name__)
        handler = threading.Thread(target=request)
        handler.start()
        handler.join(timeout=5)
        self.assertFalse(handler.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(self.callback.called.wait(5))
        time.sleep(0.25)
        self.assertTrue(self.receiver.running())
        self.receiver.close()
        self.assertIsNotNone(self.receiver._process.poll())

    def test_platform_rejection_terminates_child_without_media(self):
        self.callback.reject = True
        self.start()
        self.assertTrue(self.callback.called.wait(5))
        self.await_closed()
        with self.assertRaises(NativeReceiverProcessError):
            self.receiver.duplicate_media_readers()

    def test_expiry_revokes_inflight_pairing_before_late_ack(self):
        release = threading.Event()
        def slow(**kwargs):
            self.callback.called.set()
            release.wait(10)
            return {"paired": True, "blocked": False}
        self.callback.pair_source = slow
        # Start-up duration is not the property under test (macOS may spend
        # over a second launching the signed interpreter). Invoke the actual
        # expiry timer's callback only after pairing is demonstrably in flight.
        self.start(lifetime=30)
        expiry = None
        try:
            self.assertTrue(self.callback.called.wait(5))
            self.receiver._expiry.cancel()
            expiry = threading.Thread(target=self.receiver._expiry.function)
            expiry.start()
            self.await_closed()
            self.assertTrue(self.receiver._bridge._closed)
        finally:
            release.set()
            if expiry is not None:
                expiry.join(5)
                self.assertFalse(expiry.is_alive())
            self.receiver.close()
        self.assertNotEqual(self.receiver._process.returncode, 0)

    def test_instance_cannot_be_reused_or_started_after_stop(self):
        self.receiver.close()
        with self.assertRaises(NativeReceiverProcessError):
            self.start()

    def test_invalid_request_never_spawns(self):
        for name, pin, lifetime in (("personal device", "9876", 30),
                                    ("Team-AI-0123456789", "9876 -mp4", 30),
                                    ("Team-AI-0123456789", "9876", 14401)):
            with self.assertRaises(ValueError):
                self.receiver.start(session_id=SESSION, receiver_name=name, pin=pin, lifetime_seconds=lifetime)
        self.assertIsNone(self.receiver._process)

    @unittest.skipUnless(sys.platform == "linux", "Linux parent-death contract")
    def test_supervisor_crash_does_not_leave_a_live_native_receiver(self):
        script = """
from pathlib import Path
import sys, time
from services.trusted_media_service.native_receiver_process import NativeReceiverProcess
class Callback:
    def pair_source(self, **kwargs): return {'paired': True, 'blocked': False}
receiver = NativeReceiverProcess(callback_client=Callback(), executable=Path(sys.argv[1]))
receiver.start(session_id='6cb7a018-aad1-4ea6-a8c2-039ea0291573',
    receiver_name='Team-AI-0123456789', pin='9876', lifetime_seconds=30)
video, audio = receiver.duplicate_media_readers()
import os
if os.read(video, 13) != b'fixture-video': raise RuntimeError('fixture failed')
print(receiver._process.pid, flush=True)
time.sleep(30)
"""
        driver = subprocess.Popen([sys.executable, "-c", script, str(self.executable)],
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=ROOT)
        try:
            self.assertTrue(select.select([driver.stdout], [], [], 5)[0])
            child_pid = int(driver.stdout.readline())
            driver.kill()
            driver.wait(timeout=3)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                stat = Path(f"/proc/{child_pid}/stat")
                if not stat.exists() or stat.read_text().split(") ", 1)[1].startswith("Z "):
                    break
                time.sleep(0.02)
            else:
                self.fail("native fixture survived its supervisor")
            # Under the PID-1 test container it is now our reapable child.
            try:
                os.waitpid(child_pid, os.WNOHANG)
            except ChildProcessError:
                pass
        finally:
            if driver.poll() is None:
                driver.kill()
                driver.wait(timeout=3)
            driver.stdout.close()


if __name__ == "__main__":
    unittest.main()
