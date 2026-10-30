import base64
try:
    from services.media_io.resources import buffered_bytes
except ModuleNotFoundError:
    from media_resources import buffered_bytes
import gc
import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from diffusers import StableDiffusionXLImg2ImgPipeline, StableDiffusionXLInpaintPipeline, StableDiffusionXLPipeline
from PIL import Image


MODEL_ROOT = Path(os.environ.get("TEAMAIBOX_DRAWING_MODEL_ROOT", "/models/sdxl-base-1.0-fp16"))
SERVED_MODEL = os.environ.get("TEAMAIBOX_DRAWING_SERVED_MODEL", "sdxl-base-1.0-fp16")
PIPELINE = None
EDIT_PIPELINE = None
INPAINT_PIPELINE = None
PIPELINE_LOCK = threading.Lock()
LOAD_LOCK = threading.Lock()
JOBS_LOCK = threading.Lock()
JOB_CANCELLATIONS = {}
JOB_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
IDLE_UNLOAD_SECONDS = int(os.environ.get("TEAMAIBOX_DRAWING_IDLE_UNLOAD_SECONDS", "300"))
LAST_USED = time.monotonic()


class WorkerCancelled(Exception):
    pass


def bounded_int(value, name, minimum, maximum, default):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError(f"{name} is invalid")
    return value


def bounded_float(value, name, minimum, maximum, default):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < minimum or value > maximum:
        raise ValueError(f"{name} is invalid")
    return float(value)


def load_pipeline():
    global PIPELINE
    if PIPELINE is not None:
        return PIPELINE
    with LOAD_LOCK:
        if PIPELINE is None:
            manifest = json.loads((MODEL_ROOT / "teamaibox-model-manifest.json").read_text(encoding="utf-8"))
            if manifest.get("revision") != os.environ["TEAMAIBOX_DRAWING_MODEL_REVISION"] or manifest.get("variant") != "fp16":
                raise RuntimeError("model snapshot evidence is invalid")
            pipeline = StableDiffusionXLPipeline.from_pretrained(
                MODEL_ROOT,
                torch_dtype=torch.float16,
                variant="fp16",
                use_safetensors=True,
                local_files_only=True,
                add_watermarker=True,
            )
            pipeline.to("cuda")
            pipeline.enable_attention_slicing()
            pipeline.set_progress_bar_config(disable=True)
            PIPELINE = pipeline
    return PIPELINE


def snapshot_ready():
    try:
        manifest = json.loads((MODEL_ROOT / "teamaibox-model-manifest.json").read_text(encoding="utf-8"))
        return (manifest.get("revision") == os.environ["TEAMAIBOX_DRAWING_MODEL_REVISION"]
                and manifest.get("variant") == "fp16" and manifest.get("totalBytes", 0) > 0)
    except Exception:
        return False


def touch():
    global LAST_USED
    LAST_USED = time.monotonic()


def idle_unloader():
    global PIPELINE, EDIT_PIPELINE, INPAINT_PIPELINE
    while True:
        time.sleep(min(15, max(1, IDLE_UNLOAD_SECONDS // 4)))
        with JOBS_LOCK:
            active = bool(JOB_CANCELLATIONS)
        if active or PIPELINE is None or time.monotonic() - LAST_USED < IDLE_UNLOAD_SECONDS:
            continue
        with PIPELINE_LOCK, LOAD_LOCK:
            with JOBS_LOCK:
                if JOB_CANCELLATIONS or time.monotonic() - LAST_USED < IDLE_UNLOAD_SECONDS:
                    continue
            INPAINT_PIPELINE = None
            EDIT_PIPELINE = None
            PIPELINE = None
            gc.collect()
            torch.cuda.empty_cache()
            print(json.dumps({"event": "drawing_worker_model_unloaded", "idleSeconds": IDLE_UNLOAD_SECONDS}), flush=True)


def decode_image(value, name, mode):
    if not isinstance(value, str) or len(value) < 4 or len(value) > buffered_bytes():
        raise ValueError(f"{name} is invalid")
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) < 1 or len(raw) > buffered_bytes():
            raise ValueError()
        image = Image.open(io.BytesIO(raw))
        if image.width < 1 or image.height < 1 or image.width * image.height * 4 > buffered_bytes():
            raise ValueError()
        image.load()
        return image.convert(mode)
    except Exception as error:
        raise ValueError(f"{name} is invalid") from error


def edit_pipeline(masked):
    global EDIT_PIPELINE, INPAINT_PIPELINE
    base = load_pipeline()
    with LOAD_LOCK:
        if masked and INPAINT_PIPELINE is None:
            INPAINT_PIPELINE = StableDiffusionXLInpaintPipeline.from_pipe(base)
            INPAINT_PIPELINE.set_progress_bar_config(disable=True)
        if not masked and EDIT_PIPELINE is None:
            EDIT_PIPELINE = StableDiffusionXLImg2ImgPipeline.from_pipe(base)
            EDIT_PIPELINE.set_progress_bar_config(disable=True)
    return INPAINT_PIPELINE if masked else EDIT_PIPELINE


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxDrawingWorker/1"

    def log_message(self, format, *args):
        return

    def reply(self, status, value):
        encoded = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("cache-control", "no-store")
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path != "/health":
            self.reply(404, {"error": {"code": "not_found"}})
            return
        loaded = PIPELINE is not None
        accepting = torch.cuda.is_available() and snapshot_ready()
        self.reply(200 if accepting else 503, {
            "status": "ready" if accepting else "unavailable",
            "model": SERVED_MODEL,
            "cuda": torch.cuda.is_available(),
            "loaded": loaded,
            "accepting": accepting,
        })

    def do_POST(self):
        if self.path == "/v1/models/prepare":
            try:
                load_pipeline()
                touch()
                self.reply(200, {"status": "ready", "model": SERVED_MODEL, "loaded": True})
            except Exception:
                self.reply(500, {"error": {"code": "worker_prepare_failed"}})
            return
        if self.path == "/v1/models/unload":
            global PIPELINE, EDIT_PIPELINE, INPAINT_PIPELINE
            with JOBS_LOCK:
                if JOB_CANCELLATIONS:
                    self.reply(409, {"error": {"code": "worker_busy"}})
                    return
            with PIPELINE_LOCK, LOAD_LOCK:
                INPAINT_PIPELINE = None
                EDIT_PIPELINE = None
                PIPELINE = None
                gc.collect()
                torch.cuda.empty_cache()
            self.reply(200, {"status": "unloaded", "model": SERVED_MODEL, "loaded": False})
            return
        match = re.fullmatch(r"/v1/images/(?:generations|edits)/([0-9a-f-]+)/cancel", self.path)
        if match:
            job_id = match.group(1)
            if not JOB_ID.fullmatch(job_id):
                self.reply(400, {"error": {"code": "invalid_request", "message": "job identifier is invalid"}})
                return
            with JOBS_LOCK:
                cancellation = JOB_CANCELLATIONS.get(job_id)
                if cancellation is not None:
                    cancellation.set()
            self.reply(200, {"cancelled": cancellation is not None, "job_id": job_id})
            return
        if self.path not in {"/v1/images/generations", "/v1/images/edits"}:
            self.reply(404, {"error": {"code": "not_found"}})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length < 2 or length > buffered_bytes():
                raise ValueError("request size is invalid")
            body = json.loads(self.rfile.read(length))
            if body.get("model") != SERVED_MODEL or body.get("response_format") != "b64_json":
                raise ValueError("model or response format is invalid")
            prompt = body.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                raise ValueError("prompt is invalid")
            n = bounded_int(body.get("n"), "n", 1, 4, 1)
            size = body.get("size", "1024x1024")
            sizes = {"512x512": (512, 512), "768x768": (768, 768), "1024x1024": (1024, 1024), "1024x768": (1024, 768), "768x1024": (768, 1024)}
            if size not in sizes:
                raise ValueError("size is invalid")
            width, height = sizes[size]
            editing = self.path == "/v1/images/edits"
            source = decode_image(body.get("image_b64"), "source image", "RGB") if editing else None
            mask = decode_image(body.get("mask_b64"), "mask image", "L") if editing and body.get("mask_b64") is not None else None
            if source is not None:
                source = source.resize((width, height), Image.Resampling.LANCZOS)
            if mask is not None:
                mask = mask.resize((width, height), Image.Resampling.NEAREST)
            extension = body.get("x_teamaibox") or {}
            job_id = extension.get("job_id")
            if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
                raise ValueError("job identifier is invalid")
            seed = bounded_int(extension.get("seed"), "seed", 0, 4_294_967_295, 0)
            steps = bounded_int(extension.get("steps"), "steps", 1, 80, 28)
            guidance = bounded_float(extension.get("guidance_scale"), "guidance_scale", 0, 20, 7.0)
            strength = bounded_float(extension.get("strength"), "strength", 0.01, 1.0, 0.65) if editing else None
            output_format = extension.get("output_format", "png")
            if output_format not in {"png", "jpeg", "webp"}:
                raise ValueError("output format is invalid")
            generator = torch.Generator(device="cuda").manual_seed(seed)
            started = time.monotonic()
            cancellation = threading.Event()
            with JOBS_LOCK:
                if job_id in JOB_CANCELLATIONS:
                    raise ValueError("job is already active")
                JOB_CANCELLATIONS[job_id] = cancellation
            try:
                pipeline = edit_pipeline(mask is not None) if editing else load_pipeline()
                touch()
                def cancelled(_pipeline, _step_index, _timestep, callback_kwargs):
                    if cancellation.is_set():
                        raise WorkerCancelled()
                    return callback_kwargs

                with PIPELINE_LOCK:
                    if cancellation.is_set():
                        raise WorkerCancelled()
                    arguments = dict(
                        prompt=prompt,
                        negative_prompt=extension.get("negative_prompt") or None,
                        num_images_per_prompt=n,
                        num_inference_steps=steps,
                        guidance_scale=guidance,
                        generator=generator,
                        callback_on_step_end=cancelled,
                    )
                    if editing:
                        arguments.update(image=source, strength=strength)
                        if mask is not None:
                            arguments.update(mask_image=mask, width=width, height=height)
                    else:
                        arguments.update(width=width, height=height)
                    images = pipeline(**arguments).images
                    touch()
            finally:
                with JOBS_LOCK:
                    JOB_CANCELLATIONS.pop(job_id, None)
            data = []
            for image in images:
                buffer = io.BytesIO()
                image.save(buffer, format={"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[output_format])
                data.append({"b64_json": base64.b64encode(buffer.getvalue()).decode(), "revised_prompt": None})
            self.reply(200, {
                "created": int(time.time()),
                "data": data,
                "x_teamaibox": {
                    "seed": seed,
                    "steps": steps,
                    "guidance_scale": guidance,
                    "width": width,
                    "height": height,
                    "output_format": output_format,
                    "preset_key": extension.get("preset_key", "drawing.balanced.v1"),
                    "strength": strength,
                    "duration_milliseconds": round((time.monotonic() - started) * 1000),
                },
            })
        except ValueError as error:
            self.reply(400, {"error": {"code": "invalid_request", "message": str(error)}})
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            self.reply(503, {"error": {"code": "worker_out_of_memory"}})
        except WorkerCancelled:
            torch.cuda.empty_cache()
            self.reply(409, {"error": {"code": "worker_cancelled"}})
        except Exception:
            self.reply(500, {"error": {"code": "worker_failed"}})


if __name__ == "__main__":
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required")
    if not 10 <= IDLE_UNLOAD_SECONDS <= 86400:
        raise RuntimeError("idle unload interval is invalid")
    threading.Thread(target=idle_unloader, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
