#!/usr/bin/env python3
"""Bounded OpenAI-style OCR Provider adapter for the appliance-local HunyuanOCR worker."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import http.client
import json
import os
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


ADAPTER_VERSION = "1.0.0"
MODEL_NAME = "hunyuanocr-bf16-dflash"
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = ((MAX_INPUT_BYTES + 2) // 3) * 4 + 1024 * 1024
MAX_UPSTREAM_JSON_BYTES = 4 * 1024 * 1024
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


class ProviderError(Exception):
    def __init__(self, code: str, message: str, status: int, *, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


def _bounded_json(value: bytes, maximum: int) -> Any:
    if not value or len(value) > maximum:
        raise ProviderError("upstream_response_invalid", "The OCR dependency returned an invalid response", 502, retryable=True)
    try:
        return json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderError("upstream_response_invalid", "The OCR dependency returned invalid JSON", 502, retryable=True) from error


def _media(bytes_value: bytearray, file_type: int) -> tuple[str, str]:
    raw = bytes(bytes_value[:16])
    if file_type == 0 and raw.startswith(b"%PDF-"):
        return "application/pdf", "pdf"
    if file_type == 1:
        if raw.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png", "png"
        if raw.startswith(b"\xff\xd8\xff"):
            return "image/jpeg", "jpg"
        if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            return "image/webp", "webp"
    raise ProviderError("invalid_ocr_input", "OCR input media does not match fileType", 400)


@dataclass(frozen=True)
class Configuration:
    bind_host: str
    port: int
    certificate_file: str
    private_key_file: str
    ca_file: str
    token: bytes
    docfarm_url: str
    request_timeout_seconds: int
    poll_interval_seconds: float
    model_revision: str
    worker_image_digest: str


class DocFarmClient:
    def __init__(self, base_url: str, timeout_seconds: int, poll_interval_seconds: float):
        parsed = urllib.parse.urlsplit(base_url.rstrip("/"))
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.username or parsed.password:
            raise ValueError("DOCFARM_BASE_URL must be appliance-local loopback HTTP")
        self.host = parsed.hostname
        self.port = parsed.port or 80
        self.base_path = parsed.path.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds

    def _connection(self) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self.host, self.port, timeout=min(self.timeout_seconds, 30))

    def _request(self, method: str, path: str, body: bytes | None = None, *, content_type: str | None = None,
                 maximum_bytes: int = MAX_UPSTREAM_JSON_BYTES, allowed: tuple[int, ...] = (200,)) -> tuple[int, bytes]:
        connection = self._connection()
        try:
            headers = {"Accept": "application/json"}
            if body is not None:
                headers["Content-Type"] = content_type or "application/json"
                headers["Content-Length"] = str(len(body))
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read(maximum_bytes + 1)
            if len(payload) > maximum_bytes:
                raise ProviderError("upstream_response_too_large", "The OCR dependency response exceeded its limit", 502, retryable=True)
            if response.status not in allowed:
                raise ProviderError("upstream_request_failed", "The OCR dependency rejected the request", 503, retryable=True)
            return response.status, payload
        except (OSError, http.client.HTTPException) as error:
            raise ProviderError("upstream_unavailable", "The OCR dependency is unavailable", 503, retryable=True) from error
        finally:
            connection.close()

    def json_request(self, method: str, suffix: str, value: Any | None = None,
                     *, allowed: tuple[int, ...] = (200, 201), maximum_bytes: int = MAX_UPSTREAM_JSON_BYTES) -> Any:
        encoded = None if value is None else json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            _, payload = self._request(method, f"{self.base_path}{suffix}", encoded, maximum_bytes=maximum_bytes, allowed=allowed)
            return None if not payload else _bounded_json(payload, maximum_bytes)
        finally:
            if encoded is not None:
                mutable = bytearray(encoded)
                mutable[:] = b"\0" * len(mutable)

    def ready(self) -> bool:
        try:
            _, health = self._request("GET", "/docfarm/health", allowed=(200,))
            health_value = _bounded_json(health, MAX_UPSTREAM_JSON_BYTES)
            workers = self.json_request("GET", "/workers", allowed=(200,))
            return health_value.get("status") == "healthy" and isinstance(workers, list) and any(
                item.get("type") == "hunyuanocr" and item.get("status") == "online" for item in workers if isinstance(item, dict)
            )
        except ProviderError:
            return False

    def upload(self, content: bytearray, media_type: str, extension: str, job_id: str) -> str:
        boundary = f"teamaibox-{uuid.uuid4().hex}"
        filename = f"ocr-{job_id}.{extension}"
        prefix = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
                  f"Content-Type: {media_type}\r\n\r\n").encode("ascii")
        suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
        connection = self._connection()
        try:
            connection.putrequest("POST", f"{self.base_path}/files/upload")
            connection.putheader("Accept", "application/json")
            connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            connection.putheader("Content-Length", str(len(prefix) + len(content) + len(suffix)))
            connection.endheaders()
            connection.send(prefix)
            connection.send(content)
            connection.send(suffix)
            response = connection.getresponse()
            payload = response.read(MAX_UPSTREAM_JSON_BYTES + 1)
            if response.status != 201 or len(payload) > MAX_UPSTREAM_JSON_BYTES:
                raise ProviderError("upstream_upload_failed", "The OCR dependency rejected the protected input", 503, retryable=True)
            value = _bounded_json(payload, MAX_UPSTREAM_JSON_BYTES)
            file_id = value.get("id") if isinstance(value, dict) else None
            if not isinstance(file_id, str) or not UUID_RE.fullmatch(file_id):
                raise ProviderError("upstream_response_invalid", "The OCR dependency returned an invalid file identity", 502, retryable=True)
            return file_id
        except (OSError, http.client.HTTPException) as error:
            raise ProviderError("upstream_unavailable", "The OCR dependency is unavailable", 503, retryable=True) from error
        finally:
            connection.close()

    def create_task(self, input_file_id: str, job_id: str) -> str:
        value = self.json_request("POST", "/tasks", {
            "type": "hunyuanocr", "input_file_id": input_file_id,
            "metadata": {
                "source": "teamaibox-ocr-provider", "request_id": job_id, "model": MODEL_NAME,
                "output_format": "json", "prompt": "Recognize the document and preserve table structure.",
            },
        })
        task_id = value.get("id") if isinstance(value, dict) else None
        if not isinstance(task_id, str) or not UUID_RE.fullmatch(task_id):
            raise ProviderError("upstream_response_invalid", "The OCR dependency returned an invalid task identity", 502, retryable=True)
        return task_id

    def await_task(self, task_id: str, deadline: float) -> dict[str, Any]:
        while time.monotonic() < deadline:
            value = self.json_request("GET", f"/tasks/{task_id}", allowed=(200,))
            if not isinstance(value, dict) or value.get("id") != task_id:
                raise ProviderError("upstream_response_invalid", "The OCR dependency returned invalid task state", 502, retryable=True)
            status = value.get("status")
            if status == "completed":
                output_file_id = value.get("output_file_id")
                if not isinstance(output_file_id, str) or not UUID_RE.fullmatch(output_file_id):
                    raise ProviderError("upstream_response_invalid", "The OCR task has no valid output identity", 502, retryable=True)
                return value
            if status in {"failed", "cancelled"}:
                raise ProviderError("upstream_ocr_failed", "The OCR dependency did not complete the task", 502, retryable=status == "failed")
            if status not in {"pending", "processing", "cancel_requested"}:
                raise ProviderError("upstream_response_invalid", "The OCR dependency returned an unknown task state", 502, retryable=True)
            time.sleep(self.poll_interval_seconds)
        self.cancel_task(task_id)
        raise ProviderError("upstream_timeout", "The OCR task exceeded its bounded deadline", 504, retryable=True)

    def download_file(self, file_id: str) -> bytes:
        _, payload = self._request("GET", f"{self.base_path}/files/{file_id}", maximum_bytes=MAX_OUTPUT_BYTES, allowed=(200,))
        return payload

    def cancel_task(self, task_id: str) -> bool:
        try:
            self._request("POST", f"{self.base_path}/tasks/{task_id}/cancel?reason=Team%20AI%20Box%20cancellation",
                          allowed=(200,), maximum_bytes=MAX_UPSTREAM_JSON_BYTES)
            return True
        except ProviderError:
            return False

    def delete_file(self, file_id: str | None) -> bool:
        if not file_id:
            return True
        try:
            self._request("DELETE", f"{self.base_path}/files/{file_id}", allowed=(200, 202, 204, 404), maximum_bytes=MAX_UPSTREAM_JSON_BYTES)
            return True
        except ProviderError:
            return False

    def delete_task(self, task_id: str | None) -> bool:
        if not task_id:
            return True
        try:
            self._request("DELETE", f"{self.base_path}/tasks/{task_id}", allowed=(200, 202, 204, 404), maximum_bytes=MAX_UPSTREAM_JSON_BYTES)
            return True
        except ProviderError:
            return False


class ProviderApplication:
    def __init__(self, configuration: Configuration, docfarm: DocFarmClient):
        self.configuration = configuration
        self.docfarm = docfarm
        self._capacity = threading.BoundedSemaphore(1)
        self._active: dict[str, str] = {}
        self._active_lock = threading.Lock()

    def ready(self) -> bool:
        return self.docfarm.ready()

    def models(self) -> dict[str, Any]:
        return {"object": "list", "data": [{
            "id": MODEL_NAME, "object": "model", "owned_by": "teamaibox",
            "x_teamaibox": {"certification": "experimental", "geometry_supported": False,
                            "structured_tables": False, "latex_formulas": False},
        }]}

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._active_lock:
            task_id = self._active.get(job_id)
        requested = self.docfarm.cancel_task(task_id) if task_id else False
        return {"job_id": job_id, "cancellation_requested": requested, "active": task_id is not None}

    def recognize(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, dict) or set(request).difference({
            "model", "job_id", "file", "fileType", "useLayoutDetection", "formatBlockContent",
            "layoutShapeMode", "returnMarkdownImages", "visualize", "language_hints",
        }):
            raise ProviderError("invalid_ocr_request", "OCR request fields are invalid", 400)
        if request.get("model") != MODEL_NAME or request.get("fileType") not in {0, 1}:
            raise ProviderError("invalid_ocr_request", "OCR model or fileType is invalid", 400)
        if request.get("returnMarkdownImages") not in {False, None} or request.get("visualize") not in {False, None}:
            raise ProviderError("unsupported_ocr_option", "Embedded images and visualization are unsupported", 400)
        job_id = request.get("job_id") or str(uuid.uuid4())
        if not isinstance(job_id, str) or not UUID_RE.fullmatch(job_id):
            raise ProviderError("invalid_ocr_request", "OCR job identity is invalid", 400)
        encoded = request.get("file")
        if not isinstance(encoded, str) or len(encoded) < 4 or len(encoded) > ((MAX_INPUT_BYTES + 2) // 3) * 4 + 8:
            raise ProviderError("invalid_ocr_input", "OCR input is missing or too large", 400)
        try:
            content = bytearray(base64.b64decode(encoded, validate=True))
        except (ValueError, binascii.Error) as error:
            raise ProviderError("invalid_ocr_input", "OCR input base64 is invalid", 400) from error
        if not content or len(content) > MAX_INPUT_BYTES:
            content[:] = b"\0" * len(content)
            raise ProviderError("invalid_ocr_input", "OCR input is missing or too large", 400)
        media_type, extension = _media(content, request["fileType"])
        if not self._capacity.acquire(blocking=False):
            content[:] = b"\0" * len(content)
            raise ProviderError("ocr_capacity_exhausted", "The OCR adapter is busy", 429, retryable=True)
        input_file_id = None
        output_file_id = None
        task_id = None
        cleanup = {"input_deleted": False, "output_deleted": False, "task_deleted": False}
        started = time.monotonic()
        try:
            with self._active_lock:
                if job_id in self._active:
                    raise ProviderError("ocr_job_conflict", "The OCR job is already active", 409)
            input_file_id = self.docfarm.upload(content, media_type, extension, job_id)
            task_id = self.docfarm.create_task(input_file_id, job_id)
            with self._active_lock:
                self._active[job_id] = task_id
            task = self.docfarm.await_task(task_id, time.monotonic() + self.configuration.request_timeout_seconds)
            output_file_id = task["output_file_id"]
            value = None
            output_deadline = time.monotonic() + 10
            while time.monotonic() < output_deadline:
                try:
                    candidate = _bounded_json(self.docfarm.download_file(output_file_id), MAX_OUTPUT_BYTES)
                    if isinstance(candidate, dict):
                        value = candidate
                        break
                except ProviderError:
                    pass
                time.sleep(self.configuration.poll_interval_seconds)
            if value is None:
                raise ProviderError("upstream_output_json_invalid", "The OCR dependency output was not valid JSON", 502, retryable=True)
            markdown = value.get("markdown") if isinstance(value, dict) else None
            if not isinstance(markdown, str) or len(markdown.encode("utf-8")) > 32 * 1024 * 1024:
                raise ProviderError("upstream_output_text_invalid", "The OCR dependency returned invalid text", 502, retryable=True)
            duration_ms = int(value.get("durationMs", round((time.monotonic() - started) * 1000)))
            block = {
                "block_id": "text-1", "block_content": markdown, "block_bbox": None, "confidence": None,
                "block_label": "text", "block_format": "markdown", "reading_order": 0, "geometry_supported": False,
            }
            result = {
                "errorCode": 0, "errorMsg": "Success",
                "result": {"layoutParsingResults": [{
                    "prunedResult": {"width": None, "height": None, "geometry_supported": False, "parsing_res_list": [block]},
                    "markdown": {"text": markdown, "images": None}, "outputImages": None,
                }]},
                "x_teamaibox": {
                    "adapter_version": ADAPTER_VERSION, "model": MODEL_NAME,
                    "model_revision": self.configuration.model_revision,
                    "worker_image_digest": self.configuration.worker_image_digest,
                    "inference_mode": value.get("inferenceMode"), "backend_version": value.get("backendVersion"),
                    "duration_ms": duration_ms, "geometry_supported": False,
                    "structured_tables": False, "latex_formulas": False,
                },
            }
            return result
        finally:
            content[:] = b"\0" * len(content)
            with self._active_lock:
                self._active.pop(job_id, None)
            if task_id and not output_file_id:
                self.docfarm.cancel_task(task_id)
            cleanup["task_deleted"] = self.docfarm.delete_task(task_id)
            cleanup["output_deleted"] = self.docfarm.delete_file(output_file_id)
            cleanup["input_deleted"] = self.docfarm.delete_file(input_file_id)
            self._capacity.release()
            if not all(cleanup.values()):
                raise ProviderError("upstream_cleanup_failed", "The OCR adapter could not verify temporary data cleanup", 503, retryable=True)


class ProviderRequestHandler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxOCRProvider/1"
    protocol_version = "HTTP/1.1"

    @property
    def application(self) -> ProviderApplication:
        return self.server.application  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _authorized(self) -> bool:
        expected = b"Bearer " + self.application.configuration.token
        supplied = self.headers.get("Authorization", "").encode("utf-8", "ignore")
        return hmac.compare_digest(supplied, expected)

    def _send(self, status: int, value: Any) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _error(self, error: ProviderError) -> None:
        self._send(error.status, {"error": {"code": error.code, "message": str(error), "retryable": error.retryable}})

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding"):
            raise ProviderError("invalid_request_framing", "Chunked request bodies are unsupported", 400)
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError as error:
            raise ProviderError("invalid_request_framing", "Content-Length is invalid", 400) from error
        if length < 2 or length > MAX_JSON_BYTES:
            raise ProviderError("request_too_large", "Request body size is invalid", 413)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ProviderError("invalid_request_framing", "Request body is incomplete", 400)
        return _bounded_json(raw, MAX_JSON_BYTES)

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorized():
            self._send(401, {"error": {"code": "unauthorized", "message": "Authentication is required"}})
            return
        if self.path == "/v1/models":
            self._send(200, self.application.models())
            return
        if self.path == "/v1/health/ready":
            ready = self.application.ready()
            self._send(200 if ready else 503, {"status": "ready" if ready else "unavailable"})
            return
        self._send(404, {"error": {"code": "not_found", "message": "Route not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._send(401, {"error": {"code": "unauthorized", "message": "Authentication is required"}})
            return
        try:
            if self.path == "/v1/ocr":
                self._send(200, self.application.recognize(self._read_json()))
                return
            match = re.fullmatch(r"/v1/ocr/([0-9a-f-]{36})/cancel", self.path, re.I)
            if match and UUID_RE.fullmatch(match.group(1)):
                if self.headers.get("Content-Length") not in {None, "0"}:
                    raise ProviderError("invalid_request_framing", "Cancellation body must be empty", 400)
                self._send(200, self.application.cancel(match.group(1)))
                return
            self._send(404, {"error": {"code": "not_found", "message": "Route not found"}})
        except ProviderError as error:
            self._error(error)
        except Exception:
            self._error(ProviderError("internal_error", "The OCR adapter could not complete the request", 500, retryable=True))


def load_configuration() -> Configuration:
    token_file = os.environ["OCR_PROVIDER_TOKEN_FILE"]
    with open(token_file, "rb") as handle:
        token = handle.read(8193).strip()
    if len(token) < 32 or len(token) > 8192 or b"\0" in token or b"\n" in token or b"\r" in token:
        raise ValueError("OCR Provider token is invalid")
    port = int(os.environ.get("OCR_PROVIDER_PORT", "19094"))
    timeout = int(os.environ.get("OCR_PROVIDER_REQUEST_TIMEOUT_SECONDS", "900"))
    poll = float(os.environ.get("OCR_PROVIDER_POLL_INTERVAL_SECONDS", "0.5"))
    worker_digest = os.environ["OCR_PROVIDER_WORKER_IMAGE_DIGEST"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", worker_digest):
        raise ValueError("OCR Provider worker image digest is invalid")
    if port < 1024 or port > 65535 or timeout < 10 or timeout > 3600 or poll < 0.1 or poll > 5:
        raise ValueError("OCR Provider numeric configuration is invalid")
    return Configuration(
        bind_host=os.environ.get("OCR_PROVIDER_BIND_HOST", "0.0.0.0"), port=port,
        certificate_file=os.environ["OCR_PROVIDER_TLS_CERT_FILE"], private_key_file=os.environ["OCR_PROVIDER_TLS_KEY_FILE"],
        ca_file=os.environ["OCR_PROVIDER_CA_FILE"], token=token,
        docfarm_url=os.environ.get("OCR_PROVIDER_DOCFARM_BASE_URL", "http://127.0.0.1:9200/docfarm/api/v1"),
        request_timeout_seconds=timeout, poll_interval_seconds=poll,
        model_revision=os.environ.get("OCR_PROVIDER_MODEL_REVISION", "01b3ec869d704307645d2d8667f01c5bec6fef6d"),
        worker_image_digest=worker_digest,
    )


def healthcheck(configuration: Configuration) -> int:
    context = ssl.create_default_context(cafile=configuration.ca_file)
    request = urllib.request.Request(
        f"https://127.0.0.1:{configuration.port}/v1/health/ready",
        headers={"Authorization": f"Bearer {configuration.token.decode('utf-8')}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=5, context=context) as response:
            return 0 if response.status == 200 else 1
    except Exception:
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    configuration = load_configuration()
    if args.healthcheck:
        return healthcheck(configuration)
    docfarm = DocFarmClient(configuration.docfarm_url, configuration.request_timeout_seconds, configuration.poll_interval_seconds)
    server = ThreadingHTTPServer((configuration.bind_host, configuration.port), ProviderRequestHandler)
    server.daemon_threads = True
    server.application = ProviderApplication(configuration, docfarm)  # type: ignore[attr-defined]
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_3
    tls.load_cert_chain(configuration.certificate_file, configuration.private_key_file)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
