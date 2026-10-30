#!/usr/bin/env python3
"""Strictly validate one exact current Translation Product Accepted successor."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
from typing import Any, Sequence

try:
    from .run_current_translation_product_successor import (
        COMMANDS, EVIDENCE_ROOT, ROOT, RUN_ID, SOURCES, bind_parent, build, digest,
    )
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_current_translation_product_successor import (
        COMMANDS, EVIDENCE_ROOT, ROOT, RUN_ID, SOURCES, bind_parent, build, digest,
    )
    from run_spark_model_baseline import canonical_digest


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and resolved.is_relative_to(EVIDENCE_ROOT),
            "Translation product successor evidence is unsafe")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.current-translation-product-successor.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None
            and resolved.name == value["runId"] + ".json"
            and value.get("status") == "passed" and value.get("failure") is None
            and value.get("features") == ["official.translation", "compute.translation"]
            and value.get("ownerTaskId") == "18.8",
            "Translation product successor identity drifted")
    require(value.get("evidenceDigest") == canonical_digest(
        {key: item for key, item in value.items() if key != "evidenceDigest"}),
        "Translation product successor digest drifted")
    require(value.get("parent") == bind_parent()[1], "Translation product successor parent drifted")
    require(value.get("profile") == {
        "certificationState": "experimental", "experimentalDisclosureRequired": True,
        "selectedCertifiedProfileClaimed": False, "releaseCandidateSoakComplete": False,
    }, "Translation product successor profile boundary drifted")
    require(value.get("acceptance") == {
        "currentApplicationAndComputeAvailable": True, "textImageAudioVideoComposition": True,
        "capacityFailureCancellationPermission": True, "encryptedPersistenceAndRestart": True,
        "systemTrustedBrowser": True,
    }, "Translation product successor acceptance drifted")
    require(value.get("claimBoundary") == {
        "productAccepted": True, "enabledInSupportedRelease": True,
        "experimentalProfileDisclosed": True, "certifiedProfileClaimed": False,
        "releaseCandidateSoakComplete": False, "stageReleaseAccepted": False,
        "independentHumanAcceptanceDeferred": True,
    }, "Translation product successor claim boundary drifted")
    require(value.get("sources") == [
        {"path": item, "sha256": digest((ROOT / item).read_bytes())} for item in SOURCES
    ], "Translation product successor sources drifted")
    rows = value.get("validationCommands", [])
    require(len(rows) == len(COMMANDS), "Translation product successor command coverage drifted")
    for row, command in zip(rows, COMMANDS):
        require(row.get("argvDigest") == digest(json.dumps(list(command), separators=(",", ":")).encode())
                and row.get("exitCode") == 0 and row.get("outputRetained") is False,
                "Translation product successor recorded command drifted")
        completed = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=2400, check=False)
        require(completed.returncode == 0, "Translation product successor parent/test no longer passes")
    current, passed = build(value["runId"])
    require(passed and current.get("claimBoundary") == value.get("claimBoundary")
            and current.get("acceptance") == value.get("acceptance"),
            "Translation product successor live boundary drifted")
    return {"valid": True, "runId": value["runId"], "status": "passed",
            "featureKey": "official.translation", "features": value["features"],
            "productAccepted": True, "certifiedProfileClaimed": False}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    print(json.dumps(validate(parser.parse_args(argv).evidence), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        raise SystemExit(f"Translation product successor validation failed: {error}")
