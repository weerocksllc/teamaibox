#!/usr/bin/env python3
"""Bind the complete Agent safety test matrix to the current retained product."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Mapping

try:
    from .run_spark_model_baseline import canonical_digest, utc_now
except ImportError:
    from run_spark_model_baseline import canonical_digest, utc_now


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = ROOT / "evidence/validation/agent"
RUN_ID = re.compile(r"^current-agent-safety-[0-9]{8}-a[1-9][0-9]*$")
PARENT = ROOT / "evidence/validation/agent/current-agent-product-20260825-a1.json"
COVERAGE = ROOT / "services/agent-bridge/test/safety-scenario-coverage.v1.json"
TESTS = (
    "services/agent-bridge/test/agent-safety-coverage.test.mjs",
    "services/agent-bridge/test/agent-sandbox.test.mjs",
    "services/agent-bridge/test/agent-session-service.test.mjs",
    "services/agent-bridge/test/agent-operation-confirmation.test.mjs",
    "services/agent-bridge/test/opencode-bridge-http-server.test.mjs",
    "services/agent-bridge/test/opencode-adapter-v1-18.test.mjs",
)
REQUIRED = {
    "user_isolation", "host_escape_attempts", "quota_pressure", "offline_package_install",
    "network_denial", "reconnect_replay", "bridge_restart", "opencode_crash",
    "confirmation_races", "interruption", "uncertain_side_effects",
}


class SafetyMatrixFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SafetyMatrixFailure(message)


def source(path: Path) -> dict[str, str]:
    return {"path": path.relative_to(ROOT).as_posix(),
            "sha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


def run_tests() -> dict[str, Any]:
    result = subprocess.run(["node", "--test", *TESTS], cwd=ROOT, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=240, check=False)
    output = result.stdout.decode("utf-8", "replace")
    # Node's test reporter uses either TAP "#" or the newer Unicode info
    # marker depending on the installed Node release.
    tests = re.search(r"(?:^|\n)[#ℹ] tests ([0-9]+)(?:\n|$)", output)
    passed = re.search(r"(?:^|\n)[#ℹ] pass ([0-9]+)(?:\n|$)", output)
    require(result.returncode == 0 and tests is not None and passed is not None
            and int(tests.group(1)) == int(passed.group(1)) >= 35,
            "Agent safety source matrix failed")
    # TAP duration fields vary between otherwise identical runs. Bind the
    # executable sources below and retain only deterministic pass/fail counts;
    # the strict validator reruns the same suite instead of trusting output.
    return {"testCount": int(tests.group(1)), "passCount": int(passed.group(1)),
            "outputRetained": False}


def write_evidence(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    require(RUN_ID.fullmatch(args.run_id) is not None, "unsafe Agent safety run identity")
    output = EVIDENCE_ROOT / f"{args.run_id}.json"
    require(not output.exists(), "immutable Agent safety evidence already exists")
    parent = subprocess.run(["python3", str(ROOT / "tools/validate_current_agent_acceptance.py"),
                             "--evidence", str(PARENT)], cwd=ROOT, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=300, check=False)
    require(parent.returncode == 0, "current Agent product parent no longer validates")
    coverage = json.loads(COVERAGE.read_text(encoding="utf-8"))
    scenarios = coverage.get("scenarios", [])
    require(coverage.get("schemaVersion") == 1 and len(scenarios) == len(REQUIRED)
            and {item.get("key") for item in scenarios} == REQUIRED,
            "Agent safety scenario coverage drifted")
    tests = run_tests()
    evidence: dict[str, Any] = {
        "schemaVersion": 1,
        "runnerId": "teamaibox.current-agent-safety-matrix.v1",
        "runId": args.run_id,
        "status": "passed",
        "completedAt": utc_now(),
        "parent": source(PARENT),
        "scenarioCount": len(scenarios),
        "scenarios": scenarios,
        "tests": tests,
        "currentRuntimeBound": True,
        "blindReplayAllowed": False,
        "sources": [source(Path(__file__).resolve()),
                    source(ROOT / "tools/validate_current_agent_safety_matrix.py"),
                    source(COVERAGE),
                    *[source(ROOT / item) for item in TESTS]],
        "privacy": {"credentialsRetained": False, "commandOutputRetained": False},
    }
    evidence["evidenceDigest"] = canonical_digest(evidence)
    write_evidence(output, evidence)
    print(json.dumps({"runId": args.run_id, "status": "passed", "scenarios": len(scenarios),
                      "tests": tests["testCount"], "evidence": output.relative_to(ROOT).as_posix(),
                      "evidenceSha256": "sha256:" + hashlib.sha256(output.read_bytes()).hexdigest()},
                     sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SafetyMatrixFailure, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Current Agent safety matrix failed: {error}")
        raise SystemExit(1)
