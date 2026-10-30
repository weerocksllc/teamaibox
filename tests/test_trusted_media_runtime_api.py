from __future__ import annotations

from datetime import datetime, timezone
import unittest

from services.trusted_media_service.runtime_api import (
    PLATFORM_PEER,
    PRIVACY_POLICY,
    RuntimeApiError,
    TrustedMediaRuntimeApi,
)
from services.trusted_media_service.viewer_token_issuer import LiveKitViewerTokenIssuer


SESSION = "10000000-0000-4000-8000-000000000001"
VIEWER = "20000000-0000-4000-8000-000000000001"
GRANT = "30000000-0000-4000-8000-000000000001"


class Supervisor:
    def __init__(self) -> None:
        self.calls = []

    def start(self, request): self.calls.append(("start", request))
    def update(self, request): self.calls.append(("update", request))
    def stop(self, request): self.calls.append(("stop", request))
    def disconnect_viewer(self, request): self.calls.append(("disconnect", request))
    def health(self, session_id):
        self.calls.append(("health", session_id))
        return {"healthy": True, "outputs": {"browser": {"healthy": True}}}


class RuntimeApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 1_788_700_000.0
        self.supervisor = Supervisor()
        self.issuer = LiveKitViewerTokenIssuer(
            api_key="livekit-api-key", api_secret="s" * 32, endpoint="wss://10.64.0.20:7880",
            clock=lambda: self.now, nonce_factory=lambda: "N" * 24,
        )
        self.api = TrustedMediaRuntimeApi(supervisor=self.supervisor, token_issuer=self.issuer,
                                          clock=lambda: self.now)
        self.sequence = 0

    def invoke(self, method, path, body=None, *, peer=PLATFORM_PEER, age=0):
        self.sequence += 1
        request_id = f"00000000-0000-4000-8000-{self.sequence:012d}"
        issued_at = datetime.fromtimestamp(self.now - age, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return self.api.handle(peer_uri_san=peer, request_id=request_id, issued_at=issued_at,
                               method=method, path=path, body=body)

    def start(self, sinks=("browser",), session_id=SESSION):
        return self.invoke("POST", "/internal/v1/runtime/sessions", {
            "sessionId": session_id, "receiverName": "Team-AI-0123456789", "pairingPin": "1234", "outputSinks": list(sinks),
            "browserStartsMuted": len(sinks) == 2, "mediaPrivacyPolicy": dict(PRIVACY_POLICY),
            "expiresAt": datetime.fromtimestamp(self.now + 1800, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        })

    def test_exact_lifecycle_viewer_token_health_and_cleanup(self):
        self.assertEqual(self.start(), (204, None))
        self.assertEqual(self.supervisor.calls[0][1]["pairingPin"], "1234")
        self.assertNotIn("pairingPin", self.api._active)
        expiry = datetime.fromtimestamp(self.now + 60, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        status, connection = self.invoke("POST", f"/internal/v1/runtime/sessions/{SESSION}/viewer-connections", {
            "sessionId": SESSION, "viewerIdentityId": VIEWER, "grantId": GRANT, "audienceRevision": 2,
            "browserInstanceId": "browser-instance-0001", "expiresAt": expiry, "muted": True,
            "maximumViewers": 8, "publisherEncodeRenditions": 1,
        })
        self.assertEqual(status, 200)
        self.assertEqual(connection["url"], "wss://10.64.0.20:7880")
        self.assertNotIn(connection["accessToken"], repr(self.api.__dict__))
        self.assertEqual(self.invoke("GET", f"/internal/v1/runtime/sessions/{SESSION}/health")[0], 200)
        self.assertEqual(self.invoke("DELETE", f"/internal/v1/runtime/sessions/{SESSION}/viewers/{VIEWER}", {
            "sessionId": SESSION, "viewerIdentityId": VIEWER, "reasonCode": "cast_view_revoked"}), (204, None))
        self.assertEqual(self.invoke("DELETE", f"/internal/v1/runtime/sessions/{SESSION}", {
            "sessionId": SESSION, "reasonCode": "cast_stopped_by_initiator"}), (204, None))
        self.assertEqual(self.issuer.status()["activeAdmissionCount"], 0)

    def test_first_request_in_same_millisecond_as_start_is_not_stale(self):
        self.now = 1_788_700_000.0004
        self.api = TrustedMediaRuntimeApi(supervisor=self.supervisor, token_issuer=self.issuer,
                                          clock=lambda: self.now)
        self.now += .0002
        # The Node client serializes milliseconds, while Python's process
        # clock includes smaller fractions. This request was issued later.
        self.assertEqual(self.start(), (204, None))
        with self.assertRaisesRegex(RuntimeApiError, "request_stale"):
            self.invoke("GET", f"/internal/v1/runtime/sessions/{SESSION}/health", age=.002)

    def test_browser_scoped_disconnect_preserves_other_browser_and_returns_confirmed_count(self):
        self.start()
        sequence = iter(["A" * 24, "B" * 24])
        self.issuer._nonce_factory = lambda: next(sequence)
        expiry = datetime.fromtimestamp(self.now + 60, timezone.utc).isoformat().replace("+00:00", "Z")
        for browser in ["browser-instance-one", "browser-instance-two"]:
            issued = self.issuer.issue(session_id=SESSION, viewer_identity_id=VIEWER, grant_id=GRANT,
                audience_revision=1, browser_instance_id=browser, grant_expires_at=expiry,
                muted=False, maximum_viewers=8, publisher_encode_renditions=1)
            self.issuer.consume(issued["accessToken"], session_id=SESSION, viewer_identity_id=VIEWER,
                browser_instance_id=browser)
        def disconnect(request):
            self.supervisor.calls.append(("disconnect", request))
            for participant in self.issuer.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER,
                    browser_instance_id=request.get("browserInstanceId")):
                self.issuer.confirm_disconnected(session_id=SESSION, participant_identity=participant)
        self.supervisor.disconnect_viewer = disconnect
        path = f"/internal/v1/runtime/sessions/{SESSION}/viewers/{VIEWER}"
        body = dict(sessionId=SESSION, viewerIdentityId=VIEWER, reasonCode="cast_viewer_left")
        self.assertEqual(self.invoke("DELETE", path, {**body, "browserInstanceId": "browser-instance-one"}),
                         (200, {"remainingBrowserConnections": 1}))
        self.assertEqual(self.supervisor.calls[-1][1]["browserInstanceId"], "browser-instance-one")
        for browser in [None, "", "short", 1234]:
            with self.assertRaisesRegex(RuntimeApiError, "browser_invalid"):
                self.invoke("DELETE", path, {**body, "browserInstanceId": browser})
        self.assertEqual(len(self.issuer.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER)), 1)
        self.assertEqual(self.invoke("DELETE", path, body), (204, None))
        self.assertEqual(self.issuer.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER), ())

    def test_readiness_is_private_read_only_and_survives_an_active_session(self):
        path = "/internal/v1/runtime/readiness"
        with self.assertRaisesRegex(RuntimeApiError, "readiness_unconfigured"):
            self.invoke("GET", path)
        calls = []
        self.api._readiness = lambda: calls.append("probe") or {"test": "readiness"}
        with self.assertRaisesRegex(RuntimeApiError, "peer_unauthorized"):
            self.invoke("GET", path, peer="spiffe://teamaibox.internal/browser")
        self.assertEqual(calls, [])
        self.assertEqual(self.invoke("GET", path), (200, {"test": "readiness"}))
        self.assertEqual(self.supervisor.calls, [])
        with self.assertRaisesRegex(RuntimeApiError, "request_invalid"):
            self.invoke("GET", path, {"command": "start"})
        self.start()
        before = list(self.supervisor.calls)
        self.assertEqual(self.invoke("GET", path), (200, {"test": "readiness"}))
        self.assertEqual(self.supervisor.calls, before)
        self.assertEqual(calls, ["probe", "probe"])
        with self.assertRaisesRegex(RuntimeApiError, "session_busy"):
            self.start()

    def test_wrong_peer_stale_and_replayed_requests_fail_closed(self):
        with self.assertRaisesRegex(RuntimeApiError, "peer_unauthorized"):
            self.invoke("POST", "/internal/v1/runtime/sessions", {}, peer="spiffe://teamaibox.internal/other")
        with self.assertRaisesRegex(RuntimeApiError, "request_stale"):
            self.invoke("POST", "/internal/v1/runtime/sessions", {}, age=31)
        issued = datetime.fromtimestamp(self.now, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        request_id = "90000000-0000-4000-8000-000000000001"
        with self.assertRaises(RuntimeApiError):
            self.api.handle(peer_uri_san=PLATFORM_PEER, request_id=request_id, issued_at=issued,
                            method="POST", path="/internal/v1/runtime/sessions", body={})
        with self.assertRaisesRegex(RuntimeApiError, "request_replayed"):
            self.api.handle(peer_uri_san=PLATFORM_PEER, request_id=request_id, issued_at=issued,
                            method="POST", path="/internal/v1/runtime/sessions", body={})

    def test_shutdown_blocks_new_requests_and_retries_owned_cleanup(self):
        self.start()
        self.supervisor.stop = lambda _: (_ for _ in ()).throw(RuntimeError("private cleanup diagnostic"))
        with self.assertRaisesRegex(RuntimeApiError, "cleanup_pending"):
            self.api.shutdown()
        self.assertIsNotNone(self.api._active)
        self.assertTrue(self.api._active["stopping"])
        with self.assertRaisesRegex(RuntimeApiError, "shutting_down"):
            self.start()
        self.supervisor.stop = lambda _: None
        self.api.shutdown()
        self.assertIsNone(self.api._active)
        self.assertEqual(self.api._seen_requests, {})
        self.api.shutdown()

    def test_private_viewer_admission_is_authenticated_context_bound_and_one_use(self):
        self.start(("browser",))
        expiry = datetime.fromtimestamp(self.now + 60, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        _, issued = self.invoke("POST", f"/internal/v1/runtime/sessions/{SESSION}/viewer-connections", {
            "sessionId": SESSION, "viewerIdentityId": VIEWER, "grantId": GRANT, "audienceRevision": 1,
            "browserInstanceId": "browser-instance-0001", "expiresAt": expiry, "muted": False,
            "maximumViewers": 8, "publisherEncodeRenditions": 1})
        path = f"/internal/v1/runtime/sessions/{SESSION}/viewer-connections/consume"
        body = {"sessionId": SESSION, "viewerIdentityId": VIEWER,
                "browserInstanceId": "browser-instance-0001", "accessToken": issued["accessToken"]}
        with self.assertRaisesRegex(RuntimeApiError, "peer_unauthorized"):
            self.invoke("POST", path, body, peer="spiffe://teamaibox.internal/browser")
        with self.assertRaisesRegex(RuntimeApiError, "admission_denied"):
            self.invoke("POST", path, {**body, "browserInstanceId": "browser-instance-0002"})
        status, consumed = self.invoke("POST", path, body)
        self.assertEqual(status, 200)
        self.assertEqual(consumed["grantId"], GRANT)
        self.assertNotIn("accessToken", consumed)
        with self.assertRaisesRegex(RuntimeApiError, "admission_denied"):
            self.invoke("POST", path, body)

    def test_legacy_sinks_fail_before_side_effects_and_browser_remains_single_session(self):
        for sinks in (("hdmi",), ("hdmi", "browser"), (), ("browser", "browser"), ("unknown",)):
            with self.assertRaisesRegex(RuntimeApiError, "output_invalid"):
                self.start(sinks)
            self.assertEqual(self.supervisor.calls, [])
            self.assertIsNone(self.api._active)
        self.start()
        with self.assertRaisesRegex(RuntimeApiError, "session_busy"):
            self.start()

    def test_stop_is_idempotent_and_fences_a_late_start(self):
        stop = {"sessionId": SESSION, "reasonCode": "cast_stopped_by_initiator"}
        path = f"/internal/v1/runtime/sessions/{SESSION}"
        self.assertEqual(self.invoke("DELETE", path, stop), (204, None))
        self.assertEqual(self.invoke("DELETE", path, stop), (204, None))
        with self.assertRaisesRegex(RuntimeApiError, "session_stopped"):
            self.start()
        self.assertEqual(self.supervisor.calls, [])
        self.assertEqual(set(self.api._stopped_sessions), {SESSION})

    def test_private_failure_enum_remains_readable_after_cleanup_not_a_live_session(self):
        self.start(("browser",))
        failure = {"healthy": False, "outputs": {"browser": {"healthy": False}},
                   "receiverState": "failed", "failureCode": "video_format"}
        self.supervisor.health = lambda _: failure
        self.invoke("DELETE", f"/internal/v1/runtime/sessions/{SESSION}",
                    {"sessionId": SESSION, "reasonCode": "cast_receiver_terminated"})
        path = f"/internal/v1/runtime/sessions/{SESSION}/health"
        self.assertEqual(self.invoke("GET", path), (200, failure))
        with self.assertRaisesRegex(RuntimeApiError, "peer_unauthorized"):
            self.invoke("GET", path, peer="spiffe://teamaibox.internal/browser")
        with self.assertRaisesRegex(RuntimeApiError, "session_not_found"):
            self.invoke("GET", f"/internal/v1/runtime/sessions/{VIEWER}/health")
        with self.assertRaisesRegex(RuntimeApiError, "session_stopped"):
            self.start()
        self.now += 14431
        with self.assertRaisesRegex(RuntimeApiError, "session_not_found"):
            self.invoke("GET", path)

    def test_clean_stop_has_no_retained_failure_or_media_health(self):
        self.start(("browser",))
        self.invoke("DELETE", f"/internal/v1/runtime/sessions/{SESSION}",
                    {"sessionId": SESSION, "reasonCode": "cast_stopped_by_initiator"})
        with self.assertRaisesRegex(RuntimeApiError, "session_not_found"):
            self.invoke("GET", f"/internal/v1/runtime/sessions/{SESSION}/health")

    def test_expiry_then_platform_cleanup_returns_confirmed_stop(self):
        self.start()
        self.now += 1801
        self.assertTrue(self.api.expire_session())
        self.assertEqual(self.invoke("DELETE", f"/internal/v1/runtime/sessions/{SESSION}", {
            "sessionId": SESSION, "reasonCode": "cast_session_expired"}), (204, None))
        self.assertEqual(len([call for call in self.supervisor.calls if call[0] == "stop"]), 1)

    def test_cleanup_for_old_session_does_not_stop_another_receiver(self):
        self.start()
        self.assertEqual(self.invoke("DELETE", f"/internal/v1/runtime/sessions/{VIEWER}", {
            "sessionId": VIEWER, "reasonCode": "cast_session_expired"}), (204, None))
        self.assertEqual(self.api._active["sessionId"], SESSION)
        self.assertFalse(any(call[0] == "stop" for call in self.supervisor.calls))

    def test_request_created_before_daemon_boot_is_rejected(self):
        with self.assertRaisesRegex(RuntimeApiError, "request_stale"):
            self.invoke("DELETE", f"/internal/v1/runtime/sessions/{SESSION}", {
                "sessionId": SESSION, "reasonCode": "cast_session_expired"}, age=1)
        self.assertEqual(self.supervisor.calls, [])

    def test_stop_failure_retains_active_lock_and_credentials(self):
        self.start()
        self.supervisor.stop = lambda request: (_ for _ in ()).throw(RuntimeError("hidden detail"))
        with self.assertRaisesRegex(RuntimeApiError, "cast_runtime_unavailable"):
            self.invoke("DELETE", f"/internal/v1/runtime/sessions/{SESSION}", {
                "sessionId": SESSION, "reasonCode": "cast_runtime_failed"})
        with self.assertRaisesRegex(RuntimeApiError, "session_busy"):
            self.start()
        with self.assertRaisesRegex(RuntimeApiError, "session_stopping"):
            self.invoke("POST", f"/internal/v1/runtime/sessions/{SESSION}/viewer-connections", {})

    def test_partial_start_cleanup_failure_retains_api_ownership_for_delete_retry(self):
        self.supervisor.start = lambda _: (_ for _ in ()).throw(RuntimeError("private startup detail"))
        self.supervisor.stop = lambda _: (_ for _ in ()).throw(RuntimeError("private cleanup detail"))
        with self.assertRaisesRegex(RuntimeApiError, "cast_runtime_unavailable"):
            self.start()
        self.assertEqual(self.api._active["sessionId"], SESSION)
        self.assertTrue(self.api._active["stopping"])
        self.assertNotIn("pairingPin", self.api._active)
        with self.assertRaisesRegex(RuntimeApiError, "session_busy"):
            self.start()
        self.supervisor.stop = lambda _: None
        self.assertEqual(self.invoke("DELETE", f"/internal/v1/runtime/sessions/{SESSION}", {
            "sessionId": SESSION, "reasonCode": "cast_runtime_failed"}), (204, None))
        self.assertIsNone(self.api._active)

    def test_invalid_health_is_not_forwarded(self):
        self.start()
        self.supervisor.health = lambda _: {"healthy": True, "outputs": {}, "token": "secret"}
        with self.assertRaisesRegex(RuntimeApiError, "health_invalid"):
            self.invoke("GET", f"/internal/v1/runtime/sessions/{SESSION}/health")

    def test_extra_fields_and_exact_replay_window_boundary_are_rejected(self):
        with self.assertRaisesRegex(RuntimeApiError, "request_invalid"):
            self.invoke("POST", "/internal/v1/runtime/sessions", {
                "sessionId": SESSION, "receiverName": "Team-AI-0123456789", "pairingPin": "1234", "outputSinks": ["hdmi"],
                "browserStartsMuted": False, "mediaPrivacyPolicy": dict(PRIVACY_POLICY),
                "expiresAt": datetime.fromtimestamp(self.now + 1800, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "unexpected": True,
            })
        with self.assertRaisesRegex(RuntimeApiError, "request_stale"):
            self.invoke("POST", "/internal/v1/runtime/sessions", {}, age=30)

    def test_idle_expiry_stops_receiver_and_retries_failed_cleanup(self):
        self.start()
        self.now += 1800
        stop = self.supervisor.stop
        self.supervisor.stop = lambda _: (_ for _ in ()).throw(RuntimeError("private failure"))
        with self.assertRaisesRegex(RuntimeApiError, "cleanup_pending"):
            self.api.expire_session()
        with self.assertRaisesRegex(RuntimeApiError, "cleanup_pending"):
            self.start()
        self.supervisor.stop = stop
        self.assertTrue(self.api.expire_session())
        self.assertEqual(self.supervisor.calls[-1], ("stop", {
            "sessionId": SESSION, "reasonCode": "cast_session_expired"}))
        self.assertFalse(self.api.expire_session())
        with self.assertRaisesRegex(RuntimeApiError, "session_stopped"):
            self.start()
        self.assertEqual(self.start(session_id=VIEWER), (204, None))

    def test_replay_memory_is_bounded(self):
        self.api._seen_requests = {str(index): self.now + 30 for index in range(4096)}
        with self.assertRaisesRegex(RuntimeApiError, "replay_capacity"):
            self.start()
        self.assertEqual(self.supervisor.calls, [])


if __name__ == "__main__":
    unittest.main()
