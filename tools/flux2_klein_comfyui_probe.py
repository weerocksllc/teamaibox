#!/usr/bin/env python3
"""Run official FLUX.2 Klein NVFP4 through pinned Stock ComfyUI on Spark."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


RUN_ID = re.compile(r"^flux2-klein-runtime-20[0-9]{6}-a[1-9][0-9]*$")
MODEL_NAME = "flux-2-klein-4b-nvfp4.safetensors"
CLIP_NAME = "qwen_3_4b.safetensors"
VAE_NAME = "full_encoder_small_decoder.safetensors"
ORIGIN = "http://127.0.0.1:8188"


class ProbeError(RuntimeError):
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


def api(path: str, payload: dict[str, Any] | None = None, timeout: int = 30) -> Any:
    raw = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    request = Request(ORIGIN + path, data=raw, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        body = response.read()
        return json.loads(body) if body else {}


def loaders() -> dict[str, Any]:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": MODEL_NAME, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP_NAME, "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_NAME}},
    }


def generation(prompt: str, seed: int, prefix: str, steps: int = 4) -> dict[str, Any]:
    value = loaders()
    value.update({
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "cfg": 1.0}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "10": {"class_type": "Flux2Scheduler", "inputs": {"steps": steps, "width": 512, "height": 512}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["7", 0], "guider": ["8", 0], "sampler": ["9", 0], "sigmas": ["10", 0], "latent_image": ["6", 0]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}},
    })
    return value


def edit(prompt: str, seed: int, prefix: str, references: int) -> dict[str, Any]:
    require(references in {1, 2}, "unsupported reference count")
    value = loaders()
    value.update({
        "4": {"class_type": "LoadImage", "inputs": {"image": "source-one.png"}},
        "5": {"class_type": "GetImageSize", "inputs": {"image": ["4", 0]}},
        "6": {"class_type": "VAEEncode", "inputs": {"pixels": ["4", 0], "vae": ["3", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "8": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["7", 0]}},
        "9": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["7", 0], "latent": ["6", 0]}},
        "10": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["8", 0], "latent": ["6", 0]}},
        "11": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": ["5", 0], "height": ["5", 1], "batch_size": 1}},
        "12": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": ["5", 0], "height": ["5", 1]}},
        "13": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "14": {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": ["9", 0], "negative": ["10", 0], "cfg": 1.0}},
        "15": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "16": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["13", 0], "guider": ["14", 0], "sampler": ["15", 0], "sigmas": ["12", 0], "latent_image": ["11", 0]}},
        "17": {"class_type": "VAEDecode", "inputs": {"samples": ["16", 0], "vae": ["3", 0]}},
        "18": {"class_type": "SaveImage", "inputs": {"images": ["17", 0], "filename_prefix": prefix}},
    })
    if references == 2:
        value.update({
            "19": {"class_type": "LoadImage", "inputs": {"image": "source-two.png"}},
            "20": {"class_type": "VAEEncode", "inputs": {"pixels": ["19", 0], "vae": ["3", 0]}},
            "21": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["9", 0], "latent": ["20", 0]}},
            "22": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["10", 0], "latent": ["20", 0]}},
        })
        value["14"]["inputs"]["positive"] = ["21", 0]
        value["14"]["inputs"]["negative"] = ["22", 0]
    return value


def submit(workflow: dict[str, Any]) -> str:
    value = api("/prompt", {"prompt": workflow, "client_id": "teamaibox-flux2-smoke"})
    require(isinstance(value.get("prompt_id"), str), "ComfyUI rejected the workflow: " + str(value)[:600])
    return value["prompt_id"]


def wait_history(prompt_id: str, timeout: int = 900) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = api("/history/" + prompt_id)
        if prompt_id in value:
            return value[prompt_id]
        time.sleep(0.25)
    raise ProbeError("ComfyUI prompt timed out")


def output_from_history(history: dict[str, Any], root: Path) -> dict[str, Any]:
    images = []
    for output in history.get("outputs", {}).values():
        images.extend(output.get("images", []))
    require(len(images) == 1 and images[0].get("type") == "output", "ComfyUI output manifest is invalid")
    relative = Path(images[0].get("subfolder", "")) / images[0]["filename"]
    require(not relative.is_absolute() and ".." not in relative.parts, "ComfyUI output path is unsafe")
    path = root / relative
    require(path.is_file() and path.stat().st_size > 1000, "ComfyUI output file is missing")
    return {"path": relative.as_posix(), "bytes": path.stat().st_size, "sha256": digest(path)}


def device_stats() -> dict[str, int]:
    devices = api("/system_stats").get("devices", [])
    require(len(devices) == 1, "ComfyUI device telemetry is unavailable")
    value = devices[0]
    return {"vramTotalBytes": int(value["vram_total"]), "vramFreeBytes": int(value["vram_free"])}


def run(model_root: Path, components: Path, output_root: Path, run_id: str) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) is not None, "invalid ComfyUI probe identity")
    require((model_root / "nvfp4" / MODEL_NAME).is_file(), "official NVFP4 model is missing")
    require((components / "text_encoders" / CLIP_NAME).is_file() and
            (components / "vae" / VAE_NAME).is_file(), "ComfyUI components are missing")
    require(output_root.is_dir() and not any(output_root.iterdir()), "ComfyUI output root must be empty")
    from PIL import Image, ImageDraw

    work = Path("/tmp/teamaibox-comfyui")
    for child in ("input", "temp", "user"):
        (work / child).mkdir(parents=True, exist_ok=True)
    source_one = Image.new("RGB", (512, 512), "white")
    ImageDraw.Draw(source_one).rectangle((96, 96, 416, 416), fill=(208, 40, 48))
    source_one.save(work / "input/source-one.png")
    source_two = Image.new("RGB", (512, 512), "white")
    ImageDraw.Draw(source_two).ellipse((96, 96, 416, 416), fill=(32, 96, 208))
    source_two.save(work / "input/source-two.png")
    extra = work / "extra-model-paths.yaml"
    extra.write_text("teamaibox:\n  base_path: /\n  diffusion_models: model/nvfp4\n  text_encoders: components/text_encoders\n  vae: components/vae\n", encoding="utf-8")
    log = (work / "server.log").open("w+", encoding="utf-8")
    command = ["python3", "/opt/comfyui/main.py", "--listen", "127.0.0.1", "--port", "8188",
        "--disable-auto-launch", "--disable-metadata", "--disable-all-custom-nodes", "--disable-api-nodes",
        "--cache-none", "--reserve-vram", "8", "--use-pytorch-cross-attention", "--disable-async-offload",
        "--extra-model-paths-config", str(extra), "--output-directory", str(output_root),
        "--input-directory", str(work / "input"), "--temp-directory", str(work / "temp"),
        "--user-directory", str(work / "user")]
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=os.environ.copy())
    started = time.monotonic()
    try:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise ProbeError("ComfyUI exited during startup")
            try:
                stats = device_stats()
                break
            except (HTTPError, URLError, TimeoutError, ProbeError):
                time.sleep(0.5)
        else:
            raise ProbeError("ComfyUI startup timed out")
        minimum_free = stats["vramFreeBytes"]
        cases = []
        plans = [
            ("generation", generation("Studio product photograph of a mint green ceramic smart speaker on a pale wood desk, soft daylight, no text", 31001, "nvfp4-generation")),
            ("edit", edit("Keep the composition and change the red square into a glossy green ceramic tile", 31002, "nvfp4-edit", 1)),
            ("multi-reference", edit("Create a clean catalog scene containing the red tile from reference one and the blue circle from reference two", 31003, "nvfp4-multi-reference", 2)),
        ]
        for key, workflow in plans:
            case_started = time.monotonic()
            history = wait_history(submit(workflow))
            status = history.get("status", {})
            require(status.get("completed") is True and status.get("status_str") == "success",
                    "ComfyUI case failed: " + key + ":" + str(status)[:600])
            output = output_from_history(history, output_root)
            current = device_stats()
            minimum_free = min(minimum_free, current["vramFreeBytes"])
            cases.append({"key": key, "seed": {"generation": 31001, "edit": 31002,
                          "multi-reference": 31003}[key], "steps": 4, "guidanceScale": 1.0,
                          "durationSeconds": time.monotonic() - case_started, "output": output})
        before_cancel = {path.name for path in output_root.iterdir() if path.is_file()}
        cancel_id = submit(generation("A detailed technical illustration of a compact edge AI appliance", 31004,
                                      "nvfp4-cancelled", steps=40))
        deadline = time.monotonic() + 120
        running = False
        while time.monotonic() < deadline:
            queue = api("/queue")
            if any(len(item) > 1 and item[1] == cancel_id for item in queue.get("queue_running", [])):
                running = True
                break
            time.sleep(0.1)
        require(running, "ComfyUI cancellation prompt never reached running")
        api("/interrupt", {})
        cancel_history = wait_history(cancel_id, 180)
        after_cancel = {path.name for path in output_root.iterdir() if path.is_file()}
        require(before_cancel == after_cancel and cancel_history.get("status", {}).get("status_str") != "success",
                "ComfyUI cancellation produced a late output")
        cancellation = {"passed": True, "callbackCalls": 1,
                        "status": cancel_history.get("status", {}).get("status_str")}
        free_before = device_stats()
        api("/free", {"unload_models": True, "free_memory": True})
        time.sleep(2)
        free_after = device_stats()
        minimum_free = min(minimum_free, free_before["vramFreeBytes"])
        unload = {"passed": free_after["vramFreeBytes"] >= free_before["vramFreeBytes"],
                  "freeBytesBefore": free_before["vramFreeBytes"],
                  "freeBytesAfter": free_after["vramFreeBytes"]}
        require(unload["passed"], "ComfyUI free endpoint did not release model memory")
        return {"schemaVersion": 1, "runnerId": "teamaibox.flux2-klein-comfyui-probe.v1",
            "runId": run_id, "status": "passed", "profile": "nvfp4", "loadSeconds": cases[0]["durationSeconds"],
            "cases": cases, "cancellation": cancellation,
            "resources": {"peakCudaAllocatedBytes": stats["vramTotalBytes"] - minimum_free,
                          "peakCudaReservedBytes": stats["vramTotalBytes"] - minimum_free},
            "unload": unload, "outputs": [item["output"] for item in cases],
            "durationSeconds": time.monotonic() - started, "failure": None}
    except Exception as error:
        log.flush(); log.seek(0)
        tail = " | ".join(log.read().splitlines()[-20:])[-2400:]
        raise ProbeError(str(error) + (" | log=" + tail if tail else "")) from error
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=10)
        log.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--components", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    try:
        value = run(args.model_root.resolve(), args.components.resolve(), args.output_root.resolve(), args.run_id)
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.flux2-klein-comfyui-probe.v1",
                 "runId": args.run_id, "status": "failed", "profile": "nvfp4",
                 "failure": {"type": type(error).__name__, "message": str(error)[:3000]}}
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
