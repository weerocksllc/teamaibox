#!/usr/bin/env python3
"""TLS provider boundary for the scheduler-managed HunyuanOCR DFlash Worker."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hmac
import http.client
import json
import os
import re
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
import urllib.parse
import urllib.request


MODEL = os.environ.get("OCR_MANAGED_PROVIDER_SERVED_MODEL", "hunyuanocr-1.5-bf16-dflash")
try:
    from services.media_io.resources import buffered_bytes
except ModuleNotFoundError:
    from media_resources import buffered_bytes


def request_budget():
    return buffered_bytes(configured=os.environ.get("OCR_MANAGED_PROVIDER_MAX_REQUEST_BYTES"))


def response_budget():
    return buffered_bytes(configured=os.environ.get("OCR_MANAGED_PROVIDER_MAX_RESPONSE_BYTES"))

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
MANAGED_WORKER_HOST_RE = re.compile(
    r"^teamaibox-worker-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
LOOPBACK_WORKER_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


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
    dflash_digest: str


class WorkerClient:
    def __init__(self, configuration: Configuration):
        self.configuration = configuration

    def request(self, method: str, path: str, value: Any | None = None, timeout: int | None = None) -> tuple[int, Any]:
        raw = None if value is None else json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        connection = http.client.HTTPConnection(self.configuration.worker_host, self.configuration.worker_port,
                                                timeout=timeout or self.configuration.timeout_seconds)
        try:
            headers = {"Accept": "application/json"}
            if raw is not None:
                headers.update({"Content-Type": "application/json", "Content-Length": str(len(raw))})
            connection.request(method, path, raw, headers)
            response = connection.getresponse()
            budget = response_budget()
            payload = response.read(budget + 1)
            if len(payload) > budget:
                raise ProviderError("upstream_response_too_large", "OCR response exceeds currently available memory", 502)
            try:
                parsed = json.loads(payload) if payload else {}
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ProviderError("upstream_response_invalid", "OCR Worker returned invalid JSON", 502) from error
            return response.status, parsed
        except (OSError, http.client.HTTPException) as error:
            raise ProviderError("upstream_unavailable", "OCR Worker is unavailable", 503, True) from error
        finally:
            connection.close()


class Application:
    def __init__(self, configuration: Configuration, worker: WorkerClient):
        self.configuration = configuration
        self.worker = worker

    def models(self) -> dict[str, Any]:
        return {"object": "list", "data": [{
            "id": MODEL, "object": "model", "owned_by": "teamaibox",
            "x_teamaibox": {
                "certification": "validating", "execution_kind": "managed_node",
                "operations": ["ocr"], "exclusive": True, "maximum_concurrency": 1,
                "inference_mode": "vllm-dflash", "dflash_speculative_tokens": 15,
                "geometry_supported": False, "html_tables_preserved_in_markdown": True,
                "latex_formulas_preserved_in_markdown": True,
            },
        }]}

    def status(self) -> tuple[int, dict[str, Any]]:
        status, value = self.worker.request("GET", "/health", timeout=5)
        accepting = status == 200 and value.get("accepting") is True and value.get("model") == MODEL \
            and value.get("inference_mode") == "vllm-dflash"
        return (200 if accepting else 503), {
            "status": "ready" if accepting else "unavailable", "model": MODEL,
            "loaded": value.get("loaded") is True, "accepting": accepting,
            "execution_kind": "managed_node", "inference_mode": "vllm-dflash",
        }

    def control(self, action: str, value: Any) -> tuple[int, Any]:
        if action not in {"prepare", "unload"} or not isinstance(value, dict) or value.get("model") != MODEL:
            raise ProviderError("invalid_request", "OCR model control request is invalid", 400)
        status, result = self.worker.request("POST", f"/v1/models/{action}", value)
        expected_status = "ready" if action == "prepare" else "unloaded"
        expected_loaded = action == "prepare"
        if status < 200 or status >= 300 or result.get("model") != MODEL \
                or result.get("status") != expected_status or result.get("loaded") is not expected_loaded:
            raise ProviderError(f"model_{action}_failed", "OCR Worker model control failed", 503, True)
        return status, result

    def recognize(self, value: Any) -> tuple[int, Any]:
        if not isinstance(value, dict) or value.get("model") != MODEL:
            raise ProviderError("invalid_ocr_request", "OCR model is invalid", 400)
        status, result = self.worker.request("POST", "/ocr", value)
        if status >= 500:
            raise ProviderError("upstream_failed", "HunyuanOCR DFlash execution failed", 503, True)
        return status, result

    def cancel(self, job_id: str) -> tuple[int, Any]:
        return self.worker.request("POST", f"/ocr/{job_id}/cancel", None, timeout=5)


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxManagedHunyuanOCRProvider/1"
    protocol_version = "HTTP/1.1"

    @property
    def application(self) -> Application:
        return self.server.application  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "").encode("utf-8", "ignore")
        return hmac.compare_digest(supplied, b"Bearer " + self.application.configuration.token)

    def send_json(self, status: int, value: Any) -> None:
        raw = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error(self, error: ProviderError) -> None:
        self.send_json(error.status, {"error": {"code": error.code, "message": str(error),
                                                "retryable": error.retryable}})

    def read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding"):
            raise ProviderError("invalid_request_framing", "Chunked request bodies are unsupported", 400)
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError as error:
            raise ProviderError("invalid_request_framing", "Content-Length is invalid", 400) from error
        if length < 2 or length > request_budget():
            raise ProviderError("request_too_large", "Request is empty or exceeds currently available memory", 413)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ProviderError("invalid_request_framing", "Request body is incomplete", 400)
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProviderError("invalid_request", "Request body is invalid JSON", 400) from error

    def relay_recognition(self) -> None:
        """Forward file-bearing JSON as a stream, not several full-size copies.

        The exact configured engine validates model/job/JSON fields. The
        provider still authenticates the caller before sending any bytes.
        """
        self.close_connection = True
        if self.headers.get("Transfer-Encoding"):
            raise ProviderError("invalid_request_framing", "Content-Length is required", 400)
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 2 or self.headers.get('Content-Type','').split(';',1)[0].strip() != 'application/json':
            raise ProviderError("invalid_request_framing", "JSON and Content-Length are required", 400)
        configured = os.environ.get('OCR_MANAGED_PROVIDER_MAX_REQUEST_BYTES')
        if configured is not None and length > int(configured):
            raise ProviderError('request_too_large', 'Request exceeds the administrator byte quota', 413)
        config = self.application.configuration
        connection = http.client.HTTPConnection(config.worker_host, config.worker_port, timeout=config.timeout_seconds)
        self.connection.settimeout(config.timeout_seconds)
        # A closed response is also valid when the upstream has no length.
        self.close_connection = True
        headers_sent = False
        try:
            connection.putrequest('POST', '/ocr')
            connection.putheader('Content-Type','application/json')
            connection.putheader('Content-Length',str(length))
            connection.endheaders()
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(65536,remaining))
                if not chunk:
                    raise ProviderError('invalid_request_framing','Request body is incomplete',400)
                connection.send(chunk);remaining -= len(chunk)
            response = connection.getresponse()
            if response.getheader('Content-Type','').split(';',1)[0].strip() != 'application/json':
                raise ProviderError('upstream_response_invalid','OCR Worker returned invalid content type',502)
            self.send_response(503 if response.status >= 500 else response.status)
            self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Connection','close')
            self.end_headers();headers_sent = True
            while chunk := response.read(65536):
                self.wfile.write(chunk)
        except (OSError,http.client.HTTPException):
            if not headers_sent:
                raise ProviderError('upstream_unavailable','OCR Worker is unavailable',503,True) from None
        finally:
            connection.close()

    def do_GET(self) -> None:  # noqa: N802
        if not self.authorized():
            self.send_json(401, {"error": {"code": "unauthorized"}})
        elif self.path == "/v1/models":
            self.send_json(200, self.application.models())
        elif self.path in {"/v1/health/ready", "/v1/models/status"}:
            status, value = self.application.status()
            self.send_json(status, value)
        else:
            self.send_json(404, {"error": {"code": "not_found"}})

    def do_POST(self) -> None:  # noqa: N802
        if not self.authorized():
            self.send_json(401, {"error": {"code": "unauthorized"}})
            return
        try:
            if self.path in {"/v1/models/prepare", "/v1/models/unload"}:
                status, value = self.application.control(self.path.rsplit("/", 1)[1], self.read_json())
            elif self.path == "/v1/ocr":
                self.relay_recognition()
                return
            else:
                match = re.fullmatch(r"/v1/ocr/([0-9a-f-]{36})/cancel", self.path, re.I)
                if not match or not UUID_RE.fullmatch(match.group(1)):
                    self.send_json(404, {"error": {"code": "not_found"}})
                    return
                status, value = self.application.cancel(match.group(1))
            self.send_json(status, value)
        except ProviderError as error:
            self.error(error)
        except Exception:
            self.error(ProviderError("internal_error", "Managed OCR Provider failed", 500, True))


def worker_endpoint() -> tuple[str, int]:
    allowed_managed_host = os.environ.get("OCR_MANAGED_PROVIDER_ALLOWED_WORKER_HOST")
    if allowed_managed_host is not None and not MANAGED_WORKER_HOST_RE.fullmatch(allowed_managed_host):
        raise ValueError("managed OCR Worker host allowlist is invalid")

    raw_worker_url = os.environ.get("OCR_MANAGED_PROVIDER_WORKER_URL", "http://127.0.0.1:8000")
    if raw_worker_url != raw_worker_url.strip() or any(character in raw_worker_url for character in "\0\r\n\t?#"):
        raise ValueError("managed OCR Worker URL is invalid")
    try:
        worker = urllib.parse.urlsplit(raw_worker_url)
        worker_port = worker.port
    except ValueError as error:
        raise ValueError("managed OCR Worker URL is invalid") from error

    worker_host = worker.hostname
    allowed_hosts = LOOPBACK_WORKER_HOSTS
    if allowed_managed_host is not None:
        allowed_hosts = allowed_hosts | {allowed_managed_host}
    if (
        worker.scheme != "http"
        or worker_host not in allowed_hosts
        or worker_port != 8000
        or worker.username is not None
        or worker.password is not None
        or worker.path != ""
        or worker.query != ""
        or worker.fragment != ""
    ):
        raise ValueError("managed OCR Worker URL is invalid")
    return worker_host, worker_port


def configuration() -> Configuration:
    with open(os.environ["OCR_MANAGED_PROVIDER_TOKEN_FILE"], "rb") as handle:
        token = handle.read(8193).strip()
    if not 32 <= len(token) <= 8192 or any(value in token for value in (b"\0", b"\n", b"\r")):
        raise ValueError("managed OCR Provider token is invalid")
    worker_host, worker_port = worker_endpoint()
    image = os.environ["OCR_MANAGED_PROVIDER_WORKER_IMAGE_DIGEST"]
    dflash = os.environ["OCR_MANAGED_PROVIDER_DFLASH_DIGEST"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image) or not re.fullmatch(r"sha256:[0-9a-f]{64}", dflash):
        raise ValueError("managed OCR artifact digest is invalid")
    return Configuration(
        bind_host=os.environ.get("OCR_MANAGED_PROVIDER_BIND_HOST", "0.0.0.0"),
        port=int(os.environ.get("OCR_MANAGED_PROVIDER_PORT", "19095")),
        certificate_file=os.environ["OCR_MANAGED_PROVIDER_TLS_CERT_FILE"],
        private_key_file=os.environ["OCR_MANAGED_PROVIDER_TLS_KEY_FILE"],
        ca_file=os.environ["OCR_MANAGED_PROVIDER_CA_FILE"], token=token,
        worker_host=worker_host, worker_port=worker_port,
        timeout_seconds=int(os.environ.get("OCR_MANAGED_PROVIDER_TIMEOUT_SECONDS", "1800")),
        worker_image_digest=image, model_revision=os.environ["OCR_MANAGED_PROVIDER_MODEL_REVISION"],
        dflash_digest=dflash,
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
    server.application = Application(value, WorkerClient(value))  # type: ignore[attr-defined]
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
