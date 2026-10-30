import hashlib
import io
from pathlib import Path
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading
import time
import unittest

from services.trusted_media_runtime.sfu_gateway import PrivateSfuGateway, request_prefix

CONTROL = (b"POST /twirp/livekit.RoomService/ListRooms HTTP/1.1\r\nHost: arbitrary.invalid\r\n"
           b"Authorization: Bearer synthetic-only-component-token\r\nContent-Type: application/json\r\n"
           b"Content-Length: 2\r\nX-Forwarded-For: never-forward\r\n\r\n{}")
WEBSOCKET = (b"GET /rtc?access_token=synthetic-only-component-token HTTP/1.1\r\nHost: arbitrary.invalid\r\n"
             b"Connection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"
             b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")


class ParserTest(unittest.TestCase):
    def test_role_scoping_and_forwarded_headers_removed(self):
        value, upgraded = request_prefix(io.BytesIO(CONTROL), "control")
        self.assertFalse(upgraded)
        self.assertIn(b"Host: localhost\r\n", value)
        self.assertNotIn(b"never-forward", value)
        for role in ("publisher", "viewer"):
            with self.assertRaises(ValueError): request_prefix(io.BytesIO(CONTROL), role)
            self.assertTrue(request_prefix(io.BytesIO(WEBSOCKET), role)[1])
        with self.assertRaises(ValueError): request_prefix(io.BytesIO(WEBSOCKET), "control")

    def test_signaller_bearer_header_is_preserved_but_invalid_authorization_is_not(self):
        for role in ("publisher","viewer"):
            header=b"Authorization: Bearer synthetic-only-component-token\r\n"
            request=WEBSOCKET.replace(b"Host: arbitrary.invalid\r\n",b"Host: arbitrary.invalid\r\n"+header)
            self.assertIn(header,request_prefix(io.BytesIO(request),role)[0])
            with self.assertRaises(ValueError):
                request_prefix(io.BytesIO(request.replace(b"Bearer synthetic-only-component-token",b"Basic dGVzdA==")),role)

    def test_ambiguous_framing_and_arbitrary_routes_rejected(self):
        for data in (CONTROL.replace(b"Content-Length: 2", b"Content-Length: 2\r\nContent-Length: 2"),
                     CONTROL.replace(b"Content-Length: 2", b"Transfer-Encoding: chunked"),
                     CONTROL.replace(b"Content-Length: 2", b"Content-Length: 65537"),
                     CONTROL.replace(b"ListRooms", b"StartRoomCompositeEgress"),
                     CONTROL.replace(b"ListRooms", b"ListRooms?target=remote"),
                     CONTROL.replace(b"{}", b"{"),
                     CONTROL.replace(b"Host:", b"Missing-Host:")):
            with self.subTest(data=data[:60]), self.assertRaises(ValueError):
                request_prefix(io.BytesIO(data), "control")
        for data in (WEBSOCKET.replace(b"GET /rtc?", b"GET http://example.com/rtc?"),
                     WEBSOCKET.replace(b"GET /rtc?", b"POST /rtc?"),
                     WEBSOCKET.replace(b"13\r\n", b"8\r\n"),
                     WEBSOCKET.replace(b"Upgrade: websocket", b"Upgrade: h2c")):
            with self.assertRaises(ValueError): request_prefix(io.BytesIO(data), "viewer")


class UpstreamHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        raw = b""
        while b"\r\n\r\n" not in raw:
            part = self.request.recv(4096)
            if not part: return
            raw += part
        self.server.received.append(raw)
        if raw.startswith(b"GET /rtc?"):
            self.request.sendall(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
            while True:
                part = self.request.recv(16384)
                if not part: return
                self.request.sendall(part)
        else:
            self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")


class Upstream(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    def handle_error(self, *_): pass


class TlsGatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not ssl.HAS_TLSv1_3: raise RuntimeError("TLS 1.3 Python is required; no skipped security checks")
        cls.temp = tempfile.TemporaryDirectory(prefix="cast-sfu-gateway-")
        cls.root = Path(cls.temp.name)
        def openssl(*args):
            subprocess.run(["openssl", *args], cwd=cls.root, check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.PIPE, timeout=10)
        openssl("req", "-x509", "-sha256", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Test CA",
                "-keyout", "ca.key", "-out", "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash")
        for serial, name in enumerate(("server", "client", "other"), 2):
            openssl("req", "-new", "-sha256", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN="+name,
                    "-keyout", name+".key", "-out", name+".csr")
            (cls.root/(name+".ext")).write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                + "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n"
                + "extendedKeyUsage="+("serverAuth" if name == "server" else "clientAuth")+"\nsubjectAltName=DNS:localhost\n")
            openssl("x509", "-req", "-sha256", "-days", "1", "-in", name+".csr", "-CA", "ca.crt", "-CAkey", "ca.key",
                    "-set_serial", str(serial), "-extfile", name+".ext", "-out", name+".crt")
        cls.pin = "sha256:"+hashlib.sha256(ssl.PEM_cert_to_DER_cert((cls.root/"client.crt").read_text())).hexdigest()

    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()

    def setUp(self):
        self.upstream = Upstream(("127.0.0.1",0),UpstreamHandler)
        self.upstream.received=[]
        self.threads=[]
        self.gateways=[]
        self.start(self.upstream)

    def start(self, server):
        thread=threading.Thread(target=server.serve_forever,kwargs={"poll_interval":0.01},daemon=True)
        thread.start();self.threads.append(thread)

    def context(self, role):
        ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version=ctx.maximum_version=ssl.TLSVersion.TLSv1_3
        ctx.load_cert_chain(str(self.root/"server.crt"),str(self.root/"server.key"))
        if role != "publisher":
            ctx.verify_mode=ssl.CERT_REQUIRED;ctx.load_verify_locations(str(self.root/"ca.crt"))
        return ctx

    def gateway(self, role):
        gateway=PrivateSfuGateway(("127.0.0.1",0),role=role,upstream_port=self.upstream.server_address[1],
            context=self.context(role),peer_fingerprint=None if role=="publisher" else self.pin)
        self.gateways.append(gateway);self.start(gateway);return gateway

    def connect(self,gateway,identity="client",version=ssl.TLSVersion.TLSv1_3):
        ctx=ssl.create_default_context(cafile=str(self.root/"ca.crt"));ctx.minimum_version=ctx.maximum_version=version
        if identity: ctx.load_cert_chain(str(self.root/(identity+".crt")),str(self.root/(identity+".key")))
        return ctx.wrap_socket(socket.create_connection(gateway.server_address,timeout=3),server_hostname="localhost")

    def tearDown(self):
        for gateway in self.gateways: gateway.server_close();gateway.shutdown()
        self.upstream.shutdown();self.upstream.server_close()
        for thread in self.threads: thread.join(2);self.assertFalse(thread.is_alive())

    def test_actual_control_mtls_framing_and_one_request(self):
        gateway=self.gateway("control")
        with self.connect(gateway) as channel:
            self.assertEqual(channel.version(),"TLSv1.3")
            channel.sendall(CONTROL+CONTROL)
            result=b""
            while part:=channel.recv(4096): result+=part
        self.assertIn(b"200 OK",result)
        self.assertEqual(len(self.upstream.received),1)
        self.assertNotIn(b"X-Forwarded-For",self.upstream.received[0])

    def test_wrong_peer_no_certificate_or_tls_downgrade_never_reaches_upstream(self):
        gateway=self.gateway("control")
        for identity,version in (("other",ssl.TLSVersion.TLSv1_3),(None,ssl.TLSVersion.TLSv1_3),("client",ssl.TLSVersion.TLSv1_2)):
            try:
                with self.connect(gateway,identity,version) as channel:
                    channel.sendall(CONTROL)
                    self.assertEqual(channel.recv(4096),b"")
            except (OSError,ssl.SSLError): pass
        self.assertEqual(self.upstream.received,[])

    def test_viewer_upgrade_relays_and_shutdown_closes_active_connections(self):
        gateway=self.gateway("viewer")
        with self.connect(gateway) as channel:
            channel.sendall(WEBSOCKET)
            self.assertIn(b"101 Switching Protocols",channel.recv(4096))
            channel.sendall(b"synthetic-framed-payload")
            self.assertEqual(channel.recv(4096),b"synthetic-framed-payload")
            gateway.server_close()
            self.assertEqual(channel.recv(4096),b"")

    def test_publisher_requires_loopback_and_cannot_call_control(self):
        for host in ("0.0.0.0","10.64.0.20","8.8.8.8"):
            with self.assertRaises(ValueError):
                PrivateSfuGateway((host,0),role="publisher",upstream_port=7880,context=self.context("publisher"))
        gateway=self.gateway("publisher")
        with self.connect(gateway,None) as channel:
            channel.sendall(CONTROL)
            self.assertEqual(channel.recv(4096),b"")
        self.assertEqual(self.upstream.received,[])


if __name__ == "__main__": unittest.main()
