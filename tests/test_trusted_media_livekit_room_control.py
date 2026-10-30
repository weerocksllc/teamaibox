"""Real mutual-TLS wire tests, not a LiveKit/media acceptance substitute."""
import base64
import hashlib
import hmac
import json
import socketserver
import ssl
import unittest
from uuid import uuid4

from services.trusted_media_service.livekit_room_control import LiveKitRoomControl, RoomControlError
from tests import test_trusted_media_callback_client as callback_tests

SECRET = "synthetic-only-livekit-room-control-secret"


class RoomHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(2)
            with self.server.tls.wrap_socket(self.request, server_side=True) as channel:
                data = bytearray()
                while b"\r\n\r\n" not in data:
                    chunk = channel.recv(4096)
                    if not chunk: return
                    data.extend(chunk)
                    if len(data) > 16384: return
                header, body = data.split(b"\r\n\r\n", 1)
                first, *lines = header.decode().split("\r\n")
                headers = {key.lower(): value for key, value in (line.split(": ", 1) for line in lines)}
                length = int(headers["content-length"])
                while len(body) < length:
                    chunk = channel.recv(length-len(body))
                    if not chunk: return
                    body.extend(chunk)
                request = json.loads(body)
                self.server.received.append((first, headers, request))
                method = first.split()[1].rsplit("/", 1)[1]
                value = {}
                if method == "CreateRoom":
                    self.server.room = request["name"]
                    value = {"name": request["name"]}
                elif method == "RemoveParticipant" and not self.server.refuse:
                    self.server.participants.discard(request["identity"])
                elif method == "ListParticipants":
                    value = {"participants": [{"identity": value} for value in self.server.participants]}
                elif method == "DeleteRoom" and not self.server.refuse:
                    self.server.room = None
                elif method == "ListRooms":
                    value = {"rooms": [{"name": self.server.room}] if self.server.room else []}
                raw = json.dumps(value).encode()
                channel.sendall(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n".encode()+raw)
        except (OSError, ssl.SSLError):
            pass


@unittest.skipUnless(ssl.HAS_TLSv1_3, "requires bundled OpenSSL 3 Python")
class RoomControlTlsTest(unittest.TestCase):
    setUpClass = classmethod(callback_tests.RealCallbackTlsTest.setUpClass.__func__)
    tearDownClass = classmethod(callback_tests.RealCallbackTlsTest.tearDownClass.__func__)
    tearDown = callback_tests.RealCallbackTlsTest.tearDown

    def setUp(self):
        callback_tests.RealCallbackTlsTest.setUp(self)
        self.server.RequestHandlerClass = RoomHandler
        self.server.room, self.server.participants, self.server.refuse = None, set(), False

    def client(self, **overrides):
        return LiveKitRoomControl(**(dict(api_key="test-livekit-key", api_secret=SECRET,
            address="127.0.0.1", port=self.server.server_address[1], server_name="localhost",
            certificate_fingerprint=self.pin, tls_context=self.client_context, clock=lambda: 1000) | overrides))

    def test_real_wire_room_without_product_count_cap_and_scoped_control(self):
        client, session = self.client(), str(uuid4())
        viewer = "cast-" + "a" * 32
        client.create(session_id=session, expires_at=1120)
        self.server.participants.add(viewer)
        client.remove_viewer(session_id=session, participant_identity=viewer)
        client.delete(session_id=session)
        client.close()
        self.assertFalse(any(client._secret))
        room = "cast-" + session.replace("-", "")
        self.assertEqual(self.server.received[0][2], {"name": room, "empty_timeout": 120,
            "departure_timeout": 120, "max_participants": 0})
        methods = [first.split()[1].rsplit("/", 1)[1] for first, _, _ in self.server.received]
        self.assertEqual(methods, ["CreateRoom", "RemoveParticipant", "ListParticipants", "DeleteRoom", "ListRooms"])
        for (first, headers, _), grant in zip(self.server.received,
                ("roomCreate", "roomAdmin", "roomAdmin", "roomCreate", "roomList")):
            self.assertNotIn("Bearer", first)
            token = headers["authorization"].removeprefix("Bearer ")
            head, body, signature = token.split(".")
            claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
            self.assertEqual(claims["video"], {grant: True, "room": room})
            self.assertEqual(claims["exp"]-claims["nbf"], 15)
            expected = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), (head+"."+body).encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
            self.assertEqual(signature, expected)

    def test_cleanup_requires_absence_and_retains_ownership_for_retry(self):
        client, session = self.client(), str(uuid4())
        client.create(session_id=session, expires_at=1120)
        viewer = "cast-" + "a" * 32
        self.server.participants.add(viewer)
        self.server.refuse = True
        with self.assertRaises(RoomControlError):
            client.remove_viewer(session_id=session, participant_identity=viewer)
        with self.assertRaises(RoomControlError): client.delete(session_id=session)
        with self.assertRaises(RoomControlError): client.close()
        with self.assertRaises(RoomControlError): client.create(session_id=str(uuid4()), expires_at=1120)
        self.server.refuse = False
        client.delete(session_id=session)
        client.close()

    def test_readiness_uses_real_private_tls_and_only_reads_one_non_session_name(self):
        client = self.client()
        self.assertTrue(client.probe())
        self.assertIsNone(client._session)
        self.assertEqual(len(self.server.received), 1)
        first, _, body = self.server.received[0]
        self.assertEqual(first, "POST /twirp/livekit.RoomService/ListRooms HTTP/1.1")
        self.assertEqual(body, {"names": ["teamaibox-readiness-probe"]})
        self.server.room = "unexpected-private-room"
        with self.assertRaises(RoomControlError): client.probe()
        client.close()
        with self.assertRaises(RoomControlError): client.probe()

    def test_unowned_room_and_publisher_removal_are_rejected_without_network(self):
        client, session = self.client(), str(uuid4())
        client.create(session_id=session, expires_at=1120)
        for other in (str(uuid4()), "user-input-room", None):
            with self.assertRaises(RoomControlError): client.delete(session_id=other)
        for identity in ("cast-source-"+"a"*32, "username", "../room", "cast-"+"A"*32):
            with self.assertRaises(RoomControlError):
                client.remove_viewer(session_id=session, participant_identity=identity)
        self.assertEqual(len(self.server.received), 1)
        client.delete(session_id=session)

    def test_wrong_certificate_sends_no_control_token(self):
        client = self.client(certificate_fingerprint="sha256:"+"0"*64)
        with self.assertRaises(RoomControlError): client.create(session_id=str(uuid4()), expires_at=1120)
        self.assertEqual(self.server.received, [])
        with self.assertRaises(RoomControlError): client.close()

    def test_expiry_is_required_finite_and_bounded_before_any_room_creation(self):
        client = self.client()
        for expiry in (True, None, float('nan'), float('inf'), 999, 1000, 15401):
            with self.subTest(expiry=expiry), self.assertRaises(RoomControlError):
                client.create(session_id=str(uuid4()), expires_at=expiry)
        self.assertEqual(self.server.received, [])
        self.assertIsNone(client._session)
        client.close()


if __name__ == "__main__":
    unittest.main()
