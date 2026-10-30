#!/usr/bin/env python3
"""Strictly validate the immutable whole-product controlled-failure aggregate."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping, Sequence

try:
    from .run_controlled_failure_matrix_qualification import (
        ARTIFACT_SPECS, REQUIRED_CATEGORIES, ROOT, binding_errors, canonical_bytes, digest_bytes,
        relative, safe_repo_file, validator_commands,
    )
except ImportError:
    from run_controlled_failure_matrix_qualification import (
        ARTIFACT_SPECS, REQUIRED_CATEGORIES, ROOT, binding_errors, canonical_bytes, digest_bytes,
        relative, safe_repo_file, validator_commands,
    )


SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


class ValidationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def validate(path: Path, *, rerun_validators: bool = True) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and ROOT in resolved.parents, "aggregate evidence path is missing or unsafe")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and value.get("schemaVersion") == 1
            and value.get("suiteId") == "teamaibox.controlled-failure-matrix-qualification.v1"
            and value.get("status") == "passed", "aggregate identity or status drifted")
    claimed = value.get("evidenceDigest")
    require(SHA256.fullmatch(str(claimed)) is not None
            and claimed == digest_bytes(canonical_bytes({key: item for key, item in value.items() if key != "evidenceDigest"})),
            "aggregate evidence digest drifted")
    runner = ROOT / "tools/run_controlled_failure_matrix_qualification.py"
    require(value.get("source") == {"runnerDigest": digest_bytes(runner.read_bytes())},
            "aggregate runner source drifted")

    artifacts = value.get("artifacts")
    require(isinstance(artifacts, list) and len(artifacts) == len(ARTIFACT_SPECS)
            and {item.get("key") for item in artifacts} == set(ARTIFACT_SPECS),
            "aggregate artifact coverage drifted")
    payloads: dict[str, Mapping[str, Any]] = {}
    paths: dict[str, str] = {}
    arguments: dict[str, str] = {}
    for item in artifacts:
        key = item["key"]
        spec = ARTIFACT_SPECS[key]
        artifact = safe_repo_file(item.get("path"))
        payload = json.loads(artifact.read_text(encoding="utf-8"))
        require(isinstance(payload, Mapping) and item.get("digest") == digest_bytes(artifact.read_bytes())
                and item.get("runId") == payload.get("runId")
                and item.get("categories") == spec["categories"], f"aggregate artifact drifted: {key}")
        payloads[key] = payload
        paths[key] = relative(artifact)
        arguments[spec["argument"]] = relative(artifact)

    support = value.get("supportingBindings")
    expected_support = {"current-plan", "whole-product-failure-plan", "whole-product-failure-cleanup"}
    require(isinstance(support, list) and len(support) == 3
            and {item.get("key") for item in support} == expected_support,
            "aggregate supporting binding coverage drifted")
    for item in support:
        target = safe_repo_file(item.get("path"))
        require(item.get("digest") == digest_bytes(target.read_bytes()),
                f"aggregate supporting binding drifted: {item.get('key')}")
        arguments[item["key"]] = relative(target)

    require(binding_errors(payloads, paths) == [], "aggregate parent or node bindings drifted")
    commands = validator_commands(arguments)
    records = value.get("validatorCommands")
    require(isinstance(records, list) and len(records) == len(commands)
            and {item.get("key") for item in records} == set(commands),
            "aggregate validator coverage drifted")
    for record in records:
        key = record["key"]
        expected = commands[key]
        validator = safe_repo_file(expected[1])
        require(record.get("validator") == relative(validator)
                and record.get("validatorDigest") == digest_bytes(validator.read_bytes())
                and record.get("argv") == list(expected)
                and record.get("argvDigest") == digest_bytes(canonical_bytes(expected))
                and record.get("returnCode") == 0 and record.get("timedOut") is False
                and record.get("outputRetained") is False
                and SHA256.fullmatch(str(record.get("stdoutDigest", ""))) is not None
                and SHA256.fullmatch(str(record.get("stderrDigest", ""))) is not None,
                f"aggregate validator result drifted: {key}")
        if rerun_validators:
            completed = subprocess.run(expected, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       timeout=900, check=False)
            require(completed.returncode == 0, f"current strict validator failed: {key}")

    covered = sorted({category for item in artifacts for category in item["categories"]})
    require(REQUIRED_CATEGORIES <= set(covered), "aggregate required failure categories are incomplete")
    summary = value.get("summary")
    require(summary == {
        "artifactCount": len(ARTIFACT_SPECS),
        "validatorCount": len(ARTIFACT_SPECS),
        "failedValidatorKeys": [],
        "bindingErrors": [],
        "coveredCategories": covered,
        "requiredCategories": sorted(REQUIRED_CATEGORIES),
    }, "aggregate summary drifted")
    require(value.get("claimBoundary") == {
        "controlledFailureMatrix": True,
        "componentReadyOnly": True,
        "productAccepted": False,
        "browserTrustedHttps": False,
        "independentHumanAcceptance": False,
        "physical10GbEAsr": False,
        "usbSdkDevice": False,
        "reviewedActiveMediaLuksMigration": False,
    }, "aggregate claim boundary was weakened")
    require(value.get("privacy") == {
        "credentialsRetained": False,
        "userContentRetained": False,
        "commandOutputRetained": False,
    }, "aggregate privacy boundary drifted")
    return {
        "valid": True,
        "runId": value["runId"],
        "artifactCount": len(artifacts),
        "categoryCount": len(covered),
        "productAccepted": False,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--no-rerun-validators", action="store_true")
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence, rerun_validators=not args.no_rerun_validators),
                     sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationError, ValueError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        print(f"controlled failure matrix evidence invalid: {error}", file=sys.stderr)
        raise SystemExit(1)
