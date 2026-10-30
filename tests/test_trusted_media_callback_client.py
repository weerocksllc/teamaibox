from __future__ import annotations

from datetime import datetime, timezone, timedelta
import hashlib
import io
import json
from pathlib import Path
import socketserver
import ssl
import subprocess
import tempfile
import threading
import unittest
from uuid import uuid4

from services.trusted_media_service.callback_client import (
    CallbackError, TrustedMediaCallbackClient, _response, callback_context,
)
from services.trusted_media_service.tls_runtime_server import _DeadlineReader


class ParserTest(unittest.TestCase):
    def test_rejects_redirect_ambiguous_and_oversized_responses(self):
        for response in (
            b"HTTP/1.1 302 Found\r\nLocation: https://example.test/\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\ncontent-length: 2\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nContent-Length: 65537\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nX-Long: " + b"x" * 16384 + b"\r\n\r\n",
        ):
            with self.subTest(response=response[:40]), self.assertRaises(CallbackError):
                _response(io.BytesIO(response))


class CallbackHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(2)
            with self.server.tls.wrap_socket(self.request, server_side=True) as channel:
                self.server.versions.append(channel.version())
                data = bytearray()
                while b"\r\n\r\n" not in data:
                    chunk = channel.recv(4096)
                    if not chunk: return
                    data.extend(chunk)
                    if len(data) > 16384: return
                header, body = data.split(b"\r\n\r\n", 1)
                first, *lines = header.decode().split("\r\n")
                headers = dict(line.lower().split(": ", 1) for line in lines)
                length = int(headers["content-length"])
                while len(body) < length: body.extend(channel.recv(length - len(body)))
                self.server.received.append((first, headers, json.loads(body)))
                path = first.split()[1]
                session_id = path.split("/")[5]
                request = json.loads(body)
                if path.endswith("/source/pair"):
                    value = {"paired": not self.server.deny_pair, "repeated": False, "blocked": self.server.deny_pair,
                             "state": "paired", "failed_attempts": 0, "blocked_until": None}
                elif path.endswith("/source/streaming"):
                    value = {"session_id": session_id, "state": "streaming", "state_revision": 2}
                else:
                    value = {"authorized": True, "session_id": session_id,
                             "viewer_identity_id": request["viewer_identity_id"], "grant_id": str(uuid4()),
                             "audience_revision": 1, "muted": True, "maximum_viewers": 8,
                             "publisher_encode_renditions": 1,
                             "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat().replace("+00:00", "Z")}
                raw = json.dumps(value).encode()
                channel.sendall(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n".encode() + raw)
        except (OSError, ssl.SSLError):
            pass


class CallbackServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True


@unittest.skipUnless(ssl.HAS_TLSv1_3, "requires bundled OpenSSL 3 Python")
class RealCallbackTlsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="teamaibox-callback-test-")
        cls.root = Path(cls.temporary.name)
        def openssl(*args):
            subprocess.run(["openssl", *args], cwd=cls.root, check=True, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Callback Test CA",
                "-keyout", "ca.key", "-out", "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash")
        for serial, (name, san, usage) in enumerate((
            ("platform", "DNS:localhost", "serverAuth"),
            ("media", "URI:spiffe://teamaibox.local/service/trusted-media/" + str(uuid4()), "clientAuth"),
        ), 2):
            openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + name,
                    "-keyout", name + ".key", "-out", name + ".csr")
            (cls.root / (name + ".ext")).write_text("basicConstraints=critical,CA:FALSE\n"
                "keyUsage=critical,digitalSignature,keyEncipherment\n"
                "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n"
                f"extendedKeyUsage={usage}\nsubjectAltName={san}\n")
            openssl("x509", "-req", "-days", "1", "-in", name + ".csr", "-CA", "ca.crt", "-CAkey", "ca.key",
                    "-set_serial", str(serial), "-extfile", name + ".ext", "-out", name + ".crt")
        cls.pin = "sha256:" + hashlib.sha256(ssl.PEM_cert_to_DER_cert((cls.root / "platform.crt").read_text())).hexdigest()

    @classmethod
    def tearDownClass(cls): cls.temporary.cleanup()

    def setUp(self):
        self.server = CallbackServer(("127.0.0.1", 0), CallbackHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
        context.load_cert_chain(str(self.root / "platform.crt"), str(self.root / "platform.key"))
        context.load_verify_locations(str(self.root / "ca.crt"))
        context.verify_mode = ssl.CERT_REQUIRED
        self.server.tls, self.server.received, self.server.versions, self.server.deny_pair = context, [], [], False
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.client_context = callback_context(certificate=self.root / "media.crt", private_key=self.root / "media.key",
                                               server_ca=self.root / "ca.crt")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())

    def client(self, **overrides):
        config = dict(address="127.0.0.1", port=self.server.server_address[1], server_name="localhost",
                      certificate_fingerprint=self.pin, tls_context=self.client_context)
        return TrustedMediaCallbackClient(**(config | overrides))

    def test_real_mutual_tls_exact_callbacks_and_fresh_request_identity(self):
        client, session, connection, viewer = self.client(), str(uuid4()), str(uuid4()), str(uuid4())
        self.assertTrue(client.pair_source(session_id=session, source_connection_id=connection, pin="1234")["paired"])
        self.assertEqual(client.mark_streaming(session_id=session, source_connection_id=connection)["state"], "streaming")
        self.assertTrue(client.authorize_viewer(session_id=session, viewer_identity_id=viewer,
            browser_instance_id="browser-instance-test-1234", media_credential="synthetic-only-credential")["authorized"])
        self.assertEqual(self.server.versions, ["TLSv1.3"] * 3)
        self.assertEqual(len({headers["x-teamaibox-callback-id"] for _, headers, _ in self.server.received}), 3)
        for first, headers, body in self.server.received:
            self.assertTrue(first.startswith("POST /internal/v1/casting/sessions/" + session + "/"))
            self.assertNotIn("1234", first)
            self.assertNotIn("1234", headers["x-teamaibox-callback-issued-at"])
        self.assertEqual(self.server.received[0][2], {"pin": "1234", "source_connection_id": connection})

    def test_pin_and_hostname_failure_send_no_request_or_pin(self):
        for overrides in ({"certificate_fingerprint": "sha256:" + "0" * 64}, {"server_name": "wrong.internal"}):
            with self.subTest(overrides=overrides), self.assertRaisesRegex(CallbackError, "^cast_callback_unavailable$"):
                self.client(**overrides).pair_source(session_id=str(uuid4()), source_connection_id=str(uuid4()), pin="1234")
        self.assertEqual(self.server.received, [])

    def test_missing_client_certificate_cannot_report_pairing(self):
        context = ssl.create_default_context(cafile=str(self.root / "ca.crt"))
        context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
        with self.assertRaises(CallbackError):
            self.client(tls_context=context).pair_source(session_id=str(uuid4()), source_connection_id=str(uuid4()), pin="1234")
        self.assertEqual(self.server.received, [])

    def test_denied_pairing_and_invalid_configuration_fail_closed(self):
        self.server.deny_pair = True
        with self.assertRaises(CallbackError):
            self.client().pair_source(session_id=str(uuid4()), source_connection_id=str(uuid4()), pin="1234")
        for address in ("0.0.0.0", "8.8.8.8", "example.test"):
            with self.assertRaises(ValueError): self.client(address=address)
        with self.assertRaises(ValueError): self.client(server_name="localhost\r\nInjected: yes")
        self.client_context.minimum_version = ssl.TLSVersion.TLSv1_2
        with self.assertRaises(ValueError): self.client()
