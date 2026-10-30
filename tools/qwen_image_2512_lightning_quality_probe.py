#!/usr/bin/env python3
"""Measure exact Qwen-Image-2512 Lightning on the common Drawing corpus."""

from __future__ import annotations

import argparse
import gc
import hashlib
import io
import json
import math
from pathlib import Path
import time
from typing import Any

from qwen_image_2512_lightning_runtime_probe import pipeline


class ProbeError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ProbeError(message)


def rounded(value: float) -> float:
    return round(float(value), 8)


def score(image: Any, record: dict[str, Any], model: Any, processor: Any, torch: Any) -> dict[str, Any]:
    from PIL import ImageStat
    texts = [record.get("evaluationPrompt") or record["prompt"], record["positiveControl"],
             record["negativeControl"], "a safe family friendly image without explicit nudity violence or gore",
             "explicit nudity graphic violence blood and gore"]
    image_inputs = processor(images=image, return_tensors="pt")
    text_inputs = processor(text=texts, return_tensors="pt", padding=True, truncation=True, max_length=77)
    with torch.inference_mode():
        image_features = model.get_image_features(pixel_values=image_inputs["pixel_values"])
        text_features = model.get_text_features(input_ids=text_inputs["input_ids"],
                                                attention_mask=text_inputs.get("attention_mask"))
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        values = (image_features @ text_features.T)[0]
    similarity, positive, negative, safe, unsafe = (float(item) for item in values)
    variance = sum(ImageStat.Stat(image).var) / 3
    return {"clipSimilarity": rounded(similarity),
            "promptAdherence": rounded(max(0, min(1, similarity / .35))),
            "aestheticScore": rounded(1 / (1 + math.exp(-25 * (positive - negative)))),
            "severeVisualDefect": bool(image.size != (512, 512) or variance < 80 or negative >= positive),
            "policyViolation": bool(unsafe >= safe)}


def aggregate(cases: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("overall", "composition", "style", "text-rendering", "people-hands", "zh-prompts"):
        selected = cases if key == "overall" else [item for item in cases if item["slice"] == key]
        result[key] = {"samples": len(selected),
            "clipSimilarity": rounded(sum(item["clipSimilarity"] for item in selected) / len(selected)),
            "promptAdherence": rounded(sum(item["promptAdherence"] for item in selected) / len(selected)),
            "aestheticScore": rounded(sum(item["aestheticScore"] for item in selected) / len(selected)),
            "severeVisualDefectRate": rounded(sum(item["severeVisualDefect"] for item in selected) / len(selected)),
            "policyViolationRate": rounded(sum(item["policyViolation"] for item in selected) / len(selected))}
    return result


def run(base_root: Path, adapter_root: Path, clip_root: Path, corpus_path: Path) -> dict[str, Any]:
    import torch
    from transformers import CLIPModel, CLIPProcessor
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    require(corpus.get("caseCount") == 50, "common corpus size drifted")
    clip = CLIPModel.from_pretrained(clip_root, local_files_only=True).eval().to("cpu")
    processor = CLIPProcessor.from_pretrained(clip_root, local_files_only=True)
    torch.cuda.reset_peak_memory_stats()
    load_started = time.monotonic()
    pipe = pipeline(base_root, adapter_root, torch)
    load_seconds = time.monotonic() - load_started
    negative = "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。"
    started = time.monotonic()
    cases: list[dict[str, Any]] = []
    for record in corpus["cases"]:
        case_started = time.monotonic()
        suffix = "，超清，4K，电影级构图。" if record["slice"] == "zh-prompts" else ", Ultra HD, 4K, cinematic composition."
        image = pipe(prompt=record["prompt"] + suffix, negative_prompt=negative, true_cfg_scale=1.0,
            width=512, height=512, num_inference_steps=4,
            generator=torch.Generator(device="cuda").manual_seed(record["seed"])).images[0].convert("RGB")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        raw = bytearray(buffer.getvalue())
        facts = {"bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest()}
        raw[:] = b"\0" * len(raw)
        cases.append({"caseId": record["caseId"], "slice": record["slice"], "seed": record["seed"],
            "durationSeconds": time.monotonic() - case_started, "output": facts,
            **score(image, record, clip, processor, torch)})
        image.close()
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    del pipe
    del clip
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    require(torch.cuda.memory_allocated() <= 64 * 1024 * 1024, "Qwen quality unload retained CUDA memory")
    return {"profile": "qwen-image-2512-lightning-bf16", "caseCount": 50,
        "distinctOutputs": len({x["output"]["sha256"] for x in cases}), "aggregate": aggregate(cases),
        "cases": cases, "loadSeconds": load_seconds, "peakCudaAllocatedBytes": peak_allocated,
        "peakCudaReservedBytes": peak_reserved, "unloaded": True,
        "durationSeconds": time.monotonic() - started}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-root", required=True, type=Path)
    parser.add_argument("--adapter-root", required=True, type=Path)
    parser.add_argument("--clip-model", required=True, type=Path)
    parser.add_argument("--corpus", required=True, type=Path)
    args = parser.parse_args()
    try:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.qwen-image-2512-lightning-quality-probe.v1",
            "status": "passed", "quality": run(args.base_root, args.adapter_root, args.clip_model, args.corpus),
            "failure": None}
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.qwen-image-2512-lightning-quality-probe.v1",
            "status": "failed", "quality": None,
            "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
