"""Fail-closed application boundary for the trusted-media runtime API.

TLS termination must authenticate the client certificate and pass the exact
URI SAN into :meth:`TrustedMediaRuntimeApi.handle`.  This class deliberately
does not own a socket or a Docker API.  It accepts only the bounded casting
operations used by Platform, keeps request replay/session state in memory and
delegates fixed receiver operations to a narrow supervisor.
"""

from __future__ import annotations

from datetime import datetime, timezone
from contextlib import contextmanager
import re
from threading import RLock
import time
from typing import Callable, Mapping, Protocol

from .viewer_token_issuer import LiveKitViewerTokenIssuer


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
RECEIVER_NAME = re.compile(r"^Team-AI-[0-9A-F]{10}$")
BROWSER_INSTANCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$")
REASON = re.compile(r"^[a-z][a-z0-9_.-]{2,127}$")
REQUEST_ID = UUID
PLATFORM_PEER = "spiffe://teamaibox.internal/platform-api"
SINKS = {"browser"}
PRIVACY_POLICY = {
    "schemaVersion": 1,
    "recordingAllowed": False,
    "userContentScreenshotsAllowed": False,
    "indexingAllowed": False,
    "objectStorePersistenceAllowed": False,
    "persistentMediaBuffersAllowed": False,
    "sourceDeviceLabelPersistenceAllowed": False,
}


class RuntimeApiError(ValueError):
    """Stable error with no receiver, certificate or media detail."""

    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class ReceiverSupervisor(Protocol):
    """The only media operations available to the API boundary."""

    def start(self, request: Mapping[str, object]) -> None: ...
    def update(self, request: Mapping[str, object]) -> None: ...
    def stop(self, request: Mapping[str, object]) -> None: ...
    def disconnect_viewer(self, request: Mapping[str, object]) -> None: ...
    def health(self, session_id: str) -> Mapping[str, object]: ...


def _fail(code: str, status: int = 400) -> None:
    raise RuntimeApiError(code, status)


def _timestamp(value: object, code: str) -> float:
    if not isinstance(value, str) or not value.endswith("Z"):
        _fail(code)
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        _fail(code)
    if parsed.tzinfo is None:
        _fail(code)
    return parsed.timestamp()


def _uuid(value: object, code: str) -> str:
    if not isinstance(value, str) or UUID.fullmatch(value) is None:
        _fail(code)
    return value.lower()


def _body(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        _fail("cast_runtime_request_invalid")
    return value


def _exact_fields(value: Mapping[str, object], expected: set[str]) -> None:
    if set(value) != expected:
        _fail("cast_runtime_request_invalid")


def _sinks(value: object) -> tuple[str, ...]:
    if value != ["browser"]:
        _fail("cast_runtime_output_invalid")
    return ("browser",)


class TrustedMediaRuntimeApi:
    """Exact, replay-resistant Platform-to-media application API."""

    def __init__(self, *, supervisor: ReceiverSupervisor, token_issuer: LiveKitViewerTokenIssuer,
                 expected_peer_san: str = PLATFORM_PEER, clock: Callable[[], float] = time.time,
                 request_skew_seconds: int = 30, readiness=None) -> None:
        if not all(callable(getattr(supervisor, name, None)) for name in
                   ("start", "update", "stop", "disconnect_viewer", "health")):
            raise TypeError("trusted media supervisor is incomplete")
        if not isinstance(token_issuer, LiveKitViewerTokenIssuer):
            raise TypeError("trusted media token issuer is invalid")
        if expected_peer_san != PLATFORM_PEER or not callable(clock) or request_skew_seconds != 30:
            raise TypeError("trusted media API security policy drifted")
        self._supervisor = supervisor
        if readiness is not None and not callable(readiness):
            raise TypeError("trusted media readiness probe is invalid")
        self._readiness = readiness
        self._tokens = token_issuer
        self._expected_peer_san = expected_peer_san
        self._clock = clock
        self._request_skew_seconds = request_skew_seconds
        self._seen_requests: dict[str, float] = {}
        # UUID + expiry only. No receiver name, PIN, device identity or media.
        self._stopped_sessions: dict[str, float] = {}
        # Wire timestamps use milliseconds (including the Node client's ISO
        # strings). A sub-millisecond process start must not make a later
        # request in that same millisecond appear to predate this process.
        self._started_at = int(clock() * 1000) / 1000
        self._active: dict[str, object] | None = None
        self._lock = RLock()
        self._closed = False

    @contextmanager
    def _control_lock(self):
        # A stuck media close may retain ownership, but must not queue every
        # control/health request indefinitely behind it.
        if not self._lock.acquire(timeout=0.1):
            _fail("cast_runtime_cleanup_pending", 503)
        try:
            yield
        finally:
            self._lock.release()

    def handle(self, *, peer_uri_san: str, request_id: str, issued_at: str,
               method: str, path: str, body: object = None) -> tuple[int, object | None]:
        """Handle one request after verified TLS 1.3 mutual authentication."""

        if peer_uri_san != self._expected_peer_san:
            _fail("cast_runtime_peer_unauthorized", 403)
        normalized_request = _uuid(request_id, "cast_runtime_request_invalid")
        now = self._clock()
        timestamp = _timestamp(issued_at, "cast_runtime_request_stale")
        if abs(now - timestamp) >= self._request_skew_seconds or timestamp < self._started_at:
            _fail("cast_runtime_request_stale", 401)
        with self._control_lock():
            if self._closed:
                _fail("cast_runtime_shutting_down", 503)
            self._purge_requests(now)
            if method != "GET":
                self.expire_session()
            if normalized_request in self._seen_requests:
                _fail("cast_runtime_request_replayed", 409)
            if len(self._seen_requests) >= 4096:
                _fail("cast_runtime_replay_capacity", 503)
            # Consume the request ID before validating its body. Replaying a
            # malformed or failed mutation must never get a second attempt.
            self._seen_requests[normalized_request] = now + self._request_skew_seconds
            try:
                return self._dispatch(method=method, path=path, body=body, now=now)
            except RuntimeApiError:
                raise
            except Exception:
                _fail("cast_runtime_unavailable", 503)

    def _dispatch(self, *, method: str, path: str, body: object, now: float) -> tuple[int, object | None]:
        if method == "GET" and path == "/internal/v1/runtime/readiness":
            if body is not None:
                _fail("cast_runtime_request_invalid")
            if self._readiness is None:
                _fail("cast_runtime_readiness_unconfigured", 503)
            # A read-only capability probe must remain available while a
            # session is active (e.g. a browser reload). Admission below still
            # rejects a second receiver, and no session identity is exposed.
            return 200, self._readiness()

        if method == "POST" and path == "/internal/v1/runtime/sessions":
            value = _body(body)
            _exact_fields(value, {"sessionId", "receiverName", "pairingPin", "outputSinks", "browserStartsMuted",
                                  "mediaPrivacyPolicy", "expiresAt"})
            session_id = _uuid(value.get("sessionId"), "cast_runtime_session_invalid")
            if self._active is not None:
                _fail("cast_runtime_session_busy", 409)
            if session_id in self._stopped_sessions:
                _fail("cast_runtime_session_stopped", 409)
            if not isinstance(value.get("receiverName"), str) or RECEIVER_NAME.fullmatch(value["receiverName"]) is None:
                _fail("cast_runtime_receiver_invalid")
            if not isinstance(value.get("pairingPin"), str) or re.fullmatch(r"[1-9][0-9]{3}", value["pairingPin"]) is None:
                _fail("cast_runtime_pin_invalid")
            sinks = _sinks(value.get("outputSinks"))
            if value.get("browserStartsMuted") is not (len(sinks) == 2):
                _fail("cast_runtime_mute_policy_invalid")
            if value.get("mediaPrivacyPolicy") != PRIVACY_POLICY:
                _fail("cast_runtime_privacy_policy_invalid")
            expires_at = _timestamp(value.get("expiresAt"), "cast_runtime_expiry_invalid")
            if expires_at <= now or expires_at > now + 14_400:
                _fail("cast_runtime_expiry_invalid")
            request = {"sessionId": session_id, "receiverName": value["receiverName"], "pairingPin": value["pairingPin"],
                       "outputSinks": list(sinks), "browserStartsMuted": value["browserStartsMuted"],
                       "mediaPrivacyPolicy": dict(PRIVACY_POLICY), "expiresAt": value["expiresAt"]}
            self._active = {"sessionId": session_id, "outputSinks": sinks, "expiresAt": expires_at}
            try:
                self._supervisor.start(request)
            except Exception:
                self._active["stopping"] = True
                try:
                    self._supervisor.stop({"sessionId": session_id, "reasonCode": "cast_runtime_start_failed"})
                    self._active = None
                except Exception:
                    pass  # Retain API ownership of an uncertain startup too.
                raise
            return 204, None

        session_match = re.fullmatch(r"/internal/v1/runtime/sessions/([0-9A-Fa-f-]{36})", path)
        viewer_match = re.fullmatch(
            r"/internal/v1/runtime/sessions/([0-9A-Fa-f-]{36})/viewers/([0-9A-Fa-f-]{36})", path)
        connection_match = re.fullmatch(
            r"/internal/v1/runtime/sessions/([0-9A-Fa-f-]{36})/viewer-connections", path)
        admission_match = re.fullmatch(
            r"/internal/v1/runtime/sessions/([0-9A-Fa-f-]{36})/viewer-connections/consume", path)
        health_match = re.fullmatch(r"/internal/v1/runtime/sessions/([0-9A-Fa-f-]{36})/health", path)

        if admission_match and method == "POST":
            # Only the mutually authenticated Platform ingress can reach this
            # operation. It independently authenticates the browser's real login
            # before supplying these fields; JWT claims are never the authority.
            session_id = self._require_active(admission_match.group(1))
            if "browser" not in self._active["outputSinks"]:
                _fail("cast_runtime_browser_output_unavailable", 409)
            value = _body(body)
            _exact_fields(value, {"sessionId", "viewerIdentityId", "browserInstanceId", "accessToken"})
            if _uuid(value.get("sessionId"), "cast_runtime_session_invalid") != session_id:
                _fail("cast_runtime_session_invalid")
            viewer_id = _uuid(value.get("viewerIdentityId"), "cast_runtime_viewer_invalid")
            if not isinstance(value.get("browserInstanceId"), str) \
                    or BROWSER_INSTANCE.fullmatch(value["browserInstanceId"]) is None:
                _fail("cast_runtime_browser_invalid")
            from .viewer_token_issuer import ViewerTokenError
            try:
                return 200, self._tokens.consume(value.get("accessToken"), session_id=session_id,
                    viewer_identity_id=viewer_id, browser_instance_id=value["browserInstanceId"])
            except ViewerTokenError:
                _fail("cast_runtime_viewer_admission_denied", 403)

        if connection_match and method == "POST":
            session_id = self._require_active(connection_match.group(1))
            if "browser" not in self._active["outputSinks"]:
                _fail("cast_runtime_browser_output_unavailable", 409)
            value = _body(body)
            _exact_fields(value, {"sessionId", "viewerIdentityId", "grantId", "audienceRevision",
                                  "browserInstanceId", "expiresAt", "muted", "maximumViewers",
                                  "publisherEncodeRenditions"})
            if _uuid(value.get("sessionId"), "cast_runtime_session_invalid") != session_id:
                _fail("cast_runtime_session_invalid")
            viewer_id = _uuid(value.get("viewerIdentityId"), "cast_runtime_viewer_invalid")
            grant_id = _uuid(value.get("grantId"), "cast_runtime_grant_invalid")
            if not isinstance(value.get("audienceRevision"), int) or isinstance(value.get("audienceRevision"), bool) \
                    or value["audienceRevision"] < 1:
                _fail("cast_runtime_audience_invalid")
            if not isinstance(value.get("browserInstanceId"), str) \
                    or BROWSER_INSTANCE.fullmatch(value["browserInstanceId"]) is None:
                _fail("cast_runtime_browser_invalid")
            return 200, self._tokens.issue(
                session_id=session_id, viewer_identity_id=viewer_id, grant_id=grant_id,
                audience_revision=value["audienceRevision"], browser_instance_id=value["browserInstanceId"],
                grant_expires_at=value.get("expiresAt"), muted=value.get("muted"),
                maximum_viewers=value.get("maximumViewers"),
                publisher_encode_renditions=value.get("publisherEncodeRenditions"),
            )

        if viewer_match and method == "DELETE":
            session_id = self._require_active(viewer_match.group(1))
            viewer_id = _uuid(viewer_match.group(2), "cast_runtime_viewer_invalid")
            value = _body(body)
            scope = {"browserInstanceId"} if "browserInstanceId" in value else set()
            _exact_fields(value, {"sessionId", "viewerIdentityId", "reasonCode"} | scope)
            if _uuid(value.get("sessionId"), "cast_runtime_session_invalid") != session_id \
                    or _uuid(value.get("viewerIdentityId"), "cast_runtime_viewer_invalid") != viewer_id \
                    or not isinstance(value.get("reasonCode"), str) or REASON.fullmatch(value["reasonCode"]) is None:
                _fail("cast_runtime_request_invalid")
            browser = value.get("browserInstanceId")
            if scope and (not isinstance(browser, str) or BROWSER_INSTANCE.fullmatch(browser) is None):
                _fail("cast_runtime_browser_invalid")
            self._tokens.revoke_viewer(session_id=session_id, viewer_identity_id=viewer_id,
                                       browser_instance_id=browser)
            self._supervisor.disconnect_viewer({"sessionId": session_id, "viewerIdentityId": viewer_id,
                                                "reasonCode": value["reasonCode"],
                                                **({"browserInstanceId": browser} if scope else {})})
            if scope:
                return 200, {"remainingBrowserConnections": len(self._tokens.connected_participants(
                    session_id=session_id, viewer_identity_id=viewer_id))}
            return 204, None

        if health_match and method == "GET":
            session_id = _uuid(health_match.group(1), "cast_runtime_session_invalid")
            active = self._active is not None and self._active.get("sessionId") == session_id
            if not active and session_id not in self._stopped_sessions:
                _fail("cast_runtime_session_not_found", 404)
            if active:
                self._require_active(session_id)
            value = self._supervisor.health(session_id)
            failure = isinstance(value, Mapping) and set(value) == {"healthy", "outputs", "receiverState", "failureCode"}
            # The supervisor retains only the most recent failed UUID/enum.
            # Allow that exact, stopped session's private diagnostic to survive
            # Platform cleanup. No viewing, credentials or session restart is
            # enabled by this read. Unknown/normal stops remain unavailable.
            if not active and not failure:
                _fail("cast_runtime_session_not_found", 404)
            if not isinstance(value, Mapping) or (set(value) not in ({"healthy", "outputs"}, {"healthy", "outputs", "progress"}) and not failure) \
                    or not isinstance(value.get("healthy"), bool) or not isinstance(value.get("outputs"), Mapping) \
                    or set(value["outputs"]) != {"browser"} \
                    or any(not isinstance(item, Mapping) or set(item) != {"healthy"}
                           or not isinstance(item.get("healthy"), bool) for item in value["outputs"].values()):
                _fail("cast_runtime_health_invalid", 503)
            result = {"healthy": value["healthy"], "outputs": {
                sink: {"healthy": value["outputs"][sink]["healthy"]} for sink in ("browser",)}}
            if 'progress' in value:
                from .media_progress import validate_progress
                try:
                    result['progress'] = validate_progress(value['progress'])
                except (TypeError, ValueError):
                    _fail('cast_runtime_health_invalid', 503)
            if failure:
                from .receiver_supervisor import FAILURE_CODES
                from .native_failure import native_assertion_code
                if value["receiverState"] != "failed" or (value["failureCode"] not in FAILURE_CODES and not native_assertion_code(value["failureCode"])) \
                        or value["healthy"] or any(x["healthy"] for x in value["outputs"].values()):
                    _fail("cast_runtime_health_invalid", 503)
                result.update(receiverState="failed", failureCode=value["failureCode"])
            return 200, result

        if session_match and method == "PATCH":
            session_id = self._require_active(session_match.group(1))
            value = _body(body)
            _exact_fields(value, {"sessionId", "outputSinks", "browserStartsMuted", "mediaPrivacyPolicy"})
            if _uuid(value.get("sessionId"), "cast_runtime_session_invalid") != session_id:
                _fail("cast_runtime_session_invalid")
            sinks = _sinks(value.get("outputSinks"))
            if value.get("browserStartsMuted") is not (len(sinks) == 2) \
                    or value.get("mediaPrivacyPolicy") != PRIVACY_POLICY:
                _fail("cast_runtime_policy_invalid")
            request = {"sessionId": session_id, "outputSinks": list(sinks),
                       "browserStartsMuted": value["browserStartsMuted"],
                       "mediaPrivacyPolicy": dict(PRIVACY_POLICY)}
            self._supervisor.update(request)
            if "browser" not in sinks:
                self._tokens.clear_session(session_id)
            self._active["outputSinks"] = sinks
            return 204, None

        if session_match and method == "DELETE":
            session_id = _uuid(session_match.group(1), "cast_runtime_session_invalid")
            value = _body(body)
            _exact_fields(value, {"sessionId", "reasonCode"})
            if _uuid(value.get("sessionId"), "cast_runtime_session_invalid") != session_id \
                    or not isinstance(value.get("reasonCode"), str) or REASON.fullmatch(value["reasonCode"]) is None:
                _fail("cast_runtime_request_invalid")
            # Stop-before-start and repeated stop must be acknowledged, but
            # cannot allow a delayed POST to resurrect the released receiver.
            # Includes cleanup after expiry or Platform restart/lost stop ACK.
            self._remember_stopped(session_id, now)
            self._tokens.clear_session(session_id)
            if self._active is not None and self._active["sessionId"] == session_id:
                self._active["stopping"] = True
                self._supervisor.stop({"sessionId": session_id, "reasonCode": value["reasonCode"]})
                self._active = None
            return 204, None

        _fail("cast_runtime_route_not_found", 404)

    def _require_active(self, value: object, *, allow_stopping: bool = False) -> str:
        session_id = _uuid(value, "cast_runtime_session_invalid")
        if self._active is None or self._active.get("sessionId") != session_id:
            _fail("cast_runtime_session_not_found", 404)
        if self._active.get("stopping") and not allow_stopping:
            _fail("cast_runtime_session_stopping", 409)
        if self._clock() >= self._active["expiresAt"] and not allow_stopping:
            _fail("cast_runtime_session_expired", 409)
        return session_id

    def _purge_requests(self, now: float) -> None:
        for request_id in [key for key, expiry in self._seen_requests.items() if expiry <= now]:
            del self._seen_requests[request_id]
        for session_id in [key for key, expiry in self._stopped_sessions.items() if expiry <= now]:
            del self._stopped_sessions[session_id]

    def _remember_stopped(self, session_id: str, now: float) -> None:
        if session_id not in self._stopped_sessions and len(self._stopped_sessions) >= 4096:
            _fail("cast_runtime_cleanup_capacity", 503)
        # A start is valid for at most four hours plus the request skew.
        self._stopped_sessions[session_id] = now + 14_400 + self._request_skew_seconds

    def expire_session(self) -> bool:
        """Revoke and stop an expired receiver even when Platform is offline.

        The active-session lock is retained if the supervisor cannot confirm
        cleanup. A later timer retries, without issuing another viewer token
        or starting a second receiver in the meantime.
        """
        with self._lock:
            if self._active is None or self._clock() < self._active["expiresAt"]:
                return False
            session_id = self._active["sessionId"]
            self._remember_stopped(session_id, self._clock())
            self._active["stopping"] = True
            self._tokens.clear_session(session_id)
            try:
                self._supervisor.stop({"sessionId": session_id, "reasonCode": "cast_session_expired"})
            except Exception:
                _fail("cast_runtime_cleanup_pending", 503)
            self._active = None
            return True

    def shutdown(self) -> None:
        """Process-owner hook, not an HTTP endpoint. Retain failed cleanup."""
        with self._lock:
            self._closed = True
            if self._active is not None:
                session_id = self._active["sessionId"]
                self._active["stopping"] = True
                self._tokens.clear_session(session_id)
                try:
                    self._supervisor.stop({"sessionId": session_id, "reasonCode": "cast_service_stopping"})
                except Exception:
                    _fail("cast_runtime_cleanup_pending", 503)
                self._active = None
            self._seen_requests.clear()
            self._stopped_sessions.clear()
