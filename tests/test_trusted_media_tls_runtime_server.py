from __future__ import annotations

from datetime import datetime, timezone
import io
import json
from pathlib import Path
import socket
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from uuid import uuid4

from services.trusted_media_service.runtime_api import (
    PLATFORM_PEER, PRIVACY_POLICY, RuntimeApiError, TrustedMediaRuntimeApi,
)
from services.trusted_media_service.tls_runtime_server import (
    TrustedMediaTlsServer, _DeadlineReader, decode_request, server_context,
)
from services.trusted_media_service.viewer_token_issuer import LiveKitViewerTokenIssuer


class ParserTest(unittest.TestCase):
    def test_expired_request_deadline_cannot_be_renewed_by_a_slow_sender(self):
        left, right = socket.socketpair()
        with left as connection, right:
            reader = _DeadlineReader(connection, time.monotonic() - 1)
            with self.assertRaises(TimeoutError):
                reader.readline(100)

    def test_ambiguous_or_unbounded_http_requests_are_rejected(self):
        prefix = b"POST /internal/v1/runtime/sessions HTTP/1.1\r\nHost: localhost\r\n"
        for suffix in (
            b"Content-Length: 0\r\ncontent-length: 0\r\n\r\n",
            b"Transfer-Encoding: chunked\r\n\r\n",
            b"Content-Length: 65537\r\n\r\n",
            b"Content-Length: +0\r\n\r\n",
            b"Expect: 100-continue\r\n\r\n",
            b"X-Padding: " + b"x" * 16384 + b"\r\n\r\n",
            b"Content-Length: 2\r\nContent-Type: application/json\r\n\r\n{",
        ):
            with self.subTest(suffix=suffix[:32]), self.assertRaises(RuntimeApiError):
                decode_request(io.BytesIO(prefix + suffix))


class Supervisor:
    def __init__(self): self.calls = []
    def start(self, value): self.calls.append("start")
    def stop(self, value): self.calls.append("stop")
    def update(self, value): self.calls.append("update")
    def disconnect_viewer(self, value): self.calls.append("disconnect")
    def health(self, session_id):
        return {"healthy": True, "outputs": {"browser": {"healthy": True}}}


@unittest.skipUnless(ssl.HAS_TLSv1_3, "run with the bundled OpenSSL 3 Python for real TLS 1.3")
class RealTlsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="teamaibox-media-mtls-test-")
        cls.root = Path(cls.temporary.name)

        def openssl(*args):
            subprocess.run(["openssl", *args], cwd=cls.root, check=True,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-subj", "/CN=Ephemeral media test CA", "-keyout", "ca.key", "-out", "ca.crt",
                "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                "-addext", "subjectKeyIdentifier=hash")
        for serial, (name, san, usage) in enumerate((
            ("server", "DNS:localhost", "serverAuth"),
            ("platform", "URI:" + PLATFORM_PEER, "clientAuth"),
            ("other", "URI:spiffe://teamaibox.internal/other-service", "clientAuth"),
        ), start=2):
            openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + name,
                    "-keyout", name + ".key", "-out", name + ".csr")
            (cls.root / (name + ".ext")).write_text(
                "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                f"extendedKeyUsage={usage}\nsubjectAltName={san}\n"
                "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n")
            openssl("x509", "-req", "-days", "1", "-in", name + ".csr", "-CA", "ca.crt",
                    "-CAkey", "ca.key", "-set_serial", str(serial), "-extfile", name + ".ext",
                    "-out", name + ".crt")

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.supervisor = Supervisor()
        self.api = TrustedMediaRuntimeApi(supervisor=self.supervisor,
            token_issuer=LiveKitViewerTokenIssuer(api_key="ephemeral-test-key", api_secret="x" * 32,
                                                  endpoint="wss://localhost:7880"))
        self.server = TrustedMediaTlsServer(("127.0.0.1", 0), api=self.api, tls_context=server_context(
            certificate=self.root / "server.crt", private_key=self.root / "server.key", client_ca=self.root / "ca.crt"))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())

    def exchange(self, body=None, *, identity="platform", request_id=None, maximum=None, raw=None):
        context = ssl.create_default_context(cafile=str(self.root / "ca.crt"))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if maximum is not None: context.maximum_version = maximum
        if identity is not None:
            context.load_cert_chain(str(self.root / (identity + ".crt")), str(self.root / (identity + ".key")))
        if raw is None:
            payload = json.dumps(body or {}).encode()
            issued_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            raw = ("POST /internal/v1/runtime/sessions HTTP/1.1\r\nHost: localhost\r\n"
                   "Content-Type: application/json\r\n"
                   f"Content-Length: {len(payload)}\r\nX-TeamAIBox-Request-Id: {request_id or uuid4()}\r\n"
                   f"X-TeamAIBox-Request-Issued-At: {issued_at}\r\n\r\n").encode() + payload
        with socket.create_connection(self.server.server_address, timeout=2) as connection:
            with context.wrap_socket(connection, server_hostname="localhost") as channel:
                self.assertEqual(channel.version(), "TLSv1.3")
                channel.sendall(raw)
                data = bytearray()
                while chunk := channel.recv(4096): data.extend(chunk)
        return bytes(data)

    def test_actual_tls13_authenticated_session_and_replay(self):
        expires = datetime.now(timezone.utc).timestamp() + 60
        body = {"sessionId": str(uuid4()), "receiverName": "Team-AI-0123456789", "pairingPin": "1234", "outputSinks": ["browser"],
                "browserStartsMuted": False, "mediaPrivacyPolicy": dict(PRIVACY_POLICY),
                "expiresAt": datetime.fromtimestamp(expires, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
        request_id = str(uuid4())
        response = self.exchange(body, request_id=request_id)
        self.assertTrue(response.startswith(b"HTTP/1.1 204"), response.decode(errors="replace"))
        replay = self.exchange(body, request_id=request_id)
        self.assertIn(b"cast_runtime_request_replayed", replay)
        self.assertEqual(self.supervisor.calls, ["start"])
        self.assertNotIn(body["receiverName"].encode(), replay)

    def test_trusted_certificate_of_another_service_cannot_mutate(self):
        try:
            response = self.exchange(identity="other")
        except ConnectionResetError:
            # The peer is rejected before reading its HTTP payload. Depending
            # on the TLS stack, closing unread input may reset instead of 403.
            pass
        else:
            self.assertTrue(response.startswith(b"HTTP/1.1 403"))
            self.assertNotIn(b"other-service", response)
        self.assertEqual(self.supervisor.calls, [])

    def test_readiness_crosses_real_tls_without_mutating_receiver(self):
        node_id = "10000000-0000-4000-8000-000000000001"
        self.api._readiness = lambda: {"nodeId": node_id, "nodeGeneration": 2,
            "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "outputs": {"browser": {"available": False, "reasonCode": "cast_media_runtime_unavailable"}}}
        module = (Path(__file__).resolve().parents[1] / "apps/platform-api/src/casting/trusted-media-runtime-client.mjs").as_uri()
        script = """
          import {readFile} from 'node:fs/promises';
          const {TrustedMediaCastingRuntimeClient}=await import(process.argv[1]);
          const root=process.argv[2];
          const client=new TrustedMediaCastingRuntimeClient({origin:process.argv[3],serverName:'localhost',
            ca:await readFile(root+'/ca.crt'),cert:await readFile(root+'/platform.crt'),key:await readFile(root+'/platform.key')});
          try { const result=await client.readiness({nodeId:process.argv[4],nodeGeneration:2});
            if(result.outputs.browser.available!==false) throw new Error('incorrect availability');
            process.stdout.write('readiness_passed');
          }finally{client.close();}
        """
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script, module,
            str(self.root), f"https://127.0.0.1:{self.server.server_address[1]}", node_id], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "readiness_passed")
        self.assertEqual(self.supervisor.calls, [])

    def test_nine_browser_reads_share_one_real_tls_request_without_lock_rejections(self):
        node_id = "10000000-0000-4000-8000-000000000001"
        calls = []
        def readiness():
            calls.append("readiness")
            time.sleep(0.06)
            return {"nodeId": node_id, "nodeGeneration": 9,
                "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "outputs": {"browser": {"available": True, "reasonCode": None}}}
        self.api._readiness = readiness
        module = (Path(__file__).resolve().parents[1] / "apps/platform-api/src/casting/trusted-media-runtime-client.mjs").as_uri()
        script = """
          import {readFile} from 'node:fs/promises';
          const {TrustedMediaCastingRuntimeClient}=await import(process.argv[1]);
          const root=process.argv[2];
          const client=new TrustedMediaCastingRuntimeClient({origin:process.argv[3],serverName:'localhost',
            ca:await readFile(root+'/ca.crt'),cert:await readFile(root+'/platform.crt'),key:await readFile(root+'/platform.key')});
          try {
            const results=await Promise.all(Array.from({length:9},()=>client.readiness({nodeId:process.argv[4],nodeGeneration:9})));
            if(results.some(r=>r.outputs.browser.available!==true))throw Error('readiness_failed');
            await client.readiness({nodeId:process.argv[4],nodeGeneration:9});
            process.stdout.write('nine_readers_passed_without_cached_health');
          }finally{client.close();}
        """
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script, module,
            str(self.root), f"https://127.0.0.1:{self.server.server_address[1]}", node_id], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "nine_readers_passed_without_cached_health")
        self.assertEqual(calls, ["readiness", "readiness"])
        self.assertEqual(self.supervisor.calls, [])

    @unittest.skipUnless(shutil.which("node"), "Node is required for the cross-language client test")
    def test_real_platform_node_client_interoperates_with_python_listener(self):
        module = (Path(__file__).resolve().parents[1]
                  / "apps/platform-api/src/casting/trusted-media-runtime-client.mjs").as_uri()
        script = """
          import { readFile } from 'node:fs/promises';
          const { TrustedMediaCastingRuntimeClient } = await import(process.argv[1]);
          const root = process.argv[2];
          const client = new TrustedMediaCastingRuntimeClient({origin:process.argv[3],serverName:'localhost',
            ca:await readFile(root+'/ca.crt'),cert:await readFile(root+'/platform.crt'),key:await readFile(root+'/platform.key')});
          try {
            await client.startReceiver({sessionId:'10000000-0000-4000-8000-000000000001',
              receiverName:'Team-AI-0123456789',pairingPin:'1234',outputSinks:['browser'],browserStartsMuted:false,
              expiresAt:new Date(Date.now()+60000).toISOString(),mediaPrivacyPolicy:JSON.parse(process.argv[4])});
            const health=await client.health({sessionId:'10000000-0000-4000-8000-000000000001'});
            if (health.healthy!==true) throw new Error('test_health_invalid');
            await client.stopReceiver({sessionId:'10000000-0000-4000-8000-000000000001',reasonCode:'cast_stopped_by_initiator'});
            process.stdout.write('mtls_lifecycle_passed');
          } finally {client.close();}
        """
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script, module,
                                 str(self.root), f"https://127.0.0.1:{self.server.server_address[1]}",
                                 json.dumps(PRIVACY_POLICY)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "mtls_lifecycle_passed")
        self.assertEqual(self.supervisor.calls, ["start", "stop"])

    def test_missing_client_certificate_and_tls12_are_rejected(self):
        for options in ({"identity": None}, {"maximum": ssl.TLSVersion.TLSv1_2}):
            with self.subTest(options=options), self.assertRaises((ssl.SSLError, ConnectionError)):
                self.exchange(**options)
        self.assertEqual(self.supervisor.calls, [])

    def test_stuck_expiry_does_not_block_accept_loop_or_spawn_unbounded_cleanup(self):
        entered, release = threading.Event(), threading.Event()
        def blocked_stop(_):
            entered.set()
            release.wait(3)
        self.supervisor.stop = blocked_stop
        with self.api._lock:
            self.api._active = {"sessionId": str(uuid4()), "expiresAt": 0}
        try:
            self.assertTrue(entered.wait(1))
            worker = self.server._expiry_worker
            issued = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            raw = ("GET /internal/v1/runtime/readiness HTTP/1.1\r\nHost: localhost\r\n"
                   f"X-TeamAIBox-Request-Id: {uuid4()}\r\nX-TeamAIBox-Request-Issued-At: {issued}\r\n\r\n").encode()
            before = time.monotonic()
            response = self.exchange(raw=raw)
            self.assertLess(time.monotonic() - before, 1)
            self.assertIn(b"503", response)
            self.assertIn(b"cast_runtime_cleanup_pending", response)
            self.assertIs(self.server._expiry_worker, worker)
            self.assertTrue(self.thread.is_alive())
        finally:
            release.set()
            if self.server._expiry_worker:
                self.server._expiry_worker.join(2)

    def test_plaintext_and_public_bind_are_rejected(self):
        with socket.create_connection(self.server.server_address, timeout=2) as connection:
            connection.sendall(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            try:
                self.assertEqual(connection.recv(128), b"")
            except ConnectionResetError:
                pass
        for address in ("0.0.0.0", "8.8.8.8"):
            with self.assertRaises(ValueError):
                TrustedMediaTlsServer((address, 0), api=self.api, tls_context=self.server.tls_context)
        self.assertEqual(self.supervisor.calls, [])


if __name__ == "__main__":
    unittest.main()
