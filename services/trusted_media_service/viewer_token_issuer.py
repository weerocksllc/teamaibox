"""Memory-only, least-privilege LiveKit viewer token issuance.

The trusted media service owns this boundary.  Platform proves the current
user/session/browser authorization before calling it; the issuer then creates
one short-lived, room-scoped subscriber token.  No API secret, access token or
raw browser-instance identifier is exposed through inspection state.

This source component does not make the blocked AirPlay-compatible release
deployable.  A final image may include it only after the release package,
browser SDK and LiveKit server are admitted by the separate supply-chain gate.
"""

from __future__ import annotations

from base64 import urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import json
import re
import secrets
from threading import RLock
import time
from typing import Callable
from urllib.parse import urlsplit


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
BROWSER_INSTANCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$")
API_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
NONCE = re.compile(r"^[A-Za-z0-9_-]{22,128}$")


class ViewerTokenError(ValueError):
    """Stable, secret-free viewer-token contract failure."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ViewerTokenError(message)


def _b64(value: bytes) -> str:
    return urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _iso(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _timestamp(value: str) -> int:
    _require(isinstance(value, str) and value.endswith("Z"), "viewer grant expiry is invalid")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ViewerTokenError("viewer grant expiry is invalid") from error
    _require(parsed.tzinfo is not None, "viewer grant expiry is invalid")
    return int(parsed.timestamp())


def _validated_endpoint(value: str) -> str:
    _require(isinstance(value, str) and len(value) <= 512, "LiveKit endpoint is invalid")
    parsed = urlsplit(value)
    _require(
        parsed.scheme == "wss"
        and parsed.hostname is not None
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment,
        "LiveKit endpoint is invalid",
    )
    return value


@dataclass
class _Admission:
    session_id: str
    viewer_identity_id: str
    grant_id: str
    browser_digest: str
    participant_identity: str
    token_digest: str
    expires_at: int
    consumed: bool = False
    revoked: bool = False


class LiveKitViewerTokenIssuer:
    """Issue and account for short-lived subscriber-only LiveKit JWTs."""

    def __init__(
        self,
        *,
        api_key: str,
        api_secret: str,
        endpoint: str,
        ttl_seconds: int = 30,
        maximum_viewers: int | None = None,
        clock: Callable[[], float] = time.time,
        nonce_factory: Callable[[], str] = lambda: secrets.token_urlsafe(24),
    ) -> None:
        _require(isinstance(api_key, str) and API_KEY.fullmatch(api_key) is not None, "LiveKit API key is invalid")
        _require(isinstance(api_secret, str) and 32 <= len(api_secret.encode("utf-8")) <= 256, "LiveKit API secret is invalid")
        _require(isinstance(ttl_seconds, int) and 5 <= ttl_seconds <= 30, "viewer token TTL is invalid")
        _require(maximum_viewers is None or type(maximum_viewers) is int and maximum_viewers > 0, "viewer limit is invalid")
        _require(callable(clock) and callable(nonce_factory), "viewer token issuer dependencies are invalid")
        self._api_key = api_key
        self._api_secret = bytearray(api_secret.encode("utf-8"))
        self._endpoint = _validated_endpoint(endpoint)
        self._ttl_seconds = ttl_seconds
        self._maximum_viewers = maximum_viewers
        self._clock = clock
        self._nonce_factory = nonce_factory
        self._admissions: dict[str, _Admission] = {}
        # A 30-second JWT expiry limits NEW joins, not an existing WebRTC
        # connection. Keep independent connection ownership until actual SFU
        # removal is confirmed; otherwise eight connected viewers could
        # expire out of accounting and admit another eight.
        self._connections: dict[str, tuple[str, str]] = {}
        self._connection_browsers: dict[str, str] = {}
        self._lock = RLock()
        self._closed = False

    def issue(
        self,
        *,
        session_id: str,
        viewer_identity_id: str,
        grant_id: str,
        audience_revision: int,
        browser_instance_id: str,
        grant_expires_at: str,
        muted: bool,
        maximum_viewers: int | None,
        publisher_encode_renditions: int,
    ) -> dict[str, object]:
        _require(UUID.fullmatch(session_id or "") is not None, "casting session identity is invalid")
        _require(UUID.fullmatch(viewer_identity_id or "") is not None, "viewer identity is invalid")
        _require(UUID.fullmatch(grant_id or "") is not None, "viewer grant identity is invalid")
        _require(isinstance(audience_revision, int) and audience_revision >= 1, "audience revision is invalid")
        _require(BROWSER_INSTANCE.fullmatch(browser_instance_id or "") is not None, "browser instance is invalid")
        _require(isinstance(muted, bool), "muted state is invalid")
        _require(maximum_viewers is None or type(maximum_viewers) is int and maximum_viewers > 0, "viewer limit is invalid")
        if self._maximum_viewers is not None:
            _require(maximum_viewers == self._maximum_viewers, "configured viewer limit drifted")
        _require(publisher_encode_renditions == 1, "publisher encode count drifted")

        now = int(self._clock())
        grant_expiry = _timestamp(grant_expires_at)
        expires_at = min(grant_expiry, now + self._ttl_seconds)
        _require(expires_at >= now + 5, "viewer grant expires too soon")
        nonce = self._nonce_factory()
        _require(isinstance(nonce, str) and NONCE.fullmatch(nonce) is not None, "viewer token nonce is invalid")
        browser_digest = hashlib.sha256(browser_instance_id.encode("utf-8")).hexdigest()
        participant_digest = hashlib.sha256(
            f"{session_id}:{viewer_identity_id}:{grant_id}:{browser_digest}".encode("ascii")
        ).hexdigest()[:32]
        participant_identity = f"cast-{participant_digest}"
        room_name = "cast-" + session_id.replace("-", "")

        header = {"alg": "HS256", "typ": "JWT"}
        payload = {
            "exp": expires_at,
            "iss": self._api_key,
            "jti": nonce,
            "nbf": now,
            "sub": participant_identity,
            "video": {
                "canPublish": False,
                "canPublishData": False,
                "canSubscribe": True,
                "hidden": False,
                "recorder": False,
                "room": room_name,
                "roomJoin": True,
            },
        }
        signing_input = (
            _b64(json.dumps(header, sort_keys=True, separators=(",", ":")).encode("utf-8"))
            + "."
            + _b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        )
        signature = _b64(hmac.new(self._api_secret, signing_input.encode("ascii"), hashlib.sha256).digest())
        token = signing_input + "." + signature
        token_digest = hashlib.sha256(token.encode("ascii")).hexdigest()

        with self._lock:
            _require(not self._closed, "viewer token issuer is closed")
            self._purge(now)
            _require(nonce not in self._admissions, "viewer token nonce was already used")
            active = {
                item.participant_identity
                for item in self._admissions.values()
                if item.session_id == session_id and not item.revoked and item.expires_at > now
            }
            active.update(participant for participant, (owned_session, _) in self._connections.items()
                          if owned_session == session_id)
            _require(
                self._maximum_viewers is None or participant_identity in active or len(active) < self._maximum_viewers,
                "casting viewer limit reached",
            )
            # A reconnect gets a new admission; any earlier unconsumed bearer
            # for the same session/user/browser becomes unusable immediately.
            for item in self._admissions.values():
                if item.session_id == session_id and item.participant_identity == participant_identity:
                    item.revoked = True
            self._admissions[nonce] = _Admission(
                session_id=session_id,
                viewer_identity_id=viewer_identity_id,
                grant_id=grant_id,
                browser_digest=browser_digest,
                participant_identity=participant_identity,
                token_digest=token_digest,
                expires_at=expires_at,
            )

        return {
            "sessionId": session_id,
            "viewerIdentityId": viewer_identity_id,
            "grantId": grant_id,
            "url": self._endpoint,
            "accessToken": token,
            "expiresAt": _iso(expires_at),
        }

    def consume(self, access_token: str, *, session_id: str,
                viewer_identity_id: str, browser_instance_id: str) -> dict[str, object]:
        """Consume once, bound to an independently authenticated ingress context.

        The gateway MUST derive these identities from the current authorized
        Platform session/browser, never from JWT claims or untrusted query
        fields. Signature verification alone does not prevent forwarded use.
        This component is not a deployed signalling ingress.
        """

        _require(isinstance(session_id, str) and UUID.fullmatch(session_id) is not None,
                 "viewer admission context is invalid")
        _require(isinstance(viewer_identity_id, str) and UUID.fullmatch(viewer_identity_id) is not None,
                 "viewer admission context is invalid")
        _require(isinstance(browser_instance_id, str) and BROWSER_INSTANCE.fullmatch(browser_instance_id) is not None,
                 "viewer admission context is invalid")
        _require(isinstance(access_token, str) and len(access_token) <= 12_288, "viewer token is invalid")
        parts = access_token.split(".")
        _require(len(parts) == 3 and all(parts), "viewer token is invalid")
        signing_input = parts[0] + "." + parts[1]
        expected = _b64(hmac.new(self._api_secret, signing_input.encode("ascii"), hashlib.sha256).digest())
        _require(hmac.compare_digest(expected, parts[2]), "viewer token is invalid")
        try:
            header = json.loads(_unb64(parts[0]))
            payload = json.loads(_unb64(parts[1]))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ViewerTokenError("viewer token is invalid") from error
        _require(header == {"alg": "HS256", "typ": "JWT"}, "viewer token header is invalid")
        _require(isinstance(payload, dict), "viewer token payload is invalid")
        nonce = payload.get("jti")
        now = int(self._clock())
        with self._lock:
            _require(not self._closed, "viewer token issuer is closed")
            self._purge(now)
            admission = self._admissions.get(nonce) if isinstance(nonce, str) else None
            _require(admission is not None, "viewer token admission is unavailable")
            _require(not admission.revoked and not admission.consumed, "viewer token admission is unavailable")
            _require(admission.session_id == session_id and admission.viewer_identity_id == viewer_identity_id
                     and hmac.compare_digest(admission.browser_digest,
                         hashlib.sha256(browser_instance_id.encode("utf-8")).hexdigest()),
                     "viewer admission context is invalid")
            _require(admission.expires_at > now and payload.get("exp") == admission.expires_at, "viewer token expired")
            _require(payload.get("iss") == self._api_key and payload.get("sub") == admission.participant_identity,
                     "viewer token identity is invalid")
            _require(hashlib.sha256(access_token.encode("ascii")).hexdigest() == admission.token_digest,
                     "viewer token identity is invalid")
            connected = {participant for participant, (owned_session, _) in self._connections.items()
                         if owned_session == session_id}
            _require(self._maximum_viewers is None or admission.participant_identity in connected or len(connected) < self._maximum_viewers,
                     "casting viewer limit reached")
            self._connections[admission.participant_identity] = (session_id, viewer_identity_id)
            self._connection_browsers[admission.participant_identity] = admission.browser_digest
            admission.consumed = True
            return {
                "sessionId": admission.session_id,
                "viewerIdentityId": admission.viewer_identity_id,
                "grantId": admission.grant_id,
                "participantIdentity": admission.participant_identity,
                "expiresAt": _iso(admission.expires_at),
            }

    def revoke_viewer(self, *, session_id: str, viewer_identity_id: str, browser_instance_id: str | None = None) -> int:
        _require(UUID.fullmatch(session_id or "") is not None, "casting session identity is invalid")
        _require(UUID.fullmatch(viewer_identity_id or "") is not None, "viewer identity is invalid")
        browser_digest = self._browser_digest(browser_instance_id)
        count = 0
        with self._lock:
            self._purge(int(self._clock()))
            for admission in self._admissions.values():
                if admission.session_id == session_id and admission.viewer_identity_id == viewer_identity_id \
                        and (browser_digest is None or admission.browser_digest == browser_digest) \
                        and not admission.revoked:
                    admission.revoked = True
                    count += 1
        return count

    def clear_session(self, session_id: str) -> int:
        _require(UUID.fullmatch(session_id or "") is not None, "casting session identity is invalid")
        with self._lock:
            keys = [key for key, value in self._admissions.items() if value.session_id == session_id]
            for key in keys:
                del self._admissions[key]
            for participant, (owned_session, _) in list(self._connections.items()):
                if owned_session == session_id:
                    del self._connections[participant]
                    self._connection_browsers.pop(participant, None)
        return len(keys)

    @staticmethod
    def _browser_digest(browser_instance_id):
        if browser_instance_id is None:
            return None
        _require(isinstance(browser_instance_id, str) and BROWSER_INSTANCE.fullmatch(browser_instance_id) is not None,
                 "viewer browser context is invalid")
        return hashlib.sha256(browser_instance_id.encode("utf-8")).hexdigest()

    def connected_participants(self, *, session_id: str, viewer_identity_id: str,
                               browser_instance_id: str | None = None) -> tuple[str, ...]:
        """Internal removal targets, never a public health/API projection."""
        _require(isinstance(session_id, str) and UUID.fullmatch(session_id) is not None
                 and isinstance(viewer_identity_id, str) and UUID.fullmatch(viewer_identity_id) is not None,
                 "viewer connection context is invalid")
        browser_digest = self._browser_digest(browser_instance_id)
        with self._lock:
            return tuple(participant for participant, owner in self._connections.items()
                         if owner == (session_id, viewer_identity_id)
                         and (browser_digest is None or self._connection_browsers.get(participant) == browser_digest))

    def confirm_disconnected(self, *, session_id: str, participant_identity: str) -> None:
        """Call only after closing ingress and confirming exact SFU removal."""
        _require(isinstance(session_id, str) and UUID.fullmatch(session_id) is not None
                 and isinstance(participant_identity, str) and re.fullmatch(r"cast-[a-f0-9]{32}", participant_identity),
                 "viewer connection context is invalid")
        with self._lock:
            owner = self._connections.get(participant_identity)
            _require(owner is None or owner[0] == session_id, "viewer connection context is invalid")
            self._connections.pop(participant_identity, None)
            self._connection_browsers.pop(participant_identity, None)
            for admission in self._admissions.values():
                if admission.session_id == session_id and admission.participant_identity == participant_identity:
                    admission.revoked = True

    def status(self) -> dict[str, object]:
        """Return only aggregate, non-secret ephemeral state."""

        with self._lock:
            now = int(self._clock())
            self._purge(now)
            active = [item for item in self._admissions.values() if not item.revoked and item.expires_at > now]
            return {
                "activeAdmissionCount": len(active),
                "consumedAdmissionCount": sum(1 for item in active if item.consumed),
                "maximumViewersPerSession": self._maximum_viewers,
                "tokenTtlSeconds": self._ttl_seconds,
                "persistentState": False,
            }

    def _purge(self, now: int) -> None:
        expired = [key for key, value in self._admissions.items() if value.expires_at <= now]
        for key in expired:
            del self._admissions[key]

    def close(self) -> None:
        """Owner first stops the room; this only destroys local authority."""
        with self._lock:
            self._closed = True
            self._admissions.clear()
            self._connections.clear()
            self._connection_browsers.clear()
            self._api_secret[:] = b"\0" * len(self._api_secret)
