#!/usr/bin/env python3
"""Authenticated, warm, generation-only Worker for protected FLUX.2 BF16."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import gc
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socket import socket
from typing import Any


def buffered_bytes():
    """This standalone runtime bundle admits buffered copies against live RAM.

    Keep it self-contained: existing protected deployments mount only this
    server file, not the source repository or a Python package installation.
    """
    available = next(int(line.split()[1]) * 1024
                     for line in Path('/proc/meminfo').read_text().splitlines()
                     if line.startswith('MemAvailable:'))
    try:
        maximum = Path('/sys/fs/cgroup/memory.max').read_text().strip()
        if maximum != 'max':
            available = min(available, int(maximum) - int(Path('/sys/fs/cgroup/memory.current').read_text()))
    except (OSError, ValueError):
        pass
    return max(0, available) // 8


MODEL_ROOT = Path(os.environ.get("TEAMAIBOX_DRAWING_MODEL_ROOT", "/model"))
SERVED_MODEL = os.environ.get("TEAMAIBOX_DRAWING_SERVED_MODEL", "")
MAX_CONCURRENCY = int(os.environ.get("TEAMAIBOX_DRAWING_MAX_CONCURRENCY", "1"))
IDLE_UNLOAD_SECONDS = int(os.environ.get("TEAMAIBOX_DRAWING_IDLE_UNLOAD_SECONDS", "0"))
AUTH_TOKEN_FILE = Path(os.environ.get(
    "TEAMAIBOX_DRAWING_BEARER_TOKEN_FILE", "/run/secrets/auth/provider.token"
))
REQUEST_TIMEOUT_SECONDS = int(os.environ.get("TEAMAIBOX_DRAWING_REQUEST_TIMEOUT_SECONDS", "600"))
WATCHDOG_GRACE_SECONDS = int(os.environ.get("TEAMAIBOX_DRAWING_WATCHDOG_GRACE_SECONDS", "30"))
SOCKET_READ_TIMEOUT_SECONDS = int(os.environ.get(
    "TEAMAIBOX_DRAWING_SOCKET_READ_TIMEOUT_SECONDS", "10"
))
MAX_SERVER_THREADS = int(os.environ.get("TEAMAIBOX_DRAWING_MAX_SERVER_THREADS", "4"))
TERMINAL_JOB_TTL_SECONDS = int(os.environ.get("TEAMAIBOX_DRAWING_JOB_TOMBSTONE_SECONDS", "900"))
MAX_JOB_TOMBSTONES = int(os.environ.get("TEAMAIBOX_DRAWING_MAX_JOB_TOMBSTONES", "4096"))
MEMORY_STRATEGY = os.environ.get("TEAMAIBOX_DRAWING_MEMORY_STRATEGY", "")
OFFLOAD_ROOT = Path(os.environ.get("TEAMAIBOX_DRAWING_OFFLOAD_ROOT", "/offload"))
DISK_OFFLOAD_COMPONENTS = ("transformer", "text_encoder")
RESIDENT_CUDA_COMPONENTS = ("vae",)
JOB_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
OWNER_ID = JOB_ID
PIPELINE = None
PIPELINE_LOCK = threading.Lock()
JOBS_LOCK = threading.Lock()
FATAL_LOCK = threading.Lock()
JOBS: dict[str, "JobRecord"] = {}
REQUEST_SLOT = threading.BoundedSemaphore(value=1)
BEARER_TOKEN = ""
FATAL_CUDA_ERROR: dict[str, Any] | None = None
OFFLOAD_FACTS: dict[str, Any] = {}
TERMINAL_STATES = {"succeeded", "failed", "cancelled", "timed_out"}


class WorkerCancelled(RuntimeError):
    pass


class WallClockTimeout(WorkerCancelled):
    pass


class JobRegistryFull(RuntimeError):
    pass


class NonFiniteInference(RuntimeError):
    pass


def safe_error_diagnostic(error: BaseException) -> dict[str, Any]:
    """Return a bounded diagnostic without retaining request or credentials."""
    message = str(error)
    substitutions = (
        (r"(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+", r"\1<redacted>"),
        (r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}", r"\1<redacted>"),
        (r"(?i)(--password(?:=|\s+))[^\s]+", r"\1<redacted>"),
        (r"(?i)(https?://[^/@:\s]+:)[^/@\s]+(@)", r"\1<redacted>\2"),
        (r'(?i)(["\'](?:secret|token|password|api[_-]?key)["\']\s*:\s*["\'])[^"\']+',
         r"\1<redacted>"),
    )
    for pattern, replacement in substitutions:
        message = re.sub(pattern, replacement, message)
    message = message.replace("\r", " ").replace("\n", " ")[:2048]
    return {
        "event": "protected_worker_inference_failed",
        "errorType": type(error).__name__,
        "classification": "cuda-fatal" if is_cuda_fatal(error) else "request-failed",
        "message": message,
        # Code locations only: never capture frame locals, source lines or
        # request payloads. This distinguishes driver errors from a specific
        # operator/thread fault instead of hiding the failing call site.
        "frames": [{"file": Path(frame.filename).name, "line": frame.lineno,
                    "function": frame.name}
                   for frame in traceback.extract_tb(error.__traceback__)[-16:]],
    }


@dataclass
class JobRecord:
    job_id: str
    owner_id: str
    cancellation: threading.Event = field(default_factory=threading.Event)
    state: str = "registered"
    cancel_reason: str | None = None
    started_monotonic: float = field(default_factory=time.monotonic)
    completed_monotonic: float | None = None


def require(value: bool, message: str) -> None:
    if not value:
        raise RuntimeError(message)


def snapshot_ready() -> bool:
    try:
        model_index = json.loads((MODEL_ROOT / "model_index.json").read_text(encoding="utf-8"))
        return (
            model_index.get("_class_name") == "Flux2KleinPipeline"
            and model_index.get("is_distilled") is True
            and (MODEL_ROOT / "transformer/diffusion_pytorch_model.safetensors").is_file()
            and (MODEL_ROOT / "text_encoder/model.safetensors.index.json").is_file()
            and (MODEL_ROOT / "vae/diffusion_pytorch_model.safetensors").is_file()
        )
    except Exception:
        return False


def load_bearer_token() -> str:
    metadata = AUTH_TOKEN_FILE.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1,
            "protected Worker bearer path is not one regular file")
    require(metadata.st_uid == os.getuid() and metadata.st_gid == os.getgid(),
            "protected Worker bearer file owner drifted")
    require(metadata.st_mode & 0o077 == 0,
            "protected Worker bearer file is group/world accessible")
    require(43 <= metadata.st_size <= 256, "protected Worker bearer file size is invalid")
    descriptor = os.open(AUTH_TOKEN_FILE, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        require((opened.st_dev, opened.st_ino) == (metadata.st_dev, metadata.st_ino),
                "protected Worker bearer file changed during open")
        chunks: list[bytes] = []
        remaining = 257
        while remaining > 0:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)
    require(len(raw) <= 256, "protected Worker bearer file is oversized")
    value = raw.decode("ascii").strip()
    require(43 <= len(value) <= 128 and value.isascii() and not any(c.isspace() for c in value),
            "protected Worker bearer value is invalid")
    return value


def prepare_offload_root() -> None:
    metadata = OFFLOAD_ROOT.lstat()
    require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode),
            "protected Worker offload root is not one directory")
    require(metadata.st_uid == os.getuid() and metadata.st_gid == os.getgid(),
            "protected Worker offload root owner drifted")
    require(metadata.st_mode & 0o077 == 0,
            "protected Worker offload root is group/world accessible")
    # The volume is dedicated to this exact Worker.  A restart rebuilds the
    # disposable offload cache rather than trusting partially written tensor
    # files left by a prior fatal CUDA or power-loss exit.
    for child in OFFLOAD_ROOT.iterdir():
        child_metadata = child.lstat()
        require(not stat.S_ISLNK(child_metadata.st_mode)
                and (stat.S_ISDIR(child_metadata.st_mode)
                     or stat.S_ISREG(child_metadata.st_mode)),
                "protected Worker offload cache contains an unsafe entry")
        if stat.S_ISDIR(child_metadata.st_mode):
            shutil.rmtree(child)
        else:
            child.unlink()
    for component in DISK_OFFLOAD_COMPONENTS:
        path = OFFLOAD_ROOT / component
        path.mkdir(mode=0o700)
        require(path.lstat().st_uid == os.getuid() and path.lstat().st_gid == os.getgid()
                and path.lstat().st_mode & 0o077 == 0,
                "protected Worker component offload directory drifted")


def enable_disk_group_offload(pipeline, torch) -> dict[str, Any]:
    from diffusers.hooks import apply_group_offloading

    applied: list[str] = []
    for name in DISK_OFFLOAD_COMPONENTS:
        component = getattr(pipeline, name, None)
        require(component is not None, f"protected Worker {name} component is absent")
        apply_group_offloading(
            component,
            onload_device=torch.device("cuda"),
            offload_device=torch.device("cpu"),
            offload_type="leaf_level",
            use_stream=False,
            low_cpu_mem_usage=True,
            offload_to_disk_path=str(OFFLOAD_ROOT / name),
        )
        applied.append(name)
    # The VAE is small (~168 MB in this exact snapshot) and stays on CUDA.
    # Disk group-offloading it produced finite but nearly uniform decoded
    # tensors on this ARM64/NVIDIA runtime.  Keeping only this bounded
    # component resident preserves image fidelity while the two large
    # components remain leaf-offloaded to the dedicated encrypted volume.
    pipeline.vae.to(device=torch.device("cuda"), dtype=torch.bfloat16)
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    files = [path for path in OFFLOAD_ROOT.rglob("*") if path.is_file()]
    require(files, "protected Worker disk group offload produced no tensor files")
    return {
        "mode": MEMORY_STRATEGY,
        "components": applied,
        "resident_components": list(RESIDENT_CUDA_COMPONENTS),
        "offload_type": "leaf_level",
        "offload_to_disk": True,
        "use_stream": False,
        "low_cpu_memory_usage": True,
        "offload_file_count": len(files),
    }


def load_pipeline():
    global PIPELINE, OFFLOAD_FACTS
    require(snapshot_ready(), "protected BF16 snapshot is incomplete")
    import torch
    from diffusers import Flux2KleinPipeline

    require(torch.cuda.is_available(), "CUDA is unavailable")
    pipeline = Flux2KleinPipeline.from_pretrained(
        MODEL_ROOT, torch_dtype=torch.bfloat16, local_files_only=True,
        low_cpu_mem_usage=True,
    )
    OFFLOAD_FACTS = enable_disk_group_offload(pipeline, torch)
    pipeline.set_progress_bar_config(disable=True)
    # Group-offload hook construction and a real CUDA synchronize are both
    # required before readiness.  Qualification then proves a full first
    # image under the exact aggregate-residency byte ceiling.
    torch.cuda.synchronize()
    PIPELINE = pipeline
    return pipeline


def fatal_cuda() -> dict[str, Any] | None:
    with FATAL_LOCK:
        return None if FATAL_CUDA_ERROR is None else dict(FATAL_CUDA_ERROR)


def _terminate_after_fatal(delay_seconds: int) -> None:
    # A Python thread cannot safely interrupt a hung CUDA kernel.  Withdraw
    # readiness first, then let the exact Docker restart policy replace it.
    if delay_seconds > 0:
        time.sleep(delay_seconds)
    os._exit(70)


def mark_cuda_fatal(code: str, *, restart_delay_seconds: int | None = None) -> None:
    global FATAL_CUDA_ERROR
    with FATAL_LOCK:
        if FATAL_CUDA_ERROR is not None:
            return
        FATAL_CUDA_ERROR = {"code": code, "at_monotonic": time.monotonic()}
    delay = WATCHDOG_GRACE_SECONDS if restart_delay_seconds is None else restart_delay_seconds
    threading.Thread(target=_terminate_after_fatal, args=(delay,), daemon=True,
                     name="fatal-cuda-restart").start()


def is_cuda_fatal(error: BaseException) -> bool:
    message = f"{type(error).__name__}: {error}".lower()
    return any(marker in message for marker in (
        "cuda", "cublas", "cudnn", "out of memory", "illegal memory access",
        "device-side assert", "driver shutting down",
    ))


def prune_jobs(now: float | None = None) -> None:
    current = time.monotonic() if now is None else now
    with JOBS_LOCK:
        expired = [job_id for job_id, record in JOBS.items()
                   if record.completed_monotonic is not None
                   and current - record.completed_monotonic > TERMINAL_JOB_TTL_SECONDS]
        for job_id in expired:
            JOBS.pop(job_id, None)


def active_job_count() -> int:
    with JOBS_LOCK:
        return sum(record.state in {"registered", "running", "cancel_requested"}
                   for record in JOBS.values())


def cuda_memory() -> dict[str, int]:
    import torch
    return {
        "allocated_bytes": torch.cuda.memory_allocated(),
        "reserved_bytes": torch.cuda.memory_reserved(),
        "peak_allocated_bytes": torch.cuda.max_memory_allocated(),
        "peak_reserved_bytes": torch.cuda.max_memory_reserved(),
    }


def _wall_clock_watchdog(record: JobRecord, finished: threading.Event) -> None:
    if finished.wait(REQUEST_TIMEOUT_SECONDS):
        return
    with JOBS_LOCK:
        current = JOBS.get(record.job_id)
        if current is record and current.state in {"registered", "running"}:
            current.state = "cancel_requested"
            current.cancel_reason = "wall_clock_timeout"
            current.cancellation.set()
    if not finished.wait(WATCHDOG_GRACE_SECONDS):
        # The request already consumed the configured watchdog grace.  Exit
        # now instead of accidentally applying the grace period twice.
        mark_cuda_fatal("wall_clock_watchdog_unresponsive", restart_delay_seconds=0)


def _commit_terminal(record: JobRecord, state: str) -> bool:
    """Linearization point shared by completion and cancellation."""
    require(state in TERMINAL_STATES, "invalid terminal job state")
    with JOBS_LOCK:
        current = JOBS.get(record.job_id)
        if current is not record:
            return False
        # A socket failure or another exception after result commit must not
        # rewrite an already terminal job.  This is also the late-cancel
        # boundary observed by the product scheduler.
        if current.state in TERMINAL_STATES:
            return current.state == state
        if state == "succeeded" and current.cancellation.is_set():
            current.state = "cancelled"
            current.completed_monotonic = time.monotonic()
            return False
        current.state = state
        current.completed_monotonic = time.monotonic()
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxFlux2BF16Protected/2"
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def reply(self, status: int, value: dict) -> None:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        # This small service has no reason to keep untrusted client sockets
        # alive.  Closing every response puts an absolute bound on how long a
        # slow/idle peer can occupy one of the four server threads.
        self.close_connection = True
        self.send_response(status)
        self.send_header("connection", "close")
        self.send_header("cache-control", "no-store")
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("x-content-type-options", "nosniff")
        self.end_headers()
        self.wfile.write(encoded)

    def _authorized(self) -> bool:
        values = self.headers.get_all("authorization") or []
        if len(values) != 1:
            self.reply(401, {"error": {"code": "worker_unauthorized"}})
            return False
        value = values[0]
        if not value.startswith("Bearer ") or not secrets.compare_digest(
                value.removeprefix("Bearer "), BEARER_TOKEN):
            self.reply(401, {"error": {"code": "worker_unauthorized"}})
            return False
        return True

    def _owner(self) -> str | None:
        values = self.headers.get_all("x-teamaibox-owner") or []
        if len(values) != 1 or OWNER_ID.fullmatch(values[0]) is None:
            self.reply(400, {"error": {"code": "owner_identity_invalid"}})
            return None
        return values[0].lower()

    def _body(self) -> dict[str, Any]:
        if self.headers.get("transfer-encoding") is not None or self.headers.get("expect") is not None:
            raise ValueError("streamed request bodies are forbidden")
        lengths = self.headers.get_all("content-length") or []
        if len(lengths) != 1 or not lengths[0].isdigit():
            raise ValueError("content length is invalid")
        length = int(lengths[0])
        if length < 2 or length > buffered_bytes():
            raise ValueError("request size is invalid")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError("request body is incomplete")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("request body is invalid")
        return value

    def do_GET(self) -> None:
        if not self._authorized():
            return
        prune_jobs()
        if self.path == "/health":
            loaded = PIPELINE is not None
            fatal = fatal_cuda()
            memory: dict[str, int] = {}
            if fatal is None:
                try:
                    memory = cuda_memory()
                except Exception as error:
                    if is_cuda_fatal(error):
                        mark_cuda_fatal("fatal_cuda_health_probe")
                    fatal = fatal_cuda() or {"code": "cuda_health_unavailable"}
            accepting = loaded and snapshot_ready() and fatal is None
            self.reply(200 if accepting else 503, {
                "status": "ready" if accepting else "unavailable", "model": SERVED_MODEL,
                "loaded": loaded, "accepting": accepting, "warm": loaded,
                "placement_class": "protected-resident", "idle_unload": False,
                "ordinary_drain_allowed": False, "maximum_concurrent_requests": 1,
                "active_jobs": active_job_count(), "operations": ["images.generations"],
                "precision": "bf16", "fatal_cuda": fatal is not None,
                "wall_clock_timeout_seconds": REQUEST_TIMEOUT_SECONDS,
                "job_tombstone_capacity": MAX_JOB_TOMBSTONES,
                "memory_strategy": OFFLOAD_FACTS,
                "kv_cache": {"applicability": "not-applicable-image-diffusion-pipeline",
                             "explicit_bytes": None},
                # Do not call back into CUDA after a fatal context error.  A
                # health request must be able to withdraw readiness while the
                # restart watchdog is still counting down.
                "cuda_memory": memory if fatal is None else {},
            })
            return
        if self.path == "/v1/models":
            if fatal_cuda() is not None:
                self.reply(503, {"error": {"code": "cuda_context_unready"}})
                return
            self.reply(200, {"object": "list", "data": [{
                "id": SERVED_MODEL, "object": "model", "owned_by": "teamaibox",
                "x_teamaibox": {"precision": "bf16", "placement_class": "protected-resident",
                                "operations": ["images.generations"],
                                "memory_strategy": MEMORY_STRATEGY},
            }]})
            return
        self.reply(404, {"error": {"code": "not_found"}})

    def do_POST(self) -> None:
        if not self._authorized():
            return
        owner_id = self._owner()
        if owner_id is None:
            return
        prune_jobs()
        if fatal_cuda() is not None:
            self.reply(503, {"error": {"code": "cuda_context_unready"}})
            return
        if self.path == "/v1/models/prepare":
            self.reply(200, {"status": "ready", "model": SERVED_MODEL,
                             "loaded": PIPELINE is not None, "warm": PIPELINE is not None})
            return
        if self.path == "/v1/models/unload":
            self.reply(409, {"error": {"code": "protected_resident_unload_forbidden",
                                        "message": "ordinary unload is disabled"}})
            return
        match = re.fullmatch(r"/v1/images/generations/([0-9a-f-]{36})/cancel", self.path, re.I)
        if match and JOB_ID.fullmatch(match.group(1)):
            job_id = match.group(1).lower()
            owner_mismatch = False
            with JOBS_LOCK:
                record = JOBS.get(job_id)
                if record is not None and record.owner_id != owner_id:
                    owner_mismatch = True
                    accepted = False
                    terminal_state = record.state
                else:
                    accepted = record is not None and record.state in {"registered", "running"}
                    if accepted:
                        record.state = "cancel_requested"
                        record.cancel_reason = "owner_requested"
                        record.cancellation.set()
                    terminal_state = None if record is None else record.state
            # Never hold the global job-state lock while writing to an
            # untrusted socket: a Slowloris client must not stop cancellation
            # or completion for every other job.
            if owner_mismatch:
                self.reply(403, {"error": {"code": "job_owner_mismatch"}})
                return
            self.reply(200, {"cancelled": accepted, "job_id": job_id, "state": terminal_state})
            return
        if self.path == "/v1/images/edits":
            self.reply(400, {"error": {"code": "unsupported_operation"}})
            return
        if self.path != "/v1/images/generations":
            self.reply(404, {"error": {"code": "not_found"}})
            return
        self._generation(owner_id)

    def _generation(self, owner_id: str) -> None:
        acquired = False
        record: JobRecord | None = None
        finished = threading.Event()
        try:
            body = self._body()
            if body.get("model") != SERVED_MODEL or body.get("response_format") != "b64_json":
                raise ValueError("model or response format is invalid")
            prompt = body.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                raise ValueError("prompt is invalid")
            if body.get("n", 1) != 1 or body.get("size", "512x512") != "512x512":
                raise ValueError("this profile supports one 512x512 result")
            extension = body.get("x_teamaibox") or {}
            job_id = extension.get("job_id")
            if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
                raise ValueError("job identifier is invalid")
            job_id = job_id.lower()
            if extension.get("steps", 4) != 4 or float(extension.get("guidance_scale", 1.0)) != 1.0:
                raise ValueError("steps and guidance are fixed")
            seed = extension.get("seed", 0)
            if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 4_294_967_295:
                raise ValueError("seed is invalid")
            acquired = REQUEST_SLOT.acquire(blocking=False)
            if not acquired:
                self.reply(429, {"error": {"code": "maximum_concurrency_exceeded"}})
                return
            record = JobRecord(job_id=job_id, owner_id=owner_id)
            with JOBS_LOCK:
                if job_id in JOBS:
                    raise ValueError("job identifier was already used")
                if len(JOBS) >= MAX_JOB_TOMBSTONES:
                    raise JobRegistryFull("bounded job tombstone registry is full")
                JOBS[job_id] = record
                record.state = "running"
            threading.Thread(target=_wall_clock_watchdog, args=(record, finished), daemon=True,
                             name=f"watchdog-{job_id}").start()
            started = time.monotonic()
            import torch
            final_latent_metrics: dict[str, float | int] = {}

            def cancelled(_pipeline, _step, _timestep, callback_kwargs):
                if record is not None and record.cancellation.is_set():
                    if record.cancel_reason == "wall_clock_timeout":
                        raise WallClockTimeout("wall clock timeout")
                    raise WorkerCancelled("cancelled")
                latents = callback_kwargs.get("latents")
                if latents is not None and not torch.isfinite(latents).all().item():
                    raise NonFiniteInference(
                        f"non-finite diffusion latents after step {_step}"
                    )
                if latents is not None:
                    observed_latents = latents.detach().float()
                    final_latent_metrics.clear()
                    final_latent_metrics.update({
                        "step": int(_step),
                        "minimum": float(observed_latents.min().item()),
                        "maximum": float(observed_latents.max().item()),
                        "standard_deviation": float(observed_latents.std().item()),
                    })
                return callback_kwargs

            with PIPELINE_LOCK:
                if record.cancellation.is_set():
                    raise WorkerCancelled("cancelled")
                postprocessed = PIPELINE(
                    prompt=prompt, height=512, width=512, num_inference_steps=4,
                    guidance_scale=1.0,
                    generator=torch.Generator(device="cuda").manual_seed(seed),
                    callback_on_step_end=cancelled,
                    output_type="pt",
                ).images
                if not torch.isfinite(postprocessed).all().item():
                    raise NonFiniteInference("non-finite decoded image tensor")
                observed_output = postprocessed.detach().float()
                output_tensor_metrics = {
                    "minimum": float(observed_output.min().item()),
                    "maximum": float(observed_output.max().item()),
                    "standard_deviation": float(observed_output.std().item()),
                }
                # output_type="pt" is already VaeImageProcessor-postprocessed
                # into [0, 1].  Calling postprocess() again would denormalize a
                # second time and compress the image into [0.5, 1], producing a
                # pale, low-variance result even though inference was finite.
                image = PIPELINE.image_processor.numpy_to_pil(
                    PIPELINE.image_processor.pt_to_numpy(postprocessed)
                )[0].convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            image.close()
            if not _commit_terminal(record, "succeeded"):
                raise WorkerCancelled("cancelled before result commit")
            self.reply(200, {
                "created": int(time.time()),
                "data": [{"b64_json": base64.b64encode(buffer.getvalue()).decode(),
                          "revised_prompt": None}],
                "x_teamaibox": {
                    "seed": seed, "steps": 4, "guidance_scale": 1.0,
                    "width": 512, "height": 512, "output_format": "png",
                    "precision": "bf16", "placement_class": "protected-resident",
                    "duration_milliseconds": round((time.monotonic() - started) * 1000),
                    "owner_bound": True, "linearizable_cancellation": True,
                    "inference_metrics": {
                        "final_latents": final_latent_metrics,
                        "output_tensor": output_tensor_metrics,
                    },
                },
            })
        except JobRegistryFull:
            self.reply(503, {"error": {"code": "job_registry_capacity_exceeded"}})
        except TimeoutError:
            if record is not None:
                _commit_terminal(record, "failed")
            self.reply(408, {"error": {"code": "request_body_timeout"}})
        except ValueError as error:
            if record is not None:
                _commit_terminal(record, "failed")
            self.reply(400, {"error": {"code": "invalid_request", "message": str(error)}})
        except WallClockTimeout:
            if record is not None:
                _commit_terminal(record, "timed_out")
            self.reply(504, {"error": {"code": "worker_wall_clock_timeout"}})
        except WorkerCancelled:
            if record is not None:
                _commit_terminal(record, "cancelled")
            self.reply(409, {"error": {"code": "worker_cancelled"}})
        except Exception as error:
            if record is not None:
                _commit_terminal(record, "failed")
            print(json.dumps(safe_error_diagnostic(error), sort_keys=True, separators=(",", ":")),
                  file=sys.stderr, flush=True)
            if is_cuda_fatal(error):
                mark_cuda_fatal("fatal_cuda_inference")
                self.reply(503, {"error": {"code": "cuda_context_unready"}})
            else:
                self.reply(500, {"error": {"code": "worker_failed"}})
        finally:
            finished.set()
            if acquired:
                REQUEST_SLOT.release()


class ProtectedServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8
    allow_reuse_address = False

    def __init__(self, *args, **kwargs):
        self._thread_slots = threading.BoundedSemaphore(MAX_SERVER_THREADS)
        super().__init__(*args, **kwargs)

    def get_request(self) -> tuple[socket, Any]:
        request, address = super().get_request()
        request.settimeout(SOCKET_READ_TIMEOUT_SECONDS)
        return request, address

    def process_request(self, request: socket, client_address: Any) -> None:
        if not self._thread_slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n"
                                b"Content-Length: 0\r\nCache-Control: no-store\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._thread_slots.release()
            raise

    def process_request_thread(self, request: socket, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._thread_slots.release()


def main() -> None:
    global BEARER_TOKEN
    require(SERVED_MODEL == "flux2-klein-4b-bf16", "served-model identity is invalid")
    require(MAX_CONCURRENCY == 1, "protected BF16 concurrency must remain one")
    require(IDLE_UNLOAD_SECONDS == 0, "protected BF16 idle unload must remain disabled")
    require(30 <= REQUEST_TIMEOUT_SECONDS <= 1800, "request timeout is outside safe range")
    require(5 <= WATCHDOG_GRACE_SECONDS <= 120, "watchdog grace is outside safe range")
    require(1 <= SOCKET_READ_TIMEOUT_SECONDS <= 30, "socket timeout is outside safe range")
    require(3 <= MAX_SERVER_THREADS <= 16, "server thread bound is outside safe range")
    require(60 <= TERMINAL_JOB_TTL_SECONDS <= 3600, "job tombstone TTL is outside safe range")
    require(128 <= MAX_JOB_TOMBSTONES <= 65_536,
            "job tombstone capacity is outside safe range")
    require(MEMORY_STRATEGY == "leaf-level-group-offload-to-dedicated-disk-volume-with-resident-vae",
            "protected BF16 memory strategy is invalid")
    BEARER_TOKEN = load_bearer_token()
    prepare_offload_root()
    load_pipeline()
    ProtectedServer(("0.0.0.0", 8000), Handler).serve_forever()


if __name__ == "__main__":
    main()
