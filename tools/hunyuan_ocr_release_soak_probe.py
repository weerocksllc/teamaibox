#!/usr/bin/env python3
"""Detached, content-minimising HunyuanOCR DFlash release-soak probe."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import ssl
import statistics
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True).encode() + b"\n")
    os.replace(temporary, path)


def request(
    base_url: str,
    token: str,
    context: ssl.SSLContext,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    timeout: int,
) -> tuple[int, dict[str, Any], int]:
    encoded = canonical(body) if body is not None else None
    headers = {"accept": "application/json", "authorization": "Bearer " + token}
    if encoded is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base_url + path, data=encoded, method=method, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, context=context, timeout=timeout) as response:
            raw = response.read(64 * 1024 * 1024 + 1)
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read(64 * 1024 * 1024 + 1)
        status = error.code
    if len(raw) > 64 * 1024 * 1024:
        raise RuntimeError("HunyuanOCR response exceeded the bounded limit")
    return status, json.loads(raw or b"{}"), round((time.monotonic() - started) * 1000)


def recognized_text(value: dict[str, Any]) -> str:
    pages = value.get("result", {}).get("layoutParsingResults", [])
    if not isinstance(pages, list) or len(pages) != 1:
        raise RuntimeError("HunyuanOCR release-soak page contract drifted")
    blocks = pages[0].get("prunedResult", {}).get("parsing_res_list", [])
    if not isinstance(blocks, list) or not blocks:
        raise RuntimeError("HunyuanOCR release-soak blocks are absent")
    text = "\n".join(str(item.get("block_content") or "") for item in blocks)
    if not text.strip():
        raise RuntimeError("HunyuanOCR release-soak text is empty")
    if pages[0].get("prunedResult", {}).get("geometry_supported") is not False:
        raise RuntimeError("HunyuanOCR release-soak geometry disclosure drifted")
    if any(item.get("block_bbox") is not None or item.get("confidence") is not None for item in blocks):
        raise RuntimeError("HunyuanOCR release-soak fabricated geometry or confidence")
    return text


def gpu() -> dict[str, float]:
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=temperature.gpu,power.draw,utilization.gpu",
         "--format=csv,noheader,nounits"],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False,
    )
    lines = result.stdout.strip().splitlines()
    if result.returncode or len(lines) != 1:
        raise RuntimeError("HunyuanOCR release-soak GPU telemetry is unavailable")
    values = [float(item.strip()) for item in lines[0].split(",")]
    if len(values) != 3:
        raise RuntimeError("HunyuanOCR release-soak GPU telemetry shape drifted")
    return {"temperatureCelsius": values[0], "powerWatts": values[1], "utilizationPercent": values[2]}


def available_memory() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("host available-memory evidence is absent")


def container_rss(container_id: str) -> int:
    page_size = os.sysconf("SC_PAGE_SIZE")
    total = 0
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            cgroup = (process / "cgroup").read_text(encoding="utf-8")
            resident_pages = int((process / "statm").read_text(encoding="utf-8").split()[1])
        except (OSError, UnicodeError, ValueError, IndexError):
            continue
        if container_id in cgroup:
            total += resident_pages * page_size
    if total <= 0:
        raise RuntimeError("HunyuanOCR Worker RSS telemetry is absent")
    return total


def median_window(samples: list[dict[str, Any]], key: str, first: bool) -> float:
    count = max(1, len(samples) // 5)
    window = samples[:count] if first else samples[-count:]
    return float(statistics.median(float(item[key]) for item in window))


def run(args: argparse.Namespace) -> int:
    state = Path(args.state)
    final_path = state / "final.json"
    if final_path.exists():
        raise RuntimeError("HunyuanOCR release-soak final state already exists")
    image = (state / "input.jpg").read_bytes()
    if digest(image) != args.input_digest:
        raise RuntimeError("HunyuanOCR release-soak input digest drifted")
    token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("HunyuanOCR Provider credential is unavailable")
    context = ssl.create_default_context(cafile=args.ca_file)
    samples: list[dict[str, Any]] = []
    failure: dict[str, str] | None = None
    unload_passed = False
    prepare_milliseconds = 0
    started_at = now()
    started = time.monotonic()
    try:
        status, prepared, prepare_milliseconds = request(
            args.base_url, token, context, "POST", "/v1/models/prepare", {"model": args.model}, 600
        )
        if status != 200 or prepared.get("loaded") is not True:
            raise RuntimeError("HunyuanOCR DFlash prepare failed")
        # The measured duration starts after the exact final bytes are resident.
        started_at = now()
        started = time.monotonic()
        deadline = started + args.duration_seconds
        ordinal = 0
        encoded_image = base64.b64encode(image).decode()
        while time.monotonic() < deadline:
            ordinal += 1
            cycle_started = time.monotonic()
            status_code, model_status, health_ms = request(
                args.base_url, token, context, "GET", "/v1/models/status", None, 30
            )
            if (status_code != 200 or model_status.get("loaded") is not True
                    or model_status.get("inference_mode") != "vllm-dflash"):
                raise RuntimeError("HunyuanOCR DFlash model health drifted")
            job_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{args.run_id}:{ordinal}"))
            request_body = {
                "model": args.model,
                "job_id": job_id,
                "file": encoded_image,
                "fileType": 1,
                "useLayoutDetection": True,
                "formatBlockContent": True,
                "layoutShapeMode": "auto",
                "returnMarkdownImages": False,
                "visualize": False,
            }
            response_status, response, latency = request(
                args.base_url, token, context, "POST", "/v1/ocr", request_body, 300
            )
            extension = response.get("x_teamaibox", {})
            text_digest = digest(recognized_text(response).encode("utf-8"))
            if (response_status != 200 or response.get("errorCode") != 0
                    or text_digest != args.expected_text_digest
                    or extension.get("inference_mode") != "vllm-dflash"
                    or extension.get("dflash_num_speculative_tokens") != 15):
                raise RuntimeError("HunyuanOCR DFlash response identity drifted")
            sample = {
                "ordinal": ordinal,
                "timestamp": now(),
                "httpStatus": response_status,
                "healthPassed": True,
                "healthMilliseconds": health_ms,
                "latencyMilliseconds": latency,
                "textDigest": text_digest,
                "jobIdentityDigest": digest(job_id.encode()),
                "inferenceMode": "vllm-dflash",
                "speculativeTokens": 15,
                "hostAvailableMemoryBytes": available_memory(),
                "workerRssBytes": container_rss(args.worker_container_id),
                "gpu": gpu(),
            }
            samples.append(sample)
            checkpoint = {
                "schemaVersion": 1,
                "runnerId": "teamaibox.hunyuan-ocr-release-soak-probe.v1",
                "runId": args.run_id,
                "status": "running",
                "startedAt": started_at,
                "updatedAt": sample["timestamp"],
                "requestedDurationSeconds": args.duration_seconds,
                "intervalSeconds": args.interval_seconds,
                "sampleCount": len(samples),
                "lastOrdinal": ordinal,
                "lastTextDigest": text_digest,
                "minimumHostAvailableMemoryBytes": min(item["hostAvailableMemoryBytes"] for item in samples),
                "peakTemperatureCelsius": max(item["gpu"]["temperatureCelsius"] for item in samples),
                "sourceDigest": args.source_digest,
            }
            checkpoint["checkpointDigest"] = digest(canonical(checkpoint))
            atomic_json(state / "checkpoint.json", checkpoint)
            current = time.monotonic()
            if current < deadline:
                time.sleep(max(0, min(cycle_started + args.interval_seconds, deadline) - current))
    except BaseException as error:
        failure = {"type": type(error).__name__, "message": str(error)[:800]}
    finally:
        try:
            status, unloaded, _ = request(
                args.base_url, token, context, "POST", "/v1/models/unload", {"model": args.model}, 180
            )
            unload_passed = status == 200 and unloaded.get("loaded") is False
        except BaseException:
            unload_passed = False
        token = ""

    completed_at = now()
    elapsed = round(time.monotonic() - started, 3)
    first_latency = median_window(samples, "latencyMilliseconds", True) if samples else 0
    last_latency = median_window(samples, "latencyMilliseconds", False) if samples else 0
    first_rss = median_window(samples, "workerRssBytes", True) if samples else 0
    last_rss = median_window(samples, "workerRssBytes", False) if samples else 0
    result = {
        "schemaVersion": 1,
        "runnerId": "teamaibox.hunyuan-ocr-release-soak-probe.v1",
        "runId": args.run_id,
        "status": "passed" if failure is None and elapsed >= args.duration_seconds and unload_passed else "failed",
        "startedAt": started_at,
        "completedAt": completed_at,
        "requestedDurationSeconds": args.duration_seconds,
        "elapsedSeconds": elapsed,
        "intervalSeconds": args.interval_seconds,
        "prepareMilliseconds": prepare_milliseconds,
        "inputDigest": args.input_digest,
        "expectedTextDigest": args.expected_text_digest,
        "sourceDigest": args.source_digest,
        "workerContainerId": args.worker_container_id,
        "sampleCount": len(samples),
        "samples": samples,
        "analysis": {
            "firstWindowMedianLatencyMilliseconds": first_latency,
            "lastWindowMedianLatencyMilliseconds": last_latency,
            "latencyDegradationFraction": ((last_latency - first_latency) / first_latency) if first_latency else 0,
            "firstWindowMedianWorkerRssBytes": first_rss,
            "lastWindowMedianWorkerRssBytes": last_rss,
            "workerRssGrowthBytes": max(0, int(last_rss - first_rss)),
            "minimumHostAvailableMemoryBytes": min((item["hostAvailableMemoryBytes"] for item in samples), default=0),
            "peakTemperatureCelsius": max((item["gpu"]["temperatureCelsius"] for item in samples), default=0),
        },
        "unloadPassed": unload_passed,
        "failure": failure,
        "inputContentRetained": False,
        "recognizedContentRetained": False,
        "credentialsRetained": False,
    }
    result["evidenceDigest"] = digest(canonical(result))
    atomic_json(final_path, result)
    return 0 if result["status"] == "passed" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--duration-seconds", type=int, required=True)
    parser.add_argument("--interval-seconds", type=int, required=True)
    parser.add_argument("--input-digest", required=True)
    parser.add_argument("--expected-text-digest", required=True)
    parser.add_argument("--source-digest", required=True)
    parser.add_argument("--worker-container-id", required=True)
    parser.add_argument("--token-file", default="/run/secrets/provider.token")
    parser.add_argument("--ca-file", default="/run/secrets/ca.crt")
    parser.add_argument("--state", default="/state")
    args = parser.parse_args()
    if args.duration_seconds < 30 or args.interval_seconds < 5 or args.interval_seconds >= args.duration_seconds:
        raise SystemExit("HunyuanOCR release-soak duration or interval is invalid")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
