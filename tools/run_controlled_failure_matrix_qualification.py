#!/usr/bin/env python3
"""Aggregate the exact whole-product controlled-failure evidence without weakening any gate."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = ROOT / "evidence/validation/resilience"
RUN_ID = re.compile(r"^controlled-failure-matrix-[0-9]{8}-a[1-9][0-9]*$")

REQUIRED_CATEGORIES = {
    "worker", "model", "plugin", "process", "event-bus", "database", "object-service",
    "source", "provider", "node", "network", "durable-state", "idempotency",
    "cancellation", "failover", "encryption", "provenance", "audit", "quota", "alerts",
    "recovery",
}

ARTIFACT_SPECS: dict[str, dict[str, Any]] = {
    "currentDeployment": {
        "argument": "current-deployment",
        "validator": "tools/validate_feature_arm64_deployment_only.py",
        "categories": ["process", "database", "event-bus", "object-service", "encryption"],
    },
    "wholeProductFailure": {
        "argument": "whole-product-failure",
        "validator": "tools/validate_feature_arm64_deployment_evidence.py",
        "categories": [
            "process", "event-bus", "database", "object-service", "source", "durable-state",
            "idempotency", "encryption", "audit", "alerts", "recovery",
        ],
    },
    "pluginStale": {
        "argument": "plugin-stale",
        "validator": "tools/validate_current_plugin_stale_failure_qualification.py",
        "categories": ["plugin", "durable-state", "audit", "recovery"],
    },
    "postSoak": {
        "argument": "post-soak",
        "validator": "tools/validate_post_soak_spark_qualification.py",
        "categories": [
            "worker", "model", "process", "event-bus", "database", "node", "network",
            "durable-state", "idempotency", "failover", "recovery",
        ],
    },
    "providerGateway": {
        "argument": "provider-gateway",
        "validator": "tools/validate_real_openai_provider_gateway.py",
        "categories": ["provider", "network", "encryption", "recovery"],
    },
    "providerRouting": {
        "argument": "provider-routing",
        "validator": "tools/validate_real_external_provider_routing_qualification.py",
        "categories": [
            "provider", "network", "cancellation", "failover", "durable-state", "audit",
            "recovery",
        ],
    },
    "componentCatalog": {
        "argument": "component-catalog",
        "validator": "tools/validate_component_ready_catalog_qualification.py",
        "categories": ["provenance", "audit"],
    },
    "storageObservation": {
        "argument": "storage-observation",
        "validator": "tools/validate_storage_observation_refresh_qualification.py",
        "categories": ["object-service", "durable-state", "alerts", "recovery"],
    },
    "managedNode": {
        "argument": "managed-node",
        "validator": "tools/validate_persistent_two_box_managed_node.py",
        "categories": ["node", "network", "durable-state", "alerts", "recovery"],
    },
    "computeJob": {
        "argument": "compute-job",
        "validator": "tools/validate_managed_node_compute_job_qualification.py",
        "categories": ["worker", "node", "network", "provenance", "durable-state"],
    },
    "workerCrash": {
        "argument": "worker-crash",
        "validator": "tools/validate_managed_node_worker_crash_qualification.py",
        "categories": ["worker", "alerts", "failover", "recovery", "durable-state"],
    },
    "nodeLoss": {
        "argument": "node-loss",
        "validator": "tools/validate_managed_node_node_loss_qualification.py",
        "categories": ["node", "worker", "alerts", "failover", "recovery", "durable-state"],
    },
    "networkLoss": {
        "argument": "network-loss",
        "validator": "tools/validate_managed_node_network_loss_qualification.py",
        "categories": ["network", "node", "alerts", "failover", "recovery", "durable-state"],
    },
    "cancellation": {
        "argument": "cancellation",
        "validator": "tools/validate_managed_node_cancellation_qualification.py",
        "categories": ["cancellation", "worker", "durable-state", "audit", "recovery"],
    },
    "capacityReserve": {
        "argument": "capacity-reserve",
        "validator": "tools/validate_managed_node_capacity_reserve_qualification.py",
        "categories": ["quota", "worker", "node", "durable-state", "alerts", "recovery"],
    },
    "warmReuse": {
        "argument": "warm-reuse",
        "validator": "tools/validate_managed_node_warm_reuse_qualification.py",
        "categories": ["worker", "idempotency", "provenance", "durable-state"],
    },
    "warmUnload": {
        "argument": "warm-unload",
        "validator": "tools/validate_managed_node_warm_unload_qualification.py",
        "categories": ["worker", "recovery", "durable-state"],
    },
    "largeObject": {
        "argument": "large-object",
        "validator": "tools/validate_managed_node_large_object_qualification.py",
        "categories": ["object-service", "encryption", "provenance", "network", "durable-state"],
    },
}


class QualificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationError(message)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def safe_repo_file(value: str) -> Path:
    relative = PurePosixPath(value)
    require(not relative.is_absolute() and ".." not in relative.parts, "evidence path is unsafe")
    path = (ROOT / relative).resolve()
    require(path.is_file() and ROOT in path.parents, "evidence path is unavailable")
    return path


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def validator_commands(arguments: Mapping[str, str]) -> dict[str, tuple[str, ...]]:
    commands: dict[str, tuple[str, ...]] = {}
    for key, spec in ARTIFACT_SPECS.items():
        evidence = arguments[spec["argument"]]
        command = ("python3", spec["validator"], "--evidence", evidence)
        if key == "currentDeployment":
            command += ("--plan", arguments["current-plan"])
        elif key == "wholeProductFailure":
            command += (
                "--plan", arguments["whole-product-failure-plan"],
                "--cleanup-evidence", arguments["whole-product-failure-cleanup"],
            )
        commands[key] = command
    return commands


def run_validator(argv: tuple[str, ...], timeout_seconds: int) -> dict[str, Any]:
    validator = safe_repo_file(argv[1])
    started = time.monotonic()
    try:
        completed = subprocess.run(
            argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout_seconds, check=False,
        )
        return_code = completed.returncode
        stdout, stderr = completed.stdout, completed.stderr
        timed_out = False
    except subprocess.TimeoutExpired as error:
        return_code = 124
        stdout, stderr = error.stdout or b"", error.stderr or b""
        timed_out = True
    return {
        "validator": relative(validator),
        "validatorDigest": digest_bytes(validator.read_bytes()),
        "argv": list(argv),
        "argvDigest": digest_bytes(canonical_bytes(argv)),
        "returnCode": return_code,
        "timedOut": timed_out,
        "durationMilliseconds": round((time.monotonic() - started) * 1000),
        "stdoutDigest": digest_bytes(stdout),
        "stderrDigest": digest_bytes(stderr),
        "outputRetained": False,
    }


def load_payload(path_value: str) -> tuple[Path, Mapping[str, Any]]:
    path = safe_repo_file(path_value)
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping), "evidence payload is not an object")
    return path, value


def referenced_path(value: Any, *keys: str) -> str | None:
    current = value
    for key in keys:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current if isinstance(current, str) else None


def binding_errors(payloads: Mapping[str, Mapping[str, Any]], paths: Mapping[str, str]) -> list[str]:
    errors: list[str] = []
    current = paths["currentDeployment"]
    whole = paths["wholeProductFailure"]
    node = paths["managedNode"]
    compute = paths["computeJob"]

    if referenced_path(payloads["storageObservation"], "deployment", "path") != current:
        errors.append("storage_parent_mismatch")
    if referenced_path(payloads["managedNode"], "controlPlane", "parentEvidence") != current:
        errors.append("managed_node_deployment_mismatch")
    if referenced_path(payloads["computeJob"], "controller", "deploymentEvidence") != current:
        errors.append("compute_deployment_mismatch")
    if referenced_path(payloads["computeJob"], "managedNode", "nodeEvidence") != node:
        errors.append("compute_node_mismatch")
    if referenced_path(payloads["pluginStale"], "parent", "path") != whole:
        errors.append("plugin_parent_mismatch")
    if referenced_path(payloads["providerRouting"], "gateway", "path") != paths["providerGateway"]:
        errors.append("provider_gateway_mismatch")

    for key in ("workerCrash", "nodeLoss", "networkLoss", "cancellation", "capacityReserve", "warmReuse", "largeObject"):
        if referenced_path(payloads[key], "managedNode", "nodeEvidence") != node:
            errors.append(f"{key}_node_mismatch")
    if referenced_path(payloads["warmUnload"], "nodeEvidence", "path") != node:
        errors.append("warm_unload_node_mismatch")
    if referenced_path(payloads["warmUnload"], "jobEvidence", "path") != compute:
        errors.append("warm_unload_job_mismatch")

    summary = payloads["componentCatalog"].get("summary")
    if not isinstance(summary, Mapping) or summary.get("componentReadyCount") != 44 or summary.get("productAcceptedCount") != 0:
        errors.append("component_catalog_boundary_mismatch")
    return sorted(errors)


def qualify(run_id: str, arguments: Mapping[str, str], timeout_seconds: int) -> dict[str, Any]:
    commands = validator_commands(arguments)
    payloads: dict[str, Mapping[str, Any]] = {}
    paths: dict[str, str] = {}
    artifacts: list[dict[str, Any]] = []
    validations: list[dict[str, Any]] = []
    for key, spec in ARTIFACT_SPECS.items():
        path, payload = load_payload(arguments[spec["argument"]])
        normalized = relative(path)
        payloads[key] = payload
        paths[key] = normalized
        artifacts.append({
            "key": key,
            "path": normalized,
            "digest": digest_bytes(path.read_bytes()),
            "runId": payload.get("runId"),
            "categories": spec["categories"],
        })
        validations.append({"key": key, **run_validator(commands[key], timeout_seconds)})

    support = []
    for key in ("current-plan", "whole-product-failure-plan", "whole-product-failure-cleanup"):
        path = safe_repo_file(arguments[key])
        support.append({"key": key, "path": relative(path), "digest": digest_bytes(path.read_bytes())})

    covered = sorted({category for artifact in artifacts for category in artifact["categories"]})
    failed_validators = sorted(item["key"] for item in validations if item["returnCode"] != 0 or item["timedOut"])
    bindings = binding_errors(payloads, paths) if not failed_validators else ["binding_checks_skipped_after_validator_failure"]
    status = "passed" if not failed_validators and not bindings and REQUIRED_CATEGORIES <= set(covered) else "failed"
    result = {
        "schemaVersion": 1,
        "suiteId": "teamaibox.controlled-failure-matrix-qualification.v1",
        "runId": run_id,
        "status": status,
        "startedAt": STARTED_AT,
        "completedAt": now(),
        "artifacts": artifacts,
        "supportingBindings": support,
        "validatorCommands": validations,
        "summary": {
            "artifactCount": len(artifacts),
            "validatorCount": len(validations),
            "failedValidatorKeys": failed_validators,
            "bindingErrors": bindings,
            "coveredCategories": covered,
            "requiredCategories": sorted(REQUIRED_CATEGORIES),
        },
        "claimBoundary": {
            "controlledFailureMatrix": status == "passed",
            "componentReadyOnly": True,
            "productAccepted": False,
            "browserTrustedHttps": False,
            "independentHumanAcceptance": False,
            "physical10GbEAsr": False,
            "usbSdkDevice": False,
            "reviewedActiveMediaLuksMigration": False,
        },
        "privacy": {
            "credentialsRetained": False,
            "userContentRetained": False,
            "commandOutputRetained": False,
        },
        "source": {"runnerDigest": digest_bytes(Path(__file__).read_bytes())},
        "evidenceDigest": None,
    }
    result["evidenceDigest"] = digest_bytes(canonical_bytes({key: value for key, value in result.items() if key != "evidenceDigest"}))
    return result


STARTED_AT = now()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--run-id", required=True)
    result.add_argument("--timeout-seconds", type=int, default=300)
    for spec in ARTIFACT_SPECS.values():
        result.add_argument(f"--{spec['argument']}", required=True)
    result.add_argument("--current-plan", required=True)
    result.add_argument("--whole-product-failure-plan", required=True)
    result.add_argument("--whole-product-failure-cleanup", required=True)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    require(RUN_ID.fullmatch(args.run_id) is not None, "run ID is invalid")
    require(30 <= args.timeout_seconds <= 900, "timeout is outside the safe bound")
    target = EVIDENCE_ROOT / f"{args.run_id}.json"
    require(not target.exists(), "evidence already exists; use a new run ID")
    arguments = {key.replace("_", "-"): value for key, value in vars(args).items() if isinstance(value, str)}
    result = qualify(args.run_id, arguments, args.timeout_seconds)
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".json.tmp")
    temporary.write_bytes(canonical_bytes(result) + b"\n")
    os.replace(temporary, target)
    print(json.dumps({
        "runId": args.run_id, "status": result["status"], "evidence": relative(target),
        "artifactCount": result["summary"]["artifactCount"],
        "failedValidatorKeys": result["summary"]["failedValidatorKeys"],
        "bindingErrors": result["summary"]["bindingErrors"],
    }, sort_keys=True, separators=(",", ":")))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (QualificationError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"controlled failure matrix qualification failed: {error}", file=sys.stderr)
        raise SystemExit(2)
