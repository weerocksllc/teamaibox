#!/usr/bin/env python3
"""Strictly validate the current Agent safety matrix."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Mapping

try:
    from .run_current_agent_safety_matrix import REQUIRED, ROOT, RUN_ID, TESTS, run_tests
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_current_agent_safety_matrix import REQUIRED, ROOT, RUN_ID, TESTS, run_tests
    from run_spark_model_baseline import canonical_digest


SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def bound_source(item: Mapping[str, Any]) -> Path:
    path = ROOT / str(item.get("path", ""))
    require(path.is_file(), "Agent safety bound source is missing")
    require(item.get("sha256") == "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
            "Agent safety bound source digest drifted")
    return path


def validate(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.current-agent-safety-matrix.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None
            and value.get("status") == "passed", "Agent safety evidence identity drifted")
    digest_value = value.pop("evidenceDigest", None)
    require(SHA256.fullmatch(str(digest_value or "")) is not None
            and digest_value == canonical_digest(value), "Agent safety canonical digest drifted")
    value["evidenceDigest"] = digest_value
    parent = bound_source(value.get("parent", {}))
    checked = subprocess.run(["python3", str(ROOT / "tools/validate_current_agent_acceptance.py"),
                              "--evidence", str(parent)], cwd=ROOT, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, timeout=300, check=False)
    require(checked.returncode == 0, "Agent safety current product parent no longer validates")
    scenarios = value.get("scenarios", [])
    require(value.get("scenarioCount") == len(REQUIRED) == len(scenarios)
            and {item.get("key") for item in scenarios} == REQUIRED
            and all(isinstance(item.get("file"), str) and isinstance(item.get("test"), str)
                    for item in scenarios), "Agent safety scenario coverage drifted")
    sources = value.get("sources", [])
    require(len(sources) == 3 + len(TESTS), "Agent safety source count drifted")
    for item in sources:
        bound_source(item)
    current = run_tests()
    recorded = value.get("tests", {})
    require(current["testCount"] == recorded.get("testCount")
            and current["passCount"] == recorded.get("passCount")
            and recorded.get("outputRetained") is False,
            "Agent safety executable test result drifted")
    require(value.get("currentRuntimeBound") is True and value.get("blindReplayAllowed") is False,
            "Agent safety runtime/replay boundary drifted")
    require(value.get("privacy") == {"commandOutputRetained": False, "credentialsRetained": False},
            "Agent safety privacy boundary drifted")
    return {"runId": value["runId"], "scenarios": len(scenarios),
            "tests": current["testCount"], "currentRuntimeBound": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    require(evidence.is_relative_to(ROOT), "Agent safety evidence path escapes repository")
    result = validate(evidence)
    print(json.dumps({**result, "valid": True}, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Current Agent safety validation failed: {error}")
        raise SystemExit(1)
