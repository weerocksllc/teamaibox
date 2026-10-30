"""Anonymous native-receiver IPC to the authenticated Platform callback.

This component is not a receiver supervisor or media-readiness claim. Its sole
input is a proven sender public key from our exact child process; its sole
positive output is sent after Platform accepts pairing. No public IPC listener,
device label, key file, log parser or guessed 'paired' event is used.
"""
from __future__ import annotations

import hmac
import re
import socket
from threading import RLock
import time
from uuid import uuid4

from .runtime_api import UUID


class PairingBridgeError(RuntimeError):
    CODES = frozenset(("pairing_closed", "pairing_eof", "pairing_protocol", "pairing_peer_changed",
                       "pairing_callback", "pairing_deadline", "pairing_ack_write", "pairing_io"))

    def __init__(self, code="pairing_io"):
        self.failure_code = code if code in self.CODES else "pairing_io"
        super().__init__("cast_native_pairing_rejected")


class NativePairingBridge:
    def __init__(self, *, channel: socket.socket, callback_client,
                 session_id: str, pin: str):
        if (not isinstance(channel, socket.socket) or channel.family != socket.AF_UNIX
                or channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
                or channel.getsockname() not in ("", b"") or channel.getpeername() not in ("", b"")
                or not callable(getattr(callback_client, "pair_source", None))
                or not isinstance(session_id, str) or not UUID.fullmatch(session_id)
                or not isinstance(pin, str) or not re.fullmatch(r"[1-9][0-9]{3}", pin)):
            raise ValueError("cast_native_pairing_configuration_invalid")
        self._channel = channel
        self._callback = callback_client
        self._session = session_id.lower()
        self._pin = bytearray(pin.encode("ascii"))
        self._peer_key: bytearray | None = None
        self._source_id: str | None = None
        self._closed = False
        self._lock = RLock()

    def serve_one(self) -> None:
        """Handle one serialized native proof; failure closes and wipes the IPC."""
        with self._lock:
            if self._closed:
                raise PairingBridgeError("pairing_closed")
            request = bytearray()
            key = bytearray()
            try:
                deadline = time.monotonic() + 7
                while len(request) < 36:
                    self._channel.settimeout(max(0.001, deadline - time.monotonic()))
                    chunk = self._channel.recv(36 - len(request))
                    if not chunk:
                        raise PairingBridgeError("pairing_eof")
                    if time.monotonic() >= deadline:
                        raise PairingBridgeError("pairing_deadline")
                    request.extend(chunk)
                if request[:4] != b"TAP1":
                    raise PairingBridgeError("pairing_protocol")
                key = request[4:]
                if self._peer_key is not None and not hmac.compare_digest(self._peer_key, key):
                    raise PairingBridgeError("pairing_peer_changed")
                source_id = self._source_id or str(uuid4())
                # The concrete callback client enforces pinned TLS 1.3 and a
                # five-second whole-request deadline. Never ACK an exception.
                try:
                    result = self._callback.pair_source(session_id=self._session,
                        source_connection_id=source_id, pin=self._pin.decode("ascii"))
                except Exception:
                    raise PairingBridgeError("pairing_callback") from None
                if (self._closed or not isinstance(result, dict) or result.get("paired") is not True
                        or result.get("blocked") is not False or time.monotonic() >= deadline):
                    raise PairingBridgeError("pairing_closed" if self._closed else
                        "pairing_deadline" if time.monotonic() >= deadline else "pairing_callback")
                if self._peer_key is None:
                    self._peer_key = bytearray(key)
                self._source_id = source_id
                self._channel.settimeout(max(0.001, deadline - time.monotonic()))
                try:
                    self._channel.sendall(b"ACK1")
                except OSError:
                    raise PairingBridgeError("pairing_ack_write") from None
            except Exception as error:
                self.close()
                raise PairingBridgeError(error.failure_code if isinstance(error, PairingBridgeError) else
                    "pairing_deadline" if isinstance(error, TimeoutError) else "pairing_io") from None
            finally:
                request[:] = b"\0" * len(request)
                key[:] = b"\0" * len(key)

    def close(self) -> None:
        # Revoke the child channel immediately, even while a callback owns the
        # serialization lock. It must not receive a late ACK after stop/revoke.
        self._closed = True
        try:
            self._channel.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._channel.close()
        with self._lock:
            self._pin[:] = b"\0" * len(self._pin)
            if self._peer_key is not None:
                self._peer_key[:] = b"\0" * len(self._peer_key)
            self._source_id = None

    def authorized_source_id(self) -> str | None:
        """Internal callback binding only, never an API/evidence field.

        A receiver PID or a decoded buffer does not establish pairing. The
        supervisor can report first media only using the UUID acknowledged by
        Platform after the native cryptographic proof. Close clears it.
        """
        with self._lock:
            return None if self._closed else self._source_id
