#!/usr/bin/env python3
"""Run bounded FLUX.2 Klein generation, edit, multi-reference and cancellation probes."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from pathlib import Path
import re
import time
from typing import Any


RUN_ID = re.compile(r"^flux2-klein-runtime-20[0-9]{6}-a[1-9][0-9]*$")
PROFILES = {"bf16", "nvfp4"}


class ProbeError(RuntimeError):
    pass


class ExpectedCancellation(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProbeError(message)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            value.update(chunk)
    return "sha256:" + value.hexdigest()


def case_plan() -> list[dict[str, Any]]:
    return [
        {"key": "generation", "seed": 31001, "prompt": "Studio product photograph of a mint green ceramic smart speaker on a pale wood desk, soft daylight, no text"},
        {"key": "edit", "seed": 31002, "prompt": "Keep the composition and change the red square into a glossy green ceramic tile"},
        {"key": "multi-reference", "seed": 31003, "prompt": "Create a clean catalog scene containing the red tile from reference one and the blue circle from reference two"},
    ]


def load_pipeline(profile: str, root: Path, torch: Any, classes: tuple[Any, Any]) -> Any:
    pipeline_class, transformer_class = classes
    common = {"torch_dtype": torch.bfloat16, "local_files_only": True}
    if profile == "bf16":
        return pipeline_class.from_pretrained(root, **common)
    base = root / "base"
    transformer_path = root / "nvfp4" / "flux-2-klein-4b-nvfp4.safetensors"
    require(transformer_path.is_file() and (base / "transformer" / "config.json").is_file(),
            "NVFP4 candidate components are incomplete")
    transformer = transformer_class.from_single_file(
        str(transformer_path),
        config=str(base / "transformer"),
        torch_dtype=torch.bfloat16,
        local_files_only=True,
    )
    return pipeline_class.from_pretrained(str(base), transformer=transformer, **common)


def save_image(image: Any, path: Path) -> dict[str, Any]:
    image.save(path, format="PNG")
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": digest(path),
            "width": image.width, "height": image.height}


def run(profile: str, model_root: Path, output_root: Path, run_id: str) -> dict[str, Any]:
    require(profile in PROFILES and RUN_ID.fullmatch(run_id) is not None, "invalid runtime probe identity")
    require(model_root.is_dir() and output_root.is_dir(), "runtime probe roots must exist")
    require(not any(output_root.iterdir()), "runtime probe output root must be empty")
    import torch
    from diffusers import Flux2KleinPipeline, Flux2Transformer2DModel
    from PIL import Image, ImageDraw

    require(torch.cuda.is_available(), "CUDA is unavailable")
    started = time.monotonic()
    torch.cuda.reset_peak_memory_stats()
    pipeline = load_pipeline(profile, model_root, torch, (Flux2KleinPipeline, Flux2Transformer2DModel))
    pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=True)
    load_seconds = time.monotonic() - started

    source_one = Image.new("RGB", (512, 512), "white")
    drawing_one = ImageDraw.Draw(source_one)
    drawing_one.rectangle((96, 96, 416, 416), fill=(208, 40, 48))
    source_two = Image.new("RGB", (512, 512), "white")
    drawing_two = ImageDraw.Draw(source_two)
    drawing_two.ellipse((96, 96, 416, 416), fill=(32, 96, 208))
    outputs = []
    cases = []
    plan = case_plan()
    for item in plan:
        case_started = time.monotonic()
        arguments: dict[str, Any] = {
            "prompt": item["prompt"], "height": 512, "width": 512,
            "num_inference_steps": 4, "guidance_scale": 1.0,
            "generator": torch.Generator(device="cuda").manual_seed(item["seed"]),
        }
        if item["key"] == "edit":
            arguments["image"] = source_one
        elif item["key"] == "multi-reference":
            arguments["image"] = [source_one, source_two]
        image = pipeline(**arguments).images[0]
        output = save_image(image, output_root / f"{profile}-{item['key']}.png")
        outputs.append(output)
        cases.append({"key": item["key"], "seed": item["seed"], "steps": 4,
                      "guidanceScale": 1.0, "durationSeconds": time.monotonic() - case_started,
                      "output": output})

    callback_calls = 0

    def cancel_callback(_pipeline: Any, _step: int, _timestep: Any, callback_kwargs: dict[str, Any]) -> dict[str, Any]:
        nonlocal callback_calls
        callback_calls += 1
        raise ExpectedCancellation("bounded cancellation probe")

    cancellation_started = time.monotonic()
    cancelled = False
    try:
        pipeline(
            prompt="A detailed technical illustration of a compact edge AI appliance",
            height=512, width=512, num_inference_steps=4, guidance_scale=1.0,
            generator=torch.Generator(device="cuda").manual_seed(31004),
            callback_on_step_end=cancel_callback,
        )
    except ExpectedCancellation:
        cancelled = True
    require(cancelled and callback_calls == 1, "cooperative cancellation did not stop at the first callback")
    cancellation = {"passed": True, "callbackCalls": callback_calls,
                    "durationSeconds": time.monotonic() - cancellation_started}
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    del pipeline
    gc.collect()
    torch.cuda.empty_cache()
    synchronize_started = time.monotonic()
    torch.cuda.synchronize()
    unload = {"passed": True, "allocatedBytesAfter": torch.cuda.memory_allocated(),
              "reservedBytesAfter": torch.cuda.memory_reserved(),
              "durationSeconds": time.monotonic() - synchronize_started}
    require(unload["allocatedBytesAfter"] <= 64 * 1024 * 1024,
            "pipeline unload retained unexpected allocated CUDA memory")
    return {
        "schemaVersion": 1, "runnerId": "teamaibox.flux2-klein-runtime-probe.v1",
        "runId": run_id, "status": "passed", "profile": profile,
        "loadSeconds": load_seconds, "cases": cases, "cancellation": cancellation,
        "resources": {"peakCudaAllocatedBytes": peak_allocated, "peakCudaReservedBytes": peak_reserved},
        "unload": unload, "outputs": outputs, "durationSeconds": time.monotonic() - started,
        "failure": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=sorted(PROFILES), required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    try:
        value = run(args.profile, args.model_root.resolve(), args.output_root.resolve(), args.run_id)
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.flux2-klein-runtime-probe.v1",
                 "runId": args.run_id, "status": "failed", "profile": args.profile,
                 "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
