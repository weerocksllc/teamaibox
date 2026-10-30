#!/usr/bin/env python3
"""Strictly validate exact Drawing candidate selection evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess

try:
    from .run_drawing_candidate_selection import (MEMORY_BUDGET, PARENTS, ROOT, RUN_ID, SOURCES,
        build, sha)
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_drawing_candidate_selection import MEMORY_BUDGET, PARENTS, ROOT, RUN_ID, SOURCES, build, sha
    from run_spark_model_baseline import canonical_digest


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def validate(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    recorded = value.pop("evidenceDigest", None)
    require(recorded == canonical_digest(value), "Drawing selection digest drifted")
    value["evidenceDigest"] = recorded
    require(value.get("runnerId") == "teamaibox.drawing-candidate-selection.v1"
        and RUN_ID.fullmatch(str(value.get("runId", ""))) and path.name == value["runId"] + ".json"
        and value.get("status") == "passed" and value.get("failure") is None,
        "Drawing selection identity drifted")
    expected = build(value["runId"])
    for key in ("parents", "memoryBudget", "candidates", "intentDefaults", "fallbacks",
                "selectedLocalProfiles", "claimBoundary"):
        require(value[key] == expected[key], "Drawing selection drifted: " + key)
    require(value["memoryBudget"] == MEMORY_BUDGET
        and len(value["selectedLocalProfiles"]) == 2
        and value["intentDefaults"]["drawing.edit"] is None
        and value["fallbacks"]["drawing.edit"]["policy"] == "external-overflow-only",
        "Drawing selection boundary drifted")
    require({item["path"]: item["sha256"] for item in value["sources"]} ==
        {source.relative_to(ROOT).as_posix(): sha(source.read_bytes()) for source in SOURCES},
        "Drawing selection source binding drifted")
    require(value["claimBoundary"] == {"candidateComparisonComplete": True,
        "intentDefaultsSelected": True, "task7_21Complete": True, "profilesDeployed": False,
        "productRouted": False, "task18_5Complete": False}, "Drawing selection claims drifted")
    tests = subprocess.run(["python3", "-m", "unittest", "tests.test_drawing_candidate_selection"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60, check=False)
    require(tests.returncode == 0, "Drawing selection tests no longer pass")
    return {"valid": True, "runId": value["runId"], "evidenceDigest": recorded,
        "selectedLocalProfiles": 2, "task7_21Complete": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    path = parser.parse_args().evidence.resolve()
    require(path.is_file() and path.is_relative_to(ROOT / "evidence/validation/model-candidates"),
        "Drawing selection evidence is unscoped")
    print(json.dumps(validate(path), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        raise SystemExit("Drawing candidate selection validation failed: " + str(error))
