#!/usr/bin/env python3
"""Content-safe real OpenAI transcription probe for an internal ASR worker."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import time
from typing import Any, Sequence

import requests


BASE_URL = re.compile(r"^http://[a-z0-9-]{3,80}:8080$")
AUDIO_PATH = re.compile(r"^/validation/[a-z0-9._-]{3,80}\.wav$")
EXPECTED_WORDS = ("team", "ai", "box", "distributed", "speech", "transcription", "test")


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def wait_ready(session: requests.Session, base_url: str) -> float:
    started = time.monotonic()
    for _ in range(300):
        try:
            response = session.get(base_url + "/health/ready", timeout=1)
            value = response.json()
            if response.ok and value == {
                "status": "ready", "model": "whisper-large-v3-fp16", "device": "cuda", "precision": "fp16",
            }:
                return round((time.monotonic() - started) * 1000, 3)
        except (requests.RequestException, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError("ASR worker did not become ready within the bounded window")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--audio", type=Path, required=True)
    args = parser.parse_args(argv)
    if BASE_URL.fullmatch(args.base_url) is None or AUDIO_PATH.fullmatch(str(args.audio)) is None:
        raise SystemExit("probe endpoint or audio path is invalid")
    audio = args.audio.read_bytes()
    if not 1024 <= len(audio) <= 32 * 1024 * 1024:
        raise SystemExit("audio fixture size is invalid")

    session = requests.Session()
    session.trust_env = False
    readiness_ms = wait_ready(session, args.base_url)
    started = time.monotonic()
    with args.audio.open("rb") as source:
        response = session.post(
            args.base_url + "/v1/audio/transcriptions",
            files={"file": ("qualification.wav", source, "audio/wav")},
            data=[
                ("model", "whisper-large-v3-fp16"), ("language", "en"),
                ("response_format", "verbose_json"), ("timestamp_granularities[]", "segment"),
                ("timestamp_granularities[]", "word"),
                ("temperature", "0"),
            ],
            timeout=600,
        )
    latency_ms = round((time.monotonic() - started) * 1000, 3)
    value: dict[str, Any] = response.json()
    if not response.ok or not isinstance(value.get("text"), str) or not isinstance(value.get("segments"), list):
        raise RuntimeError(f"ASR request failed with HTTP {response.status_code}")
    words = set(re.findall(r"[a-z]+", value["text"].lower()))
    word_match_ratio = sum(word in words for word in EXPECTED_WORDS) / len(EXPECTED_WORDS)
    segments = value["segments"]
    result_words = [word for segment in segments for word in segment.get("words", [])]
    timestamp_monotonic = all(
        isinstance(segment, dict)
        and isinstance(segment.get("start"), (int, float))
        and isinstance(segment.get("end"), (int, float))
        and segment["start"] >= 0
        and segment["end"] >= segment["start"]
        and (index == 0 or segment["start"] >= segments[index - 1]["start"])
        for index, segment in enumerate(segments)
    )
    passed = (
        response.status_code == 200 and value.get("language") == "en" and len(segments) > 0
        and timestamp_monotonic and word_match_ratio >= 0.6 and len(result_words) > 0
        and all(
            isinstance(word, dict)
            and isinstance(word.get("start"), (int, float))
            and isinstance(word.get("end"), (int, float))
            and word["start"] >= 0
            and word["end"] >= word["start"]
            for word in result_words
        )
    )
    output = {
        "schemaVersion": 1,
        "passed": passed,
        "operation": "openai.audio-transcriptions.create",
        "status": response.status_code,
        "model": "whisper-large-v3-fp16",
        "language": value.get("language"),
        "durationSeconds": value.get("duration"),
        "segmentCount": len(segments),
        "wordCount": len(result_words),
        "wordTimestampsPassed": len(result_words) > 0,
        "timestampMonotonic": timestamp_monotonic,
        "wordMatchRatio": word_match_ratio,
        "latencyMilliseconds": latency_ms,
        "readinessMilliseconds": readiness_ms,
        "resultDigest": digest(value["text"].encode("utf-8")),
        "resultBytes": len(value["text"].encode("utf-8")),
        "inputArtifactDigest": digest(audio),
        "retainedAudioOrTranscriptContent": False,
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
