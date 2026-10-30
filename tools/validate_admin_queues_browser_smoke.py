#!/usr/bin/env python3
"""Strictly validate one exact Queue administration real-browser record."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.validate_feature_arm64_deployment_evidence import validate_deployment

RUNNER = ROOT / "tools/run_admin_queues_browser_smoke.mjs"
COMMON = ROOT / "tools/browser_smoke_common.mjs"
SEED = ROOT / "deploy/application-catalog-e2e/admin-queues-browser-seed.sh"
RUN_ID = re.compile(r"^admin-queues-browser-[0-9]{8}-a[1-9][0-9]*$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
UTC = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$")
TOP_FIELDS = {
    "schemaVersion", "runnerId", "runId", "featureKey", "status", "origin", "startedAt", "completedAt",
    "browser", "operations", "job", "policy", "screenshots", "console", "source", "deployment",
    "privacy", "limitations", "failure", "evidenceDigest",
}
OPERATIONS = {
    "ownerWorkspaceVisible", "livePostgresFactsVisible", "sensitiveMetadataRedacted",
    "exactConfirmationRequired", "cancellationThroughUi", "terminalCancellationVisible",
    "policyConflictVisible", "policyUpdatedThroughUi", "policyReloadRetained", "policyRestoredThroughUi",
    "auditActionsVisible", "auditChainValid", "chineseDarkApplied", "englishLightApplied",
    "mobileNoOverflow", "memberAdminHidden", "memberApiDenied", "memberDirectRouteDenied", "consoleClean",
}


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def repository_file(value: Any, label: str) -> Path:
    require(isinstance(value, str) and value, f"{label} is missing")
    relative = PurePosixPath(value)
    require(not relative.is_absolute() and ".." not in relative.parts, f"{label} is unsafe")
    path = (ROOT / relative).resolve()
    require(path.is_file() and ROOT in path.parents, f"{label} is invalid")
    return path


def validate(path: Path) -> dict[str, Any]:
    path = path.resolve()
    require(path.is_file() and ROOT in path.parents, "Admin Queues browser evidence is missing or unscoped")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_FIELDS, "Admin Queues browser evidence fields drifted")
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.admin-queues-browser-smoke.v1",
            "Admin Queues browser evidence identity drifted")
    run_id = str(value.get("runId", ""))
    require(RUN_ID.fullmatch(run_id) is not None and value.get("featureKey") == "admin.queues"
            and value.get("status") == "passed" and value.get("failure") is None,
            "Admin Queues browser acceptance did not pass")
    require(UTC.fullmatch(str(value.get("startedAt", ""))) is not None
            and UTC.fullmatch(str(value.get("completedAt", ""))) is not None,
            "Admin Queues browser timestamps are invalid")
    browser = value.get("browser")
    require(isinstance(browser, Mapping) and set(browser) == {"platform", "userAgent"}
            and "HeadlessChrome/" in str(browser.get("userAgent", "")), "real Headless Chrome identity is missing")
    operations = value.get("operations")
    require(isinstance(operations, Mapping) and set(operations) == OPERATIONS
            and all(item is True for item in operations.values()), "Admin Queues browser operations are incomplete")
    require(value.get("console") == {"errorCount": 0}, "Admin Queues browser console was not clean")

    job = value.get("job")
    require(isinstance(job, Mapping) and set(job) == {
        "jobId", "capabilityKey", "operation", "priority", "route", "attemptCount",
        "finalStatus", "cancellationRequested",
    } and UUID.fullmatch(str(job.get("jobId", ""))) is not None
            and job.get("capabilityKey") == "chat" and job.get("operation") == "qualification.queue.admin.browser"
            and job.get("priority") == 38 and job.get("route") == "unassigned" and job.get("attemptCount") == 0
            and job.get("finalStatus") == "cancelled" and job.get("cancellationRequested") is True,
            "Admin Queues durable job facts drifted")
    policy = value.get("policy")
    require(isinstance(policy, Mapping) and set(policy) == {
        "policyKey", "initialRevision", "conflictRevision", "updatedRevision", "finalRevision",
        "baselineMaxQueuedPerOwner", "testedMaxQueuedPerOwner", "finalMaxQueuedPerOwner",
    } and policy.get("policyKey") == "default"
            and isinstance(policy.get("initialRevision"), int) and policy["initialRevision"] >= 3
            and policy.get("conflictRevision") == policy["initialRevision"] + 1
            and policy.get("updatedRevision") == policy["initialRevision"] + 2
            and policy.get("finalRevision") == policy["initialRevision"] + 3
            and policy.get("baselineMaxQueuedPerOwner") == 64
            and policy.get("testedMaxQueuedPerOwner") == 66
            and policy.get("finalMaxQueuedPerOwner") == 64,
            "Admin Queues revisioned policy facts drifted")
    require(value.get("source") == {
        "runnerDigest": digest(RUNNER.read_bytes()), "commonDigest": digest(COMMON.read_bytes()),
        "seedDigest": digest(SEED.read_bytes()),
    }, "Admin Queues browser source binding drifted")
    require(value.get("privacy") == {
        "credentialsRetained": False, "userContentRetained": False,
        "commandOutputRetained": False, "syntheticContentOnly": True,
    }, "Admin Queues browser privacy boundary drifted")
    require(value.get("limitations") == {
        "trustedHttps": "not_satisfied_by_self_signed_component_origin",
        "independentHumanAcceptance": "not_performed",
        "hardwareScheduling": "not_claimed_by_queue_administration_browser_journey",
    }, "Admin Queues browser limitations drifted")

    screenshots = value.get("screenshots")
    require(isinstance(screenshots, list) and [item.get("key") for item in screenshots] == [
        "owner-queued-zh-dark", "owner-terminal-en-light", "owner-mobile-en-light", "member-denied-mobile-en-light",
    ], "Admin Queues screenshot matrix drifted")
    for item in screenshots:
        require(isinstance(item, Mapping) and set(item) == {"key", "path", "digest"},
                "Admin Queues screenshot fields drifted")
        image = repository_file(item.get("path"), "Admin Queues screenshot")
        image_bytes = image.read_bytes()
        require(image.suffix == ".png" and image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
                and item.get("digest") == digest(image_bytes), "Admin Queues screenshot digest changed")

    binding = value.get("deployment")
    require(isinstance(binding, Mapping) and set(binding) == {
        "evidencePath", "evidenceDigest", "runId", "webImageId", "platformApiImageId", "postgresImageId",
    }, "Admin Queues deployment binding drifted")
    deployment_path = repository_file(binding.get("evidencePath"), "Admin Queues deployment evidence")
    deployment_bytes = deployment_path.read_bytes()
    require(binding.get("evidenceDigest") == digest(deployment_bytes), "Admin Queues deployment digest changed")
    deployment = json.loads(deployment_bytes)
    identity = re.fullmatch(r"[a-z0-9-]+-(20[0-9]{6})-(a[1-9][0-9]*)", str(binding.get("runId", "")))
    require(identity is not None and deployment.get("runId") == binding.get("runId")
            and deployment.get("featureKey") == "admin.queues", "Admin Queues deployment identity drifted")
    plan_path = ROOT / "deploy/application-catalog-e2e" / f"plan-{identity.group(1)}-{identity.group(2)}.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    validate_deployment(deployment, plan)
    require(value.get("origin", "").rstrip("/") == plan["environment"]["TEAMAIBOX_CATALOG_PUBLIC_ORIGIN"],
            "Admin Queues browser origin differs from deployment")
    images = {item["component"]: item["imageId"] for item in deployment["imageBindings"]}
    require(binding.get("webImageId") == images.get("catalog-web")
            and binding.get("platformApiImageId") == images.get("catalog-platform-api")
            and binding.get("postgresImageId") == images.get("catalog-postgres")
            and all(SHA256.fullmatch(str(binding.get(key, ""))) is not None
                    for key in ("webImageId", "platformApiImageId", "postgresImageId")),
            "Admin Queues deployed image binding drifted")
    require(any(item.get("key") == "admin-queues-policy-and-cancellation" for item in plan.get("healthChecks", []))
            and any(item.get("key") == "admin-queues-post-restart-and-policy-restore" for item in plan.get("retainedStateChecks", [])),
            "Admin Queues lifecycle or restart proof is absent")
    serialized = json.dumps(value, sort_keys=True)
    require("must-not-leave-database" not in serialized and "BEGIN PRIVATE KEY" not in serialized,
            "Admin Queues browser evidence retained protected material")
    without_digest = dict(value)
    claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "Admin Queues browser canonical digest drifted")
    return {
        "valid": True, "runId": run_id, "status": value["status"],
        "deploymentRunId": binding["runId"], "operationCount": len(OPERATIONS),
        "screenshotCount": len(screenshots), "jobId": job["jobId"],
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Admin Queues browser evidence invalid: {error}")
        raise SystemExit(1)
