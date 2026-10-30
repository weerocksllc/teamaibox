#!/usr/bin/env python3
"""Qualify current supported environment, catalog v18, and prepared review v4."""

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


RUN_ID = re.compile(r"^current-supported-records-v4-[0-9]{8}-a[1-9][0-9]*$")
EVIDENCE_ROOT = ROOT / "evidence/validation/acceptance"
MATRIX = ROOT / "architecture/validation/supported-environment-matrix.v4.json"
CATALOG = ROOT / "architecture/validation/feature-acceptance-catalog.v18.json"
REVIEW = ROOT / "architecture/validation/final-acceptance-review.v4.json"
BROWSER = ROOT / "evidence/validation/browser/current-catalog-browser-smoke-20260831-a6.json"
COMMANDS = (
    ("python3", "tools/create_supported_environment_matrix_v4.py", "--check"),
    ("python3", "tools/validate_supported_environment_matrix_v4.py", "--matrix", str(MATRIX)),
    ("python3", "tools/create_final_acceptance_review_v4.py", "--check"),
    ("python3", "tools/validate_final_acceptance_review_v4.py", "--review", str(REVIEW)),
    ("python3", "tools/create_feature_acceptance_catalog_v18.py", "--check"),
    ("python3", "tools/validate_feature_acceptance_catalog_v18.py", "--catalog", str(CATALOG)),
    ("python3", "tools/guard_openspec_feature_completion.py", "--catalog", str(CATALOG)),
    ("python3", "-m", "unittest", "tests.test_supported_environment_matrix_v4",
     "tests.test_final_acceptance_review_v4", "tests.test_current_supported_records_v4_qualification"),
    ("openspec", "validate", "build-team-ai-box-platform", "--strict", "--no-interactive"),
)
SOURCES = (
    "tools/create_supported_environment_matrix_v4.py",
    "tools/validate_supported_environment_matrix_v4.py",
    "tests/test_supported_environment_matrix_v4.py",
    "tools/create_final_acceptance_review_v4.py",
    "tools/validate_final_acceptance_review_v4.py",
    "tests/test_final_acceptance_review_v4.py",
    "tools/run_current_supported_records_v4_qualification.py",
    "tools/validate_current_supported_records_v4_qualification.py",
    "tests/test_current_supported_records_v4_qualification.py",
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
    require(value.get(identity_key) == identity, "supported records v4 artifact drifted: " + path.name)
    if "evidence/" in path.as_posix():
        require(value.get("status") == "passed" and value.get("failure") is None,
                "supported records v4 evidence parent is not passing: " + path.name)
    run_id = value.get("runId") or value.get("matrixId") or value.get("catalogId") or value.get("reviewId")
    require(isinstance(run_id, str), "supported records v4 artifact identity missing: " + path.name)
    return value, {"path": path.relative_to(ROOT).as_posix(), "identity": identity,
                   "runId": run_id, "fileSha256": digest(raw)}


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
    require(RUN_ID.fullmatch(args.run_id) is not None, "supported records v4 run ID is invalid")
    output = EVIDENCE_ROOT / f"{args.run_id}.json"
    require(not output.exists(), "supported records v4 qualification already exists")
    matrix, matrix_binding = artifact(MATRIX, "matrixId", "teamaibox.supported-environment.v4")
    catalog, catalog_binding = artifact(CATALOG, "catalogId", "teamaibox.feature-acceptance.v18")
    review, review_binding = artifact(REVIEW, "reviewId", "teamaibox.final-acceptance.v4")
    browser, browser_binding = artifact(BROWSER, "runnerId", "teamaibox.current-catalog-browser-smoke.v1")
    require(matrix["gatePolicy"]["task20_5Satisfied"] is True
            and catalog["technicalClosure"]["productAcceptedCount"] == 40
            and catalog["technicalClosure"]["componentReadyCount"] == 4
            and catalog["technicalClosure"]["task20_1Satisfied"] is False
            and review["technicalClosure"]["task20_5Satisfied"] is True
            and review["technicalClosure"]["pendingPrerequisiteCount"] == 2
            and browser["claimBoundary"]["systemTrustedBrowser"] is True,
            "supported records v4 claim boundary drifted")
    started = utc_now()
    rows = [command(item) for item in COMMANDS]
    passed = all(row["exitCode"] == 0 for row in rows)
    report: dict[str, Any] = {
        "schemaVersion": 1, "runnerId": "teamaibox.current-supported-records-v4-qualification.v1",
        "runId": args.run_id, "status": "passed" if passed else "failed",
        "startedAt": started, "completedAt": utc_now(),
        "artifacts": {"supportedEnvironment": matrix_binding, "featureCatalog": catalog_binding,
                      "preparedFinalReview": review_binding, "currentApplicationBrowser": browser_binding},
        "summary": {"environmentCount": 6, "capabilityReviewCount": 11, "featureCount": 44,
                    "productAcceptedCount": 40, "componentReadyCount": 4,
                    "currentApplicationLaunchCount": 15, "releaseBlockerCount": 2,
                    "pendingReviewPrerequisiteCount": 2},
        "validationCommands": rows,
        "sources": [{"path": path, "sha256": digest((ROOT / path).read_bytes())} for path in SOURCES],
        "privacy": {"credentialsRetained": False, "cookieValuesRetained": False,
                    "userContentRetained": False, "commandOutputRetained": False,
                    "reviewerIdentityRetained": False},
        "claimBoundary": {"task20_5Satisfied": passed, "task20_1Satisfied": False,
            "task20_6Satisfied": False, "baseProductCatalogComplete": False,
            "independentHumanAcceptance": False, "optionalUsbModeInstalled": False,
            "activeMediaLuksMigrationSelected": False, "releaseCandidatePromoted": False,
            "drawingCertified": False, "ocrCertified": False},
        "failure": None if passed else {"failedCommandIndexes": [
            index for index, row in enumerate(rows) if row["exitCode"] != 0], "outputRetained": False},
    }
    report["evidenceDigest"] = canonical_digest(report)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"runId": args.run_id, "status": report["status"],
        "task20_5Satisfied": passed, "task20_1Satisfied": False,
        "productAcceptedCount": 40, "componentReadyCount": 4,
        "evidence": output.relative_to(ROOT).as_posix()}, separators=(",", ":")))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (QualificationFailure, OSError, ValueError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        raise SystemExit("current supported records v4 qualification failed: " + str(error))
