#!/usr/bin/env python3
"""Authenticated HTTPS OpenAI-style Provider adapter for the retained drawing worker."""

from __future__ import annotations

import argparse
import hmac
import http.client
import json
import os
import re
import ssl
import threading
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
try:
    from services.media_io.resources import buffered_bytes
except ModuleNotFoundError:
    from media_resources import buffered_bytes


MODEL = os.environ.get("DRAWING_PROVIDER_SERVED_MODEL", "sdxl-base-1.0-fp16")
OPERATIONS = tuple(item.strip() for item in os.environ.get(
    "DRAWING_PROVIDER_OPERATIONS", "images.generations,images.edits").split(",") if item.strip())
CERTIFICATION = os.environ.get("DRAWING_PROVIDER_CERTIFICATION", "experimental")
DEFAULT_STEPS = int(os.environ.get("DRAWING_PROVIDER_DEFAULT_STEPS", "8"))
DEFAULT_GUIDANCE_SCALE = float(os.environ.get("DRAWING_PROVIDER_DEFAULT_GUIDANCE_SCALE", "5"))
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


class ProviderError(Exception):
    def __init__(self, code: str, message: str, status: int, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


@dataclass(frozen=True)
class Configuration:
    bind_host: str
    port: int
    certificate_file: str
    private_key_file: str
    ca_file: str
    token: bytes
    worker_host: str
    worker_port: int
    timeout_seconds: int
    worker_image_digest: str
    model_revision: str


class WorkerClient:
    def __init__(self, host: str, port: int, timeout_seconds: int):
        if host not in {"127.0.0.1", "localhost", "::1"} or not 1024 <= port <= 65535:
            raise ValueError("drawing Worker must use appliance-local loopback")
        self.host = host
        self.port = port
        self.timeout_seconds = timeout_seconds

    def request(self, method: str, path: str, body: Any | None = None) -> tuple[int, Any]:
        encoded = None if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
        connection = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout_seconds)
        try:
            headers = {"Accept": "application/json"}
            if encoded is not None:
                headers.update({"Content-Type": "application/json", "Content-Length": str(len(encoded))})
            connection.request(method, path, body=encoded, headers=headers)
            response = connection.getresponse()
            budget = buffered_bytes()
            raw = response.read(budget + 1)
            if len(raw) > budget:
                raise ProviderError("upstream_response_too_large", "Insufficient available memory for the drawing response", 502)
            try:
                value = json.loads(raw.decode()) if raw else {}
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ProviderError("upstream_response_invalid", "The drawing Worker returned invalid JSON", 502) from error
            return response.status, value
        except (OSError, http.client.HTTPException) as error:
            raise ProviderError("upstream_unavailable", "The drawing Worker is unavailable", 503, True) from error
        finally:
            connection.close()
            if encoded is not None:
                mutable = bytearray(encoded)
                mutable[:] = b"\0" * len(mutable)

    def ready(self) -> bool:
        try:
            status, value = self.request("GET", "/health")
            return status == 200 and value.get("accepting") is True and value.get("model") == MODEL
        except ProviderError:
            return False


class Application:
    def __init__(self, configuration: Configuration, worker: WorkerClient):
        self.configuration = configuration
        self.worker = worker
        self.capacity = threading.BoundedSemaphore(1)

    def models(self) -> dict[str, Any]:
        return {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "teamaibox",
                "x_teamaibox": {"certification": CERTIFICATION, "operations": list(OPERATIONS),
                                  "maximum_concurrency": 1, "exclusive": True}}]}

    def model_status(self) -> tuple[int, dict[str, Any]]:
        status, value = self.worker.request("GET", "/health")
        accepting = status == 200 and value.get("accepting") is True and value.get("model") == MODEL
        return (200 if accepting else 503), {
            "status": "ready" if accepting else "unavailable",
            "model": MODEL,
            "loaded": value.get("loaded") is True,
            "accepting": accepting,
        }

    def control_model(self, action: str, value: Any) -> tuple[int, dict[str, Any]]:
        if action not in {"prepare", "unload"} or not isinstance(value, dict) or value.get("model") != MODEL:
            raise ProviderError("invalid_request", "The drawing model control request is invalid", 400)
        if not self.capacity.acquire(blocking=False):
            raise ProviderError("drawing_capacity_exhausted", "The drawing Provider is busy", 429, True)
        try:
            status, response = self.worker.request("POST", f"/v1/models/{action}", None)
            if status >= 500:
                raise ProviderError(f"model_{action}_failed", "The drawing Worker could not change model residency", 503, True)
            if status < 200 or status >= 300 or response.get("model") != MODEL:
                raise ProviderError(f"model_{action}_invalid", "The drawing Worker returned an invalid model-control result", 502)
            expected_status = "ready" if action == "prepare" else "unloaded"
            expected_loaded = action == "prepare"
            if response.get("status") != expected_status or response.get("loaded") is not expected_loaded:
                raise ProviderError(f"model_{action}_invalid", "The drawing Worker returned an invalid model-control result", 502)
            return status, response
        finally:
            self.capacity.release()

    def execute(self, path: str, value: Any) -> tuple[int, Any]:
        operation = "images." + path.rsplit("/", 1)[-1]
        if operation not in OPERATIONS:
            raise ProviderError("unsupported_operation", "The drawing operation is unsupported by this model", 400)
        if not isinstance(value, dict) or value.get("model") != MODEL:
            raise ProviderError("invalid_request", "The drawing model is invalid", 400)
        prompt = value.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ProviderError("invalid_request", "The drawing prompt is invalid", 400)
        request = dict(value)
        request["response_format"] = "b64_json"
        if request.get("size") == "256x256":
            request["size"] = "512x512"
        extension = request.get("x_teamaibox")
        if extension is None:
            extension = {}
        if not isinstance(extension, dict):
            raise ProviderError("invalid_request", "Drawing extensions are invalid", 400)
        extension = dict(extension)
        job_id = extension.get("job_id")
        if job_id is None:
            job_id = str(uuid.uuid4())
        if not isinstance(job_id, str) or not UUID_RE.fullmatch(job_id):
            raise ProviderError("invalid_request", "The drawing job identity is invalid", 400)
        extension.update({"job_id": job_id, "seed": extension.get("seed", 0),
                          "steps": extension.get("steps", DEFAULT_STEPS),
                          "guidance_scale": extension.get("guidance_scale", DEFAULT_GUIDANCE_SCALE),
                          "output_format": extension.get("output_format", "png"),
                          "preset_key": extension.get("preset_key", "drawing.provider.v1")})
        request["x_teamaibox"] = extension
        if not self.capacity.acquire(blocking=False):
            raise ProviderError("drawing_capacity_exhausted", "The drawing Provider is busy", 429, True)
        try:
            status, response = self.worker.request("POST", f"/v1{path}", request)
            if status >= 500:
                raise ProviderError("upstream_failed", "The drawing Worker failed", 503, True)
            return status, response
        finally:
            self.capacity.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxDrawingProvider/1"
    protocol_version = "HTTP/1.1"

    @property
    def application(self) -> Application:
        return self.server.application  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def authorized(self) -> bool:
        expected = b"Bearer " + self.application.configuration.token
        supplied = self.headers.get("Authorization", "").encode("utf-8", "ignore")
        return hmac.compare_digest(expected, supplied)

    def send_json(self, status: int, value: Any) -> None:
        body = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
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

    def error(self, error: ProviderError) -> None:
        self.send_json(error.status, {"error": {"code": error.code, "message": str(error), "retryable": error.retryable}})

    def read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding"):
            raise ProviderError("invalid_request_framing", "Chunked bodies are unsupported", 400)
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError as error:
            raise ProviderError("invalid_request_framing", "Content-Length is invalid", 400) from error
        if length < 2 or length > buffered_bytes():
            raise ProviderError("request_too_large", "Request size exceeds available memory", 413)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ProviderError("invalid_request_framing", "Request body is incomplete", 400)
        try:
            return json.loads(raw.decode())
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProviderError("invalid_request", "Request body is invalid JSON", 400) from error

    def do_GET(self) -> None:  # noqa: N802
        if not self.authorized():
            self.send_json(401, {"error": {"code": "unauthorized", "message": "Authentication is required"}})
        elif self.path == "/v1/models":
            self.send_json(200, self.application.models())
        elif self.path == "/v1/health/ready":
            status, value = self.application.model_status()
            self.send_json(status, value)
        elif self.path == "/v1/models/status":
            status, value = self.application.model_status()
            self.send_json(status, value)
        else:
            self.send_json(404, {"error": {"code": "not_found", "message": "Route not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if not self.authorized():
            self.send_json(401, {"error": {"code": "unauthorized", "message": "Authentication is required"}})
            return
        try:
            if self.path in {"/v1/models/prepare", "/v1/models/unload"}:
                action = self.path.rsplit("/", 1)[1]
                status, value = self.application.control_model(action, self.read_json())
                self.send_json(status, value)
                return
            if self.path in {"/v1/images/generations", "/v1/images/edits"}:
                status, value = self.application.execute(self.path.removeprefix("/v1"), self.read_json())
                self.send_json(status, value)
                return
            match = re.fullmatch(r"/v1/images/(generations|edits)/([0-9a-f-]{36})/cancel", self.path, re.I)
            if match and UUID_RE.fullmatch(match.group(2)):
                status, value = self.application.worker.request("POST", self.path, None)
                self.send_json(status, value)
                return
            self.send_json(404, {"error": {"code": "not_found", "message": "Route not found"}})
        except ProviderError as error:
            self.error(error)
        except Exception:
            self.error(ProviderError("internal_error", "The drawing Provider could not complete the request", 500, True))


def configuration() -> Configuration:
    if not OPERATIONS or not set(OPERATIONS).issubset({"images.generations", "images.edits"}):
        raise ValueError("drawing Provider operations are invalid")
    if CERTIFICATION not in {"experimental", "validating", "certified", "deprecated"}:
        raise ValueError("drawing Provider certification is invalid")
    if not 1 <= DEFAULT_STEPS <= 200 or not 0 <= DEFAULT_GUIDANCE_SCALE <= 50:
        raise ValueError("drawing Provider generation defaults are invalid")
    with open(os.environ["DRAWING_PROVIDER_TOKEN_FILE"], "rb") as handle:
        token = handle.read(8193).strip()
    if not 32 <= len(token) <= 8192 or any(item in token for item in (b"\0", b"\n", b"\r")):
        raise ValueError("drawing Provider token is invalid")
    worker = urllib.parse.urlsplit(os.environ.get("DRAWING_PROVIDER_WORKER_URL", "http://127.0.0.1:19096"))
    if worker.scheme != "http" or worker.hostname not in {"127.0.0.1", "localhost", "::1"} or worker.path not in {"", "/"}:
        raise ValueError("drawing Worker URL is invalid")
    image = os.environ["DRAWING_PROVIDER_WORKER_IMAGE_DIGEST"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("drawing Worker image digest is invalid")
    return Configuration(
        bind_host=os.environ.get("DRAWING_PROVIDER_BIND_HOST", "0.0.0.0"),
        port=int(os.environ.get("DRAWING_PROVIDER_PORT", "19095")),
        certificate_file=os.environ["DRAWING_PROVIDER_TLS_CERT_FILE"],
        private_key_file=os.environ["DRAWING_PROVIDER_TLS_KEY_FILE"],
        ca_file=os.environ["DRAWING_PROVIDER_CA_FILE"], token=token,
        worker_host=worker.hostname, worker_port=worker.port or 80,
        timeout_seconds=int(os.environ.get("DRAWING_PROVIDER_TIMEOUT_SECONDS", "1800")),
        worker_image_digest=image,
        model_revision=os.environ["DRAWING_PROVIDER_MODEL_REVISION"],
    )


def healthcheck(value: Configuration) -> int:
    context = ssl.create_default_context(cafile=value.ca_file)
    request = urllib.request.Request(f"https://127.0.0.1:{value.port}/v1/health/ready",
                                     headers={"Authorization": f"Bearer {value.token.decode()}"})
    try:
        with urllib.request.urlopen(request, timeout=5, context=context) as response:
            return 0 if response.status == 200 else 1
    except Exception:
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    value = configuration()
    if args.healthcheck:
        return healthcheck(value)
    server = ThreadingHTTPServer((value.bind_host, value.port), Handler)
    server.daemon_threads = True
    server.application = Application(value, WorkerClient(value.worker_host, value.worker_port, value.timeout_seconds))  # type: ignore[attr-defined]
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(value.certificate_file, value.private_key_file)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
