#!/usr/bin/env python3
"""Run bounded LongCat generation or edit lifecycle probes on Spark."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from pathlib import Path
import re
import time
from typing import Any

RUN_ID = re.compile(r"^longcat-image-runtime-[0-9]{8}-a[1-9][0-9]*$")


class ProbeError(RuntimeError):
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


def reference(seed: int) -> Any:
    from PIL import Image, ImageDraw
    image = Image.new("RGB", (512, 512), "#efe9df" if seed % 2 else "#dfeaf4")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((96, 118, 416, 394), radius=36, fill="#17211d")
    draw.ellipse((232, 238, 280, 286), fill="#6fd8aa" if seed % 2 else "#5e93da")
    return image


def run(kind: str, model_root: Path, output_root: Path, run_id: str, cycle: str) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) and kind in {"generation", "edit"}
            and model_root.is_dir() and output_root.is_dir() and cycle in {"cycle1", "cycle2"},
            "invalid LongCat runtime probe identity or root")
    import torch
    from diffusers import LongCatImageEditPipeline, LongCatImagePipeline

    require(torch.cuda.is_available(), "CUDA is unavailable")
    torch.cuda.reset_peak_memory_stats()
    load_started = time.monotonic()
    pipeline_class = LongCatImagePipeline if kind == "generation" else LongCatImageEditPipeline
    pipeline = pipeline_class.from_pretrained(str(model_root), torch_dtype=torch.bfloat16,
                                              local_files_only=True, device_map="cuda")
    pipeline.set_progress_bar_config(disable=True)
    load_seconds = time.monotonic() - load_started
    cases: list[dict[str, Any]] = []
    outputs: list[dict[str, Any]] = []
    prompts = [
        (73101, "Minimal technology poster with the exact quoted text EDGE AI, dark green on cream, clean typography"),
        (73102, "极简科技海报，画面中央清晰显示中文大字“团队智能”，深绿色与米白色，排版清晰"),
    ]
    for index, (seed, prompt) in enumerate(prompts, start=1):
        started = time.monotonic()
        generator = torch.Generator(device="cuda").manual_seed(seed)
        if kind == "generation":
            image = pipeline(prompt=prompt, height=512, width=512, num_inference_steps=12,
                             guidance_scale=4.0, enable_cfg_renorm=True,
                             enable_prompt_rewrite=False, generator=generator).images[0]
            steps = 12
            guidance = 4.0
        else:
            source = reference(seed)
            image = pipeline(image=source, prompt="Keep the device geometry, " + prompt,
                             num_inference_steps=8, guidance_scale=1.0,
                             generator=generator).images[0]
            source.close()
            steps = 8
            guidance = 1.0
        output = save(image, output_root / f"{kind}-{cycle}-{index}.png")
        image.close()
        outputs.append(output)
        cases.append({"key": f"{kind}-{index}", "seed": seed, "steps": steps,
            "guidanceScale": guidance, "durationSeconds": time.monotonic() - started,
            "output": output})
    require(len({item["sha256"] for item in outputs}) == 2, "LongCat cycle produced duplicate outputs")
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    del pipeline
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    unload = {"passed": True, "allocatedBytesAfter": torch.cuda.memory_allocated(),
              "reservedBytesAfter": torch.cuda.memory_reserved()}
    require(unload["allocatedBytesAfter"] <= 64 * 1024 * 1024,
            "LongCat unload retained unexpected CUDA allocation")
    return {"schemaVersion": 1, "runnerId": "teamaibox.longcat-image-runtime-probe.v1",
        "runId": run_id, "status": "passed", "kind": kind, "cycle": cycle,
        "profile": "longcat-image-bf16" if kind == "generation" else "longcat-image-edit-turbo-bf16",
        "capabilities": {"generation": kind == "generation", "editing": kind == "edit",
                         "multiReference": False},
        "loadSeconds": load_seconds, "cases": cases,
        "diversity": {"distinctOutputs": 2, "passed": True},
        "cancellation": {"cooperativeCallbackAvailable": False,
                         "schedulerProcessCancellationRequired": True},
        "resources": {"peakCudaAllocatedBytes": peak_allocated,
                      "peakCudaReservedBytes": peak_reserved},
        "unload": unload, "outputs": outputs, "failure": None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("generation", "edit"), required=True)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--cycle", choices=("cycle1", "cycle2"), required=True)
    args = parser.parse_args()
    try:
        value = run(args.kind, args.model_root.resolve(), args.output_root.resolve(), args.run_id, args.cycle)
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.longcat-image-runtime-probe.v1",
                 "runId": args.run_id, "status": "failed", "kind": args.kind,
                 "cycle": args.cycle, "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
