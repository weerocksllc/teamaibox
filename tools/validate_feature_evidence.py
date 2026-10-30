#!/usr/bin/env python3
"""Fail-closed validator for immutable per-feature Product Accepted evidence."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "architecture" / "validation" / "feature-acceptance-catalog.v1.json"
SCHEMA = ROOT / "architecture" / "validation" / "feature-evidence-schema.v1.json"
MIGRATIONS = ROOT / "packages" / "persistence" / "migrations" / "manifest.json"

TOP_FIELDS = {
    "schemaVersion", "evidenceId", "featureKey", "catalogDigest", "runId", "status", "startedAt",
    "completedAt", "source", "deployment", "sparkInventory", "configuration", "health", "journeys",
    "restart", "rollback", "residualState", "limitations", "humanGates", "successfulParent", "privacy",
    "evidenceDigest",
}
SOURCE_FIELDS = {"revision", "treeDigest", "dirty", "artifacts"}
DEPLOYMENT_FIELDS = {
    "deploymentId", "targetNodeId", "architecture", "composeProject", "ociImages",
    "configurationDigest", "idempotentReplayPassed",
}
INVENTORY_FIELDS = {"nodeId", "architecture", "inventoryDigest", "capturedAt", "hardwareGates"}
CONFIG_FIELDS = {
    "schemaVersion", "migrationManifestDigest", "appliedMigrations", "persistentDependencies",
    "secretsRetained",
}
PRIVACY_FIELDS = {"credentialsRetained", "userContentRetained", "commandOutputRetained", "redactionPassed"}
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
UTC_TIMESTAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$")
EVIDENCE_ID = re.compile(r"^feature-([a-z][a-z0-9.-]+)-([0-9]{8})-([a-z0-9][a-z0-9-]{1,63})$")
RUN_ID = re.compile(r"^[a-z][a-z0-9.-]{2,127}$")
KEY = re.compile(r"^[a-z][a-z0-9.-]+$")
OCI = re.compile(r"^[a-z0-9./_-]+@sha256:([0-9a-f]{64})$")
PROHIBITED = re.compile(r"(?:^|[-_./:])(mock(?:up)?s?|fixtures?|placeholders?|templates?|previews?)(?:$|[-_./:])", re.IGNORECASE)
PROHIBITED_DEPENDENCY = re.compile(r"(?:^|[-_./:])(memory|in-memory|memory-only|mock|fixture)(?:$|[-_./:])", re.IGNORECASE)


class FeatureEvidenceError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FeatureEvidenceError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical_digest(value: Any) -> str:
    return digest_bytes(canonical_bytes(value))


def parse_utc(value: Any, label: str) -> datetime:
    require(isinstance(value, str) and UTC_TIMESTAMP.fullmatch(value) is not None, f"{label} is not a UTC timestamp")
    parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    require(parsed.tzinfo == timezone.utc, f"{label} is not UTC")
    return parsed


def load_catalog() -> tuple[dict[str, Any], dict[str, Mapping[str, Any]]]:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    return catalog, {item["key"]: item for item in catalog["features"]}


def validate_schema() -> dict[str, Any]:
    value = json.loads(SCHEMA.read_text(encoding="utf-8"))
    require(value.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "feature evidence schema draft drifted")
    require(value.get("$id") == "https://teamaibox.local/schemas/feature-evidence.v1.json", "feature evidence schema id drifted")
    require(value.get("type") == "object" and value.get("additionalProperties") is False,
            "feature evidence schema must be a closed object")
    require(set(value.get("required", [])) == TOP_FIELDS, "feature evidence required fields drifted")
    require(set(value.get("properties", {})) == TOP_FIELDS, "feature evidence property fields drifted")
    require({"digest", "utcTimestamp", "reference", "ociImage", "check", "journey", "checkGroup", "gate", "limitation"}
            == set(value.get("$defs", {})), "feature evidence definitions drifted")
    return value


def _string_list(value: Any, label: str, *, minimum: int = 0) -> list[str]:
    require(isinstance(value, list) and len(value) >= minimum, f"{label} must contain at least {minimum} items")
    require(all(isinstance(item, str) and item.strip() == item and item for item in value),
            f"{label} contains an invalid string")
    require(len(value) == len(set(value)), f"{label} contains duplicates")
    return list(value)


def _safe_path(value: Any, label: str) -> PurePosixPath:
    require(isinstance(value, str) and re.match(r"^(architecture|deploy|docs|evidence|packages|apps|services|tools)/", value) is not None,
            f"{label} path is outside the evidence boundary")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts, f"{label} path is unsafe")
    require(PROHIBITED.search(value) is None, f"{label} points to mock/fixture/preview content")
    return path


def validate_reference(value: Any, label: str, evidence_root: Path) -> dict[str, str]:
    require(isinstance(value, Mapping) and set(value) == {"path", "digest"}, f"{label} reference fields drifted")
    path = _safe_path(value["path"], label)
    digest = value["digest"]
    require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None, f"{label} digest is invalid")
    target = evidence_root / path
    require(target.is_file(), f"{label} referenced file is missing: {path.as_posix()}")
    require(digest_bytes(target.read_bytes()) == digest, f"{label} referenced digest does not match")
    return {"path": path.as_posix(), "digest": digest}


def validate_gate(value: Any, label: str, evidence_root: Path) -> dict[str, Any]:
    require(isinstance(value, Mapping) and set(value) == {"key", "status", "evidence"}, f"{label} gate fields drifted")
    require(isinstance(value["key"], str) and KEY.fullmatch(value["key"]) is not None, f"{label} gate key is invalid")
    require(value["status"] in {"passed", "pending", "not-applicable"}, f"{label} gate status is invalid")
    if value["status"] == "pending":
        require(value["evidence"] is None or isinstance(value["evidence"], Mapping), f"{label} pending gate evidence is invalid")
    else:
        require(value["evidence"] is not None, f"{label} completed gate lacks evidence")
    if value["evidence"] is not None:
        validate_reference(value["evidence"], f"{label}.evidence", evidence_root)
    return dict(value)


def validate_check(value: Any, label: str, evidence_root: Path) -> dict[str, Any]:
    require(isinstance(value, Mapping) and set(value) == {"key", "passed", "evidence"}, f"{label} check fields drifted")
    require(isinstance(value["key"], str) and KEY.fullmatch(value["key"]) is not None, f"{label} check key is invalid")
    require(isinstance(value["passed"], bool), f"{label} check result is invalid")
    validate_reference(value["evidence"], f"{label}.evidence", evidence_root)
    return dict(value)


def validate_check_group(value: Any, label: str, evidence_root: Path) -> dict[str, Any]:
    require(isinstance(value, Mapping) and set(value) == {"passed", "checks"}, f"{label} fields drifted")
    require(isinstance(value["passed"], bool), f"{label}.passed is invalid")
    require(isinstance(value["checks"], list) and value["checks"], f"{label} has no checks")
    checks = [validate_check(item, f"{label}.checks[{index}]", evidence_root) for index, item in enumerate(value["checks"])]
    require(len({item["key"] for item in checks}) == len(checks), f"{label} repeats a check")
    require(value["passed"] == all(item["passed"] for item in checks), f"{label} summary does not derive from checks")
    return dict(value)


def validate_journey(value: Any, expected_id: str, label: str, evidence_root: Path) -> dict[str, Any]:
    fields = {"journeyId", "runner", "authenticated", "realEndpoint", "passed", "evidence"}
    require(isinstance(value, Mapping) and set(value) == fields, f"{label} journey fields drifted")
    require(value["journeyId"] == expected_id, f"{label} journey does not match the feature catalog")
    expected_runner = "real-browser" if expected_id.startswith("browser:") else "protocol-client"
    require(value["runner"] == expected_runner, f"{label} journey runner is invalid")
    require(value["authenticated"] is True and value["realEndpoint"] is True,
            f"{label} journey used an unauthenticated or synthetic endpoint")
    require(isinstance(value["passed"], bool), f"{label} journey result is invalid")
    validate_reference(value["evidence"], f"{label}.evidence", evidence_root)
    return dict(value)


def validate_parent(value: Any, feature_key: str, started_at: datetime, evidence_root: Path) -> dict[str, str] | None:
    if value is None:
        return None
    reference = validate_reference(value, "successfulParent", evidence_root)
    parent = json.loads((evidence_root / reference["path"]).read_text(encoding="utf-8"))
    require(parent.get("status") == "passed", "successful parent did not pass")
    require(parent.get("featureKey") == feature_key, "successful parent belongs to another feature")
    require(parent.get("evidenceDigest") == canonical_digest({key: item for key, item in parent.items() if key != "evidenceDigest"}),
            "successful parent canonical digest is invalid")
    require(parse_utc(parent.get("completedAt"), "successfulParent.completedAt") <= started_at,
            "successful parent completed after the child started")
    return reference


def validate_evidence(value: Mapping[str, Any], *, evidence_root: Path = ROOT) -> dict[str, Any]:
    validate_schema()
    require(set(value) == TOP_FIELDS, "feature evidence top-level fields drifted")
    require(value.get("schemaVersion") == 1, "feature evidence schema version drifted")
    catalog, feature_map = load_catalog()
    feature_key = value.get("featureKey")
    require(isinstance(feature_key, str) and feature_key in feature_map, "feature evidence names an unknown feature")
    feature = feature_map[feature_key]
    require(value.get("catalogDigest") == canonical_digest(catalog), "feature evidence catalog digest does not match")
    evidence_match = EVIDENCE_ID.fullmatch(str(value.get("evidenceId", "")))
    require(evidence_match is not None and evidence_match.group(1) == feature_key, "feature evidence id is invalid")
    require(isinstance(value.get("runId"), str) and RUN_ID.fullmatch(value["runId"]) is not None, "feature run id is invalid")
    require(value.get("status") in {"passed", "failed", "blocked"}, "feature evidence status is invalid")
    started_at = parse_utc(value.get("startedAt"), "startedAt")
    completed_at = parse_utc(value.get("completedAt"), "completedAt")
    require(completed_at >= started_at, "feature evidence completed before it started")

    source = value.get("source")
    require(isinstance(source, Mapping) and set(source) == SOURCE_FIELDS, "source binding fields drifted")
    require(isinstance(source["revision"], str) and re.fullmatch(r"[0-9a-f]{40,64}", source["revision"]) is not None,
            "source revision is invalid")
    require(isinstance(source["treeDigest"], str) and SHA256.fullmatch(source["treeDigest"]) is not None,
            "source tree digest is invalid")
    require(source["dirty"] is False, "dirty source cannot produce Product Accepted evidence")
    require(isinstance(source["artifacts"], list) and source["artifacts"], "source artifacts are missing")
    for index, reference in enumerate(source["artifacts"]):
        validate_reference(reference, f"source.artifacts[{index}]", evidence_root)

    deployment = value.get("deployment")
    require(isinstance(deployment, Mapping) and set(deployment) == DEPLOYMENT_FIELDS, "deployment binding fields drifted")
    require(isinstance(deployment["deploymentId"], str) and RUN_ID.fullmatch(deployment["deploymentId"]) is not None,
            "deployment id is invalid")
    require(isinstance(deployment["targetNodeId"], str) and KEY.fullmatch(deployment["targetNodeId"]) is not None,
            "deployment target node id is invalid")
    require(deployment["architecture"] == "linux/arm64/v8", "deployment is not the supported ARM64 architecture")
    require(isinstance(deployment["composeProject"], str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,63}", deployment["composeProject"]) is not None,
            "compose project is invalid")
    require(isinstance(deployment["configurationDigest"], str) and SHA256.fullmatch(deployment["configurationDigest"]) is not None,
            "deployment configuration digest is invalid")
    require(isinstance(deployment["idempotentReplayPassed"], bool), "idempotent deployment result is invalid")
    images = deployment["ociImages"]
    require(isinstance(images, list) and images, "deployment OCI image bindings are missing")
    components: set[str] = set()
    for image in images:
        require(isinstance(image, Mapping) and set(image) == {"component", "reference", "digest", "platform"},
                "OCI image binding fields drifted")
        require(isinstance(image["component"], str) and re.fullmatch(r"[a-z][a-z0-9-]+", image["component"]) is not None,
                "OCI image component is invalid")
        match = OCI.fullmatch(str(image["reference"]))
        require(match is not None, "OCI image is not pinned by digest")
        require(image["digest"] == "sha256:" + match.group(1), "OCI image reference and digest diverged")
        require(image["platform"] == "linux/arm64/v8", "OCI image platform is invalid")
        require(image["component"] not in components, "OCI image component is duplicated")
        components.add(image["component"])

    inventory = value.get("sparkInventory")
    require(isinstance(inventory, Mapping) and set(inventory) == INVENTORY_FIELDS, "Spark inventory binding fields drifted")
    require(inventory["nodeId"] == deployment["targetNodeId"], "Spark inventory belongs to another deployment target")
    require(inventory["architecture"] == deployment["architecture"], "Spark inventory architecture diverged")
    require(isinstance(inventory["inventoryDigest"], str) and SHA256.fullmatch(inventory["inventoryDigest"]) is not None,
            "Spark inventory digest is invalid")
    captured_at = parse_utc(inventory["capturedAt"], "sparkInventory.capturedAt")
    require(captured_at <= completed_at and (completed_at - captured_at).total_seconds() <= 86400,
            "Spark inventory is stale or captured after completion")
    require(isinstance(inventory["hardwareGates"], list), "Spark hardware gates are invalid")
    inventory_gates = [validate_gate(item, f"sparkInventory.hardwareGates[{index}]", evidence_root)
                       for index, item in enumerate(inventory["hardwareGates"])]

    configuration = value.get("configuration")
    require(isinstance(configuration, Mapping) and set(configuration) == CONFIG_FIELDS, "configuration binding fields drifted")
    require(isinstance(configuration["schemaVersion"], int) and configuration["schemaVersion"] >= 1,
            "configuration schema version is invalid")
    manifest_digest = digest_bytes(MIGRATIONS.read_bytes())
    require(configuration["migrationManifestDigest"] == manifest_digest, "migration manifest digest does not match")
    applied = _string_list(configuration["appliedMigrations"], "appliedMigrations", minimum=1)
    require(applied == feature["migrations"], "applied migrations do not match the feature catalog")
    persistent = _string_list(configuration["persistentDependencies"], "persistentDependencies", minimum=1)
    require(persistent == feature["persistence"], "persistent dependencies do not match the feature catalog")
    require(not any(PROHIBITED_DEPENDENCY.search(item) for item in persistent), "memory/mock/fixture product dependency is forbidden")
    require(configuration["secretsRetained"] is False, "feature evidence retained secrets")

    health = value.get("health")
    require(isinstance(health, Mapping) and set(health) == {"passed", "checks"}, "health fields drifted")
    health_result = validate_check_group(health, "health", evidence_root)
    journeys = value.get("journeys")
    require(isinstance(journeys, Mapping) and set(journeys) == {"success", "failure"}, "journey fields drifted")
    success = validate_journey(journeys["success"], feature["successJourney"], "journeys.success", evidence_root)
    failure = validate_journey(journeys["failure"], feature["failureJourney"], "journeys.failure", evidence_root)
    restart = validate_check_group(value.get("restart"), "restart", evidence_root)
    rollback = validate_check_group(value.get("rollback"), "rollback", evidence_root)

    residual = value.get("residualState")
    require(isinstance(residual, Mapping) and set(residual) == {"passed", "ownedResources", "unexpectedResources"},
            "residual-state fields drifted")
    require(isinstance(residual["passed"], bool), "residual-state result is invalid")
    _string_list(residual["ownedResources"], "residualState.ownedResources")
    unexpected = _string_list(residual["unexpectedResources"], "residualState.unexpectedResources")
    require(not unexpected, "unexpected residual resources remain")

    limitations = value.get("limitations")
    require(isinstance(limitations, list), "limitations must be a list")
    for index, limitation in enumerate(limitations):
        require(isinstance(limitation, Mapping) and set(limitation) == {"key", "disposition", "source"},
                f"limitations[{index}] fields drifted")
        require(isinstance(limitation["key"], str) and KEY.fullmatch(limitation["key"]) is not None,
                f"limitations[{index}] key is invalid")
        require(limitation["disposition"] in {"accepted", "blocking"}, f"limitations[{index}] disposition is invalid")
        validate_reference(limitation["source"], f"limitations[{index}].source", evidence_root)

    human_gates = value.get("humanGates")
    require(isinstance(human_gates, list), "human gates must be a list")
    human_gate_values = [validate_gate(item, f"humanGates[{index}]", evidence_root) for index, item in enumerate(human_gates)]
    gate_keys = {item["key"] for item in [*inventory_gates, *human_gate_values]}
    require(set(feature["hardwareGates"]["required"]) <= gate_keys, "feature hardware/human gate coverage is incomplete")
    validate_parent(value.get("successfulParent"), feature_key, started_at, evidence_root)

    privacy = value.get("privacy")
    require(isinstance(privacy, Mapping) and set(privacy) == PRIVACY_FIELDS, "privacy fields drifted")
    require(privacy["credentialsRetained"] is False and privacy["userContentRetained"] is False
            and privacy["commandOutputRetained"] is False and privacy["redactionPassed"] is True,
            "feature evidence privacy/redaction policy failed")
    expected_digest = canonical_digest({key: item for key, item in value.items() if key != "evidenceDigest"})
    require(value.get("evidenceDigest") == expected_digest, "feature evidence canonical digest does not match")

    if value["status"] == "passed":
        require(deployment["idempotentReplayPassed"] is True, "passed evidence lacks idempotent deployment replay")
        require(health_result["passed"] and success["passed"] and failure["passed"] and restart["passed"]
                and rollback["passed"] and residual["passed"], "passed evidence contains a failed acceptance section")
        require(not any(item["disposition"] == "blocking" for item in limitations), "passed evidence has a blocking limitation")
        require(all(item["status"] != "pending" for item in [*inventory_gates, *human_gate_values]),
                "passed evidence has a pending hardware/human gate")
    return {
        "valid": True,
        "featureKey": feature_key,
        "evidenceId": value["evidenceId"],
        "status": value["status"],
        "evidenceDigest": value["evidenceDigest"],
        "successfulParentBound": value["successfulParent"] is not None,
    }


def validate(path: Path, *, evidence_root: Path = ROOT) -> dict[str, Any]:
    return validate_evidence(json.loads(path.read_text(encoding="utf-8")), evidence_root=evidence_root)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, default=ROOT)
    args = parser.parse_args(argv)
    result = validate(args.evidence.resolve(), evidence_root=args.evidence_root.resolve())
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FeatureEvidenceError, json.JSONDecodeError, OSError) as error:
        print(f"feature evidence invalid: {error}")
        raise SystemExit(1)
