"""Private, RAM-only LiveKit publisher credential for one admitted cast.

Never return this credential from the Web/runtime API or put it in argv,
environment, URLs or logs. The admitted output adapter sets auth-token on its
GStreamer signaller object. TTL limits new joins, NOT an existing connection;
the supervisor must separately stop the publisher and delete its room on stop.
This component alone proves neither SFU delivery nor revocation.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import hmac
import json
import secrets
from threading import RLock
import time

from .viewer_token_issuer import API_KEY, UUID, _b64, _validated_endpoint


@dataclass(frozen=True)
class PublisherCredential:
    endpoint: str
    room: str
    identity: str
    expires_at: int
    access_token: str = field(repr=False)


class PublisherCredentialIssuer:
    def __init__(self, *, api_key: str, api_secret: str, endpoint: str, clock=time.time):
        if (not isinstance(api_key, str) or not API_KEY.fullmatch(api_key)
                or not isinstance(api_secret, str) or not 32 <= len(api_secret.encode()) <= 256
                or not callable(clock)):
            raise ValueError("cast_publisher_configuration_invalid")
        self._endpoint = _validated_endpoint(endpoint)
        self._api_key, self._secret, self._clock = api_key, bytearray(api_secret.encode()), clock
        self._closed = False
        self._lock = RLock()

    def issue(self, *, session_id: str, session_expires_at: int) -> PublisherCredential:
        with self._lock:
            return self._issue_locked(session_id=session_id, session_expires_at=session_expires_at)

    def _issue_locked(self, *, session_id: str, session_expires_at: int) -> PublisherCredential:
        now = int(self._clock())
        if (self._closed or not isinstance(session_id, str) or not UUID.fullmatch(session_id)
                or type(session_expires_at) is not int or not now + 5 <= session_expires_at <= now + 14400):
            raise ValueError("cast_publisher_admission_invalid")
        session_id = session_id.lower()
        room = "cast-" + session_id.replace("-", "")
        identity = "cast-source-" + hashlib.sha256(session_id.encode("ascii")).hexdigest()[:32]
        expiry = min(now + 30, session_expires_at)
        # Exact pinned gst-plugins-rs LiveKit signaller labels raw tracks as
        # Camera/Microphone. These names do not grant device access: this
        # process consumes only the paired receiver's private GDP pipes.
        claims = {"iss": self._api_key, "sub": identity, "nbf": now, "exp": expiry,
                  "jti": secrets.token_urlsafe(24), "video": {
                      "room": room, "roomJoin": True, "canPublish": True,
                      "canPublishSources": ["camera", "microphone"],
                      "canSubscribe": False, "canPublishData": False,
                      "canUpdateOwnMetadata": False, "hidden": False, "recorder": False}}
        encode = lambda value: _b64(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
        unsigned = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode(claims)
        signature = _b64(hmac.new(self._secret, unsigned.encode("ascii"), hashlib.sha256).digest())
        return PublisherCredential(self._endpoint, room, identity, expiry, unsigned + "." + signature)

    def close(self):
        with self._lock:
            self._closed = True
            self._secret[:] = b"\0" * len(self._secret)
