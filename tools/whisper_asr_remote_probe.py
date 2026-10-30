#!/usr/bin/env python3
"""Content-safe cross-box mTLS probe for the real Whisper ASR endpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import ssl
import time
from typing import Any, Sequence

import requests
from validation_origin import is_https_origin


VALIDATION_FILE = re.compile(r"^/validation/[a-z0-9._-]{3,80}$")
EXPECTED_WORDS = ("team", "ai", "box", "distributed", "speech", "transcription", "test")


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def bounded_file(path: Path, minimum: int, maximum: int) -> bytes:
    if VALIDATION_FILE.fullmatch(str(path)) is None or not path.is_file() or path.is_symlink():
        raise RuntimeError("remote probe artifact path is invalid")
    value = path.read_bytes()
    if not minimum <= len(value) <= maximum:
        raise RuntimeError("remote probe artifact size is invalid")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--ca", type=Path, required=True)
    parser.add_argument("--cert", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    args = parser.parse_args(argv)
    if not is_https_origin(args.base_url):
        raise RuntimeError("supply an explicit HTTPS ASR origin without credentials, path or query")
    audio = bounded_file(args.audio, 1024, 32 * 1024 * 1024)
    ca = bounded_file(args.ca, 100, 16 * 1024)
    cert = bounded_file(args.cert, 100, 16 * 1024)
    bounded_file(args.key, 100, 16 * 1024)

    session = requests.Session()
    session.trust_env = False
    session.verify = str(args.ca)
    session.cert = (str(args.cert), str(args.key))
    ready = None
    ready_started = time.monotonic()
    for _ in range(300):
        try:
            response = session.get(args.base_url + "/health/ready", timeout=2, allow_redirects=False)
            value = response.json()
            if response.ok and value.get("status") == "ready" and value.get("model") == "whisper-large-v3-fp16" and value.get("tlsVersion") == "TLSv1.3" and value.get("clientCertificatePresented") is True:
                ready = value
                break
        except (requests.RequestException, ValueError):
            pass
        time.sleep(2)
    if ready is None:
        raise RuntimeError("cross-box ASR worker did not become mTLS-ready")
    readiness_ms = round((time.monotonic() - ready_started) * 1000, 3)

    started = time.monotonic()
    with args.audio.open("rb") as source:
        response = session.post(
            args.base_url + "/v1/audio/transcriptions",
            files={"file": ("qualification.wav", source, "audio/wav")},
            data=[
                ("model", "whisper-large-v3-fp16"), ("language", "en"),
                ("response_format", "verbose_json"), ("timestamp_granularities[]", "segment"),
                ("temperature", "0"),
            ],
            timeout=620,
            allow_redirects=False,
        )
    latency_ms = round((time.monotonic() - started) * 1000, 3)
    value: dict[str, Any] = response.json()
    if not response.ok or not isinstance(value.get("text"), str) or not isinstance(value.get("segments"), list):
        raise RuntimeError(f"cross-box ASR request failed with HTTP {response.status_code}")
    words = set(re.findall(r"[a-z]+", value["text"].lower()))
    ratio = sum(word in words for word in EXPECTED_WORDS) / len(EXPECTED_WORDS)
    segments = value["segments"]
    monotonic = all(
        isinstance(segment, dict) and isinstance(segment.get("start"), (int, float))
        and isinstance(segment.get("end"), (int, float)) and segment["start"] >= 0
        and segment["end"] >= segment["start"]
        and (index == 0 or segment["start"] >= segments[index - 1]["start"])
        for index, segment in enumerate(segments)
    )
    passed = response.status_code == 200 and value.get("language") == "en" and segments and monotonic and ratio >= 0.6 and response.headers.get("x-teamaibox-tls-version") == "TLSv1.3"
    output = {
        "schemaVersion": 1,
        "passed": bool(passed),
        "operation": "openai.audio-transcriptions.create",
        "endpointOrigin": args.base_url,
        "transport": "mutual-tls-1.3",
        "serverCertificateAuthorityDigest": digest(ca),
        "clientCertificateDigest": digest(ssl.PEM_cert_to_DER_cert(cert.decode("ascii"))),
        "gatewayObservedClientCertificateDigest": ready["clientCertificateDigest"],
        "status": response.status_code,
        "model": "whisper-large-v3-fp16",
        "language": value.get("language"),
        "durationSeconds": value.get("duration"),
        "segmentCount": len(segments),
        "timestampMonotonic": monotonic,
        "wordMatchRatio": ratio,
        "latencyMilliseconds": latency_ms,
        "readinessMilliseconds": readiness_ms,
        "resultDigest": digest(value["text"].encode("utf-8")),
        "resultBytes": len(value["text"].encode("utf-8")),
        "inputArtifactDigest": digest(audio),
        "retainedAudioTranscriptOrPrivateKeyContent": False,
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
