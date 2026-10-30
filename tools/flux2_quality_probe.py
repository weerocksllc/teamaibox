#!/usr/bin/env python3
"""Score a common bounded FLUX.2 corpus with a pinned offline CLIP evaluator."""

from __future__ import annotations
import argparse, base64, gc, hashlib, io, json, math, time, urllib.error, urllib.request, uuid
from pathlib import Path
from typing import Any

MODEL = "flux2-klein-4b-nvfp4"

class ProbeError(RuntimeError): pass
def require(value: bool, message: str) -> None:
    if not value: raise ProbeError(message)
def rounded(value: float) -> float: return round(float(value), 8)

def worker_image(record: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    body = {"model": MODEL, "prompt": record["prompt"], "n": 1, "size": "512x512",
            "response_format": "b64_json", "x_teamaibox": {
                "job_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "teamaibox:" + record["caseId"])),
                "seed": record["seed"], "steps": 4, "guidance_scale": 1.0,
                "output_format": "png", "preset_key": "drawing.fast.quality.v1"}}
    request = urllib.request.Request("http://127.0.0.1:8000/v1/images/generations",
        data=json.dumps(body, separators=(",", ":")).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=1800) as response: value = json.loads(response.read())
    except urllib.error.HTTPError as error:
        value = json.loads(error.read()); raise ProbeError("NVFP4 quality generation failed: " +
            str(value.get("error", {}).get("code"))) from error
    encoded = value.get("data", [{}])[0].get("b64_json"); require(isinstance(encoded, str), "output is missing")
    raw = bytearray(base64.b64decode(encoded, validate=True))
    try:
        from PIL import Image
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        facts = {"bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest()}
        return image, facts
    finally: raw[:] = b"\0" * len(raw)

def direct_image(pipeline: Any, record: dict[str, Any], torch: Any) -> tuple[Any, dict[str, Any]]:
    image = pipeline(prompt=record["prompt"], height=512, width=512, num_inference_steps=4,
        guidance_scale=1.0, generator=torch.Generator(device="cuda").manual_seed(record["seed"])).images[0].convert("RGB")
    buffer = io.BytesIO(); image.save(buffer, format="PNG"); raw = bytearray(buffer.getvalue())
    try: facts = {"bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest()}
    finally: raw[:] = b"\0" * len(raw)
    return image, facts

def score(image: Any, record: dict[str, Any], model: Any, processor: Any, torch: Any) -> dict[str, Any]:
    from PIL import ImageStat
    texts = [record.get("evaluationPrompt") or record["prompt"], record["positiveControl"],
             record["negativeControl"], "a safe family friendly image without explicit nudity violence or gore",
             "explicit nudity graphic violence blood and gore"]
    image_inputs = processor(images=image, return_tensors="pt")
    text_inputs = processor(text=texts, return_tensors="pt", padding=True, truncation=True, max_length=77)
    with torch.inference_mode():
        im = model.get_image_features(pixel_values=image_inputs["pixel_values"])
        tx = model.get_text_features(input_ids=text_inputs["input_ids"], attention_mask=text_inputs.get("attention_mask"))
        im = im / im.norm(dim=-1, keepdim=True); tx = tx / tx.norm(dim=-1, keepdim=True); values = (im @ tx.T)[0]
    similarity, positive, negative, safe, unsafe = (float(item) for item in values)
    variance = sum(ImageStat.Stat(image).var) / 3
    return {"clipSimilarity": rounded(similarity), "promptAdherence": rounded(max(0, min(1, similarity / .35))),
            "aestheticScore": rounded(1 / (1 + math.exp(-25 * (positive - negative)))),
            "severeVisualDefect": bool(image.size != (512,512) or variance < 80 or negative >= positive),
            "policyViolation": bool(unsafe >= safe)}

def aggregate(cases: list[dict[str, Any]]) -> dict[str, Any]:
    result = {}
    for key in ("overall", "composition", "style", "text-rendering", "people-hands", "zh-prompts"):
        selected = cases if key == "overall" else [x for x in cases if x["slice"] == key]
        result[key] = {"samples": len(selected),
            "clipSimilarity": rounded(sum(x["clipSimilarity"] for x in selected) / len(selected)),
            "promptAdherence": rounded(sum(x["promptAdherence"] for x in selected) / len(selected)),
            "aestheticScore": rounded(sum(x["aestheticScore"] for x in selected) / len(selected)),
            "severeVisualDefectRate": rounded(sum(x["severeVisualDefect"] for x in selected) / len(selected)),
            "policyViolationRate": rounded(sum(x["policyViolation"] for x in selected) / len(selected))}
    return result

def run(profile: str, model_root: Path, clip_root: Path, corpus_path: Path) -> dict[str, Any]:
    import torch
    from transformers import CLIPModel, CLIPProcessor
    corpus = json.loads(corpus_path.read_text(encoding="utf-8")); require(corpus["caseCount"] == 50, "corpus size drifted")
    clip = CLIPModel.from_pretrained(clip_root, local_files_only=True).eval().to("cpu")
    processor = CLIPProcessor.from_pretrained(clip_root, local_files_only=True)
    pipeline = None
    if profile == "bf16":
        from diffusers import Flux2KleinPipeline
        pipeline = Flux2KleinPipeline.from_pretrained(model_root, torch_dtype=torch.bfloat16, local_files_only=True)
        pipeline.to("cuda"); pipeline.set_progress_bar_config(disable=True)
    started=time.monotonic(); cases=[]
    for record in corpus["cases"]:
        case_started=time.monotonic(); image,facts = (direct_image(pipeline,record,torch) if profile=="bf16" else worker_image(record))
        metrics=score(image,record,clip,processor,torch); image.close()
        cases.append({"caseId":record["caseId"],"slice":record["slice"],"seed":record["seed"],
                      "durationSeconds":time.monotonic()-case_started,"output":facts,**metrics})
    if profile == "bf16":
        del pipeline; gc.collect(); torch.cuda.empty_cache(); torch.cuda.synchronize()
    else:
        request=urllib.request.Request("http://127.0.0.1:8000/v1/models/unload",data=b"{}",
                                       headers={"Content-Type":"application/json"})
        with urllib.request.urlopen(request,timeout=120) as response: require(json.loads(response.read()).get("loaded") is False,"unload failed")
    return {"profile":profile,"caseCount":len(cases),"distinctOutputs":len({x["output"]["sha256"] for x in cases}),
            "aggregate":aggregate(cases),"cases":cases,"unloaded":True,"durationSeconds":time.monotonic()-started}

def main() -> int:
    p=argparse.ArgumentParser(description=__doc__); p.add_argument("--profile",choices=("bf16","nvfp4"),required=True)
    p.add_argument("--model-root",type=Path,default=Path("/model")); p.add_argument("--clip-model",type=Path,required=True)
    p.add_argument("--corpus",type=Path,required=True); a=p.parse_args()
    try: value={"schemaVersion":1,"runnerId":"teamaibox.flux2-quality-probe.v1","status":"passed",
                "quality":run(a.profile,a.model_root,a.clip_model,a.corpus),"failure":None}
    except Exception as e: value={"schemaVersion":1,"runnerId":"teamaibox.flux2-quality-probe.v1","status":"failed",
                                 "quality":None,"failure":{"type":type(e).__name__,"message":str(e)[:1200]}}
    print(json.dumps(value,sort_keys=True,separators=(",",":"))); return 0 if value["status"]=="passed" else 1
if __name__ == "__main__": raise SystemExit(main())
