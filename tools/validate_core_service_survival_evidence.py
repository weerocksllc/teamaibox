#!/usr/bin/env python3
"""Validate functional core-service survival evidence from the allowlisted Spark."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY = ROOT / "deploy/compose/resource-policy.json"
SPARK_RUNNER = ROOT / "tools/spark_validation.py"
TARGET = "dgx-spark-dev-01"
TARGET_INVENTORY = ROOT / "evidence/hardware/dgx-spark-dev-01/inventory-2026-08-10.json"
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
CONTAINER_ID = re.compile(r"^[a-f0-9]{64}$")
RUN_ID = re.compile(r"^(?P<date>[0-9]{8})-core-survival-(?P<suffix>a[1-9][0-9]*)$")
DOMAINS = {"identity", "administration", "files", "messaging", "database", "object", "queue"}
CONTAINER_ROLES = (
    "platform", "web", "object", "messaging", "postgres", "queue", "scheduler", "ai",
)


class EvidenceError(RuntimeError):
    pass


def canonical_digest(value: Any) -> str:
    body = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(body).hexdigest()


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise EvidenceError(f"invalid JSON evidence: {path.name}") from error
    if not isinstance(value, dict):
        raise EvidenceError(f"evidence must be an object: {path.name}")
    return value


def require(value: bool, message: str) -> None:
    if not value:
        raise EvidenceError(message)


def expected_container_names(run_id: str) -> dict[str, str]:
    return {
        role: f"teamaibox-validation-{run_id}-survival-{role}"
        for role in CONTAINER_ROLES
    }


def validate_run_identity(run_id: object, evidence_path: Path) -> str:
    match = RUN_ID.fullmatch(str(run_id))
    require(match is not None, "core-service survival run identity is invalid")
    expected_name = f"core-service-survival-{match.group('date')}-{match.group('suffix')}.json"
    require(evidence_path.name == expected_name, "core-service survival evidence path does not match its run identity")
    return str(run_id)


def validate_container_identities(run_id: str, value: object) -> dict[str, Any]:
    require(
        isinstance(value, Mapping)
        and set(value) == set(CONTAINER_ROLES)
        and len(value) == len(CONTAINER_ROLES),
        "core-service container roles drifted",
    )
    expected_names = expected_container_names(run_id)
    identities: dict[str, Any] = {}
    seen_ids: set[str] = set()
    for role in CONTAINER_ROLES:
        identity = value[role]
        require(isinstance(identity, Mapping) and set(identity) == {
            "name", "containerId", "running", "validationRunLabel",
        }, f"core-service container identity fields drifted: {role}")
        container_id = str(identity.get("containerId", ""))
        require(
            identity.get("name") == expected_names[role]
            and CONTAINER_ID.fullmatch(container_id) is not None
            and container_id not in seen_ids
            and identity.get("running") is True
            and identity.get("validationRunLabel") == run_id,
            f"core-service container identity drifted: {role}",
        )
        seen_ids.add(container_id)
        identities[role] = dict(identity)
    return identities


def validate(evidence_path: Path, policy_path: Path = DEFAULT_POLICY) -> dict[str, Any]:
    evidence, policy = load(evidence_path), load(policy_path)
    run_id = validate_run_identity(evidence.get("runId"), evidence_path)
    objectives = policy.get("serviceObjectives")
    require(isinstance(objectives, dict) and set(objectives) == DOMAINS, "service objective policy is incomplete")
    require(evidence.get("schemaVersion") == 1, "evidence schema is invalid")
    require(evidence.get("target") == TARGET, "evidence is not from the primary Spark target")
    require(evidence.get("architecture") == "linux/arm64/v8", "evidence is not from the ARM64 Spark target")
    require(
        evidence.get("deviceBaselineDigest") == "sha256:" + hashlib.sha256(TARGET_INVENTORY.read_bytes()).hexdigest(),
        "primary Spark inventory lineage drifted",
    )
    require(evidence.get("claimEligible") is True, "Spark validation run is not claim eligible")
    require(evidence.get("cleanupPassed") is True and evidence.get("residualStatePassed") is True, "Spark cleanup or residual gate failed")
    require("core-service-survival" in evidence.get("suites", []), "core-service survival suite is absent")
    require(SHA256.fullmatch(str(evidence.get("sourceTreeDigest", ""))) is not None, "source tree digest is invalid")
    steps = evidence.get("steps")
    require(isinstance(steps, list), "evidence steps are invalid")
    matching = [step for step in steps if step.get("name") == "core-service-survival"]
    require(len(matching) == 1, "functional survival step is not unique")
    step = matching[0]
    require(step.get("required") is True and step.get("passed") is True and step.get("returnCode") == 0, "functional survival step failed")
    artifact = evidence.get("suiteArtifacts", {}).get("coreServiceSurvival", {})
    require(isinstance(artifact, Mapping) and set(artifact) == {
        "measurement", "attestation", "outputDigest", "runnerSourceDigest", "retainedRequestOrResponseContent",
    }, "functional objective artifact is incomplete")
    require(artifact.get("retainedRequestOrResponseContent") is False, "functional objective artifact retained request or response content")
    require(artifact.get("runnerSourceDigest") in {
        "sha256:" + hashlib.sha256(SPARK_RUNNER.read_bytes()).hexdigest(),
        # Exact Spark validation runner used by retained functional evidence.
        "sha256:81f0d8334b4e5bec19871097a5d99daaaa2a44996670b6a881a7b464480688c1",
    }, "functional objective runner source lineage drifted")
    attestation = artifact.get("attestation")
    measurement = artifact.get("measurement")
    require(isinstance(measurement, Mapping) and isinstance(attestation, Mapping), "functional objective artifact documents are invalid")
    require(
        measurement.get("runId") == attestation.get("runId") == run_id
        and measurement.get("target") == attestation.get("target") == TARGET,
        "functional objective run or target identity drifted",
    )
    identities = validate_container_identities(run_id, measurement.get("containers"))
    rendered = (
        json.dumps(measurement, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
        + json.dumps(attestation, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    )
    output_digest = "sha256:" + hashlib.sha256(rendered.encode("utf-8")).hexdigest()
    require(artifact.get("outputDigest") == step.get("stdoutDigest") == output_digest, "functional objective output lineage drifted")
    require(isinstance(measurement, Mapping), "functional objective measurements are absent")
    require(measurement.get("passed") is True and measurement.get("probesPerDomain", 0) >= 8, "functional objective measurements failed")
    require(measurement.get("domains") == {domain: True for domain in sorted(DOMAINS)}, "functional measurement domains failed")
    latencies = measurement.get("maximumLatencyMilliseconds")
    measured_objectives = measurement.get("objectives")
    require(isinstance(latencies, Mapping) and set(latencies) == DOMAINS, "functional latency measurements are incomplete")
    require(isinstance(measured_objectives, Mapping) and set(measured_objectives) == DOMAINS, "functional objective measurements are incomplete")
    for domain in DOMAINS:
        observed = measured_objectives[domain]
        require(isinstance(observed, Mapping) and set(observed) == {
            "healthy", "probes", "successRate", "minimumSuccessRate",
            "maximumLatencyMilliseconds", "maximumAllowedLatencyMilliseconds",
        }, f"functional objective measurement fields drifted: {domain}")
        require(observed.get("healthy") is True and observed.get("probes") == measurement["probesPerDomain"], f"functional objective failed: {domain}")
        require(observed.get("successRate") == observed.get("minimumSuccessRate") == objectives[domain]["minimumSuccessRate"], f"functional success objective failed: {domain}")
        require(observed.get("maximumLatencyMilliseconds") == latencies[domain], f"functional latency projection drifted: {domain}")
        require(isinstance(latencies[domain], int) and 0 <= latencies[domain] <= objectives[domain]["maximumLatencyMilliseconds"], f"functional latency objective failed: {domain}")
        require(observed.get("maximumAllowedLatencyMilliseconds") == objectives[domain]["maximumLatencyMilliseconds"], f"functional latency policy drifted: {domain}")
    require(measurement.get("stress") == {
        "running": True,
        "memoryLimitBytes": 1_073_741_824,
        "cpuLimitCores": 2,
        "network": "none",
        "containerName": expected_container_names(run_id)["ai"],
        "workerCount": 4,
        "touchedBytes": 536_870_912,
    }, "bounded AI saturation identity drifted")
    require(isinstance(attestation, Mapping), "functional objective attestation is absent")
    require(attestation.get("schemaVersion") == 1 and attestation.get("passed") is True, "functional objective attestation failed")
    require(attestation.get("functionalObjectives") is True, "generic readiness evidence cannot satisfy the functional gate")
    require(set(attestation.get("domains", [])) == DOMAINS, "functional objective domains are incomplete")
    require(isinstance(attestation.get("probesPerDomain"), int) and attestation["probesPerDomain"] >= 8, "functional probe coverage is insufficient")
    require(attestation.get("objectivePolicyDigest") == canonical_digest(objectives), "functional objective policy digest drifted")
    require(attestation.get("containerIdentityDigest") == canonical_digest(identities), "core-service container identity digest drifted")
    result_material = {
        "containerIdentityDigest": canonical_digest(identities),
        "domains": sorted(DOMAINS),
        "functionalObjectives": True,
        "objectivePolicy": objectives,
        "passed": True,
        "probesPerDomain": attestation["probesPerDomain"],
        "runId": run_id,
        "target": TARGET,
    }
    require(attestation.get("resultDigest") == canonical_digest(result_material), "functional result digest drifted")
    return {
        "valid": True,
        "runId": run_id,
        "target": TARGET,
        "containerIdentityDigest": attestation["containerIdentityDigest"],
        "domains": sorted(DOMAINS),
        "probesPerDomain": attestation["probesPerDomain"],
        "objectivePolicyDigest": attestation["objectivePolicyDigest"],
        "resultDigest": attestation["resultDigest"],
        "maximumLatencyMilliseconds": dict(sorted(latencies.items())),
        "sourceTreeDigest": evidence["sourceTreeDigest"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    args = parser.parse_args()
    try:
        result = validate(args.evidence, args.policy)
    except EvidenceError as error:
        print(json.dumps({"valid": False, "error": str(error)}, sort_keys=True, separators=(",", ":")))
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
