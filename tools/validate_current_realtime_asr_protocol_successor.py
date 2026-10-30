#!/usr/bin/env python3
"""Validate fresh realtime ASR protocol evidence and normal-system-trust launch."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Sequence

try:
    from .validate_realtime_asr_browser_smoke import ROOT, validate as validate_base
except ImportError:
    from validate_realtime_asr_browser_smoke import ROOT, validate as validate_base


class ValidationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    base = validate_base(resolved)
    require(base.get("status") == "passed" and base.get("journeyCount") == 2,
            "realtime ASR successor base validation failed")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(value.get("runId") == "realtime-asr-browser-20260830-trusted-a6"
            and "runtimeBinding" not in value,
            "realtime ASR successor identity drifted")
    launch = resolved.with_name("current-trusted-realtime-asr-protocol-20260830-a6-launch.json")
    require(launch.is_file(), "realtime ASR successor launch attestation is missing")
    attestation = json.loads(launch.read_text(encoding="utf-8"))
    require(attestation.get("runnerId") == "teamaibox.trusted-browser-preload.v1"
            and attestation.get("systemTrustOnly") is True
            and attestation.get("certificateBypassArgumentsPresent") is False
            and attestation.get("customClientCaArgumentPresent") is False,
            "realtime ASR successor did not use normal system trust")
    return {"valid": True, "runId": value["runId"], "status": "passed", "journeyCount": 2,
            "systemTrustedBrowser": True, "launchFileSha256": digest(launch),
            "currentPlatformBoundByAggregate": True}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    print(json.dumps(validate(parser.parse_args(argv).evidence), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationError, OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        raise SystemExit("current realtime ASR protocol successor validation failed: " + str(error))
