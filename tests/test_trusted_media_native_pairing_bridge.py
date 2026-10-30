"""Real anonymous socketpair/native boundary; no LAN or Apple acceptance claim."""
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest

from services.trusted_media_service.native_pairing_bridge import NativePairingBridge, PairingBridgeError

ROOT = Path(__file__).resolve().parents[1]
SESSION = "6cb7a018-aad1-4ea6-a8c2-039ea0291573"


class Callback:
    def __init__(self):
        self.calls = []
        self.reject = False

    def pair_source(self, **kwargs):
        self.calls.append(kwargs)
        if self.reject:
            raise RuntimeError("private callback detail")
        return {"paired": True, "blocked": False}


class PairingBridgeTest(unittest.TestCase):
    def setUp(self):
        self.parent, self.child = socket.socketpair()
        self.callback = Callback()
        self.bridge = NativePairingBridge(channel=self.parent, callback_client=self.callback,
            session_id=SESSION, pin="1234")
        self.addCleanup(self.bridge.close)
        self.addCleanup(self.child.close)

    def request(self, key=b"k" * 32):
        self.child.sendall(b"TAP1" + key)
        self.bridge.serve_one()
        self.assertEqual(self.child.recv(4), b"ACK1")

    def test_reconnect_reuses_the_same_platform_source_binding(self):
        self.assertIsNone(self.bridge.authorized_source_id())
        self.request()
        self.request()
        self.assertEqual(self.callback.calls[0], self.callback.calls[1])
        self.assertEqual(self.callback.calls[0]["session_id"], SESSION)
        self.assertEqual(self.bridge.authorized_source_id(), self.callback.calls[0]["source_connection_id"])
        self.bridge.close()
        self.assertIsNone(self.bridge.authorized_source_id())

    def test_different_sender_cannot_reuse_an_authorized_session(self):
        self.request()
        self.child.sendall(b"TAP1" + b"x" * 32)
        with self.assertRaisesRegex(PairingBridgeError, "^cast_native_pairing_rejected$") as caught:
            self.bridge.serve_one()
        self.assertEqual(caught.exception.failure_code, "pairing_peer_changed")
        self.assertEqual(len(self.callback.calls), 1)
        self.assertEqual(self.child.recv(4), b"")
        self.assertEqual(self.bridge._pin, b"\0" * 4)

    def test_platform_rejection_never_acknowledges_or_exposes_detail(self):
        self.callback.reject = True
        self.child.sendall(b"TAP1" + b"k" * 32)
        with self.assertRaisesRegex(PairingBridgeError, "^cast_native_pairing_rejected$") as caught:
            self.bridge.serve_one()
        self.assertEqual(caught.exception.failure_code, "pairing_callback")
        self.assertEqual(self.child.recv(4), b"")

    def test_malformed_native_event_does_not_call_platform(self):
        self.child.sendall(b"BAD1" + b"k" * 32)
        with self.assertRaises(PairingBridgeError) as caught:
            self.bridge.serve_one()
        self.assertEqual(caught.exception.failure_code, "pairing_protocol")
        self.assertEqual(self.callback.calls, [])

    def test_peer_close_discards_truncated_request(self):
        self.child.sendall(b"TAP1")
        self.child.close()
        with self.assertRaises(PairingBridgeError) as caught:
            self.bridge.serve_one()
        self.assertEqual(caught.exception.failure_code, "pairing_eof")
        self.assertEqual(self.callback.calls, [])

    def test_tcp_channel_is_not_accepted_as_private_child_ipc(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as channel:
            with self.assertRaisesRegex(ValueError, "configuration_invalid"):
                NativePairingBridge(channel=channel, callback_client=self.callback,
                                    session_id=SESSION, pin="1234")

    def test_revocation_disconnects_before_an_inflight_callback_can_ack(self):
        entered, release = threading.Event(), threading.Event()
        def slow_callback(**_):
            entered.set()
            release.wait(timeout=2)
            return {"paired": True, "blocked": False}
        self.callback.pair_source = slow_callback
        errors = []
        def serve():
            try:
                self.bridge.serve_one()
            except PairingBridgeError:
                errors.append("rejected")
        self.child.sendall(b"TAP1" + b"k" * 32)
        worker = threading.Thread(target=serve)
        worker.start()
        self.assertTrue(entered.wait(timeout=1))
        closer = threading.Thread(target=self.bridge.close)
        closer.start()
        try:
            self.child.settimeout(0.5)
            self.assertEqual(self.child.recv(4), b"")
        finally:
            release.set()
            worker.join(timeout=2)
            closer.join(timeout=2)
        self.assertFalse(worker.is_alive() or closer.is_alive())
        self.assertEqual(errors, ["rejected"])
        self.assertEqual(self.bridge._pin, b"\0" * 4)

    @unittest.skipUnless(shutil.which("cc"), "C compiler required")
    def test_native_code_waits_for_platform_acceptance_over_real_socketpair(self):
        source = r'''
#include "platform_pairing_ack.h"
#include <stdlib.h>
int main(int argc, char **argv) {
    if (argc != 2) return 64;
    unsigned char key[32];
    memset(key, 'k', sizeof(key));
    return teamaibox_platform_pairing_ack(atoi(argv[1]), key) ? 0 : 1;
}
'''
        with tempfile.TemporaryDirectory(prefix="teamaibox-native-ack-") as folder:
            binary = Path(folder) / "probe"
            compiled = subprocess.run([shutil.which("cc"), "-std=c11", "-D_POSIX_C_SOURCE=200809L", "-D_DARWIN_C_SOURCE",
                "-Wall", "-Wextra", "-Werror", "-I", str(ROOT / "services/trusted_media_service/native"),
                "-x", "c", "-", "-o", str(binary)], input=source.encode(), capture_output=True, timeout=30)
            self.assertEqual(compiled.returncode, 0, compiled.stderr.decode())
            for reject in (False, True):
                with self.subTest(platform_rejects=reject):
                    parent, child = socket.socketpair()
                    callback = Callback()
                    callback.reject = reject
                    bridge = NativePairingBridge(channel=parent, callback_client=callback,
                        session_id=SESSION, pin="1234")
                    errors = []
                    def serve():
                        try:
                            bridge.serve_one()
                        except PairingBridgeError as error:
                            errors.append(str(error))
                    thread = threading.Thread(target=serve)
                    thread.start()
                    try:
                        result = subprocess.run([str(binary), str(child.fileno())],
                            pass_fds=(child.fileno(),), capture_output=True, timeout=9)
                        thread.join(timeout=1)
                        self.assertFalse(thread.is_alive())
                        self.assertEqual(result.returncode, 1 if reject else 0)
                        self.assertEqual(result.stdout + result.stderr, b"")
                        self.assertEqual(len(callback.calls), 1)
                        self.assertEqual(len(errors), 1 if reject else 0)
                    finally:
                        bridge.close()
                        child.close()
                        thread.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
