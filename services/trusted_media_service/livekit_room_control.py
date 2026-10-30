"""Private, exact-session LiveKit room lifecycle; never a media-view grant.

Uses the documented Twirp API through a pinned TLS 1.3 control endpoint.
Only one owned cast room is addressable. API keys/JWTs stay in RAM and are
never returned, logged or placed in URLs. Removing a participant is NOT token
revocation on self-hosted LiveKit: the separate single-use ingress must still
reject that participant's old or copied admission before any reconnect.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import secrets
import socket
from threading import RLock
import time

from .callback_client import TrustedMediaCallbackClient, _response
from .tls_runtime_server import _DeadlineReader
from .viewer_token_issuer import API_KEY, UUID, _b64


class RoomControlError(RuntimeError):
    def __init__(self):
        super().__init__("cast_sfu_control_unavailable")


class LiveKitRoomControl:
    def __init__(self, *, api_key: str, api_secret: str, address: str, port: int,
                 server_name: str, certificate_fingerprint: str, tls_context, clock=time.time):
        # Reuse the identical private-address/hostname/TLS/pin configuration
        # checks; callbacks themselves are not used for the room-service API.
        checked = TrustedMediaCallbackClient(address=address, port=port, server_name=server_name,
            certificate_fingerprint=certificate_fingerprint, tls_context=tls_context)
        if (not isinstance(api_key, str) or not API_KEY.fullmatch(api_key)
                or not isinstance(api_secret, str) or not 32 <= len(api_secret.encode()) <= 256
                or not callable(clock)):
            raise ValueError("cast_sfu_control_configuration_invalid")
        self._address, self._port, self._name = checked._address, port, server_name
        self._pin, self._tls = certificate_fingerprint, tls_context
        self._api_key, self._secret = api_key, bytearray(api_secret.encode())
        self._clock, self._lock = clock, RLock()
        self._session = self._room = None
        self._closed = False

    def _post(self, method: str, payload: dict, permission: str) -> dict:
        # All call sites are fixed below; no externally supplied API operation,
        # room name, recording request, metadata or arbitrary resource path.
        now = int(self._clock())
        encode = lambda value: _b64(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
        claims = {"iss": self._api_key, "nbf": now, "exp": now + 15,
                  "jti": secrets.token_urlsafe(24), "video": {permission: True, "room": self._room}}
        unsigned = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode(claims)
        token = unsigned + "." + _b64(hmac.new(self._secret, unsigned.encode(), hashlib.sha256).digest())
        body = json.dumps(payload, separators=(",", ":")).encode()
        request = bytearray((f"POST /twirp/livekit.RoomService/{method} HTTP/1.1\r\n"
            f"Host: {self._name}:{self._port}\r\nAuthorization: Bearer {token}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
            "Accept: application/json\r\nConnection: close\r\n\r\n").encode())
        request.extend(body)
        deadline = time.monotonic() + 5
        try:
            with socket.create_connection((self._address, self._port), timeout=5) as plain:
                plain.settimeout(max(0.001, deadline - time.monotonic()))
                with self._tls.wrap_socket(plain, server_hostname=self._name) as channel:
                    pin = "sha256:" + hashlib.sha256(channel.getpeercert(binary_form=True)).hexdigest()
                    if pin != self._pin or channel.version() != "TLSv1.3" or time.monotonic() >= deadline:
                        raise RoomControlError()
                    channel.settimeout(max(0.001, deadline - time.monotonic()))
                    channel.sendall(request)
                    return _response(_DeadlineReader(channel, deadline))
        except Exception:
            raise RoomControlError() from None
        finally:
            request[:] = b"\0" * len(request)

    def _owned(self, session_id):
        if (self._closed or not isinstance(session_id, str) or not UUID.fullmatch(session_id)
                or self._session != session_id.lower()):
            raise RoomControlError()

    def create(self, *, session_id: str, expires_at: float):
        with self._lock:
            if (self._closed or self._session is not None or not isinstance(session_id, str)
                    or not UUID.fullmatch(session_id) or type(expires_at) not in (float, int)
                    or not math.isfinite(expires_at) or not 0 < expires_at - self._clock() <= 14400):
                raise RoomControlError()

            # A viewer can leave while the Apple sender is not paired yet.
            # Keep that empty room for the remaining authorized session, not
            # for just one second. Stop/expiry still explicitly DeleteRoom;
            # this finite SFU timeout is only the orphan cleanup backstop.
            remaining = max(1, math.ceil(expires_at - self._clock()))

            # Retain ownership even if the response is lost. No second room
            # may be started until this exact uncertain room is cleaned up.
            self._session = session_id.lower()
            self._room = "cast-" + self._session.replace("-", "")
            value = self._post("CreateRoom", {"name": self._room, "empty_timeout": remaining,
                "departure_timeout": remaining, "max_participants": 0}, "roomCreate")
            if (value.get("name") != self._room
                    or value.get("maxParticipants", value.get("max_participants", 0)) != 0
                    or value.get("activeRecording", value.get("active_recording", False)) is not False
                    or value.get("metadata", "") != ""):
                raise RoomControlError()

    def probe(self):
        """Read one fixed, non-session room name. Never enumerate other rooms."""
        with self._lock:
            if self._closed:
                raise RoomControlError()
            value = self._post("ListRooms", {"names": ["teamaibox-readiness-probe"]}, "roomList")
            if set(value) - {"rooms"} or value.get("rooms", []) != []:
                raise RoomControlError()
            return True

    def remove_viewer(self, *, session_id: str, participant_identity: str):
        with self._lock:
            self._owned(session_id)
            if not isinstance(participant_identity, str) or not re.fullmatch(r"cast-[0-9a-f]{32}", participant_identity):
                raise RoomControlError()
            try:
                self._post("RemoveParticipant", {"room": self._room, "identity": participant_identity}, "roomAdmin")
            except RoomControlError:
                pass  # Lost response/already gone still requires read-back.
            value = self._post("ListParticipants", {"room": self._room}, "roomAdmin")
            participants = value.get("participants", [])
            if (set(value) - {"participants"} or not isinstance(participants, list) or len(participants) > 9
                    or any(not isinstance(item, dict) or not isinstance(item.get("identity"), str)
                           or item["identity"] == participant_identity for item in participants)):
                raise RoomControlError()

    def delete(self, *, session_id: str):
        with self._lock:
            self._owned(session_id)
            try:
                self._post("DeleteRoom", {"room": self._room}, "roomCreate")
            except RoomControlError:
                pass  # A timeout is not cleanup success without read-back.
            value = self._post("ListRooms", {"names": [self._room]}, "roomList")
            if set(value) - {"rooms"} or value.get("rooms", []) != []:
                raise RoomControlError()
            self._session = self._room = None

    def close(self):
        with self._lock:
            if self._session is not None:
                raise RoomControlError()  # Caller must first prove cleanup.
            self._closed = True
            self._secret[:] = b"\0" * len(self._secret)
