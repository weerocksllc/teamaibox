#!/usr/bin/env python3
"""Exercise the retained realtime-ASR worker without retaining audio or transcript text."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import threading
import time
from typing import Any

import requests


EXPECTED_TOKENS = tuple(
    "team ai box private transcription test 2026 local artificial intelligence keeps team data protected".split()
)


def require(value: bool, message: str) -> None:
    if not value:
        raise RuntimeError(message)


def digest(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def transcribe(base_url: str, model: str, fixture: Path, gate: threading.Barrier) -> dict[str, Any]:
    gate.wait(timeout=10)
    started = time.monotonic()
    with fixture.open("rb") as source:
        response = requests.post(
            base_url + "/v1/audio/transcriptions",
            data={"model": model, "language": "en", "response_format": "verbose_json"},
            files={"file": (fixture.name, source, "audio/wav")},
            timeout=180,
        )
    elapsed = round((time.monotonic() - started) * 1000, 3)
    require(response.status_code == 200, "ASR transcription request failed")
    value = response.json()
    transcript = value.get("text")
    segments = value.get("segments")
    require(isinstance(transcript, str) and transcript.strip(), "ASR transcript is empty")
    require(isinstance(segments, list) and segments, "ASR segment result is empty")
    normalized = tuple(transcript.lower().split())
    matched = sum(token in normalized for token in EXPECTED_TOKENS)
    require(matched == len(EXPECTED_TOKENS), "ASR deterministic token recall drifted")
    require(all(
        isinstance(item, dict)
        and isinstance(item.get("start"), (int, float))
        and isinstance(item.get("end"), (int, float))
        and 0 <= item["start"] <= item["end"] <= 300
        for item in segments
    ), "ASR segment timeline drifted")
    encoded = transcript.encode("utf-8")
    return {
        "statusCode": response.status_code,
        "latencyMilliseconds": elapsed,
        "language": value.get("language"),
        "durationSeconds": value.get("duration"),
        "segmentCount": len(segments),
        "matchedTokenCount": matched,
        "expectedTokenCount": len(EXPECTED_TOKENS),
        "tokenRecall": 1.0,
        "resultDigest": digest(encoded),
        "resultBytes": len(encoded),
        "contentRetained": False,
    }


def run(base_url: str, model: str, fixture: Path) -> dict[str, Any]:
    fixture_bytes = fixture.read_bytes()
    require(44 <= len(fixture_bytes) <= 8 * 1024 * 1024, "ASR fixture is outside the bounded input envelope")
    health_response = requests.get(base_url + "/health/ready", timeout=15)
    require(health_response.status_code == 200, "ASR readiness request failed")
    health = health_response.json()
    require(
        health == {
            "status": "ready",
            "model": model,
            "device": "cpu",
            "precision": "int8",
            "maximum_concurrent_requests": 1,
        },
        "ASR readiness contract drifted",
    )
    models_response = requests.get(base_url + "/v1/models", timeout=15)
    require(models_response.status_code == 200, "ASR model discovery failed")
    models = models_response.json()
    discovered = [item.get("id") for item in models.get("data", []) if isinstance(item, dict)]
    require(discovered == [model], "ASR served-model identity drifted")

    gate = threading.Barrier(2)
    wall_started = time.monotonic()
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(transcribe, base_url, model, fixture, gate) for _ in range(2)]
        parallel = [future.result(timeout=190) for future in futures]
    wall_elapsed = round((time.monotonic() - wall_started) * 1000, 3)
    require(len({item["resultDigest"] for item in parallel}) == 1, "ASR warm results are not deterministic")

    with fixture.open("rb") as source:
        rejected = requests.post(
            base_url + "/v1/audio/transcriptions",
            data={"model": model + "-unavailable", "language": "en"},
            files={"file": (fixture.name, source, "audio/wav")},
            timeout=15,
        )
    require(rejected.status_code == 404, "ASR unavailable model did not fail closed")
    rejected_value = rejected.json()
    require(
        rejected_value.get("detail", {}).get("error", {}).get("code") == "model_not_found",
        "ASR unavailable-model error contract drifted",
    )
    return {
        "modelDiscovered": True,
        "servedModel": model,
        "health": health,
        "inputDigest": digest(fixture_bytes),
        "inputBytes": len(fixture_bytes),
        "simultaneousRequestCount": 2,
        "serverReportedMaximumConcurrentRequests": 1,
        "parallelRequests": parallel,
        "parallelWallMilliseconds": wall_elapsed,
        "deterministicAcrossQueuedRequests": True,
        "unavailableModel": {"statusCode": 404, "errorCode": "model_not_found", "failClosed": True},
        "audioRetained": False,
        "transcriptRetained": False,
        "passed": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--model", required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.base_url.rstrip("/"), args.model, args.fixture), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
