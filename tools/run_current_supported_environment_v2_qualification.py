#!/usr/bin/env python3
"""Create immutable qualification for the current supported-environment and feature catalogs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from typing import Any, Sequence

try:
    from .run_spark_model_baseline import canonical_digest, utc_now
    from .spark_validation import ROOT
except ImportError:
    from run_spark_model_baseline import canonical_digest, utc_now
    from spark_validation import ROOT


RUN_ID = re.compile(r"^current-supported-environment-v2-[0-9]{8}-a[1-9][0-9]*$")
EVIDENCE_ROOT = ROOT / "evidence/validation/acceptance"
MATRIX = ROOT / "architecture/validation/supported-environment-matrix.v2.json"
CATALOG = ROOT / "architecture/validation/feature-acceptance-catalog.v6.json"
COMMANDS = (
    ("python3", "tools/create_supported_environment_matrix_v2.py", "--check"),
    ("python3", "tools/validate_supported_environment_matrix_v2.py"),
    ("python3", "tools/create_feature_acceptance_catalog_v6.py", "--check"),
    ("python3", "tools/validate_feature_acceptance_catalog_v6.py"),
    ("python3", "tools/guard_openspec_feature_completion.py"),
    ("openspec", "validate", "build-team-ai-box-platform", "--strict"),
)
SOURCES = (
    "tools/create_supported_environment_matrix_v2.py",
    "tools/validate_supported_environment_matrix_v2.py",
    "tests/test_supported_environment_matrix_v2.py",
    "tools/create_feature_acceptance_catalog_v6.py",
    "tools/validate_feature_acceptance_catalog_v6.py",
    "tests/test_feature_acceptance_catalog_v6.py",
    "tools/run_current_supported_environment_v2_qualification.py",
    "tools/validate_current_supported_environment_v2_qualification.py",
    "tests/test_current_supported_environment_v2_qualification.py",
)


class QualificationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationFailure(message)


def digest(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def artifact(path: Path, identity_key: str, identity: str) -> tuple[dict[str, Any], dict[str, str]]:
    raw = path.read_bytes()
    value = json.loads(raw)
    require(value.get(identity_key) == identity, f"current artifact drifted: {path.name}")
    return value, {"path": path.relative_to(ROOT).as_posix(), identity_key: identity,
                   "fileSha256": digest(raw)}


def command(argv: tuple[str, ...]) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=2400, check=False)
    return {"argvDigest": digest(json.dumps(list(argv), separators=(",", ":")).encode()),
            "exitCode": completed.returncode,
            "durationMilliseconds": int((time.monotonic() - started) * 1000),
            "stdoutDigest": digest(completed.stdout), "stderrDigest": digest(completed.stderr),
            "outputRetained": False}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    require(RUN_ID.fullmatch(args.run_id) is not None, "supported-environment qualification run ID is invalid")
    output = EVIDENCE_ROOT / f"{args.run_id}.json"
    require(not output.exists(), "supported-environment qualification already exists")
    matrix, matrix_binding = artifact(MATRIX, "matrixId", "teamaibox.supported-environment.v2")
    catalog, catalog_binding = artifact(CATALOG, "catalogId", "teamaibox.feature-acceptance.v6")
    require(matrix["gatePolicy"]["task20_5Satisfied"] is True
            and matrix["gatePolicy"]["task20_1Satisfied"] is False
            and catalog["technicalClosure"]["productAcceptedCount"] == 10,
            "current supported environment or feature catalog claim drifted")
    started = utc_now()
    rows = [command(item) for item in COMMANDS]
    passed = all(row["exitCode"] == 0 for row in rows)
    report = {
        "schemaVersion": 1,
        "runnerId": "teamaibox.current-supported-environment-v2-qualification.v1",
        "runId": args.run_id,
        "status": "passed" if passed else "failed",
        "startedAt": started,
        "completedAt": utc_now(),
        "artifacts": {"supportedEnvironment": matrix_binding, "featureCatalog": catalog_binding},
        "summary": {"environmentCount": 6, "managedWorkerObservationCount": 1,
                    "modelProfileCount": 5, "featureCount": 44,
                    "componentReadyCount": 34, "productAcceptedCount": 10,
                    "releaseBlockerCount": 2},
        "gatePolicy": matrix["gatePolicy"],
        "validationCommands": rows,
        "sources": [{"path": path, "sha256": digest((ROOT / path).read_bytes())} for path in SOURCES],
        "privacy": {"credentialsRetained": False, "cookieValuesRetained": False,
                    "userContentRetained": False, "commandOutputRetained": False},
        "claimBoundary": {"task20_5Satisfied": passed, "task20_1Satisfied": False,
                          "task20_6Satisfied": False, "baseProductCatalogComplete": False,
                          "independentHumanAcceptance": False,
                          "optionalUsbModeInstalled": False,
                          "activeMediaLuksMigrationSelected": False,
                          "releaseCandidatePromoted": False},
        "failure": None if passed else {"failedCommandIndexes": [index for index, row in enumerate(rows)
                                                                    if row["exitCode"] != 0],
                                        "outputRetained": False},
    }
    report["evidenceDigest"] = canonical_digest(report)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"runId": args.run_id, "status": report["status"],
                      "task20_5Satisfied": passed, "task20_1Satisfied": False,
                      "evidence": output.relative_to(ROOT).as_posix()}, separators=(",", ":")))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (QualificationFailure, OSError, ValueError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        raise SystemExit(f"current supported-environment v2 qualification failed: {error}")
