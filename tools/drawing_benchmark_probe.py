#!/usr/bin/env python3
"""Measure the retained Drawing Provider without retaining generated images."""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import ssl
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


ORIGIN = "https://127.0.0.1:19095/v1"
MODEL = "sdxl-base-1.0-fp16"


def call(path: str, token: str, context: ssl.SSLContext, body: dict[str, Any], timeout: int) -> dict[str, Any]:
    encoded = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
    request = urllib.request.Request(ORIGIN + path, data=encoded, method="POST", headers={
        "accept": "application/json", "authorization": "Bearer " + token,
        "content-type": "application/json",
    })
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, context=context, timeout=timeout) as response:
            raw = response.read(96 * 1024 * 1024 + 1)
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read(1024 * 1024 + 1)
        status = error.code
    elapsed = round((time.monotonic() - started) * 1000)
    value = json.loads(raw)
    image = value.get("data", [{}])[0].get("b64_json") if isinstance(value, dict) else None
    result: dict[str, Any] = {"httpStatus": status, "wallMilliseconds": elapsed}
    if status == 200 and isinstance(image, str):
        decoded = bytearray(base64.b64decode(image, validate=True))
        try:
            facts = value.get("x_teamaibox") or {}
            result.update({
                "passed": len(decoded) > 1000,
                "bytes": len(decoded),
                "sha256": "sha256:" + hashlib.sha256(decoded).hexdigest(),
                "workerMilliseconds": facts.get("duration_milliseconds"),
                "seed": facts.get("seed"),
                "steps": facts.get("steps"),
                "width": facts.get("width"),
                "height": facts.get("height"),
            })
        finally:
            decoded[:] = b"\0" * len(decoded)
    else:
        result.update({
            "passed": False,
            "errorCode": value.get("error", {}).get("code") if isinstance(value, dict) else None,
        })
    mutable = bytearray(raw)
    mutable[:] = b"\0" * len(mutable)
    return result


def control(action: str, token: str, context: ssl.SSLContext, timeout: int) -> dict[str, Any]:
    request = urllib.request.Request(
        ORIGIN + "/models/" + action,
        data=json.dumps({"model": MODEL}, separators=(",", ":")).encode(),
        method="POST",
        headers={"accept": "application/json", "authorization": "Bearer " + token,
                 "content-type": "application/json"},
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, context=context, timeout=timeout) as response:
        value = json.load(response)
    return {"httpStatus": response.status, "status": value.get("status"),
            "loaded": value.get("loaded"), "wallMilliseconds": round((time.monotonic() - started) * 1000)}


def request_body(seed: int, steps: int, prompt: str) -> dict[str, Any]:
    return {
        "model": MODEL, "prompt": prompt, "n": 1, "size": "512x512", "response_format": "b64_json",
        "x_teamaibox": {"job_id": str(uuid.uuid4()), "seed": seed, "steps": steps,
                          "guidance_scale": 5, "negative_prompt": "text, watermark, logo",
                          "output_format": "png", "preset_key": "drawing.certification.benchmark.v1"},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", default="/run/secrets/provider.token")
    parser.add_argument("--ca-file", default="/run/secrets/ca.crt")
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    if not 4 <= args.steps <= 40:
        raise SystemExit("steps must be between 4 and 40")
    with open(args.token_file, encoding="utf-8") as handle:
        token = handle.read().strip()
    if len(token) < 32:
        raise SystemExit("Provider token is unavailable")
    context = ssl.create_default_context(cafile=args.ca_file)
    prompt = "A small green team-computing appliance centered on a clean white desk, professional product photograph"
    report: dict[str, Any] = {"schemaVersion": 1, "steps": args.steps, "cold": None,
                              "warm": [], "concurrency": None, "unload": None}
    control("unload", token, context, args.timeout)
    report["cold"] = call("/images/generations", token, context,
                          request_body(17001, args.steps, prompt), args.timeout)
    for offset in range(3):
        report["warm"].append(call("/images/generations", token, context,
                                   request_body(42000 + offset, args.steps, prompt), args.timeout))
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(call, "/images/generations", token, context,
                                   request_body(314159 + offset, args.steps, prompt), args.timeout)
                   for offset in range(2)]
        concurrent = [future.result() for future in futures]
    report["concurrency"] = {
        "requested": 2, "declaredMaximum": 1, "results": concurrent,
        "successful": sum(item.get("httpStatus") == 200 for item in concurrent),
        "capacityRejected": sum(item.get("httpStatus") == 429
                                and item.get("errorCode") == "drawing_capacity_exhausted" for item in concurrent),
    }
    report["unload"] = control("unload", token, context, args.timeout)
    successes = [report["cold"], *report["warm"],
                 *(item for item in concurrent if item.get("httpStatus") == 200)]
    report["passed"] = (
        len(successes) == 5 and all(item.get("passed") is True and item.get("workerMilliseconds", 0) > 0
                                    for item in successes)
        and report["concurrency"]["successful"] == 1
        and report["concurrency"]["capacityRejected"] == 1
        and report["unload"] == {**report["unload"], "httpStatus": 200, "status": "unloaded", "loaded": False}
    )
    report["contentRetained"] = False
    token = "[REDACTED]"
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
