"""Hardened OpenAI-style FLUX.2 Klein NVFP4 Worker backed by Stock ComfyUI."""

from __future__ import annotations

import base64
try:
    from services.media_io.resources import buffered_bytes
except ModuleNotFoundError:
    from media_resources import buffered_bytes
import io
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SERVED_MODEL = os.environ.get("TEAMAIBOX_DRAWING_SERVED_MODEL", "flux2-klein-4b-nvfp4")
MODEL_NAME = "flux-2-klein-4b-nvfp4.safetensors"
CLIP_NAME = "qwen_3_4b.safetensors"
VAE_NAME = "full_encoder_small_decoder.safetensors"
MODEL_ROOT = Path(os.environ.get("TEAMAIBOX_DRAWING_MODEL_ROOT", "/model/nvfp4"))
COMPONENT_ROOT = Path(os.environ.get("TEAMAIBOX_DRAWING_COMPONENT_ROOT", "/components"))
COMFY_ROOT = Path(os.environ.get("TEAMAIBOX_COMFY_ROOT", "/opt/comfyui"))
WORK_ROOT = Path(os.environ.get("TEAMAIBOX_DRAWING_WORK_ROOT", "/tmp/teamaibox-flux2-worker"))
COMFY_ORIGIN = "http://127.0.0.1:8188"
MAX_REFERENCES = 3
JOB_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
IDLE_UNLOAD_SECONDS = int(os.environ.get("TEAMAIBOX_DRAWING_IDLE_UNLOAD_SECONDS", "300"))


class WorkerError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def bounded_int(value: Any, name: str, minimum: int, maximum: int, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise WorkerError("invalid_request", f"{name} is invalid")
    return value


def bounded_number(value: Any, name: str, minimum: float, maximum: float, default: float) -> float:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
        raise WorkerError("invalid_request", f"{name} is invalid")
    return float(value)


def decode_image(value: Any, name: str) -> Any:
    from PIL import Image
    if not isinstance(value, str) or not 4 <= len(value) <= buffered_bytes():
        raise WorkerError("invalid_request", f"{name} is invalid")
    raw = bytearray()
    try:
        raw.extend(base64.b64decode(value, validate=True))
        if not 1 <= len(raw) <= buffered_bytes():
            raise ValueError()
        image = Image.open(io.BytesIO(raw))
        if image.width < 1 or image.height < 1 or image.width * image.height * 4 > buffered_bytes():
            raise ValueError()
        image.load()
        return image.convert("RGB")
    except Exception as error:
        raise WorkerError("invalid_request", f"{name} is invalid") from error
    finally:
        raw[:] = b"\0" * len(raw)


def loaders() -> dict[str, Any]:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": MODEL_NAME, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP_NAME, "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_NAME}},
    }


def generation_workflow(prompt: str, seed: int, prefix: str, width: int, height: int,
                        steps: int) -> dict[str, Any]:
    value = loaders()
    value.update({
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "cfg": 1.0}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "10": {"class_type": "Flux2Scheduler", "inputs": {"steps": steps, "width": width, "height": height}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["7", 0], "guider": ["8", 0], "sampler": ["9", 0], "sigmas": ["10", 0], "latent_image": ["6", 0]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}},
    })
    return value


def edit_workflow(prompt: str, seed: int, prefix: str, filenames: list[str],
                  width: int, height: int, steps: int) -> dict[str, Any]:
    if not 1 <= len(filenames) <= MAX_REFERENCES:
        raise WorkerError("invalid_request", "reference image count is invalid")
    value = loaders()
    value.update({
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "7": {"class_type": "Flux2Scheduler", "inputs": {"steps": steps, "width": width, "height": height}},
        "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    })
    positive: list[Any] = ["4", 0]
    negative: list[Any] = ["5", 0]
    node = 20
    for filename in filenames:
        load, encode, positive_ref, negative_ref = (str(node + offset) for offset in range(4))
        value[load] = {"class_type": "LoadImage", "inputs": {"image": filename}}
        value[encode] = {"class_type": "VAEEncode", "inputs": {"pixels": [load, 0], "vae": ["3", 0]}}
        value[positive_ref] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": positive, "latent": [encode, 0]}}
        value[negative_ref] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": negative, "latent": [encode, 0]}}
        positive, negative = [positive_ref, 0], [negative_ref, 0]
        node += 4
    value.update({
        "10": {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": positive, "negative": negative, "cfg": 1.0}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["8", 0], "guider": ["10", 0], "sampler": ["9", 0], "sigmas": ["7", 0], "latent_image": ["6", 0]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}},
    })
    return value


class ComfyRuntime:
    def __init__(self) -> None:
        self.input = WORK_ROOT / "input"
        self.output = WORK_ROOT / "output"
        self.temp = WORK_ROOT / "temp"
        self.user = WORK_ROOT / "user"
        self.log_path = WORK_ROOT / "comfy.log"
        self.process: subprocess.Popen[Any] | None = None
        self.api_lock = threading.Lock()
        self.loaded = False
        self.last_used = time.monotonic()

    def api(self, path: str, payload: dict[str, Any] | None = None, timeout: int = 30) -> Any:
        raw = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        request = Request(COMFY_ORIGIN + path, data=raw, headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=timeout) as response:
            body = response.read()
            return json.loads(body) if body else {}

    def start(self) -> None:
        if self.process is not None:
            return
        if not (MODEL_ROOT / MODEL_NAME).is_file() or not (COMPONENT_ROOT / "text_encoders" / CLIP_NAME).is_file() \
                or not (COMPONENT_ROOT / "vae" / VAE_NAME).is_file():
            raise RuntimeError("FLUX.2 runtime components are missing")
        for path in (self.input, self.output, self.temp, self.user):
            path.mkdir(parents=True, exist_ok=True)
        extra = WORK_ROOT / "extra-model-paths.yaml"
        extra.write_text("teamaibox:\n  base_path: /\n  diffusion_models: model/nvfp4\n  text_encoders: components/text_encoders\n  vae: components/vae\n", encoding="utf-8")
        log = self.log_path.open("w", encoding="utf-8")
        command = ["python3", str(COMFY_ROOT / "main.py"), "--listen", "127.0.0.1", "--port", "8188",
            "--disable-auto-launch", "--disable-metadata", "--disable-all-custom-nodes", "--disable-api-nodes",
            "--cache-none", "--reserve-vram", "8", "--use-pytorch-cross-attention", "--disable-async-offload",
            "--extra-model-paths-config", str(extra), "--output-directory", str(self.output),
            "--input-directory", str(self.input), "--temp-directory", str(self.temp),
            "--user-directory", str(self.user)]
        self.process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=os.environ.copy())
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError("ComfyUI exited during startup")
            if self.ready():
                return
            time.sleep(0.5)
        raise RuntimeError("ComfyUI startup timed out")

    def ready(self) -> bool:
        if self.process is None or self.process.poll() is not None:
            return False
        try:
            return len(self.api("/system_stats", timeout=2).get("devices", [])) == 1
        except (OSError, HTTPError, URLError, TimeoutError, json.JSONDecodeError):
            return False

    def submit(self, workflow: dict[str, Any], client_id: str) -> str:
        value = self.api("/prompt", {"prompt": workflow, "client_id": client_id})
        prompt_id = value.get("prompt_id")
        if not isinstance(prompt_id, str):
            raise WorkerError("workflow_rejected", "ComfyUI rejected the drawing workflow", 502)
        return prompt_id

    def wait(self, prompt_id: str, timeout: int = 1800) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.api("/history/" + prompt_id)
            if prompt_id in value:
                return value[prompt_id]
            time.sleep(0.2)
        raise WorkerError("worker_timeout", "The drawing workflow timed out", 504)

    def result_path(self, history: dict[str, Any]) -> Path:
        images: list[dict[str, Any]] = []
        for output in history.get("outputs", {}).values():
            images.extend(output.get("images", []))
        if len(images) != 1 or images[0].get("type") != "output":
            raise WorkerError("worker_output_invalid", "The drawing output manifest is invalid", 502)
        relative = Path(images[0].get("subfolder", "")) / str(images[0].get("filename", ""))
        if relative.is_absolute() or ".." in relative.parts:
            raise WorkerError("worker_output_invalid", "The drawing output path is unsafe", 502)
        path = self.output / relative
        if not path.is_file() or not 1 <= path.stat().st_size <= buffered_bytes():
            raise WorkerError("worker_output_invalid", "The drawing output is invalid", 502)
        return path

    def free(self) -> None:
        self.api("/free", {"unload_models": True, "free_memory": True}, timeout=60)
        self.loaded = False


class Application:
    def __init__(self, runtime: ComfyRuntime):
        self.runtime = runtime
        self.capacity = threading.BoundedSemaphore(1)
        self.active_lock = threading.Lock()
        self.active: dict[str, str | None] = {}

    def health(self) -> tuple[int, dict[str, Any]]:
        accepting = self.runtime.ready()
        return (200 if accepting else 503), {"status": "ready" if accepting else "unavailable",
            "model": SERVED_MODEL, "cuda": accepting, "loaded": self.runtime.loaded, "accepting": accepting,
            "operations": ["images.generations", "images.edits"], "maximum_reference_images": MAX_REFERENCES}

    def control(self, action: str) -> tuple[int, dict[str, Any]]:
        if action == "prepare":
            if not self.runtime.ready():
                raise WorkerError("worker_unavailable", "The FLUX.2 runtime is unavailable", 503)
            if self.runtime.loaded:
                return 200, {"status": "ready", "model": SERVED_MODEL, "loaded": True}
            if not self.capacity.acquire(blocking=False):
                raise WorkerError("worker_busy", "The drawing Worker is busy", 409)
            warmup_id = "00000000-0000-4000-8000-000000000001"
            output_path: Path | None = None
            with self.active_lock:
                self.active[warmup_id] = None
            try:
                workflow = generation_workflow("neutral grey calibration tile", 1,
                                               "teamaibox-warmup", 256, 256, 1)
                prompt_id = self.runtime.submit(workflow, "teamaibox-warmup")
                with self.active_lock:
                    self.active[warmup_id] = prompt_id
                history = self.runtime.wait(prompt_id)
                status = history.get("status", {})
                if status.get("completed") is not True or status.get("status_str") != "success":
                    raise WorkerError("worker_prepare_failed", "The FLUX.2 model could not be prepared", 503)
                output_path = self.runtime.result_path(history)
                self.runtime.loaded = True
                self.runtime.last_used = time.monotonic()
                return 200, {"status": "ready", "model": SERVED_MODEL, "loaded": True}
            finally:
                with self.active_lock:
                    self.active.pop(warmup_id, None)
                if output_path is not None:
                    output_path.unlink(missing_ok=True)
                try:
                    self.runtime.api("/history", {"clear": True}, timeout=10)
                except Exception:
                    pass
                self.capacity.release()
        if action != "unload":
            raise WorkerError("invalid_request", "model control action is invalid")
        with self.active_lock:
            if self.active:
                raise WorkerError("worker_busy", "The drawing Worker is busy", 409)
        self.runtime.free()
        return 200, {"status": "unloaded", "model": SERVED_MODEL, "loaded": False}

    def cancel(self, job_id: str) -> tuple[int, dict[str, Any]]:
        with self.active_lock:
            prompt_id = self.active.get(job_id)
            cancellable = job_id in self.active and isinstance(prompt_id, str)
        if cancellable:
            self.runtime.api("/interrupt", {}, timeout=10)
        return 200, {"cancelled": cancellable, "job_id": job_id, "prompt_id": prompt_id}

    def execute(self, editing: bool, body: Any) -> tuple[int, dict[str, Any]]:
        from PIL import Image
        if not isinstance(body, dict) or body.get("model") != SERVED_MODEL or body.get("response_format") != "b64_json":
            raise WorkerError("invalid_request", "model or response format is invalid")
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise WorkerError("invalid_request", "prompt is invalid")
        if body.get("mask_b64") is not None:
            raise WorkerError("capability_unsupported", "FLUX.2 Klein does not support masked editing", 422)
        extension = body.get("x_teamaibox") or {}
        if not isinstance(extension, dict):
            raise WorkerError("invalid_request", "drawing extensions are invalid")
        if extension.get("negative_prompt") not in {None, ""}:
            raise WorkerError("capability_unsupported", "This distilled FLUX.2 profile does not support negative prompts", 422)
        job_id = extension.get("job_id")
        if not isinstance(job_id, str) or JOB_ID.fullmatch(job_id) is None:
            raise WorkerError("invalid_request", "job identifier is invalid")
        n = bounded_int(body.get("n"), "n", 1, 4, 1)
        size = body.get("size", "512x512")
        try:
            width, height = (int(item) for item in size.split("x", 1))
        except (AttributeError, TypeError, ValueError) as error:
            raise WorkerError("invalid_request", "size is invalid") from error
        if width % 64 or height % 64 or not 256 <= width <= 1024 or not 256 <= height <= 1024:
            raise WorkerError("invalid_request", "size is invalid")
        seed = bounded_int(extension.get("seed"), "seed", 0, 4_294_967_295, 0)
        requested_steps = bounded_int(extension.get("steps"), "steps", 1, 80, 4)
        steps = min(requested_steps, 12)
        bounded_number(extension.get("guidance_scale"), "guidance_scale", 0, 20, 1.0)
        output_format = extension.get("output_format", "png")
        if output_format not in {"png", "jpeg", "webp"}:
            raise WorkerError("invalid_request", "output format is invalid")
        encoded_references: list[Any] = []
        if editing:
            encoded_references.append(body.get("image_b64"))
            extra_references = extension.get("reference_images_b64", [])
            if not isinstance(extra_references, list) or len(extra_references) > MAX_REFERENCES - 1:
                raise WorkerError("invalid_request", "reference images are invalid")
            encoded_references.extend(extra_references)
        if not self.capacity.acquire(blocking=False):
            raise WorkerError("drawing_capacity_exhausted", "The drawing Worker is busy", 429)
        started = time.monotonic()
        references: list[Any] = []
        source_paths: list[Path] = []
        output_paths: list[Path] = []
        with self.active_lock:
            if job_id in self.active:
                self.capacity.release()
                raise WorkerError("invalid_request", "job is already active")
            self.active[job_id] = None
        try:
            for index, value in enumerate(encoded_references):
                references.append(decode_image(value, "source image" if index == 0 else "reference image"))
            filenames = []
            for index, image in enumerate(references):
                path = self.runtime.input / f"{job_id}-reference-{index}.png"
                image.resize((width, height), Image.Resampling.LANCZOS).save(path, format="PNG")
                source_paths.append(path)
                filenames.append(path.name)
            data = []
            for index in range(n):
                prefix = f"teamaibox-{job_id}-{index}"
                workflow = (edit_workflow(prompt, seed + index, prefix, filenames, width, height, steps)
                            if editing else generation_workflow(prompt, seed + index, prefix, width, height, steps))
                prompt_id = self.runtime.submit(workflow, "teamaibox-" + job_id)
                with self.active_lock:
                    self.active[job_id] = prompt_id
                history = self.runtime.wait(prompt_id)
                status = history.get("status", {})
                if status.get("completed") is not True or status.get("status_str") != "success":
                    raise WorkerError("worker_cancelled" if status.get("status_str") == "error" else "worker_failed",
                                      "The drawing workflow did not complete", 409 if status.get("status_str") == "error" else 500)
                path = self.runtime.result_path(history)
                output_paths.append(path)
                with Image.open(path) as opened:
                    buffer = io.BytesIO()
                    opened.convert("RGB").save(buffer, format={"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[output_format])
                data.append({"b64_json": base64.b64encode(buffer.getvalue()).decode(), "revised_prompt": None})
            self.runtime.loaded = True
            self.runtime.last_used = time.monotonic()
            return 200, {"created": int(time.time()), "data": data, "x_teamaibox": {
                "seed": seed, "steps": steps, "requested_steps": requested_steps, "guidance_scale": 1.0,
                "requested_guidance_scale": extension.get("guidance_scale", 1.0), "width": width, "height": height,
                "output_format": output_format, "preset_key": extension.get("preset_key", "drawing.fast.v1"),
                "reference_count": len(references), "masked_editing": False,
                "duration_milliseconds": round((time.monotonic() - started) * 1000)}}
        finally:
            with self.active_lock:
                self.active.pop(job_id, None)
            for image in references:
                image.close()
            for path in (*source_paths, *output_paths):
                path.unlink(missing_ok=True)
            try:
                self.runtime.api("/history", {"clear": True}, timeout=10)
            except Exception:
                pass
            self.capacity.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxFlux2DrawingWorker/1"

    @property
    def application(self) -> Application:
        return self.server.application  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def reply(self, status: int, value: Any) -> None:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.send_header("x-content-type-options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding"):
            raise WorkerError("invalid_request_framing", "chunked request bodies are unsupported")
        try:
            length = int(self.headers.get("content-length", "-1"))
        except ValueError as error:
            raise WorkerError("invalid_request_framing", "Content-Length is invalid") from error
        if not 2 <= length <= buffered_bytes():
            raise WorkerError("request_too_large", "request size is invalid", 413)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise WorkerError("invalid_request_framing", "request body is incomplete")
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise WorkerError("invalid_request", "request body is invalid JSON") from error

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.reply(404, {"error": {"code": "not_found"}})
            return
        status, value = self.application.health()
        self.reply(status, value)

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path in {"/v1/models/prepare", "/v1/models/unload"}:
                status, value = self.application.control(self.path.rsplit("/", 1)[1])
            else:
                match = re.fullmatch(r"/v1/images/(?:generations|edits)/([0-9a-f-]+)/cancel", self.path, re.I)
                if match and JOB_ID.fullmatch(match.group(1)):
                    status, value = self.application.cancel(match.group(1))
                elif self.path in {"/v1/images/generations", "/v1/images/edits"}:
                    status, value = self.application.execute(self.path.endswith("/edits"), self.read_json())
                else:
                    self.reply(404, {"error": {"code": "not_found"}})
                    return
            self.reply(status, value)
        except WorkerError as error:
            self.reply(error.status, {"error": {"code": error.code, "message": str(error)}})
        except Exception:
            self.reply(500, {"error": {"code": "worker_failed", "message": "The drawing Worker failed"}})


def idle_unloader(application: Application) -> None:
    while True:
        time.sleep(min(15, max(1, IDLE_UNLOAD_SECONDS // 4)))
        with application.active_lock:
            active = bool(application.active)
        if not active and application.runtime.loaded and time.monotonic() - application.runtime.last_used >= IDLE_UNLOAD_SECONDS:
            try:
                application.runtime.free()
            except Exception:
                pass


def main() -> int:
    if not 10 <= IDLE_UNLOAD_SECONDS <= 86400:
        raise RuntimeError("idle unload interval is invalid")
    runtime = ComfyRuntime()
    runtime.start()
    application = Application(runtime)
    threading.Thread(target=idle_unloader, args=(application,), daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", 8000), Handler)
    server.daemon_threads = True
    server.application = application  # type: ignore[attr-defined]
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        if runtime.process is not None and runtime.process.poll() is None:
            runtime.process.terminate()
            runtime.process.wait(timeout=30)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
