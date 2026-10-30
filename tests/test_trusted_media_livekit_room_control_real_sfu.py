"""Opt-in real pinned LiveKit control test behind a loopback mutual-TLS ingress.

No sender, receiver advertisement, browser, GPU, HDMI or media is involved.
The synthetic API secret is delivered through stdin, never env/argv/a file.
"""
import http.client
from datetime import datetime, timezone
import json
import os
import select
import shutil
import socketserver
import ssl
import subprocess
import threading
import time
import unittest
from uuid import uuid4

from services.trusted_media_service.livekit_room_control import LiveKitRoomControl
from services.trusted_media_service.callback_client import callback_context
from services.trusted_media_service.viewer_token_issuer import LiveKitViewerTokenIssuer
from tests import test_trusted_media_callback_client as callback_tests

IMAGE = "docker.io/livekit/livekit-server@sha256:4eeb7a7af9e133afee7d07fc48623373852a34ad709094345d1761c9b283dc1a"
SECRET = "synthetic-only-not-a-deployment-livekit-secret"

# A real protocol client, not a browser/media claim. The synthetic credential
# arrives over stdin and is used only on the exact test SFU's loopback port.
SIGNAL_CLIENT = r"""
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {port,token}=JSON.parse(input); input='';
const url=new URL('ws://127.0.0.1:'+port+'/rtc');
url.searchParams.set('access_token',token); url.searchParams.set('protocol','16');
url.searchParams.set('auto_subscribe','1');
const client=new WebSocket(url);
const timer=setTimeout(()=>{client.close();process.exit(2)},15000);
client.addEventListener('open',()=>process.stdout.write('opened\n'));
client.addEventListener('message',()=>process.stdout.write('signal\n'),{once:true});
client.addEventListener('close',(event)=>{clearTimeout(timer);process.stdout.write('closed:'+event.code+'\n')});
client.addEventListener('error',()=>{process.stdout.write('transport-error\n')});
"""


class ForwardHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(5)
            with self.server.tls.wrap_socket(self.request, server_side=True) as channel:
                data = bytearray()
                while b"\r\n\r\n" not in data:
                    chunk = channel.recv(4096)
                    if not chunk: return
                    data.extend(chunk)
                    if len(data) > 16384: return
                head, body = data.split(b"\r\n\r\n", 1)
                first, *lines = head.decode().split("\r\n")
                headers = {k.lower(): v for k, v in (line.split(": ", 1) for line in lines)}
                length = int(headers["content-length"])
                while len(body) < length:
                    chunk = channel.recv(length - len(body))
                    if not chunk: return
                    body.extend(chunk)
                connection = http.client.HTTPConnection("127.0.0.1", self.server.sfu_port, timeout=3)
                try:
                    connection.request("POST", first.split()[1], bytes(body),
                        {"Authorization": headers["authorization"], "Content-Type": "application/json"})
                    response = connection.getresponse()
                    raw = response.read(65537)
                    if len(raw) > 65536: return
                    self.server.codes.append(response.status)
                    channel.sendall(f"HTTP/1.1 {response.status} Result\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n".encode()+raw)
                finally:
                    connection.close()
        except (OSError, ssl.SSLError, http.client.HTTPException):
            pass


@unittest.skipUnless(os.environ.get("TEAMAIBOX_TEST_REAL_SFU") == "1" and ssl.HAS_TLSv1_3,
                     "opt-in isolated real SFU test")
class RealSfuRoomControlTest(unittest.TestCase):
    setUpClass = classmethod(callback_tests.RealCallbackTlsTest.setUpClass.__func__)
    tearDownClass = classmethod(callback_tests.RealCallbackTlsTest.tearDownClass.__func__)

    def test_real_sfu_nine_participant_room_and_confirmed_cleanup(self):
        name = "teamaibox-sfu-control-test-" + uuid4().hex[:12]
        network = name + "-private"
        subprocess.run(["docker", "image", "inspect", IMAGE], check=True, stdout=subprocess.DEVNULL)
        # Docker Desktop suppresses published ports on --internal networks.
        # The test has a dedicated bridge and only a loopback published API;
        # no receiver, public listener or external-IP discovery is enabled.
        subprocess.run(["docker", "network", "create", network], check=True, stdout=subprocess.DEVNULL)
        process = server = thread = signal_client = None
        config = ("port: 7880\nbind_addresses: [0.0.0.0]\nkeys:\n  room-test-key: " + SECRET
            + "\nrtc:\n  node_ip: 127.0.0.1\n  use_external_ip: false\n  tcp_port: 7881\n  udp_port: 7882\nlogging:\n  level: error\n").encode()
        try:
            process = subprocess.Popen(["docker", "run", "--rm", "-i", "--name", name,
                "--network", network, "--publish", "127.0.0.1::7880", "--read-only",
                "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--log-driver", "none",
                IMAGE, "--config", "/dev/stdin"], stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            process.stdin.write(config)
            process.stdin.close()
            deadline, port = time.monotonic() + 30, None
            while time.monotonic() < deadline:
                self.assertIsNone(process.poll(), "exact test SFU exited before readiness")
                result = subprocess.run(["docker", "port", name, "7880/tcp"], capture_output=True, text=True)
                if result.returncode == 0 and result.stdout.startswith("127.0.0.1:"):
                    port = int(result.stdout.strip().split(":")[-1])
                    try:
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                        conn.request("GET", "/")
                        ready = conn.getresponse().status == 200
                        conn.close()
                        if ready: break
                    except (OSError, http.client.HTTPException): pass
                time.sleep(0.1)
            else:
                self.fail("exact test SFU did not become ready")
            server = callback_tests.CallbackServer(("127.0.0.1", 0), ForwardHandler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
            context.load_cert_chain(str(self.root / "platform.crt"), str(self.root / "platform.key"))
            context.load_verify_locations(str(self.root / "ca.crt"))
            context.verify_mode = ssl.CERT_REQUIRED
            server.tls, server.sfu_port, server.codes = context, port, []
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            tls = callback_context(certificate=self.root / "media.crt", private_key=self.root / "media.key",
                                   server_ca=self.root / "ca.crt")
            client = LiveKitRoomControl(api_key="room-test-key", api_secret=SECRET, address="127.0.0.1",
                port=server.server_address[1], server_name="localhost", certificate_fingerprint=self.pin, tls_context=tls)
            session = str(uuid4())
            client.create(session_id=session, expires_at=time.time()+120)
            client.remove_viewer(session_id=session, participant_identity="cast-" + "a" * 32)
            issuer = LiveKitViewerTokenIssuer(api_key="room-test-key", api_secret=SECRET,
                endpoint="wss://localhost:7880")
            viewer = str(uuid4())
            viewer_context = dict(session_id=session, viewer_identity_id=viewer,
                                  browser_instance_id="synthetic-browser-instance-0001")
            grant = issuer.issue(session_id=session, viewer_identity_id=viewer, grant_id=str(uuid4()),
                audience_revision=1, browser_instance_id="synthetic-browser-instance-0001",
                grant_expires_at=datetime.fromtimestamp(time.time()+60, timezone.utc).isoformat().replace('+00:00','Z'),
                muted=True, maximum_viewers=8, publisher_encode_renditions=1)
            admission = issuer.consume(grant["accessToken"], **viewer_context)
            node = shutil.which("node")
            self.assertIsNotNone(node, "Node with built-in WebSocket required for real signalling test")
            signal_client = subprocess.Popen([node, "--input-type=module", "-e", SIGNAL_CLIENT],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            signal_client.stdin.write(json.dumps({"port":port,"token":grant["accessToken"]}).encode())
            signal_client.stdin.close()
            deadline = time.monotonic()+8
            received = b""
            while b"opened\n" not in received and time.monotonic()<deadline:
                if select.select([signal_client.stdout],[],[],0.1)[0]:
                    chunk=os.read(signal_client.stdout.fileno(),1024)
                    if not chunk: break
                    received+=chunk
            self.assertIn(b"opened\n",received)
            participants=client._post("ListParticipants",{"room":client._room},"roomAdmin").get("participants",[])
            self.assertIn(admission["participantIdentity"],[item["identity"] for item in participants])
            client.remove_viewer(session_id=session, participant_identity=admission["participantIdentity"])
            self.assertEqual(signal_client.wait(timeout=5),0)
            received += signal_client.stdout.read()
            self.assertRegex(received, rb"closed:[0-9]{4}\n")
            # Replaying our admission is rejected locally. This does not yet
            # prove a deployed network ingress prevents raw SFU token reuse.
            with self.assertRaises(ValueError):
                issuer.consume(grant["accessToken"], **viewer_context)
            client.delete(session_id=session)
            client.close()
            self.assertEqual(server.codes[0], 200)
            self.assertEqual(server.codes[-2:], [200, 200])
        finally:
            if signal_client:
                if signal_client.poll() is None: signal_client.terminate()
                signal_client.wait(timeout=5)
                signal_client.stdout.close()
            if server:
                server.shutdown()
                server.server_close()
                thread.join(2)
            if process:
                subprocess.run(["docker", "stop", "--time", "3", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                process.wait(timeout=10)
            subprocess.run(["docker", "network", "rm", network], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    unittest.main()
