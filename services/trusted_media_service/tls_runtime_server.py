"""Bounded, private TLS 1.3/mTLS socket boundary for the media control API.

This listener does not start/advertise a receiver, obtain host privileges or
terminate browser media. Its only client is the exact Platform certificate
identity. The supplied supervisor retains responsibility for receiver lifetime.
"""

from __future__ import annotations

from http import HTTPStatus
import ipaddress
import json
from pathlib import Path
import re
import socketserver
import ssl
import threading
import time

from .runtime_api import PLATFORM_PEER, RuntimeApiError, TrustedMediaRuntimeApi


MAX_HEADERS = 16 * 1024
MAX_BODY = 64 * 1024
MAX_CONNECTIONS = 8
HEADER = re.compile(rb"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"))


def server_context(*, certificate: Path, private_key: Path, client_ca: Path) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.maximum_version = ssl.TLSVersion.TLSv1_3
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_cert_chain(str(certificate), str(private_key))
    context.load_verify_locations(cafile=str(client_ca))
    context.num_tickets = 0
    return context


def decode_request(reader):
    line = reader.readline(MAX_HEADERS + 1)
    fields = line.rstrip(b"\r\n").split(b" ")
    if (len(line) > MAX_HEADERS or not line.endswith(b"\r\n") or len(fields) != 3
            or fields[0] not in (b"GET", b"POST", b"PATCH", b"DELETE")
            or fields[2] != b"HTTP/1.1"
            or not re.fullmatch(rb"/internal/v1/runtime/(?:sessions(?:/[A-Za-z0-9/-]+)?|readiness)", fields[1])):
        raise RuntimeApiError("cast_runtime_request_invalid", 400)
    headers = {}
    size = len(line)
    while True:
        line = reader.readline(MAX_HEADERS + 1)
        size += len(line)
        if size > MAX_HEADERS or not line.endswith(b"\r\n"):
            raise RuntimeApiError("cast_runtime_headers_invalid", 431)
        if line == b"\r\n":
            break
        key, separator, value = line[:-2].partition(b":")
        key = key.lower()
        if (not separator or not HEADER.fullmatch(key) or key in headers
                or any(c < 32 and c != 9 or c == 127 for c in value)):
            raise RuntimeApiError("cast_runtime_headers_invalid", 400)
        headers[key] = value.strip()
    if b"transfer-encoding" in headers or b"expect" in headers or b"host" not in headers:
        raise RuntimeApiError("cast_runtime_headers_invalid", 400)
    length = headers.get(b"content-length", b"0")
    if not re.fullmatch(rb"0|[1-9][0-9]{0,5}", length) or int(length) > MAX_BODY:
        raise RuntimeApiError("cast_runtime_body_too_large", 413)
    count = int(length)
    if fields[0] == b"GET" and count != 0:
        raise RuntimeApiError("cast_runtime_request_invalid", 400)
    body = None
    if count:
        if headers.get(b"content-type", b"").lower() != b"application/json":
            raise RuntimeApiError("cast_runtime_content_type_invalid", 415)
        raw = reader.read(count)
        if len(raw) != count:
            raise RuntimeApiError("cast_runtime_request_invalid", 400)
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError):
            raise RuntimeApiError("cast_runtime_request_invalid", 400) from None
    try:
        return dict(method=fields[0].decode("ascii"), path=fields[1].decode("ascii"), body=body,
                    request_id=headers.get(b"x-teamaibox-request-id", b"").decode("ascii"),
                    issued_at=headers.get(b"x-teamaibox-request-issued-at", b"").decode("ascii"))
    except UnicodeError:
        raise RuntimeApiError("cast_runtime_headers_invalid", 400) from None


class _DeadlineReader:
    """One total request deadline; slowly dripping bytes cannot renew it."""
    def __init__(self, channel, deadline):
        self.channel, self.deadline, self.buffer = channel, deadline, bytearray()

    def _receive(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("cast_runtime_request_timeout")
        self.channel.settimeout(remaining)
        chunk = self.channel.recv(4096)
        if not chunk:
            return False
        self.buffer.extend(chunk)
        return True

    def readline(self, limit):
        while b"\n" not in self.buffer and len(self.buffer) < limit:
            if not self._receive(): break
        end = self.buffer.find(b"\n") + 1
        end = min(end if end else len(self.buffer), limit)
        result = bytes(self.buffer[:end])
        del self.buffer[:end]
        return result

    def read(self, count):
        while len(self.buffer) < count:
            if not self._receive(): break
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        deadline = time.monotonic() + 5
        self.request.settimeout(5)
        try:
            with self.server.tls_context.wrap_socket(self.request, server_side=True) as channel:
                try:
                    certificate = channel.getpeercert()
                    uris = [value for kind, value in certificate.get("subjectAltName", ()) if kind == "URI"]
                    if uris != [PLATFORM_PEER] or channel.version() != "TLSv1.3":
                        raise RuntimeApiError("cast_runtime_peer_unauthorized", 403)
                    request = decode_request(_DeadlineReader(channel, deadline))
                    status, body = self.server.api.handle(peer_uri_san=PLATFORM_PEER, **request)
                except RuntimeApiError as error:
                    status, body = error.status, {"error": {"code": error.code}}
                except Exception:
                    status, body = 503, {"error": {"code": "cast_runtime_unavailable"}}
                raw = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
                if len(raw) > MAX_BODY:
                    status, raw = 503, b'{"error":{"code":"cast_runtime_response_invalid"}}'
                channel.sendall((f"HTTP/1.1 {status} {HTTPStatus(status).phrase}\r\n"
                                 f"Content-Length: {len(raw)}\r\n"
                                 "Content-Type: application/json\r\nCache-Control: no-store\r\n"
                                 "X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n").encode() + raw)
        except (OSError, ssl.SSLError):
            pass  # Never log certificates, request paths, PINs or viewer tokens.


class TrustedMediaTlsServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    # Permit the same owned listener to restart across TCP TIME_WAIT, without
    # allowing two live listeners to share a port (SO_REUSEPORT stays off).
    allow_reuse_address = True
    allow_reuse_port = False
    request_queue_size = MAX_CONNECTIONS

    def __init__(self, address, *, api: TrustedMediaRuntimeApi, tls_context: ssl.SSLContext):
        host, port = address
        ip = ipaddress.ip_address(host)
        if (not any(ip in network for network in PRIVATE_NETWORKS) or ip.is_unspecified
                or not isinstance(port, int) or isinstance(port, bool) or not 0 <= port <= 65535
                or not isinstance(api, TrustedMediaRuntimeApi)
                or tls_context.verify_mode != ssl.CERT_REQUIRED
                or tls_context.minimum_version != ssl.TLSVersion.TLSv1_3
                or tls_context.maximum_version != ssl.TLSVersion.TLSv1_3):
            raise ValueError("trusted media listener security configuration is invalid")
        self.api, self.tls_context = api, tls_context
        self._capacity = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self._expiry_worker = None
        self._next_expiry_sweep = 0.0
        super().__init__((host, port), _Handler)

    def process_request(self, request, client_address):
        if not self._capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._capacity.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._capacity.release()

    def handle_error(self, request, client_address):
        pass  # Socket errors must not produce raw tracebacks or request data.

    def service_actions(self):
        # Never run media teardown on the socket accept loop. At most one
        # cleanup worker exists, even if a kernel/device operation never returns.
        if self._expiry_worker is not None and self._expiry_worker.is_alive():
            return
        if time.monotonic() < self._next_expiry_sweep:
            return
        self._next_expiry_sweep = time.monotonic() + 0.2
        def expire():
            try:
                self.api.expire_session()
            except RuntimeApiError:
                pass  # Retain ownership; a subsequent sweep may retry.
        self._expiry_worker = threading.Thread(target=expire, name="cast-expiry", daemon=True)
        self._expiry_worker.start()
