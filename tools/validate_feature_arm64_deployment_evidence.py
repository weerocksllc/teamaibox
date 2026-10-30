#!/usr/bin/env python3
"""Validate exact ARM64 feature deployment runner and cleanup evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import re
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "architecture" / "validation" / "feature-deployment-runner.v1.json"
CATALOG = ROOT / "architecture" / "validation" / "feature-acceptance-catalog.v1.json"
RUNNER = ROOT / "tools" / "run_feature_arm64_deployment.py"
HISTORICAL_RUNNERS = ROOT / "architecture" / "validation" / "historical-feature-runner-digests.v1.json"
HISTORICAL_CATALOGS = ROOT / "architecture" / "validation" / "historical-feature-catalog-digests.v1.json"
HISTORICAL_POLICIES = ROOT / "architecture" / "validation" / "historical-feature-deployment-policy-digests.v1.json"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
UTC = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$")
SUCCESS_FIELDS_V1 = {
    "schemaVersion", "runnerId", "runId", "featureKey", "status", "startedAt", "completedAt", "target",
    "architecture", "composeProject", "sourceDigest", "sourceFileCount", "planDigest", "policyDigest",
    "runnerDigest", "catalogDigest", "runtimeEnvironmentDigest", "imageBindings", "migrationNames", "steps",
    "idempotentReplayPassed", "rollbackAttempted", "rollbackPassed", "stagingCleanupPassed", "failure",
    "credentialsRetained", "commandOutputRetained", "evidenceDigest",
}
SUCCESS_FIELDS_V2 = SUCCESS_FIELDS_V1 | {"deploymentRoot", "deploymentRootRetained", "deploymentMaterialCheckPassed"}
STEP_FIELDS = {
    "key", "passed", "durationMilliseconds", "commandDigest", "stdoutDigest", "stderrDigest", "returnCode",
    "outputRetained",
}
CLEANUP_FIELDS_V1 = {
    "schemaVersion", "cleanupId", "target", "parentEvidence", "ownedRunIds", "composeProject",
    "containersRemoved", "volumesRemoved", "imagesRemoved", "stagingPathsRemoved", "residualContainerCount",
    "residualVolumeCount", "residualStagingPathCount", "status", "completedAt", "credentialsRetained",
    "commandOutputRetained", "evidenceDigest",
}
CLEANUP_FIELDS_V2 = CLEANUP_FIELDS_V1 | {"deploymentPathsRemoved", "residualDeploymentPathCount"}

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.run_feature_arm64_deployment import canonical_bytes, digest_bytes, validate_plan


class FeatureDeploymentEvidenceError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FeatureDeploymentEvidenceError(message)


def _safe_reference(value: Any) -> Path:
    require(isinstance(value, str) and value.startswith("evidence/"), "cleanup parent evidence path is invalid")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts, "cleanup parent evidence path is unsafe")
    target = ROOT / path
    require(target.is_file(), "cleanup parent evidence file is missing")
    return target


def _canonical_digest(value: Mapping[str, Any]) -> str:
    return digest_bytes(canonical_bytes({key: item for key, item in value.items() if key != "evidenceDigest"}))


def accepted_runner_digests() -> set[str]:
    value = json.loads(HISTORICAL_RUNNERS.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.feature-deploy.v1"
            and set(value) == {"schemaVersion", "runnerId", "retiredRunnerDigests"},
            "historical feature runner registry drifted")
    retired = value.get("retiredRunnerDigests")
    require(isinstance(retired, list), "historical feature runner registry is invalid")
    digests = {digest_bytes(RUNNER.read_bytes())}
    for item in retired:
        require(isinstance(item, Mapping) and set(item) == {"digest", "retiredAt", "reason"}
                and SHA256.fullmatch(item.get("digest", "")) is not None
                and UTC.fullmatch(item.get("retiredAt", "")) is not None
                and isinstance(item.get("reason"), str) and len(item["reason"]) >= 80,
                "historical feature runner entry is invalid")
        require(item["digest"] not in digests, "historical feature runner digest is duplicated or still current")
        digests.add(item["digest"])
    return digests


def accepted_catalog_digests() -> set[str]:
    value = json.loads(HISTORICAL_CATALOGS.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1 and value.get("catalogId") == "teamaibox.feature-acceptance.v1"
            and set(value) == {"schemaVersion", "catalogId", "retiredCatalogDigests"},
            "historical feature catalog registry drifted")
    retired = value.get("retiredCatalogDigests")
    require(isinstance(retired, list), "historical feature catalog registry is invalid")
    digests = {digest_bytes(CATALOG.read_bytes())}
    for item in retired:
        require(isinstance(item, Mapping) and set(item) == {"digest", "retiredAt", "reason"}
                and SHA256.fullmatch(item.get("digest", "")) is not None
                and UTC.fullmatch(item.get("retiredAt", "")) is not None
                and isinstance(item.get("reason"), str) and len(item["reason"]) >= 80,
                "historical feature catalog entry is invalid")
        require(item["digest"] not in digests, "historical feature catalog digest is duplicated or still current")
        digests.add(item["digest"])
    return digests


def accepted_policy_digests() -> set[str]:
    value = json.loads(HISTORICAL_POLICIES.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1 and value.get("policyId") == "teamaibox.feature-deployment-policy-history.v1"
            and set(value) == {"schemaVersion", "policyId", "retiredPolicyDigests"},
            "historical feature deployment policy registry drifted")
    retired = value.get("retiredPolicyDigests")
    require(isinstance(retired, list), "historical feature deployment policy entries are invalid")
    digests = {digest_bytes(POLICY.read_bytes())}
    for item in retired:
        require(isinstance(item, Mapping) and set(item) == {"digest", "retiredAt", "reason"}
                and SHA256.fullmatch(item.get("digest", "")) is not None
                and UTC.fullmatch(item.get("retiredAt", "")) is not None
                and isinstance(item.get("reason"), str) and len(item["reason"]) >= 80,
                "historical feature deployment policy entry is invalid")
        require(item["digest"] not in digests, "historical feature deployment policy digest is duplicated or still current")
        digests.add(item["digest"])
    return digests


def validate_deployment(value: Mapping[str, Any], plan: Mapping[str, Any]) -> dict[str, Any]:
    schema_version = value.get("schemaVersion")
    require(set(value) == (SUCCESS_FIELDS_V2 if schema_version == 2 else SUCCESS_FIELDS_V1),
            "feature deployment evidence fields drifted")
    require(schema_version in {1, 2} and value.get("runnerId") == "teamaibox.feature-deploy.v1",
            "feature deployment evidence identity drifted")
    plan = validate_plan(plan)
    require(value.get("runId") == plan["runId"] and value.get("featureKey") == plan["featureKey"],
            "feature deployment evidence does not match the plan")
    require(value.get("target") == plan["target"] and value.get("architecture") == "linux/arm64/v8",
            "feature deployment evidence target or architecture drifted")
    require(value.get("composeProject") == "teamaibox_feature_" + re.sub(r"[^a-z0-9]", "_", plan["runId"]),
            "feature deployment Compose identity drifted")
    require(isinstance(value.get("startedAt"), str) and UTC.fullmatch(value["startedAt"]) is not None
            and isinstance(value.get("completedAt"), str) and UTC.fullmatch(value["completedAt"]) is not None,
            "feature deployment timestamps are invalid")
    require(value.get("planDigest") == digest_bytes(canonical_bytes(plan)), "feature deployment plan digest changed")
    require(value.get("policyDigest") in accepted_policy_digests(), "feature deployment policy digest changed")
    require(value.get("runnerDigest") in accepted_runner_digests(), "feature deployment runner digest changed")
    require(value.get("catalogDigest") in accepted_catalog_digests(), "feature deployment catalog digest changed")
    require(isinstance(value.get("runtimeEnvironmentDigest"), str) and SHA256.fullmatch(value["runtimeEnvironmentDigest"]) is not None,
            "feature runtime environment is not digest-bound")
    require(isinstance(value.get("sourceDigest"), str) and SHA256.fullmatch(value["sourceDigest"]) is not None
            and isinstance(value.get("sourceFileCount"), int) and not isinstance(value["sourceFileCount"], bool)
            and value["sourceFileCount"] >= len(plan["sourcePaths"]),
            "feature deployment source archive attestation is invalid")
    bindings = value.get("imageBindings")
    require(isinstance(bindings, list) and len(bindings) == len(plan["images"]), "feature image binding coverage drifted")
    for declaration, binding in zip(plan["images"], bindings):
        require(isinstance(binding, Mapping)
                and set(binding) == {"component", "buildTag", "imageId", "platform"}, "feature image binding fields drifted")
        require(binding["component"] == declaration["component"] and binding["buildTag"] == declaration["buildTag"],
                "feature image binding does not match the plan")
        require(isinstance(binding["imageId"], str) and SHA256.fullmatch(binding["imageId"]) is not None
                and binding["platform"] == "linux/arm64/v8", "feature image is not a measured ARM64 digest")
    require(value.get("migrationNames") == plan["migrations"]["expected"], "feature migration binding drifted")
    steps = value.get("steps")
    require(isinstance(steps, list) and steps, "feature deployment steps are missing")
    expected_steps = [
        "verify-target", *[
            f"reuse-{item['component']}" if "reuse" in item else f"build-{item['component']}"
            for item in plan["images"]
        ], "render-compose",
        "deploy-dependencies", "migrate", "deploy-feature",
        *[f"health-{item['key']}" for item in plan["healthChecks"]],
        *[f"retained-{item['key']}" for item in plan["retainedStateChecks"]],
        "idempotent-replay", "residual-check", *(["durable-deployment-material"] if schema_version == 2 else []),
    ]
    require([item.get("key") for item in steps if isinstance(item, Mapping)] == expected_steps,
            "feature deployment successful step sequence drifted")
    for step in steps:
        require(isinstance(step, Mapping) and set(step) == STEP_FIELDS, f"feature deployment step {step.get('key')} fields drifted")
        require(step["passed"] is True and step["returnCode"] == 0 and step["outputRetained"] is False,
                f"feature deployment step {step['key']} did not pass or retained output")
        require(all(isinstance(step[key], str) and SHA256.fullmatch(step[key]) is not None
                    for key in ("commandDigest", "stdoutDigest", "stderrDigest")),
                f"feature deployment step {step['key']} digest is invalid")
    require(value.get("status") == "passed" and value.get("failure") is None,
            "feature deployment evidence did not pass")
    require(value.get("idempotentReplayPassed") is True and value.get("stagingCleanupPassed") is True,
            "feature deployment replay or staging cleanup failed")
    if schema_version == 2:
        require(value.get("deploymentRoot") == "/var/lib/teamaibox-feature-deployments/" + plan["runId"]
                and value.get("deploymentRootRetained") is True
                and value.get("deploymentMaterialCheckPassed") is True,
                "durable retained deployment material is incomplete")
    require(value.get("rollbackAttempted") is False and value.get("rollbackPassed") is False,
            "successful feature deployment unexpectedly claims rollback")
    require(value.get("credentialsRetained") is False and value.get("commandOutputRetained") is False,
            "feature deployment evidence retained sensitive output")
    require(value.get("evidenceDigest") == _canonical_digest(value), "feature deployment canonical digest changed")
    return {"valid": True, "runId": value["runId"], "status": value["status"], "imageCount": len(bindings), "stepCount": len(steps)}


def validate_cleanup(value: Mapping[str, Any], deployment: Mapping[str, Any]) -> dict[str, Any]:
    schema_version = value.get("schemaVersion")
    require(set(value) == (CLEANUP_FIELDS_V2 if schema_version == 2 else CLEANUP_FIELDS_V1),
            "feature cleanup evidence fields drifted")
    require(schema_version == deployment.get("schemaVersion") and schema_version in {1, 2}
            and value.get("status") == "passed", "feature cleanup evidence did not pass")
    require(isinstance(value.get("completedAt"), str) and UTC.fullmatch(value["completedAt"]) is not None,
            "feature cleanup timestamp is invalid")
    require(value.get("target") == deployment["target"] and value.get("composeProject") == deployment["composeProject"],
            "feature cleanup target or Compose project drifted")
    require(value.get("ownedRunIds") == [deployment["runId"]], "feature cleanup owns an unexpected run")
    parents = value.get("parentEvidence")
    require(isinstance(parents, list) and len(parents) == 1, "feature cleanup must bind one exact successful parent")
    parent = parents[0]
    require(isinstance(parent, Mapping) and set(parent) == {"path", "digest"}, "feature cleanup parent fields drifted")
    target = _safe_reference(parent["path"])
    require(parent.get("digest") == digest_bytes(target.read_bytes()), "feature cleanup parent digest changed")
    require(json.loads(target.read_text(encoding="utf-8")) == deployment, "feature cleanup parent content does not match")
    expected_prefix = deployment["composeProject"]
    containers = value.get("containersRemoved")
    volumes = value.get("volumesRemoved")
    staging = value.get("stagingPathsRemoved")
    require(isinstance(containers, list) and len(containers) >= 1
            and all(isinstance(item, str) and item.startswith(expected_prefix + "-") for item in containers),
            "feature cleanup container ownership is invalid")
    require(isinstance(volumes, list) and len(volumes) >= 1
            and all(isinstance(item, str) and item.startswith(expected_prefix + "_") for item in volumes),
            "feature cleanup volume ownership is invalid")
    require(staging == ["/tmp/teamaibox-feature-" + deployment["runId"]], "feature cleanup staging ownership is invalid")
    if schema_version == 2:
        require(value.get("deploymentPathsRemoved") == ["/var/lib/teamaibox-feature-deployments/" + deployment["runId"]]
                and value.get("residualDeploymentPathCount") == 0,
                "feature cleanup durable deployment-path ownership is invalid")
    images = value.get("imagesRemoved")
    require(isinstance(images, list) and len(images) == len(deployment["imageBindings"]),
            "feature cleanup image coverage drifted")
    for removed, binding in zip(images, deployment["imageBindings"]):
        require(isinstance(removed, Mapping) and set(removed) == {"tag", "imageId"}
                and removed["tag"] == binding["buildTag"] and removed["imageId"] == binding["imageId"],
                "feature cleanup removed an unowned image")
    require(value.get("residualContainerCount") == 0 and value.get("residualVolumeCount") == 0
            and value.get("residualStagingPathCount") == 0, "feature cleanup left residual resources")
    require(value.get("credentialsRetained") is False and value.get("commandOutputRetained") is False,
            "feature cleanup retained sensitive output")
    require(value.get("evidenceDigest") == _canonical_digest(value), "feature cleanup canonical digest changed")
    return {"valid": True, "cleanupId": value["cleanupId"], "status": value["status"], "parentRunId": deployment["runId"]}


def validate(deployment_path: Path, plan_path: Path, cleanup_path: Path) -> dict[str, Any]:
    deployment = json.loads(deployment_path.read_text(encoding="utf-8"))
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    cleanup = json.loads(cleanup_path.read_text(encoding="utf-8"))
    deployed = validate_deployment(deployment, plan)
    cleaned = validate_cleanup(cleanup, deployment)
    return {"valid": True, "deployment": deployed, "cleanup": cleaned}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--cleanup-evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    result = validate(args.evidence.resolve(), args.plan.resolve(), args.cleanup_evidence.resolve())
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FeatureDeploymentEvidenceError, ValueError, json.JSONDecodeError, OSError) as error:
        print(f"feature ARM64 deployment evidence invalid: {error}")
        raise SystemExit(1)
