#!/usr/bin/env python3
"""Strictly validate the immutable current supported-environment v2 qualification."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
from typing import Sequence

try:
    from .run_current_supported_environment_v2_qualification import (
        CATALOG, COMMANDS, EVIDENCE_ROOT, MATRIX, RUN_ID, SOURCES, artifact, digest,
    )
    from .run_spark_model_baseline import canonical_digest
    from .spark_validation import ROOT
except ImportError:
    from run_current_supported_environment_v2_qualification import (
        CATALOG, COMMANDS, EVIDENCE_ROOT, MATRIX, RUN_ID, SOURCES, artifact, digest,
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
            "supported-environment qualification path is unsafe")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    recorded = value.pop("evidenceDigest", None)
    require(recorded == canonical_digest(value), "supported-environment qualification digest drifted")
    value["evidenceDigest"] = recorded
    require(value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.current-supported-environment-v2-qualification.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None
            and resolved.name == f"{value.get('runId')}.json"
            and value.get("status") == "passed" and value.get("failure") is None,
            "supported-environment qualification identity drifted")
    expected_artifacts = {
        "supportedEnvironment": artifact(MATRIX, "matrixId", "teamaibox.supported-environment.v2")[1],
        "featureCatalog": artifact(CATALOG, "catalogId", "teamaibox.feature-acceptance.v6")[1],
    }
    require(value.get("artifacts") == expected_artifacts, "supported-environment artifact binding drifted")
    require(value.get("summary") == {"environmentCount": 6, "managedWorkerObservationCount": 1,
            "modelProfileCount": 5, "featureCount": 44, "componentReadyCount": 34,
            "productAcceptedCount": 10, "releaseBlockerCount": 2},
            "supported-environment qualification summary drifted")
    require(value.get("claimBoundary") == {"task20_5Satisfied": True, "task20_1Satisfied": False,
            "task20_6Satisfied": False, "baseProductCatalogComplete": False,
            "independentHumanAcceptance": False, "optionalUsbModeInstalled": False,
            "activeMediaLuksMigrationSelected": False, "releaseCandidatePromoted": False},
            "supported-environment qualification claim boundary drifted")
    require(value.get("sources") == [{"path": source, "sha256": digest((ROOT / source).read_bytes())}
                                      for source in SOURCES],
            "supported-environment qualification source drifted")
    rows = value.get("validationCommands", [])
    require(len(rows) == len(COMMANDS)
            and all(row.get("exitCode") == 0 and row.get("outputRetained") is False for row in rows),
            "supported-environment qualification recorded command failed")
    if live_commands:
        for command in COMMANDS:
            completed = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       timeout=2400, check=False)
            require(completed.returncode == 0,
                    f"supported-environment current validator failed: {' '.join(command[:2])}")
    return {"valid": True, "runId": value["runId"], "status": "passed",
            "evidenceDigest": recorded, "task20_5Satisfied": True,
            "task20_1Satisfied": False, "task20_6Satisfied": False}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        raise SystemExit(f"current supported-environment v2 qualification invalid: {error}")
