#!/usr/bin/env python3
"""Run bounded GLM-Image generation, edit, multi-reference and lifecycle probes."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from pathlib import Path
import re
import time
from typing import Any


RUN_ID = re.compile(r"^glm-image-runtime-[0-9]{8}-a[1-9][0-9]*$")


class ProbeError(RuntimeError):
    pass


class ExpectedCancellation(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ProbeError(message)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            value.update(chunk)
    return "sha256:" + value.hexdigest()


def save(image: Any, path: Path) -> dict[str, Any]:
    image.save(path, format="PNG")
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": digest(path),
            "width": image.width, "height": image.height}


def reference_images() -> tuple[Any, Any]:
    from PIL import Image, ImageDraw

    first = Image.new("RGB", (512, 512), "#f1ede4")
    draw = ImageDraw.Draw(first)
    draw.rounded_rectangle((120, 130, 390, 380), radius=24, fill="#171d1a")
    draw.ellipse((238, 240, 270, 272), fill="#6dd6a5")
    second = Image.new("RGB", (512, 512), "#dcebf6")
    draw = ImageDraw.Draw(second)
    draw.ellipse((125, 125, 387, 387), fill="#3273b8")
    return first, second


def run(model_root: Path, output_root: Path, run_id: str, cycle: str) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) is not None and model_root.is_dir() and output_root.is_dir(),
            "invalid GLM-Image runtime probe identity or root")
    require(cycle in {"cycle1", "cycle2"}, "invalid GLM-Image load cycle")
    import torch
    from diffusers import GlmImagePipeline

    require(torch.cuda.is_available(), "CUDA is unavailable")
    torch.manual_seed(62100)
    torch.cuda.reset_peak_memory_stats()
    load_started = time.monotonic()
    pipeline = GlmImagePipeline.from_pretrained(str(model_root), torch_dtype=torch.bfloat16,
                                                local_files_only=True, device_map="cuda")
    pipeline.set_progress_bar_config(disable=True)
    load_seconds = time.monotonic() - load_started
    outputs: list[dict[str, Any]] = []
    cases: list[dict[str, Any]] = []
    generation_cases = [
        ("english-text", 62101,
         "Minimal technology poster with the exact quoted text \"EDGE AI\", dark green on cream, clean typography"),
        ("chinese-text", 62102,
         "极简科技海报，画面中央清晰显示准确中文大字“团队智能”，深绿色与米白色，排版清晰"),
    ]
    for key, seed, prompt in generation_cases:
        started = time.monotonic()
        torch.manual_seed(seed)
        image = pipeline(prompt=prompt, height=512, width=512, num_inference_steps=20,
                         guidance_scale=1.5,
                         generator=torch.Generator(device="cuda").manual_seed(seed)).images[0]
        output = save(image, output_root / f"{cycle}-{key}.png")
        image.close()
        outputs.append(output)
        cases.append({"key": key, "operation": "generation", "seed": seed, "steps": 20,
                      "guidanceScale": 1.5, "durationSeconds": time.monotonic() - started,
                      "output": output})
    if cycle == "cycle1":
        first, second = reference_images()
        operation_cases = [
            ("edit", 62103, [first],
             "Keep the compact black edge AI device shape and place it on a walnut desk under soft studio light."),
            ("multi-reference", 62104, [first, second],
             "Create a premium product poster combining the compact black edge AI device from the first reference with the blue circular motif from the second reference, no text."),
        ]
        for key, seed, images, prompt in operation_cases:
            started = time.monotonic()
            torch.manual_seed(seed)
            image = pipeline(prompt=prompt, image=images, height=512, width=512,
                             num_inference_steps=20, guidance_scale=1.5,
                             generator=torch.Generator(device="cuda").manual_seed(seed)).images[0]
            output = save(image, output_root / f"{cycle}-{key}.png")
            image.close()
            outputs.append(output)
            cases.append({"key": key, "operation": "edit" if key == "edit" else "multi-reference",
                          "seed": seed, "steps": 20, "guidanceScale": 1.5,
                          "referenceCount": len(images), "durationSeconds": time.monotonic() - started,
                          "output": output})
        first.close()
        second.close()
    require(len({item["sha256"] for item in outputs}) == len(outputs),
            "GLM-Image cycle produced duplicate outputs")

    callback_calls = 0

    def cancel(_pipeline: Any, _step: int, _timestep: Any,
               callback_kwargs: dict[str, Any]) -> dict[str, Any]:
        nonlocal callback_calls
        callback_calls += 1
        raise ExpectedCancellation("bounded GLM-Image cancellation")

    cancelled = False
    cancel_started = time.monotonic()
    try:
        pipeline(prompt="A detailed product illustration", height=512, width=512,
                 num_inference_steps=20, guidance_scale=1.5,
                 generator=torch.Generator(device="cuda").manual_seed(62105), callback_on_step_end=cancel)
    except ExpectedCancellation:
        cancelled = True
    require(cancelled and callback_calls == 1, "GLM-Image cooperative cancellation failed")
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    del pipeline
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    unload = {"passed": True, "allocatedBytesAfter": torch.cuda.memory_allocated(),
              "reservedBytesAfter": torch.cuda.memory_reserved()}
    require(unload["allocatedBytesAfter"] <= 64 * 1024 * 1024,
            "GLM-Image unload retained unexpected CUDA allocation")
    return {"schemaVersion": 1, "runnerId": "teamaibox.glm-image-runtime-probe.v1",
        "runId": run_id, "status": "passed", "profile": "glm-image-bf16", "cycle": cycle,
        "capabilities": {"generation": True, "editing": True, "multiReference": True},
        "loadSeconds": load_seconds, "cases": cases,
        "diversity": {"distinctOutputs": len(outputs), "passed": True},
        "cancellation": {"passed": True, "callbackCalls": callback_calls,
                         "durationSeconds": time.monotonic() - cancel_started},
        "resources": {"peakCudaAllocatedBytes": peak_allocated,
                      "peakCudaReservedBytes": peak_reserved},
        "unload": unload, "outputs": outputs, "failure": None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--cycle", choices=("cycle1", "cycle2"), required=True)
    args = parser.parse_args()
    try:
        value = run(args.model_root.resolve(), args.output_root.resolve(), args.run_id, args.cycle)
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.glm-image-runtime-probe.v1",
                 "runId": args.run_id, "status": "failed", "profile": "glm-image-bf16",
                 "cycle": args.cycle,
                 "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
