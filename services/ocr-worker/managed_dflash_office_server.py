#!/usr/bin/env python3
"""Low-residency ComputePlugin controller for HunyuanOCR 1.5 DFlash."""

from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


SERVED_MODEL = os.environ.get("TEAMAIBOX_HUNYUAN_SERVED_MODEL", "hunyuanocr-1.5-bf16-dflash")
ENGINE_PYTHON = os.environ.get("TEAMAIBOX_HUNYUAN_ENGINE_PYTHON", "/opt/vllm-venv/bin/python")
ENGINE_SCRIPT = os.environ.get("TEAMAIBOX_HUNYUAN_ENGINE_SCRIPT", "/opt/teamaibox/ocr-worker/managed_dflash_engine.py")
MODEL_MARKER = Path(os.environ.get("TEAMAIBOX_HUNYUAN_MODEL_MARKER", "/model-cache/huggingface/model.marker"))
DFLASH_MARKER = Path(os.environ.get("TEAMAIBOX_HUNYUAN_DFLASH_MARKER", "/model-cache/hunyuanocr-dflash/config.json"))
PREPARE_TIMEOUT = int(os.environ.get("TEAMAIBOX_HUNYUAN_PREPARE_TIMEOUT_SECONDS", "600"))
try:
    from services.media_io.resources import buffered_bytes
except ModuleNotFoundError:
    from media_resources import buffered_bytes


def body_budget():
    return buffered_bytes(configured=os.environ.get("TEAMAIBOX_HUNYUAN_MAX_BODY_BYTES"))

JOB_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
STARTUP_ERROR_PATH = Path('/tmp/teamaibox-ocr-startup-error.log')


class EngineSupervisor:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.capacity = threading.BoundedSemaphore(1)
        self.process: subprocess.Popen[bytes] | None = None
        self.process_group_id: int | None = None
        self.active_job: str | None = None
        self.preparing_process: subprocess.Popen[bytes] | None = None
        self.prepare_deadline = 0.0
        self.startup_log_process = None
        self.startup_log_tail = bytearray()
        self.startup_diagnostic: dict[str, Any] = {"phase": "idle", "exitCode": None, "reason": None}

    def startup_status(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.startup_diagnostic)

    def _clear_startup_log_locked(self):
        self.startup_log_tail[:] = b"\0" * len(self.startup_log_tail)
        self.startup_log_tail.clear()
        try:
            STARTUP_ERROR_PATH.unlink(missing_ok=True)
        except OSError:
            pass

    def _drain_diagnostics(self, process: subprocess.Popen[bytes]) -> None:
        # Drain continuously so a full pipe cannot deadlock startup. Retain only
        # fixed error classes over HTTP. Startup-only detail stays in a bounded
        # private RAM file, never in the API, Docker log or user-result storage.
        reason = None
        tail = b""
        stream = process.stdout
        if stream is None:
            return
        try:
            while chunk := stream.read(4096):
                tail = (tail + chunk)[-8192:]
                for marker, code in [(b"CUDA out of memory", "cuda_memory_exhausted"),
                                     (b"larger than the available KV cache memory", "kv_cache_budget_insufficient"),
                                     (b"No space left on device", "temporary_storage_exhausted"),
                                     (b"Address already in use", "engine_port_busy"),
                                     (b"ModuleNotFoundError", "engine_dependency_missing"),
                                     (b"CUDA error", "cuda_runtime_error"),
                                     (b"ninja: build stopped", "engine_compile_failed")]:
                    if marker in tail:
                        reason = code
                with self.lock:
                    if self.startup_log_process is process:
                        self.startup_log_tail.extend(chunk)
                        del self.startup_log_tail[:-65536]
                    if self.preparing_process is process and reason:
                        self.startup_diagnostic["reason"] = reason
        finally:
            stream.close()
            # Startup stderr is useful for diagnosis but can contain local
            # paths. Never expose it through HTTP or stdout. Retain at most
            # 64 KiB only in the existing private tmpfs, until the next start.
            with self.lock:
                if self.startup_log_process is process and self.startup_log_tail:
                    try:
                        fd = os.open(STARTUP_ERROR_PATH,
                                     os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
                        with os.fdopen(fd, "wb") as failure_log:
                            os.fchmod(failure_log.fileno(), 0o600)
                            failure_log.write(self.startup_log_tail)
                    except OSError:
                        pass  # Diagnostic storage must not affect the model lifecycle.
                    self.startup_log_process = None
                    self.startup_log_tail[:] = b"\0" * len(self.startup_log_tail)
                    self.startup_log_tail.clear()

    def snapshot_ready(self) -> bool:
        return MODEL_MARKER.is_file() and DFLASH_MARKER.is_file()

    def loaded(self) -> bool:
        with self.lock:
            return self.process is not None and self.process.poll() is None and self._ready()

    def _request(self, method: str, path: str, body: Any | None = None, timeout: int = 30) -> tuple[int, Any]:
        raw = None if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
        connection = http.client.HTTPConnection("127.0.0.1", 8001, timeout=timeout)
        try:
            headers = {"Accept": "application/json"}
            if raw is not None:
                headers.update({"Content-Type": "application/json", "Content-Length": str(len(raw))})
            connection.request(method, path, raw, headers)
            response = connection.getresponse()
            budget = body_budget()
            payload = response.read(budget + 1)
            if len(payload) > budget:
                raise RuntimeError("engine response exceeded limit")
            return response.status, json.loads(payload) if payload else {}
        finally:
            connection.close()

    def _ready(self) -> bool:
        try:
            status, value = self._request("GET", "/health", timeout=3)
            return status == 200 and value.get("loaded") is True and value.get("model") == SERVED_MODEL \
                and value.get("inference_mode") == "vllm-dflash"
        except Exception:
            return False

    def prepare(self) -> bool:
        with self.lock:
            if not self.snapshot_ready():
                raise RuntimeError("qualified HunyuanOCR/DFlash snapshots are absent")
            if self.process is not None and self.process.poll() is None and self._ready():
                return True
            joined = self.process is not None and self.process is self.preparing_process and self.process.poll() is None
            if not joined:
                self._stop_locked()
                self.process = subprocess.Popen(
                    [ENGINE_PYTHON, ENGINE_SCRIPT], stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    close_fds=True, start_new_session=True,
                )
                self.process_group_id = self.process.pid
                self.preparing_process = self.process
                self._clear_startup_log_locked()
                self.startup_log_process = self.process
                self.prepare_deadline = time.monotonic() + PREPARE_TIMEOUT
                self.startup_diagnostic = {"phase": "loading", "exitCode": None, "reason": None}
                threading.Thread(target=self._drain_diagnostics, args=(self.process,), daemon=True).start()
            process = self.process
            deadline = self.prepare_deadline
        while time.monotonic() < deadline:
            with self.lock:
                if self.process is not process:
                    raise RuntimeError("HunyuanOCR DFlash engine preparation was cancelled")
                exit_code = process.poll()
                if exit_code is not None:
                    self.startup_diagnostic.update(phase="failed", exitCode=exit_code)
                    raise RuntimeError("HunyuanOCR DFlash engine exited while preparing")
            if self._ready():
                with self.lock:
                    if self.process is not process:
                        raise RuntimeError("HunyuanOCR DFlash engine preparation was cancelled")
                    self.preparing_process = None
                    self.startup_log_process = None
                    self._clear_startup_log_locked()
                    self.startup_diagnostic.update(phase="ready")
                return joined
            time.sleep(1)
        with self.lock:
            if self.process is process:
                self._stop_locked()
                self.startup_diagnostic.update(phase="failed", reason="engine_prepare_timeout")
        raise RuntimeError("HunyuanOCR DFlash engine preparation timed out")

    def _stop_locked(self) -> None:
        process = self.process
        process_group_id = self.process_group_id
        self.process = None
        self.process_group_id = None
        self.preparing_process = None
        if process is None or process_group_id is None:
            return
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            process.poll()  # Reap the leader instead of waiting 20 seconds on its zombie.
            try:
                os.killpg(process_group_id, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            try:
                os.killpg(process_group_id, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process_group_id, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)

    def unload(self, force: bool = False) -> None:
        with self.lock:
            if self.active_job is not None and not force:
                raise RuntimeError("engine is busy")
            self._stop_locked()
            self.startup_log_process = None
            self._clear_startup_log_locked()
            self.startup_diagnostic = {"phase": "idle", "exitCode": None, "reason": None}

    def execute(self, value: Any) -> tuple[int, Any]:
        if not isinstance(value, dict):
            return 400, {"error": {"code": "invalid_ocr_request"}}
        job_id = value.get("job_id")
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
            return 400, {"error": {"code": "invalid_ocr_request"}}
        if not self.capacity.acquire(blocking=False):
            return 429, {"error": {"code": "ocr_capacity_exhausted", "retryable": True}}
        try:
            with self.lock:
                if self.active_job is not None:
                    return 409, {"error": {"code": "ocr_job_conflict"}}
                self.active_job = job_id
            self.prepare()
            return self._request("POST", "/ocr", value, timeout=1800)
        finally:
            with self.lock:
                self.active_job = None
            self.capacity.release()

    def cancel(self, job_id: str) -> bool:
        with self.lock:
            if self.active_job != job_id:
                return False
            self.active_job = None
            self._stop_locked()
            self.startup_log_process = None
            self._clear_startup_log_locked()
            self.startup_diagnostic = {"phase": "cancelled", "exitCode": None, "reason": None}
            return True


SUPERVISOR = EngineSupervisor()


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxHunyuanDFlashWorker/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def send_json(self, status: int, value: Any) -> None:
        raw = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_json(self) -> Any:
        length = int(self.headers.get("Content-Length", "-1"))
        if length < 2 or length > body_budget():
            raise ValueError("request size is invalid")
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/diagnostics/startup":
            self.send_json(200, SUPERVISOR.startup_status())
            return
        if self.path != "/health":
            self.send_json(404, {"error": {"code": "not_found"}})
            return
        accepting = SUPERVISOR.snapshot_ready()
        self.send_json(200 if accepting else 503, {
            "status": "ready" if accepting else "unavailable", "model": SERVED_MODEL,
            "loaded": SUPERVISOR.loaded(), "accepting": accepting,
            "inference_mode": "vllm-dflash", "operations": ["ocr"],
        })

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path == "/v1/models/prepare":
                value = self.read_json()
                if value.get("model") != SERVED_MODEL:
                    raise ValueError("model is invalid")
                warm = SUPERVISOR.prepare()
                self.send_json(200, {"status": "ready", "model": SERVED_MODEL,
                                     "loaded": True, "warm_reuse": warm})
                return
            if self.path == "/v1/models/unload":
                value = self.read_json()
                if value.get("model") != SERVED_MODEL:
                    raise ValueError("model is invalid")
                SUPERVISOR.unload()
                self.send_json(200, {"status": "unloaded", "model": SERVED_MODEL, "loaded": False})
                return
            match = re.fullmatch(r"/ocr/([0-9a-f-]{36})/cancel", self.path, re.I)
            if match and JOB_ID.fullmatch(match.group(1)):
                cancelled = SUPERVISOR.cancel(match.group(1))
                self.send_json(200, {"cancelled": cancelled, "job_id": match.group(1)})
                return
            if self.path == "/ocr":
                status, value = SUPERVISOR.execute(self.read_json())
                self.send_json(status, value)
                return
            self.send_json(404, {"error": {"code": "not_found"}})
        except ValueError as error:
            self.send_json(400, {"error": {"code": "invalid_request", "message": str(error)}})
        except RuntimeError as error:
            status = 409 if str(error) == "engine is busy" else 503
            self.send_json(status, {"error": {"code": "worker_unavailable", "retryable": True}})
        except Exception:
            self.send_json(500, {"error": {"code": "worker_failed", "retryable": True}})


def main() -> int:
    if os.environ.get("INFERENCE_MODE") != "vllm-dflash":
        raise RuntimeError("managed HunyuanOCR Worker refuses non-DFlash startup")
    server = ThreadingHTTPServer(("0.0.0.0", 8000), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        SUPERVISOR.unload(force=True)
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
