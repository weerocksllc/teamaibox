#!/usr/bin/env python3
"""Strictly validate the immutable current supported-records v3 qualification."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
from typing import Sequence

try:
    from .run_current_supported_records_v3_qualification import (
        BROWSER, CATALOG, COMMANDS, EVIDENCE_ROOT, MATRIX, REVIEW, RUN_ID, SOURCES, artifact, digest,
    )
    from .run_spark_model_baseline import canonical_digest
    from .spark_validation import ROOT
except ImportError:
    from run_current_supported_records_v3_qualification import (
        BROWSER, CATALOG, COMMANDS, EVIDENCE_ROOT, MATRIX, REVIEW, RUN_ID, SOURCES, artifact, digest,
    )
    from run_spark_model_baseline import canonical_digest
    from spark_validation import ROOT


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def validate(path: Path, *, live_commands: bool = True) -> dict:
    resolved = path.resolve()
    require(resolved.is_file() and resolved.is_relative_to(EVIDENCE_ROOT),
            "supported records v3 qualification path is unsafe")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    recorded = value.pop("evidenceDigest", None)
    require(recorded == canonical_digest(value), "supported records v3 qualification digest drifted")
    value["evidenceDigest"] = recorded
    require(value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.current-supported-records-v3-qualification.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None
            and resolved.name == f"{value.get('runId')}.json"
            and value.get("status") == "passed" and value.get("failure") is None,
            "supported records v3 qualification identity drifted")
    expected_artifacts = {
        "supportedEnvironment": artifact(MATRIX, "matrixId", "teamaibox.supported-environment.v3")[1],
        "featureCatalog": artifact(CATALOG, "catalogId", "teamaibox.feature-acceptance.v15")[1],
        "preparedFinalReview": artifact(REVIEW, "reviewId", "teamaibox.final-acceptance.v3")[1],
        "currentApplicationBrowser": artifact(BROWSER, "runnerId", "teamaibox.current-catalog-browser-smoke.v1")[1],
    }
    require(value.get("artifacts") == expected_artifacts,
            "supported records v3 artifact binding drifted")
    require(value.get("summary") == {"environmentCount": 6, "capabilityReviewCount": 11,
            "featureCount": 44, "productAcceptedCount": 40, "componentReadyCount": 4,
            "currentApplicationLaunchCount": 15, "releaseBlockerCount": 2,
            "pendingReviewPrerequisiteCount": 2}, "supported records v3 summary drifted")
    require(value.get("claimBoundary") == {"task20_5Satisfied": True,
            "task20_1Satisfied": False, "task20_6Satisfied": False,
            "baseProductCatalogComplete": False, "independentHumanAcceptance": False,
            "optionalUsbModeInstalled": False, "activeMediaLuksMigrationSelected": False,
            "releaseCandidatePromoted": False, "drawingCertified": False, "ocrCertified": False},
            "supported records v3 claim boundary drifted")
    require(value.get("sources") == [
        {"path": source, "sha256": digest((ROOT / source).read_bytes())} for source in SOURCES],
        "supported records v3 source drifted")
    rows = value.get("validationCommands", [])
    require(len(rows) == len(COMMANDS)
            and all(row.get("exitCode") == 0 and row.get("outputRetained") is False for row in rows),
            "supported records v3 recorded command failed")
    if live_commands:
        for command in COMMANDS:
            completed = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       timeout=2400, check=False)
            require(completed.returncode == 0,
                    "supported records v3 current validator failed: " + " ".join(command[:2]))
    return {"valid": True, "runId": value["runId"], "status": "passed",
            "evidenceDigest": recorded, "task20_5Satisfied": True,
            "task20_1Satisfied": False, "task20_6Satisfied": False,
            "productAcceptedCount": 40, "componentReadyCount": 4}


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
        raise SystemExit("current supported records v3 qualification invalid: " + str(error))
