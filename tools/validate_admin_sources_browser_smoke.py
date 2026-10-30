#!/usr/bin/env python3
"""Strictly validate one exact Source Center real-browser record."""
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

RUNNER = ROOT / "tools/run_admin_sources_browser_smoke.mjs"
COMMON = ROOT / "tools/browser_smoke_common.mjs"
RUN_ID = re.compile(r"^admin-sources-browser-[0-9]{8}-a[1-9][0-9]*$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
UTC = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$")
TOP_FIELDS = {
    "schemaVersion", "runnerId", "runId", "featureKey", "status", "origin", "startedAt", "completedAt",
    "browser", "operations", "dataPlanes", "configuration", "offlineMedia", "screenshots", "console", "source",
    "deployment", "privacy", "limitations", "failure", "evidenceDigest",
}
OPERATIONS = {
    "ownerWorkspaceVisible", "dataPlanesVisible", "realCountersVisible", "durableConfigurationVisible",
    "allEcosystemsVisible", "offlineMediaVisible", "verifiedMediumVisible", "failureMediaVisible",
    "sourceDisabledThroughUi", "sourceDisableReloadRetained", "sourceRestoredThroughUi",
    "corruptApprovalDenied", "wrongArchitectureDenied", "auditActionsVisible", "auditChainValid",
    "chineseDarkApplied", "englishLightApplied", "mobileNoOverflow", "memberAdminHidden",
    "memberApiDenied", "memberDirectRouteDenied", "consoleClean",
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
    require(path.is_file() and ROOT in path.parents, "Admin Sources browser evidence is missing or unscoped")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_FIELDS, "Admin Sources browser evidence fields drifted")
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.admin-sources-browser-smoke.v1", "Admin Sources browser evidence identity drifted")
    run_id = str(value.get("runId", ""))
    require(RUN_ID.fullmatch(run_id) is not None and value.get("featureKey") == "admin.sources" and value.get("status") == "passed" and value.get("failure") is None, "Admin Sources browser acceptance did not pass")
    require(UTC.fullmatch(str(value.get("startedAt", ""))) is not None and UTC.fullmatch(str(value.get("completedAt", ""))) is not None, "Admin Sources browser timestamps are invalid")
    browser = value.get("browser")
    require(isinstance(browser, Mapping) and set(browser) == {"platform", "userAgent"} and "HeadlessChrome/" in str(browser.get("userAgent", "")), "real Headless Chrome identity is missing")
    operations = value.get("operations")
    require(isinstance(operations, Mapping) and set(operations) == OPERATIONS and all(item is True for item in operations.values()), "Admin Sources browser operations are incomplete")
    require(value.get("console") == {"errorCount": 0}, "Admin Sources browser console was not clean")

    planes = value.get("dataPlanes")
    require(isinstance(planes, Mapping) and set(planes) == {"state", "ecosystems"} and planes.get("state") == "ready", "Admin Sources data-plane state drifted")
    ecosystems = planes.get("ecosystems")
    require(isinstance(ecosystems, Mapping) and set(ecosystems) == {"pip", "npm", "apt"}, "Admin Sources data-plane ecosystems drifted")
    for key, item in ecosystems.items():
        require(isinstance(item, Mapping) and set(item) == {"requests", "cacheHits", "upstreamFetches", "upstreamBytes"}
                and all(isinstance(item[field], int) and not isinstance(item[field], bool) for field in item)
                and item["requests"] > 0 and item["cacheHits"] > 0 and item["upstreamFetches"] >= 0 and item["upstreamBytes"] >= 0,
                f"Admin Sources {key} live counters are invalid")
    configuration = value.get("configuration")
    require(configuration == {"sourceCount": 4, "policyCount": 3, "ecosystems": ["apt", "npm", "pip"], "protectedCredentialReferences": 1, "restoredSourceKey": "pip.acceptance.cache", "restoredEnabled": True}, "Admin Sources durable configuration facts drifted")
    media = value.get("offlineMedia")
    require(isinstance(media, Mapping) and set(media) == {"count", "verifiedMediaId", "verifiedState", "pendingFailureMedia", "corruptDeniedStatus", "wrongArchitectureDeniedStatus"}
            and media.get("count") == 3 and re.fullmatch(r"[0-9a-f-]{36}", str(media.get("verifiedMediaId", ""))) is not None
            and media.get("verifiedState") == "approved-ready-healthy" and media.get("pendingFailureMedia") == 2
            and media.get("corruptDeniedStatus") == 409 and media.get("wrongArchitectureDeniedStatus") == 409, "Admin Sources signed media facts drifted")
    require(value.get("source") == {"runnerDigest": digest(RUNNER.read_bytes()), "commonDigest": digest(COMMON.read_bytes())}, "Admin Sources browser source binding drifted")
    require(value.get("privacy") == {"credentialsRetained": False, "userContentRetained": False, "commandOutputRetained": False, "syntheticContentOnly": True}, "Admin Sources browser privacy boundary drifted")
    require(value.get("limitations") == {"trustedHttps": "not_satisfied_by_self_signed_component_origin", "independentHumanAcceptance": "not_performed", "physicalOfflineMedia": "containerized_signed_media_fixture_only"}, "Admin Sources browser limitations drifted")

    screenshots = value.get("screenshots")
    require(isinstance(screenshots, list) and [item.get("key") for item in screenshots] == ["owner-pip-zh-dark", "owner-npm-en-light", "owner-mobile-en-light", "member-denied-mobile-en-light"], "Admin Sources screenshot matrix drifted")
    for item in screenshots:
        require(isinstance(item, Mapping) and set(item) == {"key", "path", "digest"}, "Admin Sources screenshot fields drifted")
        image = repository_file(item.get("path"), "Admin Sources screenshot")
        image_bytes = image.read_bytes()
        require(image.suffix == ".png" and image_bytes.startswith(b"\x89PNG\r\n\x1a\n") and item.get("digest") == digest(image_bytes), "Admin Sources screenshot digest changed")

    binding = value.get("deployment")
    require(isinstance(binding, Mapping) and set(binding) == {"evidencePath", "evidenceDigest", "runId", "webImageId", "platformApiImageId", "postgresImageId", "sandboxImageId"}, "Admin Sources deployment binding drifted")
    deployment_path = repository_file(binding.get("evidencePath"), "Admin Sources deployment evidence")
    deployment_bytes = deployment_path.read_bytes()
    require(binding.get("evidenceDigest") == digest(deployment_bytes), "Admin Sources deployment digest changed")
    deployment = json.loads(deployment_bytes)
    identity = re.fullmatch(r"[a-z0-9-]+-(20[0-9]{6})-(a[1-9][0-9]*)", str(binding.get("runId", "")))
    require(identity is not None and deployment.get("runId") == binding.get("runId") and deployment.get("featureKey") == "admin.sources", "Admin Sources deployment identity drifted")
    plan = json.loads((ROOT / "deploy/application-catalog-e2e" / f"plan-{identity.group(1)}-{identity.group(2)}.json").read_text(encoding="utf-8"))
    validate_deployment(deployment, plan)
    require(value.get("origin", "").rstrip("/") == plan["environment"]["TEAMAIBOX_CATALOG_PUBLIC_ORIGIN"], "Admin Sources browser origin differs from deployment")
    images = {item["component"]: item["imageId"] for item in deployment["imageBindings"]}
    keys = {"webImageId": "catalog-web", "platformApiImageId": "catalog-platform-api", "postgresImageId": "catalog-postgres", "sandboxImageId": "agent-sandbox"}
    require(all(binding.get(key) == images.get(component) and SHA256.fullmatch(str(binding.get(key, ""))) is not None for key, component in keys.items()), "Admin Sources deployed image binding drifted")
    health_keys = {item.get("key") for item in plan.get("healthChecks", [])}
    retained_keys = {item.get("key") for item in plan.get("retainedStateChecks", [])}
    require({"admin-sources-native-clients-online", "admin-sources-native-clients-offline-cache", "admin-sources-failure-matrix", "admin-sources-offline-media-detached-state", "admin-sources-offline-media-reapproval"}.issubset(health_keys)
            and {"admin-sources-post-restart-failure-classification", "admin-sources-retained-native-cache", "admin-sources-post-restart", "admin-sources-durable-state"}.issubset(retained_keys), "Admin Sources native client, failure, media, or restart proof is absent")
    serialized = json.dumps(value, sort_keys=True)
    require("BEGIN PRIVATE KEY" not in serialized and "password" not in serialized.lower(), "Admin Sources browser evidence retained protected material")
    without_digest = dict(value); claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "Admin Sources browser canonical digest drifted")
    return {"valid": True, "runId": run_id, "status": value["status"], "deploymentRunId": binding["runId"], "operationCount": len(OPERATIONS), "screenshotCount": len(screenshots), "sourceCount": configuration["sourceCount"], "policyCount": configuration["policyCount"]}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--evidence", type=Path, required=True); args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":"))); return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Admin Sources browser evidence invalid: {error}"); raise SystemExit(1)
