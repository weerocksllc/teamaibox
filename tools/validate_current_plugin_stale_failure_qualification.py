#!/usr/bin/env python3
"""Strictly validate current plugin stale-evidence fail-closed qualification."""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import re
import sys
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tools.appliance_operations import canonical_digest, digest_bytes
from tools.validate_feature_arm64_deployment_evidence import validate_deployment

SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
PLAN = ROOT / "deploy/application-catalog-e2e/plan-20260822-a368.json"
SOURCES = {
    "runnerDigest": ROOT / "tools/run_current_plugin_stale_failure_qualification.py",
    "planDigest": PLAN,
    "protocolDigest": ROOT / "deploy/application-catalog-e2e/plugin-current-stale-failure-protocol-test.mjs",
    "retainedProtocolDigest": ROOT / "deploy/application-catalog-e2e/plugin-current-stale-failure-retained-check.mjs",
}


class ValidationError(ValueError): pass


def require(value: bool, message: str) -> None:
    if not value: raise ValidationError(message)


def exact_path(value: Any) -> Path:
    require(isinstance(value, str), "parent path is invalid"); relative = PurePosixPath(value)
    require(not relative.is_absolute() and ".." not in relative.parts, "parent path is unsafe")
    path = ROOT / relative; require(path.is_file(), "parent evidence is missing"); return path


def clean_step(value: Any, label: str) -> None:
    require(isinstance(value, dict) and value.get("passed") is True and value.get("returnCode") == 0
            and value.get("outputRetained") is False and all(SHA256.fullmatch(value.get(key, "")) is not None
            for key in ("commandDigest", "stdoutDigest", "stderrDigest")), f"{label} step is invalid")


def validate(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.current-plugin-stale-failure.v1"
            and value.get("runId") == "current-plugin-stale-failure-20260822-a1"
            and value.get("status") == "passed" and value.get("target") == "dgx-spark-dev-01",
            "exact successful current plugin failure run is required")
    claimed = value.get("evidenceDigest")
    require(SHA256.fullmatch(claimed or "") is not None
            and canonical_digest({key: item for key, item in value.items() if key != "evidenceDigest"}) == claimed,
            "current plugin failure evidence digest changed")
    parent = value.get("parent", {}); parent_path = exact_path(parent.get("path"))
    require(parent.get("runId") == "whole-product-failure-20260822-a368"
            and parent.get("digest") == digest_bytes(parent_path.read_bytes()), "plugin failure parent binding changed")
    plan = json.loads(PLAN.read_text(encoding="utf-8")); validate_deployment(json.loads(parent_path.read_text(encoding="utf-8")), plan)
    require(value.get("source") == {key: digest_bytes(source.read_bytes()) for key, source in SOURCES.items()},
            "current plugin failure source binding changed")
    failure = value.get("failure", {}); clean_step(failure.get("step"), "stale rejection")
    require(failure.get("result") == {"schemaVersion": 1, "status": "passed", "observedCode": "evidence_stale",
            "packageImported": False, "runtimeStarted": False, "cutoverOccurred": False, "auditRecorded": True,
            "auditChainValid": True, "credentialsRetained": False, "packageContentRetained": False},
            "stale supply-chain rejection proof drifted")
    restart = value.get("restart", {}); clean_step(restart.get("step"), "platform API restart")
    before, after = restart.get("before", {}), restart.get("after", {})
    require(before.get("containerId") == after.get("containerId") and before.get("imageId") == after.get("imageId")
            and before.get("mountIdentityDigest") == after.get("mountIdentityDigest")
            and before.get("startedAt") != after.get("startedAt")
            and before.get("state") == after.get("state") == "running"
            and before.get("health") == after.get("health") == "healthy", "platform API restart identity drifted")
    retained = value.get("retained", {}); clean_step(retained.get("step"), "retained stale rejection")
    require(retained.get("result") == {"schemaVersion": 1, "status": "passed", "rejectedImportRetained": True,
            "runtimeStarted": False, "cutoverOccurred": False, "auditChainValid": True, "credentialsRetained": False},
            "stale rejection retention proof drifted")
    require(value.get("credentialsRetained") is False and value.get("commandOutputRetained") is False
            and value.get("packageContentRetained") is False and value.get("limitations") == {
                "migrationFailure": "historical_a172_evidence_only_current_fixture_rejected_as_stale",
                "browserTrustedHttps": "not_satisfied", "independentHumanAcceptance": "not_performed"},
            "current plugin failure boundary drifted")
    return {"valid": True, "runId": value["runId"], "observedCode": "evidence_stale", "restartRetained": True}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv); print(json.dumps(validate(args.evidence.resolve()), sort_keys=True, separators=(",", ":"))); return 0


if __name__ == "__main__":
    try: raise SystemExit(main())
    except (ValidationError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"current plugin stale-failure evidence invalid: {error}"); raise SystemExit(1)
