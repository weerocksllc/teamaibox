#!/usr/bin/env python3
"""Strictly validate current resource-controlled Provider contract lifecycle deployment."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from typing import Any, Mapping

try:
    from .deploy_current_provider_contract_lifecycle import (
        CURRENT, PLATFORM, PROJECT, REMOTE, ROOT, RUN_ID, PARENT_RUN_ID, RUNTIME, RUNTIME_KEY, SOURCES,
    )
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from deploy_current_provider_contract_lifecycle import (
        CURRENT, PLATFORM, PROJECT, REMOTE, ROOT, RUN_ID, PARENT_RUN_ID, RUNTIME, RUNTIME_KEY, SOURCES,
    )
    from run_spark_model_baseline import canonical_digest


class ValidationError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ValidationError(message)


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def bound(item: Mapping[str, Any], label: str, root: Path = ROOT) -> Path:
    path = (ROOT / str(item.get("path", ""))).resolve()
    require(path.is_file() and path.is_relative_to(root) and item.get("digest") == digest(path), f"{label} drifted")
    return path


def validate(path: Path) -> Mapping[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and resolved.is_relative_to(ROOT / "evidence/validation/feature-deployments"), "Provider lifecycle evidence is unavailable")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.current-provider-contract-lifecycle-deployment.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None and resolved.name == value["runId"] + ".json"
            and value.get("status") == "passed" and value.get("failure") is None, "Provider lifecycle evidence identity drifted")
    claimed = value.pop("evidenceDigest", None)
    require(claimed == canonical_digest(value), "Provider lifecycle evidence digest drifted")
    value["evidenceDigest"] = claimed
    parent_item = value.get("parent", {})
    parent_path = bound(parent_item, "exact ASR parent", ROOT / "evidence/validation/feature-deployments")
    parent = json.loads(parent_path.read_text(encoding="utf-8"))
    parent_claimed = parent.pop("evidenceDigest", None)
    require(parent_claimed == canonical_digest(parent) and parent_claimed == parent_item.get("evidenceDigest")
            and PARENT_RUN_ID.fullmatch(str(parent.get("runId", ""))) is not None and parent.get("status") == "passed"
            and parent.get("failure") is None and parent.get("images", {}).get("platform", {}).get("imageId") == parent_item.get("platformImageId"),
            "exact ASR parent evidence drifted")
    require([item.get("path") for item in value.get("sources", [])] == list(SOURCES), "Provider lifecycle source list drifted")
    for item in value["sources"]:
        bound(item, "Provider lifecycle source")
    require(value.get("sourceTests") == {"passed": True, "count": 8, "outputRetained": False}, "Provider lifecycle source test result drifted")
    images = value.get("images", {})
    require(images.get("parentImageId") == parent_item.get("platformImageId") and images.get("candidateImageId") != images.get("parentImageId")
            and images.get("architecture") == "arm64", "Provider lifecycle image lineage drifted")
    result = REMOTE.run(("sudo", "docker", "inspect", PLATFORM), 30)
    require(result.returncode == 0, "live Platform container is missing")
    current = json.loads(result.stdout)[0]
    runtime = value.get("runtime", {})
    require(current["Id"] == runtime.get("containerId") and current["Image"] == runtime.get("imageId") == images.get("candidateImageId")
            and current["State"].get("Health", {}).get("Status") == "healthy" and runtime.get("healthy") is True,
            "live Provider lifecycle Platform drifted")
    pinned = REMOTE.run(("sudo", "grep", "^" + RUNTIME_KEY + "=", RUNTIME), 15)
    require(pinned.returncode == 0 and pinned.stdout.strip() == RUNTIME_KEY + "=" + current["Image"], "Platform image pin drifted")
    persistent = REMOTE.run(("sudo", "sha256sum", CURRENT + "/source/services/scheduler/src/external-provider-contract-tester.mjs"), 15)
    require(persistent.returncode == 0 and persistent.stdout.split()[0] == hashlib.sha256((ROOT / SOURCES[0]).read_bytes()).hexdigest(), "persistent Provider tester drifted")
    require(runtime.get("internalReadyStatus") == 200 and runtime.get("httpsIngress") == {"readyStatus": 200, "unauthenticatedSessionStatus": 401, "trustClaimed": False}, "recorded ingress proof drifted")
    live_probe = REMOTE.run(("curl", "-ksS", "-o", "/dev/null", "-w", "%{http_code}", "https://127.0.0.1/health/ready"), 30)
    require(live_probe.returncode == 0 and live_probe.stdout == "200", "live HTTPS readiness failed")
    tests = subprocess.run(["node", "--test", "services/scheduler/test/external-provider-contract-tester.test.mjs"], cwd=ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120, check=False)
    require(tests.returncode == 0, "current Provider lifecycle tests failed")
    require(value.get("componentReady") is True and value.get("productAccepted") is False
            and value.get("blockers") == ["real Drawing product acceptance", "model quality certification", "independent human acceptance"],
            "Provider lifecycle claim boundary drifted")
    return {"valid": True, "runId": value["runId"], "platformImageId": current["Image"],
            "parentRunId": parent_item["runId"], "sourceTests": value["sourceTests"]["count"], "productAccepted": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationError, OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        print(f"Current Provider lifecycle validation failed: {error}")
        raise SystemExit(1)
