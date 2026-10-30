#!/usr/bin/env python3
"""Run bounded Qwen-Image-2512 Lightning generation and lifecycle probes."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
from pathlib import Path
import re
import time
from typing import Any

RUN_ID = re.compile(r"^qwen-image-2512-lightning-runtime-[0-9]{8}-a[1-9][0-9]*$")
WEIGHT = "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors"


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


def pipeline(base_root: Path, adapter_root: Path, torch: Any) -> Any:
    from diffusers import FlowMatchEulerDiscreteScheduler, QwenImagePipeline
    from diffusers.models import QwenImageTransformer2DModel

    scheduler_config = {"base_image_seq_len": 256, "base_shift": math.log(3), "invert_sigmas": False,
        "max_image_seq_len": 8192, "max_shift": math.log(3), "num_train_timesteps": 1000,
        "shift": 1.0, "shift_terminal": None, "stochastic_sampling": False,
        "time_shift_type": "exponential", "use_beta_sigmas": False, "use_dynamic_shifting": True,
        "use_exponential_sigmas": False, "use_karras_sigmas": False}
    scheduler = FlowMatchEulerDiscreteScheduler.from_config(scheduler_config)
    transformer = QwenImageTransformer2DModel.from_pretrained(str(base_root), subfolder="transformer",
        torch_dtype=torch.bfloat16, local_files_only=True, device_map="cuda")
    value = QwenImagePipeline.from_pretrained(str(base_root), transformer=transformer,
        scheduler=scheduler, torch_dtype=torch.bfloat16, local_files_only=True, device_map="cuda")
    value.load_lora_weights(str(adapter_root), weight_name=WEIGHT, adapter_name="lightning")
    value.set_adapters(["lightning"], adapter_weights=[1.0])
    value.set_progress_bar_config(disable=True)
    return value


def run(base_root: Path, adapter_root: Path, output_root: Path, run_id: str, cycle: str) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) and base_root.is_dir() and adapter_root.is_dir()
            and output_root.is_dir() and cycle in {"cycle1", "cycle2"}
            and (adapter_root / WEIGHT).is_file(), "invalid Qwen runtime probe identity or root")
    import torch
    require(torch.cuda.is_available(), "CUDA is unavailable")
    torch.cuda.reset_peak_memory_stats()
    load_started = time.monotonic()
    pipe = pipeline(base_root, adapter_root, torch)
    load_seconds = time.monotonic() - load_started
    negative = "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。"
    cases: list[dict[str, Any]] = []
    outputs: list[dict[str, Any]] = []
    prompts = [(84101, "Minimal technology poster with the exact quoted text EDGE AI, dark green on cream, clean typography, Ultra HD, 4K, cinematic composition."),
               (84102, "极简科技海报，画面中央清晰显示中文大字“团队智能”，深绿色与米白色，排版清晰，超清，4K，电影级构图。")]
    for index, (seed, prompt) in enumerate(prompts, start=1):
        started = time.monotonic()
        image = pipe(prompt=prompt, negative_prompt=negative, true_cfg_scale=1.0,
            width=512, height=512, num_inference_steps=4,
            generator=torch.Generator(device="cuda").manual_seed(seed)).images[0]
        output = save(image, output_root / f"{cycle}-{index}.png")
        image.close()
        outputs.append(output)
        cases.append({"key": f"generation-{index}", "seed": seed, "steps": 4,
            "trueCfgScale": 1.0, "durationSeconds": time.monotonic() - started, "output": output})
    require(len({x["sha256"] for x in outputs}) == 2, "Qwen cycle produced duplicate outputs")
    callback_calls = 0

    def cancel(_pipeline: Any, _step: int, _timestep: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
        nonlocal callback_calls
        callback_calls += 1
        raise ExpectedCancellation("bounded Qwen cancellation")

    cancelled = False
    try:
        pipe(prompt="A detailed product illustration", negative_prompt=negative, true_cfg_scale=1.0,
             width=512, height=512, num_inference_steps=4,
             generator=torch.Generator(device="cuda").manual_seed(84103), callback_on_step_end=cancel)
    except ExpectedCancellation:
        cancelled = True
    require(cancelled and callback_calls == 1, "Qwen cooperative cancellation failed")
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    del pipe
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    unload = {"passed": True, "allocatedBytesAfter": torch.cuda.memory_allocated(),
              "reservedBytesAfter": torch.cuda.memory_reserved()}
    require(unload["allocatedBytesAfter"] <= 64 * 1024 * 1024,
            "Qwen unload retained unexpected CUDA allocation")
    return {"schemaVersion": 1, "runnerId": "teamaibox.qwen-image-2512-lightning-runtime-probe.v1",
        "runId": run_id, "status": "passed", "cycle": cycle,
        "profile": "qwen-image-2512-lightning-bf16", "capabilities": {"generation": True,
            "editing": False, "multiReference": False}, "loadSeconds": load_seconds, "cases": cases,
        "diversity": {"distinctOutputs": 2, "passed": True},
        "cancellation": {"passed": True, "callbackCalls": callback_calls},
        "resources": {"peakCudaAllocatedBytes": peak_allocated,
                      "peakCudaReservedBytes": peak_reserved},
        "unload": unload, "outputs": outputs, "failure": None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-root", required=True, type=Path)
    parser.add_argument("--adapter-root", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--cycle", choices=("cycle1", "cycle2"), required=True)
    args = parser.parse_args()
    try:
        value = run(args.base_root.resolve(), args.adapter_root.resolve(), args.output_root.resolve(),
                    args.run_id, args.cycle)
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.qwen-image-2512-lightning-runtime-probe.v1",
            "runId": args.run_id, "status": "failed", "cycle": args.cycle,
            "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
