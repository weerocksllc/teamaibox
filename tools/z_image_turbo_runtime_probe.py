#!/usr/bin/env python3
"""Run bounded Z-Image-Turbo generation-only quality and lifecycle probes."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from pathlib import Path
import re
import time
from typing import Any


RUN_ID = re.compile(r"^z-image-turbo-runtime-[0-9]{8}-a[1-9][0-9]*$")


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


def cases() -> list[dict[str, Any]]:
    return [
        {"key": "english-text", "seed": 52001,
         "prompt": "A clean technology poster with the exact large English text EDGE AI, dark green and cream, crisp typography"},
        {"key": "chinese-text", "seed": 52002,
         "prompt": "一张极简科技海报，画面中央清晰显示准确中文大字“团队智能”，深绿色与米白色，排版清晰"},
        {"key": "portrait", "seed": 52003,
         "prompt": "Professional studio portrait of an East Asian product designer, natural skin texture, soft rim light, neutral background"},
        {"key": "product-a", "seed": 52004,
         "prompt": "Premium product photograph of a compact black edge AI appliance on a walnut desk, soft daylight, no text"},
        {"key": "product-b", "seed": 52005,
         "prompt": "Premium product photograph of a compact black edge AI appliance on a walnut desk, soft daylight, no text"},
    ]


def save(image: Any, path: Path) -> dict[str, Any]:
    image.save(path, format="PNG")
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": digest(path),
            "width": image.width, "height": image.height}


def run(model_root: Path, output_root: Path, run_id: str, cycle: str) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) is not None and model_root.is_dir() and output_root.is_dir(),
            "invalid Z-Image runtime probe identity or root")
    require(cycle in {"cycle1", "cycle2"}, "invalid Z-Image load cycle")
    import torch
    from diffusers import ZImagePipeline

    require(torch.cuda.is_available(), "CUDA is unavailable")
    started = time.monotonic()
    torch.cuda.reset_peak_memory_stats()
    pipeline = ZImagePipeline.from_pretrained(str(model_root), torch_dtype=torch.bfloat16,
                                              local_files_only=True)
    pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=True)
    load_seconds = time.monotonic() - started
    outputs = []
    observations = []
    for item in cases():
        case_started = time.monotonic()
        image = pipeline(prompt=item["prompt"], height=512, width=512, num_inference_steps=9,
                         guidance_scale=0.0,
                         generator=torch.Generator(device="cuda").manual_seed(item["seed"])).images[0]
        output = save(image, output_root / (cycle + "-" + item["key"] + ".png"))
        outputs.append(output)
        observations.append({"key": item["key"], "seed": item["seed"], "steps": 9,
                             "guidanceScale": 0.0,
                             "durationSeconds": time.monotonic() - case_started, "output": output})
    require(len({item["sha256"] for item in outputs}) == len(outputs),
            "Z-Image diversity probe produced duplicate outputs")

    callback_calls = 0

    def cancel(_pipeline: Any, _step: int, _timestep: Any, callback_kwargs: dict[str, Any]) -> dict[str, Any]:
        nonlocal callback_calls
        callback_calls += 1
        raise ExpectedCancellation("bounded Z-Image cancellation")

    cancelled = False
    cancel_started = time.monotonic()
    try:
        pipeline(prompt="A detailed illustration of an edge AI appliance", height=512, width=512,
                 num_inference_steps=9, guidance_scale=0.0,
                 generator=torch.Generator(device="cuda").manual_seed(52006), callback_on_step_end=cancel)
    except ExpectedCancellation:
        cancelled = True
    require(cancelled and callback_calls == 1, "Z-Image cooperative cancellation failed")
    cancellation = {"passed": True, "callbackCalls": callback_calls,
                    "durationSeconds": time.monotonic() - cancel_started}
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    del pipeline
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    unload = {"passed": True, "allocatedBytesAfter": torch.cuda.memory_allocated(),
              "reservedBytesAfter": torch.cuda.memory_reserved()}
    require(unload["allocatedBytesAfter"] <= 64 * 1024 * 1024,
            "Z-Image unload retained unexpected allocated CUDA memory")
    return {"schemaVersion": 1, "runnerId": "teamaibox.z-image-turbo-runtime-probe.v1",
        "runId": run_id, "status": "passed", "profile": "z-image-turbo-bf16", "cycle": cycle,
        "capabilities": {"generation": True, "editing": False, "multiReference": False},
        "loadSeconds": load_seconds, "cases": observations, "diversity": {"distinctOutputs": 5, "passed": True},
        "cancellation": cancellation,
        "resources": {"peakCudaAllocatedBytes": peak_allocated, "peakCudaReservedBytes": peak_reserved},
        "unload": unload, "outputs": outputs, "durationSeconds": time.monotonic() - started, "failure": None}


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
        value = {"schemaVersion": 1, "runnerId": "teamaibox.z-image-turbo-runtime-probe.v1",
                 "runId": args.run_id, "status": "failed", "profile": "z-image-turbo-bf16",
                 "cycle": args.cycle,
                 "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
