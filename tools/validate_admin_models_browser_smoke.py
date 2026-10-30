#!/usr/bin/env python3
"""Strictly validate one exact Models administration real-browser record."""
from __future__ import annotations

import os
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

RUNNER = ROOT / "tools/run_admin_models_browser_smoke.mjs"
COMMON = ROOT / "tools/browser_smoke_common.mjs"
RUN_ID = re.compile(r"^admin-models-browser-[0-9]{8}-a[1-9][0-9]*$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
UTC = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$")
PROFILE_ID = os.environ.get('TEAMAIBOX_BROWSER_MODEL_PROFILE_ID')
PROFILE_KEY = "asr.whisper-large-v3.fp16.spark-worker02.audio.v2"
TOP_FIELDS = {
    "schemaVersion", "runnerId", "runId", "featureKey", "status", "origin", "startedAt", "completedAt",
    "browser", "operations", "model", "runtime", "routing", "screenshots", "console", "source", "deployment",
    "privacy", "limitations", "failure", "evidenceDigest",
}
OPERATIONS = {
    "ownerWorkspaceVisible", "durableProfilesVisible", "evidenceCardVisible", "productionBlockedVisible",
    "runtimeTruthVisible", "validationRouteInitiallyDisabled", "validationRouteEnabledThroughUi",
    "validationRouteReloadRetained", "validationRouteRestoredThroughUi", "productionApiDenied",
    "certifiedProfileUiIneligible", "auditActionsVisible", "auditChainValid", "chineseDarkApplied",
    "englishLightApplied", "mobileNoOverflow", "memberAdminHidden", "memberApiDenied",
    "memberDirectRouteDenied", "consoleClean",
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
    require(path.is_file() and ROOT in path.parents, "Admin Models browser evidence is missing or unscoped")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_FIELDS, "Admin Models browser evidence fields drifted")
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.admin-models-browser-smoke.v1", "Admin Models browser evidence identity drifted")
    run_id = str(value.get("runId", ""))
    require(RUN_ID.fullmatch(run_id) is not None and value.get("featureKey") == "admin.models"
            and value.get("status") == "passed" and value.get("failure") is None, "Admin Models browser acceptance did not pass")
    require(UTC.fullmatch(str(value.get("startedAt", ""))) is not None and UTC.fullmatch(str(value.get("completedAt", ""))) is not None, "Admin Models browser timestamps are invalid")
    browser = value.get("browser")
    require(isinstance(browser, Mapping) and set(browser) == {"platform", "userAgent"}
            and "HeadlessChrome/" in str(browser.get("userAgent", "")), "real Headless Chrome identity is missing")
    operations = value.get("operations")
    require(isinstance(operations, Mapping) and set(operations) == OPERATIONS
            and all(item is True for item in operations.values()), "Admin Models browser operations are incomplete")
    require(value.get("console") == {"errorCount": 0}, "Admin Models browser console was not clean")

    model = value.get("model")
    require(isinstance(model, Mapping) and set(model) == {
        "profileId", "profileKey", "profileCount", "lifecycleState", "precision", "productionEligible",
        "limitationCount", "rawEvidenceCount",
    } and model.get("profileId") == PROFILE_ID and model.get("profileKey") == PROFILE_KEY
            and isinstance(model.get("profileCount"), int) and model["profileCount"] >= 9
            and model.get("lifecycleState") == "experimental" and model.get("precision") == "fp16"
            and model.get("productionEligible") is False
            and isinstance(model.get("limitationCount"), int) and model["limitationCount"] > 0
            and isinstance(model.get("rawEvidenceCount"), int) and model["rawEvidenceCount"] > 0,
            "Admin Models evidence-backed model facts drifted")
    runtime = value.get("runtime")
    require(isinstance(runtime, Mapping) and set(runtime) == {
        "collectionStatus", "nodeCount", "freshNodeCount", "placementCount", "workerCount", "renderedEmptyState",
    } and runtime.get("collectionStatus") in {"fresh", "partial", "stale", "unavailable"}
            and isinstance(runtime.get("nodeCount"), int) and runtime["nodeCount"] >= 1
            and isinstance(runtime.get("freshNodeCount"), int) and 0 <= runtime["freshNodeCount"] <= runtime["nodeCount"]
            and isinstance(runtime.get("placementCount"), int) and runtime["placementCount"] >= 0
            and isinstance(runtime.get("workerCount"), int) and runtime["workerCount"] >= 0
            and runtime.get("renderedEmptyState") is ((runtime["placementCount"] + runtime["workerCount"]) == 0),
            "Admin Models truthful runtime facts drifted")
    routing = value.get("routing")
    require(routing == {
        "policyKey": "validation.default", "environment": "validation", "initialEnabled": False,
        "enabledThroughUi": True, "reloadRetained": True, "finalEnabled": False,
        "productionDeniedStatus": 400,
    }, "Admin Models validation-only routing facts drifted")
    require(value.get("source") == {"runnerDigest": digest(RUNNER.read_bytes()), "commonDigest": digest(COMMON.read_bytes())}, "Admin Models browser source binding drifted")
    require(value.get("privacy") == {
        "credentialsRetained": False, "userContentRetained": False, "commandOutputRetained": False,
        "syntheticContentOnly": True,
    }, "Admin Models browser privacy boundary drifted")
    require(value.get("limitations") == {
        "trustedHttps": "not_satisfied_by_self_signed_component_origin",
        "independentHumanAcceptance": "not_performed",
        "physicalModelWorkerLifecycle": "not_claimed_by_model_administration_browser_journey",
    }, "Admin Models browser limitations drifted")

    screenshots = value.get("screenshots")
    require(isinstance(screenshots, list) and [item.get("key") for item in screenshots] == [
        "owner-asr-zh-dark", "owner-asr-en-light", "owner-mobile-en-light", "member-denied-mobile-en-light",
    ], "Admin Models screenshot matrix drifted")
    for item in screenshots:
        require(isinstance(item, Mapping) and set(item) == {"key", "path", "digest"}, "Admin Models screenshot fields drifted")
        image = repository_file(item.get("path"), "Admin Models screenshot")
        image_bytes = image.read_bytes()
        require(image.suffix == ".png" and image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
                and item.get("digest") == digest(image_bytes), "Admin Models screenshot digest changed")

    binding = value.get("deployment")
    require(isinstance(binding, Mapping) and set(binding) == {
        "evidencePath", "evidenceDigest", "runId", "webImageId", "platformApiImageId", "postgresImageId",
    }, "Admin Models deployment binding drifted")
    deployment_path = repository_file(binding.get("evidencePath"), "Admin Models deployment evidence")
    deployment_bytes = deployment_path.read_bytes()
    require(binding.get("evidenceDigest") == digest(deployment_bytes), "Admin Models deployment digest changed")
    deployment = json.loads(deployment_bytes)
    identity = re.fullmatch(r"[a-z0-9-]+-(20[0-9]{6})-(a[1-9][0-9]*)", str(binding.get("runId", "")))
    require(identity is not None and deployment.get("runId") == binding.get("runId")
            and deployment.get("featureKey") == "admin.models", "Admin Models deployment identity drifted")
    plan_path = ROOT / "deploy/application-catalog-e2e" / f"plan-{identity.group(1)}-{identity.group(2)}.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    validate_deployment(deployment, plan)
    require(value.get("origin", "").rstrip("/") == plan["environment"]["TEAMAIBOX_CATALOG_PUBLIC_ORIGIN"], "Admin Models browser origin differs from deployment")
    images = {item["component"]: item["imageId"] for item in deployment["imageBindings"]}
    require(binding.get("webImageId") == images.get("catalog-web")
            and binding.get("platformApiImageId") == images.get("catalog-platform-api")
            and binding.get("postgresImageId") == images.get("catalog-postgres")
            and all(SHA256.fullmatch(str(binding.get(key, ""))) is not None for key in ("webImageId", "platformApiImageId", "postgresImageId")), "Admin Models deployed image binding drifted")
    require(any(item.get("key") == "admin-models-profile-card-runtime-and-validation-routing" for item in plan.get("healthChecks", []))
            and any(item.get("key") == "admin-models-post-restart-and-policy-restore" for item in plan.get("retainedStateChecks", [])), "Admin Models lifecycle or restart proof is absent")
    serialized = json.dumps(value, sort_keys=True)
    require("BEGIN PRIVATE KEY" not in serialized and "password" not in serialized.lower(), "Admin Models browser evidence retained protected material")
    without_digest = dict(value)
    claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "Admin Models browser canonical digest drifted")
    return {"valid": True, "runId": run_id, "status": value["status"], "deploymentRunId": binding["runId"], "operationCount": len(OPERATIONS), "screenshotCount": len(screenshots), "profileId": PROFILE_ID}


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
        print(f"Admin Models browser evidence invalid: {error}")
        raise SystemExit(1)
