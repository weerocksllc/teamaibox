from __future__ import annotations

from base64 import urlsafe_b64decode
from datetime import datetime, timezone
import json
import unittest

from services.trusted_media_service.viewer_token_issuer import LiveKitViewerTokenIssuer, ViewerTokenError


SESSION = "10000000-0000-4000-8000-000000000001"
VIEWER = "20000000-0000-4000-8000-000000000001"
GRANT = "30000000-0000-4000-8000-000000000001"
BROWSER = "browser-instance-0001"


def decode_segment(value: str) -> dict[str, object]:
    return json.loads(urlsafe_b64decode(value + "=" * (-len(value) % 4)))


class TrustedMediaViewerTokenIssuerTest(unittest.TestCase):
    def issuer(self, *, clock=lambda: 1_800_000_000, nonce="A" * 32, **overrides):
        config = {
            "api_key": "teamaibox-test-api-key",
            "api_secret": "a-secret-value-that-is-at-least-thirty-two-bytes",
            "endpoint": "wss://10.64.0.20:7880",
            "clock": clock,
            "nonce_factory": lambda: nonce,
            "maximum_viewers": 8,  # Explicit policy fixture, not the product default.
        }
        config.update(overrides)
        return LiveKitViewerTokenIssuer(**config)

    @staticmethod
    def request(**overrides):
        value = {
            "session_id": SESSION,
            "viewer_identity_id": VIEWER,
            "grant_id": GRANT,
            "audience_revision": 2,
            "browser_instance_id": BROWSER,
            "grant_expires_at": datetime.fromtimestamp(1_800_000_600, tz=timezone.utc)
                .isoformat(timespec="seconds").replace("+00:00", "Z"),
            "muted": True,
            "maximum_viewers": 8,
            "publisher_encode_renditions": 1,
        }
        value.update(overrides)
        return value

    def test_issues_one_short_lived_room_scoped_subscriber_only_token(self):
        issuer = self.issuer()
        result = issuer.issue(**self.request())
        header, payload, signature = result["accessToken"].split(".")
        self.assertEqual(decode_segment(header), {"alg": "HS256", "typ": "JWT"})
        claims = decode_segment(payload)
        self.assertEqual(claims["iss"], "teamaibox-test-api-key")
        self.assertEqual(claims["exp"] - claims["nbf"], 30)
        self.assertEqual(claims["video"], {
            "canPublish": False,
            "canPublishData": False,
            "canSubscribe": True,
            "hidden": False,
            "recorder": False,
            "room": "cast-" + SESSION.replace("-", ""),
            "roomJoin": True,
        })
        self.assertNotIn(VIEWER, result["accessToken"])
        self.assertNotIn(BROWSER, result["accessToken"])
        self.assertEqual(len(signature), 43)
        self.assertEqual(result["expiresAt"], "2027-01-15T08:00:30Z")
        self.assertEqual(issuer.status(), {
            "activeAdmissionCount": 1,
            "consumedAdmissionCount": 0,
            "maximumViewersPerSession": 8,
            "tokenTtlSeconds": 30,
            "persistentState": False,
        })

    def test_close_erases_authority_and_never_issues_again(self):
        issuer = self.issuer()
        token = issuer.issue(**self.request())["accessToken"]
        issuer.close()
        self.assertEqual(issuer._api_secret, b"\0" * len(issuer._api_secret))
        self.assertEqual(issuer.status()["activeAdmissionCount"], 0)
        with self.assertRaisesRegex(ViewerTokenError, "closed"):
            issuer.issue(**self.request())
        with self.assertRaises(ViewerTokenError):
            issuer.consume(token, session_id=SESSION, viewer_identity_id=VIEWER, browser_instance_id=BROWSER)

    def test_resource_based_viewing_admits_more_than_eight_without_losing_ownership(self):
        from uuid import uuid4
        import secrets
        issuer=self.issuer(maximum_viewers=None, nonce_factory=lambda:secrets.token_urlsafe(24))
        for _ in range(12):
            viewer=str(uuid4()); request=self.request(viewer_identity_id=viewer,grant_id=str(uuid4()),maximum_viewers=None)
            token=issuer.issue(**request)['accessToken']
            issuer.consume(token,session_id=SESSION,viewer_identity_id=viewer,browser_instance_id=BROWSER)
        self.assertEqual(len(issuer._connections),12)
        self.assertIsNone(issuer.status()['maximumViewersPerSession'])
        issuer.clear_session(SESSION)
        self.assertFalse(issuer._connections)

    def test_consumes_each_admission_once_and_rejects_tampering(self):
        issuer = self.issuer()
        result = issuer.issue(**self.request())
        accepted = issuer.consume(result["accessToken"], session_id=SESSION, viewer_identity_id=VIEWER, browser_instance_id=BROWSER)
        self.assertEqual(accepted["sessionId"], SESSION)
        self.assertEqual(accepted["viewerIdentityId"], VIEWER)
        self.assertRegex(accepted["participantIdentity"], r"^cast-[0-9a-f]{32}$")
        with self.assertRaisesRegex(ViewerTokenError, "admission is unavailable"):
            issuer.consume(result["accessToken"], session_id=SESSION, viewer_identity_id=VIEWER, browser_instance_id=BROWSER)

        other = self.issuer(nonce="B" * 32).issue(**self.request())
        parts = other["accessToken"].split(".")
        parts[1] = ("A" if parts[1][0] != "A" else "B") + parts[1][1:]
        with self.assertRaisesRegex(ViewerTokenError, "invalid"):
            self.issuer(nonce="B" * 32).consume(".".join(parts), session_id=SESSION, viewer_identity_id=VIEWER, browser_instance_id=BROWSER)

    def test_revoke_and_session_clear_destroy_ephemeral_authority(self):
        issuer = self.issuer()
        first = issuer.issue(**self.request())
        self.assertEqual(issuer.revoke_viewer(session_id=SESSION, viewer_identity_id=VIEWER), 1)
        with self.assertRaisesRegex(ViewerTokenError, "admission is unavailable"):
            issuer.consume(first["accessToken"], session_id=SESSION, viewer_identity_id=VIEWER, browser_instance_id=BROWSER)
        self.assertEqual(issuer.clear_session(SESSION), 1)
        self.assertEqual(issuer.status()["activeAdmissionCount"], 0)

    def test_fresh_reconnect_invalidates_the_earlier_browser_admission(self):
        nonces = iter(["A" * 32, "B" * 32])
        issuer = self.issuer(nonce_factory=lambda: next(nonces))
        first = issuer.issue(**self.request())
        second = issuer.issue(**self.request())
        with self.assertRaisesRegex(ViewerTokenError, "admission is unavailable"):
            issuer.consume(first["accessToken"], session_id=SESSION, viewer_identity_id=VIEWER, browser_instance_id=BROWSER)
        self.assertEqual(issuer.consume(second["accessToken"], session_id=SESSION,
            viewer_identity_id=VIEWER, browser_instance_id=BROWSER)["sessionId"], SESSION)
        self.assertEqual(issuer.status()["activeAdmissionCount"], 1)

    def test_forwarded_token_requires_exact_authenticated_user_session_and_browser(self):
        issuer = self.issuer()
        result = issuer.issue(**self.request())
        context = dict(session_id=SESSION, viewer_identity_id=VIEWER, browser_instance_id=BROWSER)
        for field, changed in (("session_id", "00000000-0000-4000-8000-000000000099"),
                               ("viewer_identity_id", "00000000-0000-4000-8000-000000000099"),
                               ("browser_instance_id", BROWSER + "-other")):
            with self.subTest(field=field), self.assertRaisesRegex(ViewerTokenError, "context is invalid"):
                issuer.consume(result["accessToken"], **(context | {field:changed}))
            self.assertEqual(issuer.status()["consumedAdmissionCount"], 0)
        self.assertEqual(issuer.consume(result["accessToken"], **context)["viewerIdentityId"], VIEWER)

    def test_bearer_without_independent_context_is_not_an_ingress_admission(self):
        issuer = self.issuer()
        result = issuer.issue(**self.request())
        with self.assertRaises(TypeError):
            issuer.consume(result["accessToken"])

    def test_rejects_plaintext_endpoint_expanded_privilege_and_expiring_grant(self):
        with self.assertRaisesRegex(ViewerTokenError, "endpoint"):
            self.issuer(endpoint="ws://10.64.0.20:7880?token=unsafe")
        issuer = self.issuer()
        with self.assertRaisesRegex(ViewerTokenError, "viewer limit"):
            issuer.issue(**self.request(maximum_viewers=9))
        with self.assertRaisesRegex(ViewerTokenError, "encode count"):
            issuer.issue(**self.request(publisher_encode_renditions=2))
        expiry = datetime.fromtimestamp(1_800_000_004, tz=timezone.utc) \
            .isoformat(timespec="seconds").replace("+00:00", "Z")
        with self.assertRaisesRegex(ViewerTokenError, "expires too soon"):
            issuer.issue(**self.request(grant_expires_at=expiry))


if __name__ == "__main__":
    unittest.main()
