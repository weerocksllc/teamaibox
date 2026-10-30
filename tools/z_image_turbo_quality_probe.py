#!/usr/bin/env python3
"""Measure Z-Image-Turbo on the common synthetic Drawing quality corpus."""

from __future__ import annotations

import argparse
import gc
import hashlib
import io
import json
import math
import time
from pathlib import Path
from typing import Any


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


def run(model_root: Path, clip_root: Path, corpus_path: Path) -> dict[str, Any]:
    import torch
    from diffusers import ZImagePipeline
    from transformers import CLIPModel, CLIPProcessor

    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    require(corpus.get("caseCount") == 50, "common corpus size drifted")
    clip = CLIPModel.from_pretrained(clip_root, local_files_only=True).eval().to("cpu")
    processor = CLIPProcessor.from_pretrained(clip_root, local_files_only=True)
    torch.cuda.reset_peak_memory_stats()
    load_started = time.monotonic()
    pipeline = ZImagePipeline.from_pretrained(model_root, torch_dtype=torch.bfloat16, local_files_only=True)
    pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=True)
    load_seconds = time.monotonic() - load_started
    started = time.monotonic()
    cases: list[dict[str, Any]] = []
    for record in corpus["cases"]:
        case_started = time.monotonic()
        image = pipeline(prompt=record["prompt"], height=512, width=512, num_inference_steps=9,
                         guidance_scale=0.0,
                         generator=torch.Generator(device="cuda").manual_seed(record["seed"])).images[0].convert("RGB")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        raw = bytearray(buffer.getvalue())
        facts = {"bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest()}
        raw[:] = b"\0" * len(raw)
        metrics = score(image, record, clip, processor, torch)
        image.close()
        cases.append({"caseId": record["caseId"], "slice": record["slice"], "seed": record["seed"],
                      "durationSeconds": time.monotonic() - case_started, "output": facts, **metrics})
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    del pipeline
    del clip
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    require(torch.cuda.memory_allocated() <= 64 * 1024 * 1024, "quality probe unload retained CUDA memory")
    return {"profile": "z-image-turbo-bf16", "caseCount": len(cases),
            "distinctOutputs": len({item["output"]["sha256"] for item in cases}),
            "aggregate": aggregate(cases), "cases": cases, "loadSeconds": load_seconds,
            "peakCudaAllocatedBytes": peak_allocated, "peakCudaReservedBytes": peak_reserved,
            "unloaded": True, "durationSeconds": time.monotonic() - started}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--clip-model", required=True, type=Path)
    parser.add_argument("--corpus", required=True, type=Path)
    args = parser.parse_args()
    try:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.z-image-turbo-quality-probe.v1",
                 "status": "passed", "quality": run(args.model_root, args.clip_model, args.corpus),
                 "failure": None}
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.z-image-turbo-quality-probe.v1",
                 "status": "failed", "quality": None,
                 "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
