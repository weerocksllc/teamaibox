"""Publisher token source tests; no SFU or browser acceptance claims."""
from base64 import urlsafe_b64decode, urlsafe_b64encode
import hashlib
import hmac
import json
import unittest
from unittest.mock import patch
import threading

from services.trusted_media_service.publisher_credentials import PublisherCredentialIssuer

SESSION = "10000000-0000-4000-8000-000000000001"
SECRET = "test-only-not-a-deployment-secret-0001"
NOW = 1800000000


class PublisherCredentialsTest(unittest.TestCase):
    def issuer(self, **overrides):
        return PublisherCredentialIssuer(**({"api_key": "test-api-key", "api_secret": SECRET,
            "endpoint": "wss://10.64.0.20:7880", "clock": lambda: NOW} | overrides))

    def test_exact_short_room_scoped_publish_only_grant_and_signature(self):
        result = self.issuer().issue(session_id=SESSION, session_expires_at=NOW + 600)
        header, body, signature = result.access_token.split(".")
        decode = lambda value: json.loads(urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        claims = decode(body)
        self.assertEqual(decode(header), {"alg": "HS256", "typ": "JWT"})
        self.assertEqual(set(claims), {"iss", "sub", "nbf", "exp", "jti", "video"})
        self.assertEqual(claims["video"], {"room": "cast-" + SESSION.replace("-", ""),
            "roomJoin": True, "canPublish": True, "canPublishSources": ["camera", "microphone"],
            "canSubscribe": False, "canPublishData": False, "canUpdateOwnMetadata": False,
            "hidden": False, "recorder": False})
        self.assertEqual(claims["exp"] - claims["nbf"], 30)
        self.assertEqual(claims["sub"], result.identity)
        self.assertNotIn(result.access_token, repr(result))
        self.assertNotIn(SECRET, repr(self.issuer()))
        expected = urlsafe_b64encode(hmac.new(SECRET.encode(), (header + "." + body).encode(),
                                             hashlib.sha256).digest()).rstrip(b"=").decode()
        self.assertEqual(signature, expected)

    def test_fresh_reconnect_is_new_token_for_same_single_publisher_identity(self):
        issuer = self.issuer()
        first = issuer.issue(session_id=SESSION, session_expires_at=NOW + 10)
        second = issuer.issue(session_id=SESSION, session_expires_at=NOW + 10)
        self.assertNotEqual(first.access_token, second.access_token)
        self.assertEqual(first.identity, second.identity)
        self.assertEqual(first.expires_at, NOW + 10)

    def test_other_session_has_no_same_room_or_identity(self):
        issuer = self.issuer()
        first = issuer.issue(session_id=SESSION, session_expires_at=NOW + 600)
        second = issuer.issue(session_id=SESSION[:-1] + "2", session_expires_at=NOW + 600)
        self.assertNotEqual(first.room, second.room)
        self.assertNotEqual(first.identity, second.identity)

    def test_invalid_or_expired_admission_is_denied(self):
        issuer = self.issuer()
        for expiry in (NOW - 1, NOW + 4, NOW + 14401, True, float(NOW + 10)):
            with self.subTest(expiry=expiry), self.assertRaises(ValueError):
                issuer.issue(session_id=SESSION, session_expires_at=expiry)
        for session in (None, "", "username", "file:///tmp/token"):
            with self.subTest(session=session), self.assertRaises(ValueError):
                issuer.issue(session_id=session, session_expires_at=NOW + 600)

    def test_closed_issuer_does_not_issue_and_wipes_owned_secret(self):
        issuer = self.issuer()
        issuer.close()
        issuer.close()
        self.assertFalse(any(issuer._secret))
        with self.assertRaises(ValueError):
            issuer.issue(session_id=SESSION, session_expires_at=NOW + 600)

    def test_plaintext_or_credential_bearing_endpoint_is_denied(self):
        for endpoint in ("ws://10.64.0.20:7880", "wss://user:secret@10.64.0.20", "wss://10.64.0.20?token=x"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                self.issuer(endpoint=endpoint)

    def test_close_cannot_wipe_key_during_inflight_signature(self):
        issuer = self.issuer()
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        original = hmac.new
        results = []
        def delayed(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
            return original(*args, **kwargs)
        def close():
            issuer.close()
            closed.set()
        with patch('services.trusted_media_service.publisher_credentials.hmac.new', side_effect=delayed):
            issue_thread = threading.Thread(target=lambda: results.append(
                issuer.issue(session_id=SESSION, session_expires_at=NOW+600)))
            close_thread = threading.Thread(target=close)
            issue_thread.start()
            try:
                self.assertTrue(entered.wait(2))
                close_thread.start()
                self.assertFalse(closed.wait(0.05))
                self.assertEqual(bytes(issuer._secret), SECRET.encode())
            finally:
                release.set()
                issue_thread.join(2)
                if close_thread.ident is not None: close_thread.join(2)
        self.assertEqual(len(results), 1)
        self.assertTrue(closed.is_set())
        self.assertFalse(any(issuer._secret))
        with self.assertRaises(ValueError):
            issuer.issue(session_id=SESSION, session_expires_at=NOW+600)


if __name__ == "__main__":
    unittest.main()
