#!/usr/bin/env python3
"""Measure LongCat generation and edit candidates on the common Drawing corpus."""

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


class ProbeError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ProbeError(message)


def rounded(value: float) -> float:
    return round(float(value), 8)


def reference(record: dict[str, Any]) -> Any:
    from PIL import Image, ImageDraw
    color = "#ece6dc" if record["seed"] % 2 else "#dce9f2"
    image = Image.new("RGB", (512, 512), color)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((96, 118, 416, 394), radius=36, fill="#17211d")
    draw.ellipse((232, 238, 280, 286), fill="#6fd8aa")
    return image


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


def image_facts(image: Any) -> dict[str, Any]:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    raw = bytearray(buffer.getvalue())
    facts = {"bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest()}
    raw[:] = b"\0" * len(raw)
    return facts


def run(generation_root: Path, edit_root: Path, clip_root: Path, corpus_path: Path) -> dict[str, Any]:
    import torch
    from diffusers import LongCatImageEditPipeline, LongCatImagePipeline
    from transformers import CLIPModel, CLIPProcessor

    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    require(corpus.get("caseCount") == 50, "common corpus size drifted")
    clip = CLIPModel.from_pretrained(clip_root, local_files_only=True).eval().to("cpu")
    processor = CLIPProcessor.from_pretrained(clip_root, local_files_only=True)
    torch.cuda.reset_peak_memory_stats()
    load_started = time.monotonic()
    generation = LongCatImagePipeline.from_pretrained(generation_root, torch_dtype=torch.bfloat16,
                                                       local_files_only=True, device_map="cuda")
    generation.set_progress_bar_config(disable=True)
    generation_load_seconds = time.monotonic() - load_started
    started = time.monotonic()
    generation_cases: list[dict[str, Any]] = []
    for record in corpus["cases"]:
        case_started = time.monotonic()
        image = generation(prompt=record["prompt"], height=512, width=512, num_inference_steps=50,
            guidance_scale=4.0, enable_cfg_renorm=True, enable_prompt_rewrite=False,
            generator=torch.Generator(device="cuda").manual_seed(record["seed"])).images[0].convert("RGB")
        generation_cases.append({"caseId": record["caseId"], "slice": record["slice"],
            "seed": record["seed"], "durationSeconds": time.monotonic() - case_started,
            "output": image_facts(image), **score(image, record, clip, processor, torch)})
        image.close()
    del generation
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    require(torch.cuda.memory_allocated() <= 64 * 1024 * 1024,
            "LongCat generation unload retained CUDA memory")

    selected_edit: list[dict[str, Any]] = []
    for slice_name in corpus["sliceCounts"]:
        selected_edit.extend([item for item in corpus["cases"] if item["slice"] == slice_name][:2])
    require(len(selected_edit) == 10, "LongCat edit slice coverage drifted")
    load_started = time.monotonic()
    editing = LongCatImageEditPipeline.from_pretrained(edit_root, torch_dtype=torch.bfloat16,
                                                       local_files_only=True, device_map="cuda")
    editing.set_progress_bar_config(disable=True)
    edit_load_seconds = time.monotonic() - load_started
    edit_cases: list[dict[str, Any]] = []
    for record in selected_edit:
        case_started = time.monotonic()
        source = reference(record)
        image = editing(image=source, prompt="Keep the compact device geometry and apply: " + record["prompt"],
            num_inference_steps=8, guidance_scale=1.0,
            generator=torch.Generator(device="cuda").manual_seed(record["seed"])).images[0].convert("RGB")
        source.close()
        edit_cases.append({"caseId": record["caseId"], "slice": record["slice"],
            "seed": record["seed"], "durationSeconds": time.monotonic() - case_started,
            "output": image_facts(image), **score(image, record, clip, processor, torch)})
        image.close()
    peak_allocated = torch.cuda.max_memory_allocated()
    peak_reserved = torch.cuda.max_memory_reserved()
    del editing
    del clip
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    require(torch.cuda.memory_allocated() <= 64 * 1024 * 1024, "LongCat quality unload retained CUDA memory")
    return {"generation": {"profile": "longcat-image-bf16", "caseCount": 50,
                "distinctOutputs": len({x["output"]["sha256"] for x in generation_cases}),
                "aggregate": aggregate(generation_cases), "cases": generation_cases,
                "loadSeconds": generation_load_seconds},
            "editing": {"profile": "longcat-image-edit-turbo-bf16", "caseCount": 10,
                "distinctOutputs": len({x["output"]["sha256"] for x in edit_cases}),
                "aggregate": aggregate(edit_cases), "cases": edit_cases,
                "loadSeconds": edit_load_seconds},
            "peakCudaAllocatedBytes": peak_allocated, "peakCudaReservedBytes": peak_reserved,
            "unloaded": True, "durationSeconds": time.monotonic() - started}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generation-model", required=True, type=Path)
    parser.add_argument("--edit-model", required=True, type=Path)
    parser.add_argument("--clip-model", required=True, type=Path)
    parser.add_argument("--corpus", required=True, type=Path)
    args = parser.parse_args()
    try:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.longcat-image-quality-probe.v1",
            "status": "passed", "quality": run(args.generation_model, args.edit_model,
                                                   args.clip_model, args.corpus), "failure": None}
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.longcat-image-quality-probe.v1",
            "status": "failed", "quality": None,
            "failure": {"type": type(error).__name__, "message": str(error)[:1200]}}
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
