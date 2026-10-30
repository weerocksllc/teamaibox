#!/usr/bin/env python3
"""Exercise the retained FLUX.2 Worker through its real localhost HTTP boundary."""

from __future__ import annotations

import base64
import hashlib
import http.client
import io
import json
from pathlib import Path
import re
import threading
import time
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ORIGIN = "http://127.0.0.1:8000"
MODEL = "flux2-klein-4b-nvfp4"
RUN_ID = re.compile(r"^flux2-worker-protocol-20[0-9]{6}-a[1-9][0-9]*$")


class ProbeError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProbeError(message)


def call(path: str, body: dict[str, Any] | None = None, timeout: int = 1800) -> tuple[int, dict[str, Any]]:
    raw = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = Request(ORIGIN + path, data=raw, method="POST" if body is not None else "GET",
                      headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            value = json.loads(response.read())
            return response.status, value
    except HTTPError as error:
        return error.code, json.loads(error.read())


def encode(image: Any) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def output_facts(value: dict[str, Any]) -> dict[str, Any]:
    from PIL import Image, ImageStat
    encoded = value.get("data", [{}])[0].get("b64_json")
    require(isinstance(encoded, str), "Worker output is missing")
    raw = bytearray(base64.b64decode(encoded, validate=True))
    try:
        require(len(raw) > 1000, "Worker output is unexpectedly small")
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        stat = ImageStat.Stat(image)
        require(image.size == (512, 512) and sum(stat.var) / 3 >= 80, "Worker output is visually empty")
        return {"bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
                "width": image.width, "height": image.height,
                "meanRgb": [round(item, 4) for item in stat.mean]}
    finally:
        raw[:] = b"\0" * len(raw)


def request_body(job_id: str, prompt: str, seed: int, *, image: str | None = None,
                 references: list[str] | None = None, steps: int = 4) -> dict[str, Any]:
    extension: dict[str, Any] = {"job_id": job_id, "seed": seed, "steps": steps,
        "guidance_scale": 1.0, "output_format": "png", "preset_key": "drawing.fast.v1"}
    if references:
        extension["reference_images_b64"] = references
    value: dict[str, Any] = {"model": MODEL, "prompt": prompt, "n": 1, "size": "512x512",
                             "response_format": "b64_json", "x_teamaibox": extension}
    if image is not None:
        value["image_b64"] = image
    return value


def invalid_json() -> tuple[int, dict[str, Any]]:
    connection = http.client.HTTPConnection("127.0.0.1", 8000, timeout=10)
    try:
        connection.request("POST", "/v1/images/generations", body=b"{", headers={
            "Content-Type": "application/json", "Content-Length": "1"})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def run(run_id: str) -> dict[str, Any]:
    from PIL import Image, ImageDraw
    require(RUN_ID.fullmatch(run_id) is not None, "invalid protocol run identity")
    started = time.monotonic()
    status, health = call("/health", timeout=10)
    require(status == 200 and health.get("accepting") is True and health.get("loaded") is False,
            "Worker did not start unloaded and accepting")
    prepare_started = time.monotonic()
    status, prepared = call("/v1/models/prepare", {}, timeout=1800)
    prepare_seconds = time.monotonic() - prepare_started
    require(status == 200 and prepared == {"status": "ready", "model": MODEL, "loaded": True},
            "Worker prepare failed")

    source_one = Image.new("RGB", (512, 512), "white")
    ImageDraw.Draw(source_one).rectangle((96, 96, 416, 416), fill=(208, 40, 48))
    source_two = Image.new("RGB", (512, 512), "white")
    ImageDraw.Draw(source_two).ellipse((96, 96, 416, 416), fill=(32, 96, 208))
    encoded_one, encoded_two = encode(source_one), encode(source_two)
    plans = [
        ("generation", "/v1/images/generations", request_body(
            "10000000-0000-4000-8000-000000000001",
            "Studio product photograph of a mint green ceramic smart speaker on a pale wood desk, soft daylight, no text", 41001)),
        ("edit", "/v1/images/edits", request_body(
            "10000000-0000-4000-8000-000000000002",
            "Keep the composition and change the red square into a glossy green ceramic tile", 41002,
            image=encoded_one)),
        ("multi-reference", "/v1/images/edits", request_body(
            "10000000-0000-4000-8000-000000000003",
            "Create a clean catalog composition containing both reference objects", 41003,
            image=encoded_one, references=[encoded_two])),
    ]
    cases = []
    for key, path, body in plans:
        case_started = time.monotonic()
        status, value = call(path, body)
        require(status == 200 and value.get("x_teamaibox", {}).get("steps") == 4
                and value.get("x_teamaibox", {}).get("guidance_scale") == 1.0,
                "Worker case failed: " + key)
        cases.append({"key": key, "durationSeconds": time.monotonic() - case_started,
                      "referenceCount": value["x_teamaibox"]["reference_count"],
                      "output": output_facts(value)})

    cancel_job = "10000000-0000-4000-8000-000000000004"
    cancelled_result: dict[str, Any] = {}

    def generate_for_cancel() -> None:
        status_value, body_value = call("/v1/images/generations", request_body(
            cancel_job, "Highly detailed technical cutaway of a compact edge AI appliance", 41004, steps=12))
        cancelled_result.update({"status": status_value, "body": body_value})

    thread = threading.Thread(target=generate_for_cancel)
    thread.start()
    cancellation = None
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        status, candidate = call(f"/v1/images/generations/{cancel_job}/cancel", {})
        if status == 200 and candidate.get("cancelled") is True:
            cancellation = candidate
            break
        time.sleep(0.1)
    require(cancellation is not None, "running Worker job could not be cancelled")
    thread.join(timeout=1800)
    require(not thread.is_alive() and cancelled_result.get("status") == 409
            and cancelled_result.get("body", {}).get("error", {}).get("code") == "worker_cancelled",
            "cancelled Worker request did not terminate correctly")

    security = []
    status, value = invalid_json()
    security.append({"key": "invalid-json", "status": status, "code": value.get("error", {}).get("code")})
    wrong = request_body("10000000-0000-4000-8000-000000000005", "test", 5)
    wrong["model"] = "wrong-model"
    status, value = call("/v1/images/generations", wrong)
    security.append({"key": "wrong-model", "status": status, "code": value.get("error", {}).get("code")})
    masked = request_body("10000000-0000-4000-8000-000000000006", "test", 6, image=encoded_one)
    masked["mask_b64"] = encoded_two
    status, value = call("/v1/images/edits", masked)
    security.append({"key": "masked-edit", "status": status, "code": value.get("error", {}).get("code")})
    negative = request_body("10000000-0000-4000-8000-000000000007", "test", 7)
    negative["x_teamaibox"]["negative_prompt"] = "text"
    status, value = call("/v1/images/generations", negative)
    security.append({"key": "negative-prompt", "status": status, "code": value.get("error", {}).get("code")})
    require(security == [
        {"key": "invalid-json", "status": 413, "code": "request_too_large"},
        {"key": "wrong-model", "status": 400, "code": "invalid_request"},
        {"key": "masked-edit", "status": 422, "code": "capability_unsupported"},
        {"key": "negative-prompt", "status": 422, "code": "capability_unsupported"},
    ], "Worker security boundary drifted: " + str(security))

    status, unloaded = call("/v1/models/unload", {})
    require(status == 200 and unloaded.get("loaded") is False, "Worker unload failed")
    status, reloaded = call("/v1/models/prepare", {}, timeout=1800)
    require(status == 200 and reloaded.get("loaded") is True, "Worker reload failed")
    status, final_unload = call("/v1/models/unload", {})
    require(status == 200 and final_unload.get("loaded") is False, "Worker final unload failed")
    residues = {key: sorted(path.name for path in (Path("/tmp/teamaibox-flux2-worker") / key).iterdir()
                            if path.is_file()) for key in ("input", "output")}
    require(residues == {"input": [], "output": []}, "Worker retained request artifacts")
    return {"schemaVersion": 1, "runnerId": "teamaibox.flux2-worker-protocol-probe.v1",
        "runId": run_id, "status": "passed", "model": MODEL, "prepareSeconds": prepare_seconds,
        "cases": cases, "cancellation": {"passed": True, "status": 409, "code": "worker_cancelled"},
        "security": security, "unloadReload": {"passed": True, "finalLoaded": False},
        "residues": residues, "outputsRetained": False, "durationSeconds": time.monotonic() - started,
        "failure": None}


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    try:
        value = run(args.run_id)
    except Exception as error:
        value = {"schemaVersion": 1, "runnerId": "teamaibox.flux2-worker-protocol-probe.v1",
                 "runId": args.run_id, "status": "failed",
                 "failure": {"type": type(error).__name__, "message": str(error)[:2400]}}
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if value["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
