"""Private, pinned TLS 1.3 callbacks. No public/proxy or redirect fallback.

The receiver supervisor may report pairing only after native authentication,
and streaming only after a real media event. This transport does not manufacture
either event. Request bodies and peer errors are never logged or persisted.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import socket
import ssl
import time
from uuid import uuid4

from .runtime_api import BROWSER_INSTANCE, UUID
from .tls_runtime_server import PRIVATE_NETWORKS, _DeadlineReader


class CallbackError(RuntimeError):
    def __init__(self):
        super().__init__("cast_callback_unavailable")


def callback_context(*, certificate: Path, private_key: Path, server_ca: Path) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=str(server_ca))
    context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(str(certificate), str(private_key))
    return context


def _uuid(value: str) -> str:
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("cast_callback_identity_invalid")
    return value.lower()


def _response(reader: _DeadlineReader) -> dict:
    # A small, single JSON response with unambiguous framing is sufficient for
    # all three fixed callbacks. Reject redirects, chunking, duplicate headers,
    # compression and oversized/truncated bodies rather than guessing.
    line = reader.readline(256)
    if not re.fullmatch(rb"HTTP/1\.[01] 200 [^\r\n]{1,80}\r\n", line):
        raise CallbackError()
    size = len(line)
    headers = {}
    for _ in range(48):
        line = reader.readline(4096)
        size += len(line)
        if size > 16384 or not line.endswith(b"\r\n"):
            raise CallbackError()
        if line == b"\r\n":
            break
        key, separator, value = line[:-2].partition(b":")
        key = key.lower()
        if not separator or not re.fullmatch(rb"[a-z0-9-]+", key) or key in headers:
            raise CallbackError()
        headers[key] = value.strip()
    else:
        raise CallbackError()
    length = headers.get(b"content-length", b"")
    if (not re.fullmatch(rb"[0-9]{1,5}", length) or not 2 <= int(length) <= 65536
            or b"transfer-encoding" in headers or b"content-encoding" in headers
            or headers.get(b"content-type", b"").split(b";", 1)[0] != b"application/json"):
        raise CallbackError()
    raw = reader.read(int(length))
    if len(raw) != int(length):
        raise CallbackError()
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise CallbackError()
    return result


class TrustedMediaCallbackClient:
    """Only fixed callback paths at an explicitly configured private address."""
    def __init__(self, *, address: str, port: int, server_name: str,
                 certificate_fingerprint: str, tls_context: ssl.SSLContext):
        ip = ipaddress.ip_address(address)
        if (not any(ip in network for network in PRIVATE_NETWORKS) or ip.is_unspecified
                or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535
                or not isinstance(server_name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", server_name)
                or not isinstance(certificate_fingerprint, str)
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", certificate_fingerprint)
                or not isinstance(tls_context, ssl.SSLContext) or not tls_context.check_hostname
                or tls_context.verify_mode != ssl.CERT_REQUIRED
                or tls_context.minimum_version != ssl.TLSVersion.TLSv1_3
                or tls_context.maximum_version != ssl.TLSVersion.TLSv1_3):
            raise ValueError("cast_callback_configuration_invalid")
        self._address, self._port, self._name = str(ip), port, server_name
        self._fingerprint, self._context = certificate_fingerprint, tls_context

    def _post(self, session_id: str, suffix: str, body: dict) -> dict:
        path = "/internal/v1/casting/sessions/" + _uuid(session_id) + suffix
        issued = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        raw = bytearray(json.dumps(body, separators=(",", ":")).encode())
        if len(raw) > 65536:
            raise ValueError("cast_callback_request_invalid")
        request = bytearray((f"POST {path} HTTP/1.1\r\nHost: {self._name}:{self._port}\r\n"
                            f"Content-Length: {len(raw)}\r\nContent-Type: application/json\r\n"
                            f"X-TeamAIBox-Callback-Id: {uuid4()}\r\nX-TeamAIBox-Callback-Issued-At: {issued}\r\n"
                            "Accept: application/json\r\nConnection: close\r\n\r\n").encode())
        request.extend(raw)
        deadline = time.monotonic() + 5
        try:
            # Numeric private address avoids an unbounded/DNS-rebinding hop;
            # certificate hostname validation still uses the configured name.
            with socket.create_connection((self._address, self._port), timeout=5) as plain:
                plain.settimeout(max(0.001, deadline - time.monotonic()))
                with self._context.wrap_socket(plain, server_hostname=self._name) as channel:
                    actual = "sha256:" + hashlib.sha256(channel.getpeercert(binary_form=True)).hexdigest()
                    if actual != self._fingerprint or channel.version() != "TLSv1.3":
                        raise CallbackError()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CallbackError()
                    channel.settimeout(remaining)
                    # PINs/credentials are not sent until PKI, hostname and
                    # the exact leaf pin have all been verified.
                    channel.sendall(request)
                    return _response(_DeadlineReader(channel, deadline))
        except Exception:
            raise CallbackError() from None
        finally:
            raw[:] = b"\0" * len(raw)
            request[:] = b"\0" * len(request)

    def pair_source(self, *, session_id: str, source_connection_id: str, pin: str) -> dict:
        connection = _uuid(source_connection_id)
        if not isinstance(pin, str) or not re.fullmatch(r"[1-9][0-9]{3}", pin):
            raise ValueError("cast_callback_pin_invalid")
        value = self._post(session_id, "/source/pair", {"pin": pin, "source_connection_id": connection})
        if (set(value) != {"paired", "repeated", "blocked", "state", "failed_attempts", "blocked_until"}
                or any(type(value[key]) is not bool for key in ("paired", "repeated", "blocked"))
                or value["paired"] is not True or value["blocked"] is not False):
            raise CallbackError()
        return value

    def mark_streaming(self, *, session_id: str, source_connection_id: str) -> dict:
        value = self._post(session_id, "/source/streaming", {"source_connection_id": _uuid(source_connection_id)})
        if (set(value) != {"session_id", "state", "state_revision"}
                or value["session_id"] != _uuid(session_id) or value["state"] != "streaming"
                or type(value["state_revision"]) is not int or value["state_revision"] < 1):
            raise CallbackError()
        return value

    def authorize_viewer(self, *, session_id: str, viewer_identity_id: str,
                         browser_instance_id: str, media_credential: str) -> dict:
        if (not isinstance(browser_instance_id, str) or not BROWSER_INSTANCE.fullmatch(browser_instance_id)
                or not isinstance(media_credential, str) or not 16 <= len(media_credential) <= 16384):
            raise ValueError("cast_callback_viewer_invalid")
        value = self._post(session_id, "/viewers/authorize", {
            "viewer_identity_id": _uuid(viewer_identity_id), "browser_instance_id": browser_instance_id,
            "media_credential": media_credential})
        if (set(value) != {"authorized", "session_id", "viewer_identity_id", "grant_id", "audience_revision",
                           "expires_at", "muted", "maximum_viewers", "publisher_encode_renditions"}
                or value["authorized"] is not True or value["session_id"] != _uuid(session_id)
                or value["viewer_identity_id"] != _uuid(viewer_identity_id)
                or not isinstance(value["grant_id"], str) or not UUID.fullmatch(value["grant_id"])
                or type(value["audience_revision"]) is not int or value["audience_revision"] < 1
                or type(value["muted"]) is not bool
                or value["maximum_viewers"] is not None and (type(value["maximum_viewers"]) is not int or value["maximum_viewers"] < 1)
                or value["publisher_encode_renditions"] != 1):
            raise CallbackError()
        try:
            expiry = datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00"))
            ttl = expiry.timestamp() - time.time()
            if expiry.tzinfo is None or not 0 < ttl <= 300:
                raise ValueError()
        except (TypeError, ValueError, AttributeError):
            raise CallbackError() from None
        return value
