#!/usr/bin/env python3
"""Minimal content-safe TLS 1.3/mTLS gateway for an internal ASR worker."""

from __future__ import annotations

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
from typing import Any

import httpx


UPSTREAM = os.environ.get("ASR_UPSTREAM", "http://worker:8080")
LISTEN_HOST = os.environ.get("ASR_GATEWAY_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("ASR_GATEWAY_PORT", "9443"))
CERT_FILE = Path(os.environ.get("ASR_GATEWAY_CERT_FILE", "/validation/server.crt"))
KEY_FILE = Path(os.environ.get("ASR_GATEWAY_KEY_FILE", "/validation/server.key"))
CLIENT_CA_FILE = Path(os.environ.get("ASR_GATEWAY_CLIENT_CA_FILE", "/validation/ca.crt"))
MAXIMUM_REQUEST_BYTES = 270 * 1024 * 1024
MAXIMUM_RESPONSE_BYTES = 32 * 1024 * 1024

if UPSTREAM != "http://worker:8080" or LISTEN_HOST != "0.0.0.0" or LISTEN_PORT != 9443:
    raise RuntimeError("ASR gateway endpoint declaration is not allowlisted")
if not all(path.is_file() and 100 <= path.stat().st_size <= 16 * 1024 for path in (CERT_FILE, KEY_FILE, CLIENT_CA_FILE)):
    raise RuntimeError("ASR gateway TLS material is missing or invalid")


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "TeamAIBoxASR"
    sys_version = ""

    def log_message(self, _format: str, *args: Any) -> None:
        return

    def _json(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.send_header("x-content-type-options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _peer(self) -> tuple[str, str] | None:
        certificate = self.connection.getpeercert(binary_form=True)  # type: ignore[attr-defined]
        if not certificate:
            return None
        return self.connection.version(), "sha256:" + hashlib.sha256(certificate).hexdigest()  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health/ready":
            self._json(404, {"error": "not_found"})
            return
        peer = self._peer()
        if peer is None or peer[0] != "TLSv1.3":
            self._json(401, {"error": "client_certificate_required"})
            return
        try:
            with httpx.Client(trust_env=False, timeout=2) as client:
                response = client.get(UPSTREAM + "/health/ready")
                upstream = response.json()
        except (httpx.HTTPError, ValueError):
            self._json(503, {"status": "loading"})
            return
        ready = response.status_code == 200 and upstream == {
            "status": "ready", "model": "whisper-large-v3-fp16", "device": "cuda", "precision": "fp16",
        }
        self._json(200 if ready else 503, {
            "status": "ready" if ready else "loading",
            "model": "whisper-large-v3-fp16",
            "tlsVersion": peer[0],
            "clientCertificatePresented": True,
            "clientCertificateDigest": peer[1],
        })

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/audio/transcriptions":
            self._json(404, {"error": "not_found"})
            return
        peer = self._peer()
        content_type = self.headers.get("content-type", "")
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            length = -1
        if peer is None or peer[0] != "TLSv1.3":
            self._json(401, {"error": "client_certificate_required"})
            return
        if not content_type.startswith("multipart/form-data;") or not 1 <= length <= MAXIMUM_REQUEST_BYTES:
            self._json(400, {"error": "invalid_request_shape"})
            return
        body = self.rfile.read(length)
        if len(body) != length:
            self._json(400, {"error": "incomplete_request"})
            return
        try:
            with httpx.Client(trust_env=False, timeout=620) as client:
                response = client.post(
                    UPSTREAM + "/v1/audio/transcriptions",
                    content=body,
                    headers={"content-type": content_type, "content-length": str(length)},
                )
            output = response.content
        except httpx.HTTPError:
            self._json(502, {"error": "upstream_unavailable"})
            return
        if len(output) > MAXIMUM_RESPONSE_BYTES:
            self._json(502, {"error": "upstream_response_too_large"})
            return
        response_type = response.headers.get("content-type", "application/json").split(";", 1)[0]
        if response_type not in {"application/json", "text/plain", "text/vtt"}:
            self._json(502, {"error": "upstream_content_type_invalid"})
            return
        self.send_response(response.status_code)
        self.send_header("content-type", response_type)
        self.send_header("content-length", str(len(output)))
        self.send_header("cache-control", "no-store")
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("x-teamaibox-tls-version", peer[0])
        self.end_headers()
        self.wfile.write(output)


def main() -> None:
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), GatewayHandler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.maximum_version = ssl.TLSVersion.TLSv1_3
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_verify_locations(cafile=str(CLIENT_CA_FILE))
    context.load_cert_chain(certfile=str(CERT_FILE), keyfile=str(KEY_FILE))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
