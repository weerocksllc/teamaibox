#!/usr/bin/env python3
"""Detached, content-free OCR stability probe executed inside a restricted GPU container."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import http.client
import json
import os
from pathlib import Path
import statistics
import subprocess
import time
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


def request(host: str, port: int, path: str, body: dict[str, Any] | None = None,
            timeout: int = 300) -> tuple[int, dict[str, Any], bytes, int]:
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    encoded = canonical(body) if body is not None else None
    started = time.monotonic()
    try:
        connection.request("POST" if body is not None else "GET", path, body=encoded,
                           headers={"content-type": "application/json"} if body is not None else {})
        response = connection.getresponse()
        raw = response.read(64 * 1024 * 1024 + 1)
        if len(raw) > 64 * 1024 * 1024:
            raise RuntimeError("OCR response exceeded the bounded limit")
        return response.status, json.loads(raw), raw, round((time.monotonic() - started) * 1000)
    finally:
        connection.close()


def gpu() -> dict[str, float]:
    raw = subprocess.run(
        ["nvidia-smi", "--query-gpu=temperature.gpu,power.draw,utilization.gpu",
         "--format=csv,noheader,nounits"], text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=15, check=True,
    ).stdout.strip().splitlines()
    if len(raw) != 1:
        raise RuntimeError("GPU telemetry count drifted")
    values = [float(item.strip()) for item in raw[0].split(",")]
    if len(values) != 3:
        raise RuntimeError("GPU telemetry shape drifted")
    return {"temperatureCelsius": values[0], "powerWatts": values[1], "utilizationPercent": values[2]}


def available_memory() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("host available memory is absent")


def container_rss(container_ids: list[str]) -> dict[str, int]:
    page_size = os.sysconf("SC_PAGE_SIZE")
    result = {item: 0 for item in container_ids}
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            cgroup = (process / "cgroup").read_text()
            resident_pages = int((process / "statm").read_text().split()[1])
        except (OSError, ValueError, IndexError):
            continue
        for container_id in container_ids:
            if container_id in cgroup:
                result[container_id] += resident_pages * page_size
                break
    if any(value <= 0 for value in result.values()):
        raise RuntimeError("OCR container RSS telemetry is absent")
    return result


def median_window(samples: list[dict[str, Any]], key: str, first: bool) -> float:
    count = max(1, len(samples) // 5)
    window = samples[:count] if first else samples[-count:]
    return float(statistics.median(item[key] for item in window))


def run(args: argparse.Namespace) -> int:
    state = Path(args.state)
    final_path = state / "final.json"
    if final_path.exists():
        raise RuntimeError("soak final state already exists")
    sample = (state / "input.png").read_bytes()
    if digest(sample) != args.input_digest:
        raise RuntimeError("soak input digest drifted")
    request_body = {"file": base64.b64encode(sample).decode(), "fileType": 1}
    started_at = now()
    started = time.monotonic()
    deadline = started + args.duration_seconds
    samples: list[dict[str, Any]] = []
    failure: dict[str, str] | None = None
    try:
        ordinal = 0
        while time.monotonic() < deadline:
            ordinal += 1
            cycle_started = time.monotonic()
            health_status, health, _, health_ms = request(args.host, args.port, "/health", timeout=15)
            if health_status != 200 or health.get("accepting") is not True or health.get("pipeline") != "pp-doclayout-v3-vlm-v1":
                raise RuntimeError("OCR health failed")
            status, value, raw, latency = request(args.host, args.port, "/layout-parsing", request_body)
            if status != 200 or value.get("errorCode") != 0 or digest(raw) != args.response_digest:
                raise RuntimeError("OCR response identity drifted")
            sample_record = {
                "ordinal": ordinal, "timestamp": now(), "httpStatus": status,
                "responseDigest": digest(raw), "latencyMilliseconds": latency,
                "healthMilliseconds": health_ms, "healthPassed": True,
                "hostAvailableMemoryBytes": available_memory(), "gpu": gpu(),
                "containerRssBytes": container_rss(args.container_id),
            }
            samples.append(sample_record)
            checkpoint = {
                "schemaVersion": 1, "runnerId": "teamaibox.current-ocr-soak-probe.v1",
                "runId": args.run_id, "status": "running", "startedAt": started_at,
                "updatedAt": sample_record["timestamp"], "requestedDurationSeconds": args.duration_seconds,
                "intervalSeconds": args.interval_seconds, "sampleCount": len(samples),
                "lastOrdinal": ordinal, "lastResponseDigest": sample_record["responseDigest"],
                "minimumHostAvailableMemoryBytes": min(item["hostAvailableMemoryBytes"] for item in samples),
                "peakTemperatureCelsius": max(item["gpu"]["temperatureCelsius"] for item in samples),
                "sourceDigest": args.source_digest,
            }
            checkpoint["checkpointDigest"] = digest(canonical(checkpoint))
            atomic_json(state / "checkpoint.json", checkpoint)
            next_cycle = cycle_started + args.interval_seconds
            current = time.monotonic()
            if current < deadline:
                # Sleep through the final boundary too. Without this, a cycle
                # whose next start equals the deadline can spin requests until
                # the wall-clock duration happens to expire.
                time.sleep(max(0, min(next_cycle, deadline) - current))
    except BaseException as error:
        failure = {"type": type(error).__name__, "message": str(error)[:600]}
    completed_at = now()
    elapsed = round(time.monotonic() - started, 3)
    first_latency = median_window(samples, "latencyMilliseconds", True) if samples else 0
    last_latency = median_window(samples, "latencyMilliseconds", False) if samples else 0
    result = {
        "schemaVersion": 1, "runnerId": "teamaibox.current-ocr-soak-probe.v1", "runId": args.run_id,
        "status": "passed" if failure is None and elapsed >= args.duration_seconds else "failed",
        "startedAt": started_at, "completedAt": completed_at,
        "requestedDurationSeconds": args.duration_seconds, "elapsedSeconds": elapsed,
        "intervalSeconds": args.interval_seconds, "inputDigest": args.input_digest,
        "expectedResponseDigest": args.response_digest, "sourceDigest": args.source_digest,
        "containerIds": args.container_id, "sampleCount": len(samples), "samples": samples,
        "analysis": {
            "firstWindowMedianLatencyMilliseconds": first_latency,
            "lastWindowMedianLatencyMilliseconds": last_latency,
            "latencyDegradationFraction": ((last_latency - first_latency) / first_latency) if first_latency else 0,
            "minimumHostAvailableMemoryBytes": min((item["hostAvailableMemoryBytes"] for item in samples), default=0),
            "peakTemperatureCelsius": max((item["gpu"]["temperatureCelsius"] for item in samples), default=0),
        },
        "failure": failure, "inputContentRetained": False, "recognizedContentRetained": False,
        "credentialsRetained": False,
    }
    result["evidenceDigest"] = digest(canonical(result))
    atomic_json(final_path, result)
    return 0 if result["status"] == "passed" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18082)
    parser.add_argument("--duration-seconds", type=int, required=True)
    parser.add_argument("--interval-seconds", type=int, required=True)
    parser.add_argument("--input-digest", required=True)
    parser.add_argument("--response-digest", required=True)
    parser.add_argument("--source-digest", required=True)
    parser.add_argument("--container-id", action="append", required=True)
    parser.add_argument("--state", default="/state")
    args = parser.parse_args()
    if args.duration_seconds < 30 or args.interval_seconds < 5 or args.interval_seconds >= args.duration_seconds:
        raise SystemExit("soak duration or interval is invalid")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
