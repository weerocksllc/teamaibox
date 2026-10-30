#!/usr/bin/env python3
"""Generation-only OpenAI worker for bounded Qwen and LongCat profiles."""

from __future__ import annotations

import base64
try:
    from services.media_io.resources import buffered_bytes
except ModuleNotFoundError:
    from media_resources import buffered_bytes
import gc
import io
import json
import math
import os
from pathlib import Path
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


KIND = os.environ.get("TEAMAIBOX_DRAWING_SPECIALIST_KIND", "")
SERVED_MODEL = os.environ.get("TEAMAIBOX_DRAWING_SERVED_MODEL", "")
MODEL_ROOT = Path(os.environ.get("TEAMAIBOX_DRAWING_MODEL_ROOT", "/model"))
ADAPTER_ROOT = Path(os.environ.get("TEAMAIBOX_DRAWING_ADAPTER_ROOT", "/model/adapter"))
IDLE_UNLOAD_SECONDS = int(os.environ.get("TEAMAIBOX_DRAWING_IDLE_UNLOAD_SECONDS", "180"))
JOB_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
QWEN_WEIGHT = "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors"
PIPELINE = None
PIPELINE_LOCK = threading.Lock()
LOAD_LOCK = threading.Lock()
JOBS_LOCK = threading.Lock()
JOB_CANCELLATIONS = {}
LAST_USED = time.monotonic()


class WorkerCancelled(RuntimeError):
    pass


def snapshot_ready():
    if KIND == "qwen-image-2512-lightning":
        return ((MODEL_ROOT / "model_index.json").is_file()
                and (ADAPTER_ROOT / QWEN_WEIGHT).is_file())
    if KIND == "longcat-image":
        return ((MODEL_ROOT / "model_index.json").is_file()
                and (MODEL_ROOT / "transformer/diffusion_pytorch_model.safetensors").is_file())
    return False


def load_pipeline():
    global PIPELINE
    if PIPELINE is not None:
        return PIPELINE
    with LOAD_LOCK:
        if PIPELINE is not None:
            return PIPELINE
        import torch
        if KIND == "qwen-image-2512-lightning":
            from diffusers import FlowMatchEulerDiscreteScheduler, QwenImagePipeline
            from diffusers.models import QwenImageTransformer2DModel
            scheduler = FlowMatchEulerDiscreteScheduler.from_config({
                "base_image_seq_len": 256, "base_shift": math.log(3), "invert_sigmas": False,
                "max_image_seq_len": 8192, "max_shift": math.log(3), "num_train_timesteps": 1000,
                "shift": 1.0, "shift_terminal": None, "stochastic_sampling": False,
                "time_shift_type": "exponential", "use_beta_sigmas": False,
                "use_dynamic_shifting": True, "use_exponential_sigmas": False,
                "use_karras_sigmas": False})
            transformer = QwenImageTransformer2DModel.from_pretrained(MODEL_ROOT,
                subfolder="transformer", torch_dtype=torch.bfloat16, local_files_only=True,
                device_map="cuda")
            pipeline = QwenImagePipeline.from_pretrained(MODEL_ROOT, transformer=transformer,
                scheduler=scheduler, torch_dtype=torch.bfloat16, local_files_only=True,
                device_map="cuda")
            pipeline.load_lora_weights(ADAPTER_ROOT, weight_name=QWEN_WEIGHT, adapter_name="lightning")
            pipeline.set_adapters(["lightning"], adapter_weights=[1.0])
        elif KIND == "longcat-image":
            from diffusers import LongCatImagePipeline
            pipeline = LongCatImagePipeline.from_pretrained(MODEL_ROOT, torch_dtype=torch.bfloat16,
                local_files_only=True, device_map="cuda")
        else:
            raise RuntimeError("unsupported specialist kind")
        pipeline.set_progress_bar_config(disable=True)
        PIPELINE = pipeline
    return PIPELINE


def unload():
    global PIPELINE
    with PIPELINE_LOCK, LOAD_LOCK:
        PIPELINE = None
        gc.collect()
        import torch
        torch.cuda.empty_cache()
        torch.cuda.synchronize()


def touch():
    global LAST_USED
    LAST_USED = time.monotonic()


def idle_unloader():
    while True:
        time.sleep(min(15, max(1, IDLE_UNLOAD_SECONDS // 4)))
        with JOBS_LOCK:
            active = bool(JOB_CANCELLATIONS)
        if active or PIPELINE is None or time.monotonic() - LAST_USED < IDLE_UNLOAD_SECONDS:
            continue
        unload()


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxDrawingSpecialistWorker/1"

    def log_message(self, _format, *_args):
        return

    def reply(self, status, value):
        raw = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path != "/health":
            self.reply(404, {"error": {"code": "not_found"}})
            return
        accepting = snapshot_ready()
        self.reply(200 if accepting else 503, {"status": "ready" if accepting else "unavailable",
            "model": SERVED_MODEL, "loaded": PIPELINE is not None, "accepting": accepting,
            "operations": ["images.generations"]})

    def do_POST(self):
        global PIPELINE
        if self.path == "/v1/models/prepare":
            try:
                load_pipeline()
                touch()
                self.reply(200, {"status": "ready", "model": SERVED_MODEL, "loaded": True})
            except Exception:
                self.reply(500, {"error": {"code": "worker_prepare_failed"}})
            return
        if self.path == "/v1/models/unload":
            with JOBS_LOCK:
                if JOB_CANCELLATIONS:
                    self.reply(409, {"error": {"code": "worker_busy"}})
                    return
            unload()
            self.reply(200, {"status": "unloaded", "model": SERVED_MODEL, "loaded": False})
            return
        match = re.fullmatch(r"/v1/images/generations/([0-9a-f-]{36})/cancel", self.path, re.I)
        if match and JOB_ID.fullmatch(match.group(1)):
            with JOBS_LOCK:
                cancellation = JOB_CANCELLATIONS.get(match.group(1))
                if cancellation is not None:
                    cancellation.set()
            self.reply(200, {"cancelled": cancellation is not None, "job_id": match.group(1)})
            return
        if self.path == "/v1/images/edits":
            self.reply(400, {"error": {"code": "unsupported_operation"}})
            return
        if self.path != "/v1/images/generations":
            self.reply(404, {"error": {"code": "not_found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 2 or length > buffered_bytes():
                raise ValueError("request size is invalid")
            body = json.loads(self.rfile.read(length))
            if body.get("model") != SERVED_MODEL or body.get("response_format") != "b64_json":
                raise ValueError("model or response format is invalid")
            prompt = body.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                raise ValueError("prompt is invalid")
            if body.get("n", 1) != 1 or body.get("size", "512x512") not in {"256x256", "512x512"}:
                raise ValueError("only one 512x512 result is supported")
            extension = body.get("x_teamaibox") or {}
            job_id = extension.get("job_id")
            if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
                raise ValueError("job identifier is invalid")
            seed = extension.get("seed", 0)
            if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 4_294_967_295:
                raise ValueError("seed is invalid")
            expected_steps = 4 if KIND == "qwen-image-2512-lightning" else 50
            expected_guidance = 1.0 if KIND == "qwen-image-2512-lightning" else 4.0
            if extension.get("steps", expected_steps) != expected_steps:
                raise ValueError("steps are fixed by the qualified profile")
            if float(extension.get("guidance_scale", expected_guidance)) != expected_guidance:
                raise ValueError("guidance scale is fixed by the qualified profile")
            import torch
            cancellation = threading.Event()
            with JOBS_LOCK:
                if job_id in JOB_CANCELLATIONS:
                    raise ValueError("job is already active")
                JOB_CANCELLATIONS[job_id] = cancellation
            started = time.monotonic()
            try:
                pipe = load_pipeline()
                touch()

                def cancelled(_pipeline, _step, _timestep, kwargs):
                    if cancellation.is_set():
                        raise WorkerCancelled("cancelled")
                    return kwargs

                arguments = {"prompt": prompt, "width": 512, "height": 512,
                    "num_inference_steps": expected_steps,
                    "generator": torch.Generator(device="cuda").manual_seed(seed)}
                if KIND == "qwen-image-2512-lightning":
                    arguments.update({"negative_prompt": "低分辨率，低画质，肢体畸形，文字模糊，扭曲。",
                        "true_cfg_scale": expected_guidance, "callback_on_step_end": cancelled})
                else:
                    # LongCatImagePipeline currently exposes no cooperative step callback.
                    # Its Provider therefore advertises cancellationMode=none rather than
                    # passing Qwen's unsupported callback and failing during inference.
                    arguments.update({"guidance_scale": expected_guidance,
                        "enable_cfg_renorm": True, "enable_prompt_rewrite": False})
                with PIPELINE_LOCK:
                    if cancellation.is_set():
                        raise WorkerCancelled("cancelled")
                    image = pipe(**arguments).images[0].convert("RGB")
                touch()
            finally:
                with JOBS_LOCK:
                    JOB_CANCELLATIONS.pop(job_id, None)
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            image.close()
            self.reply(200, {"created": int(time.time()),
                "data": [{"b64_json": base64.b64encode(buffer.getvalue()).decode(), "revised_prompt": None}],
                "x_teamaibox": {"seed": seed, "steps": expected_steps,
                    "guidance_scale": expected_guidance, "width": 512, "height": 512,
                    "output_format": "png", "preset_key": extension.get("preset_key", "drawing.specialist.v1"),
                    "duration_milliseconds": round((time.monotonic() - started) * 1000)}})
        except ValueError as error:
            self.reply(400, {"error": {"code": "invalid_request", "message": str(error)}})
        except WorkerCancelled:
            self.reply(409, {"error": {"code": "worker_cancelled"}})
        except Exception:
            self.reply(500, {"error": {"code": "worker_failed"}})


def main():
    if KIND not in {"qwen-image-2512-lightning", "longcat-image"} or not SERVED_MODEL:
        raise RuntimeError("specialist identity is invalid")
    if not 10 <= IDLE_UNLOAD_SECONDS <= 86400:
        raise RuntimeError("idle unload interval is invalid")
    threading.Thread(target=idle_unloader, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()


if __name__ == "__main__":
    main()
