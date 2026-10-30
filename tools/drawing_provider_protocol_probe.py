#!/usr/bin/env python3
"""Run a bounded drawing Provider request without retaining generated image content."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import ssl
import urllib.error
import urllib.request
import uuid


def request(url: str, token: str, ca_file: str, value: dict, timeout: int) -> tuple[int, dict]:
    encoded = json.dumps(value, separators=(",", ":")).encode()
    call = urllib.request.Request(url, data=encoded, method="POST", headers={
        "Accept": "application/json", "Content-Type": "application/json", "Authorization": f"Bearer {token}",
    })
    context = ssl.create_default_context(cafile=ca_file)
    try:
        with urllib.request.urlopen(call, context=context, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", default="https://127.0.0.1:19095/v1")
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--ca-file", required=True)
    parser.add_argument("--job-id")
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    with open(args.token_file, encoding="utf-8") as handle:
        token = handle.read().strip()
    job_id = args.job_id or str(uuid.uuid4())
    status, value = request(args.origin.rstrip("/") + "/images/generations", token, args.ca_file, {
        "model": "sdxl-base-1.0-fp16", "prompt": "A small green robot on a plain white background",
        "n": 1, "size": "512x512", "response_format": "b64_json",
        "x_teamaibox": {"job_id": job_id, "seed": 4242, "steps": 4, "guidance_scale": 5,
                         "negative_prompt": "text, watermark", "output_format": "png",
                         "preset_key": "drawing.provider.smoke.v1"},
    }, args.timeout)
    image = value.get("data", [{}])[0].get("b64_json") if isinstance(value, dict) else None
    if status != 200 or not isinstance(image, str):
        print(json.dumps({"passed": False, "status": status,
                          "errorCode": value.get("error", {}).get("code") if isinstance(value, dict) else None},
                         separators=(",", ":"), sort_keys=True))
        return 1
    raw = bytearray(base64.b64decode(image, validate=True))
    facts = value.get("x_teamaibox", {})
    output = {"passed": True, "status": status, "jobId": job_id, "bytes": len(raw),
              "sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
              "facts": {key: facts.get(key) for key in ("seed", "steps", "guidance_scale", "width", "height",
                                                              "output_format", "preset_key", "duration_milliseconds")}}
    raw[:] = b"\0" * len(raw)
    print(json.dumps(output, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
