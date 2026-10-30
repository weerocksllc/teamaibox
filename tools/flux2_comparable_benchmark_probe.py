#!/usr/bin/env python3
"""Measure comparable FLUX.2 BF16/NVFP4 cold and warm image latency."""

from __future__ import annotations

import argparse
import base64
import gc
import hashlib
import io
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
from typing import Any


PROMPT = "Studio product photograph of a mint green ceramic smart speaker on a pale wood desk, soft daylight, no text"
SEEDS = (42001, 42002, 42003, 42004)
JOB_IDS = tuple(f"42000000-0000-4000-8000-{index:012d}" for index in range(1, 5))
MODEL = "flux2-klein-4b-nvfp4"


class ProbeError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProbeError(message)


def image_facts(raw: bytes) -> dict[str, Any]:
    from PIL import Image, ImageStat
    with Image.open(io.BytesIO(raw)) as opened:
        image = opened.convert("RGB")
    variance = sum(ImageStat.Stat(image).var) / 3
    require(image.size == (512, 512) and variance >= 80, "benchmark output is visually empty")
    return {"bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
            "width": image.width, "height": image.height}


def call(path: str, body: dict[str, Any], timeout: int = 1800) -> tuple[int, dict[str, Any]]:
    raw = json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request("http://127.0.0.1:8000" + path, data=raw,
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def nvfp4() -> dict[str, Any]:
    started = time.monotonic()
    results = []
    for index, seed in enumerate(SEEDS):
        case_started = time.monotonic()
        body = {"model": MODEL, "prompt": PROMPT, "n": 1, "size": "512x512",
                "response_format": "b64_json", "x_teamaibox": {
                    "job_id": JOB_IDS[index], "seed": seed, "steps": 4,
                    "guidance_scale": 1.0, "output_format": "png",
                    "preset_key": "drawing.fast.benchmark.v1"}}
        status, value = call("/v1/images/generations", body)
        error_code = value.get("error", {}).get("code") if isinstance(value, dict) else None
        require(status == 200, f"NVFP4 generation failed: HTTP {status}, code={error_code}")
        encoded = value.get("data", [{}])[0].get("b64_json")
        require(isinstance(encoded, str), "NVFP4 output is missing")
        decoded = bytearray(base64.b64decode(encoded, validate=True))
        try:
            facts = image_facts(bytes(decoded))
        finally:
            decoded[:] = b"\0" * len(decoded)
        results.append({"position": "cold" if index == 0 else "warm", "seed": seed,
                        "durationSeconds": time.monotonic() - case_started, "output": facts})
    status, unloaded = call("/v1/models/unload", {})
    require(status == 200 and unloaded.get("loaded") is False, "NVFP4 unload failed")
    return {"profile": "nvfp4", "loadSeconds": None,
            "coldFirstResultSeconds": results[0]["durationSeconds"], "results": results,
            "unloaded": True, "durationSeconds": time.monotonic() - started}


def bf16(model_root: Path) -> dict[str, Any]:
    import torch
    from diffusers import Flux2KleinPipeline

    require(model_root.is_dir(), "BF16 model root is missing")
    started = time.monotonic()
    load_started = time.monotonic()
    pipeline = Flux2KleinPipeline.from_pretrained(
        model_root, torch_dtype=torch.bfloat16, local_files_only=True)
    pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=True)
    load_seconds = time.monotonic() - load_started
    results = []
    for index, seed in enumerate(SEEDS):
        case_started = time.monotonic()
        image = pipeline(prompt=PROMPT, height=512, width=512, num_inference_steps=4,
                         guidance_scale=1.0,
                         generator=torch.Generator(device="cuda").manual_seed(seed)).images[0]
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="PNG")
        raw = bytearray(buffer.getvalue())
        try:
            facts = image_facts(bytes(raw))
        finally:
            raw[:] = b"\0" * len(raw)
        results.append({"position": "cold" if index == 0 else "warm", "seed": seed,
                        "durationSeconds": time.monotonic() - case_started, "output": facts})
    del pipeline
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    require(torch.cuda.memory_allocated() <= 64 * 1024 * 1024, "BF16 unload retained CUDA allocations")
    return {"profile": "bf16", "loadSeconds": load_seconds,
            "coldFirstResultSeconds": load_seconds + results[0]["durationSeconds"],
            "results": results, "unloaded": True, "durationSeconds": time.monotonic() - started}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("bf16", "nvfp4"), required=True)
    parser.add_argument("--model-root", type=Path, default=Path("/model"))
    args = parser.parse_args()
    try:
        result = bf16(args.model_root) if args.profile == "bf16" else nvfp4()
        value = {"schemaVersion": 1, "runnerId": "teamaibox.flux2-comparable-benchmark-probe.v1",
                 "status": "passed", "benchmark": result, "failure": None}
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.flux2-comparable-benchmark-probe.v1",
                 "status": "failed", "benchmark": None,
                 "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
