#!/usr/bin/env python3
"""Qualify the exact-current supported environment, catalog, and prepared review records."""

from __future__ import annotations

if __name__ == "__main__":
    raise SystemExit("Retired OpenSpec qualification runner. See docs/project/legacy-validation.md; no checks or reports were run.")

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


RUN_ID = re.compile(r"^current-supported-records-v3-[0-9]{8}-a[1-9][0-9]*$")
EVIDENCE_ROOT = ROOT / "evidence/validation/acceptance"
MATRIX = ROOT / "architecture/validation/supported-environment-matrix.v3.json"
CATALOG = ROOT / "architecture/validation/feature-acceptance-catalog.v15.json"
REVIEW = ROOT / "architecture/validation/final-acceptance-review.v3.json"
BROWSER = ROOT / "evidence/validation/browser/current-catalog-browser-smoke-20260830-a5.json"
COMMANDS = (
    ("python3", "tools/create_supported_environment_matrix_v3.py", "--check"),
    ("python3", "tools/validate_supported_environment_matrix_v3.py", "--matrix", str(MATRIX)),
    ("python3", "tools/create_final_acceptance_review_v3.py", "--check"),
    ("python3", "tools/validate_final_acceptance_review_v3.py", "--review", str(REVIEW)),
    ("python3", "tools/create_feature_acceptance_catalog_v15.py", "--check"),
    ("python3", "tools/validate_feature_acceptance_catalog_v15.py", "--catalog", str(CATALOG)),
    ("python3", "tools/guard_openspec_feature_completion.py", "--catalog", str(CATALOG)),
    ("python3", "-m", "unittest", "tests.test_supported_environment_matrix_v3",
     "tests.test_final_acceptance_review_v3", "tests.test_current_supported_records_v3_qualification"),
    ("openspec", "validate", "build-team-ai-box-platform", "--strict"),
)
SOURCES = (
    "tools/create_supported_environment_matrix_v3.py",
    "tools/validate_supported_environment_matrix_v3.py",
    "tests/test_supported_environment_matrix_v3.py",
    "tools/create_final_acceptance_review_v3.py",
    "tools/validate_final_acceptance_review_v3.py",
    "tests/test_final_acceptance_review_v3.py",
    "tools/run_current_supported_records_v3_qualification.py",
    "tools/validate_current_supported_records_v3_qualification.py",
    "tests/test_current_supported_records_v3_qualification.py",
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
    require(value.get(identity_key) == identity, f"supported records artifact drifted: {path.name}")
    if "evidence/" in path.as_posix():
        require(value.get("status") == "passed" and value.get("failure") is None,
                f"supported records evidence parent is not passing: {path.name}")
    run_id = value.get("runId") or value.get("matrixId") or value.get("catalogId") or value.get("reviewId")
    require(isinstance(run_id, str), f"supported records artifact identity missing: {path.name}")
    return value, {"path": path.relative_to(ROOT).as_posix(), "identity": identity,
                   "runId": run_id, "fileSha256": digest(raw)}


def command(argv: tuple[str, ...]) -> dict[str, Any]:
    """Reject new execution; historical record readers remain separate."""
    raise RuntimeError("Retired OpenSpec qualification runner. See docs/project/legacy-validation.md; no checks or reports were run.")


def main(argv: Sequence[str] | None = None) -> int:
    """Reject new execution; historical record readers remain separate."""
    raise RuntimeError("Retired OpenSpec qualification runner. See docs/project/legacy-validation.md; no checks or reports were run.")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (QualificationFailure, OSError, ValueError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        raise SystemExit("current supported records v3 qualification failed: " + str(error))
