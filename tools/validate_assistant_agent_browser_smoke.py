#!/usr/bin/env python3
"""Strictly validate one exact complete Assistant real-browser evidence record."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools" / "run_assistant_agent_browser_smoke.mjs"
TOP_KEYS = {
    "schemaVersion", "runnerId", "runId", "featureKey", "scope", "status", "origin",
    "startedAt", "completedAt", "browser", "journeys", "console", "credentialRotation", "source",
    "deployment", "privacy", "failure", "evidenceDigest",
}
JOURNEY_KEYS = {
    "key", "role", "launchable", "newConversationCreated", "realtimeConnected",
    "agentModeSelected", "realAgentCompleted", "responseNonEmpty", "routingVisible",
    "usageVisible", "completedToolVisible", "confirmationApprovedExactlyOnce",
    "protectedInputUploaded", "sourceCitationVisible", "sourceCitationDownloaded",
    "protectedAgentArtifactVisible", "protectedAgentArtifactDownloaded",
    "actionableUnavailableVisible", "unavailableErrorCodeVisible",
    "persistedAfterReload", "approvedConfirmationRetained", "ownershipDenied",
    "eventOwnershipDenied", "screenshot",
}

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.validate_feature_arm64_deployment_evidence import validate_deployment


class AssistantAgentBrowserEvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssistantAgentBrowserEvidenceError(message)


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def repository_path(value: Any, label: str) -> Path:
    require(isinstance(value, str) and value, f"{label} is missing")
    path = (ROOT / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    require(path != ROOT and ROOT in path.parents, f"{label} escapes the repository")
    return path


def validate(evidence_path: Path) -> Mapping[str, Any]:
    evidence_path = evidence_path.resolve()
    require(evidence_path.is_file() and ROOT in evidence_path.parents, "Assistant Agent browser evidence is missing or unscoped")
    value = json.loads(evidence_path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_KEYS, "Assistant Agent browser evidence fields drifted")
    require(
        value["schemaVersion"] == 1 and value["runnerId"] == "teamaibox.assistant-agent-browser-smoke.v1",
        "Assistant Agent browser evidence identity drifted",
    )
    require(
        value["featureKey"] == "official.assistant" and value["scope"] == "agent-mode-product-ui",
        "Assistant Agent browser scope drifted",
    )
    require(value["status"] == "passed" and value["failure"] is None, "Assistant Agent browser smoke did not pass")
    require(value["origin"].startswith("https://") and value["origin"].endswith("/"), "Assistant Agent browser origin is not HTTPS")
    require(value["console"] == {"errorCount": 0}, "Assistant Agent browser console was not clean")
    require(value["privacy"] == {
        "credentialsRetained": False,
        "promptContentRetained": False,
        "modelOutputRetained": False,
        "commandOutputRetained": False,
        "syntheticContentOnly": True,
    }, "Assistant Agent browser privacy boundary drifted")

    browser = value["browser"]
    require(
        isinstance(browser, Mapping) and set(browser) == {"platform", "userAgent"}
        and isinstance(browser["userAgent"], str) and "HeadlessChrome/" in browser["userAgent"],
        "real Chrome identity is missing",
    )
    source = value["source"]
    require(isinstance(source, Mapping) and set(source) == {"runnerDigest"}, "Assistant Agent browser source binding drifted")
    require(source["runnerDigest"] == digest(RUNNER.read_bytes()), "Assistant Agent browser runner changed after evidence capture")

    deployment_binding = value["deployment"]
    require(
        isinstance(deployment_binding, Mapping)
        and set(deployment_binding) == {"evidencePath", "evidenceDigest", "runId", "webImageId"},
        "Assistant Agent deployment binding drifted",
    )
    deployment_path = repository_path(deployment_binding["evidencePath"], "Assistant Agent deployment evidence")
    deployment_bytes = deployment_path.read_bytes()
    require(deployment_binding["evidenceDigest"] == digest(deployment_bytes), "Assistant Agent deployment evidence digest changed")
    deployment = json.loads(deployment_bytes)
    deployment_identity = re.fullmatch(r"[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})", deployment_binding["runId"])
    require(deployment_identity is not None, "Assistant Agent bound deployment run identity is invalid")
    plan_path = ROOT / "deploy" / "application-catalog-e2e" / f"plan-{deployment_identity.group(1)}-{deployment_identity.group(2)}.json"
    require(plan_path.is_file(), "Assistant Agent bound deployment plan is missing")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    validate_deployment(deployment, plan)
    require(
        deployment["runId"] == deployment_binding["runId"],
        "Assistant Agent deployment identity drifted",
    )
    require(value["origin"] == plan["environment"]["TEAMAIBOX_CATALOG_PUBLIC_ORIGIN"] + "/", "Assistant Agent browser origin does not match its deployment plan")
    require(all(service in plan["featureServices"] for service in ("agent-owner-sandbox", "agent-member-sandbox", "agent-bridge-owner", "agent-bridge-member")), "Assistant Agent services are absent from the bound deployment")
    web = next((item for item in deployment["imageBindings"] if item["component"] == "catalog-web"), None)
    expected_web_image = web["imageId"] if web is not None else plan["environment"].get("TEAMAIBOX_CATALOG_WEB_IMAGE")
    require(isinstance(expected_web_image, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", expected_web_image) is not None
            and expected_web_image == deployment_binding["webImageId"], "Assistant Agent web image binding drifted")
    rotation = value["credentialRotation"]
    require(isinstance(rotation, Mapping) and set(rotation) == {
        "ttlSeconds", "deploymentCompletedAt", "notBefore", "observedAt", "crossedBeforeBrowser",
    }, "Assistant Agent credential-rotation evidence drifted")
    completed_at = datetime.fromisoformat(deployment["completedAt"].replace("Z", "+00:00"))
    not_before = datetime.fromisoformat(rotation["notBefore"].replace("Z", "+00:00"))
    observed_at = datetime.fromisoformat(rotation["observedAt"].replace("Z", "+00:00"))
    require(
        rotation["ttlSeconds"] == 300
        and rotation["deploymentCompletedAt"] == deployment["completedAt"]
        and not_before == completed_at + timedelta(seconds=300)
        and rotation["observedAt"] == value["startedAt"]
        and observed_at >= not_before
        and rotation["crossedBeforeBrowser"] is True,
        "Assistant Agent browser did not cross the original model-credential lifetime",
    )

    journeys = value["journeys"]
    require(
        isinstance(journeys, list) and [item.get("key") for item in journeys] == ["owner", "ordinary-user"],
        "Assistant Agent owner/member browser coverage is incomplete",
    )
    owner, member = journeys
    for item, role in zip(journeys, ("owner", "member")):
        require(set(item) == JOURNEY_KEYS and item["role"] == role, f"{item.get('key')} Agent journey drifted")
        for key in (
            "launchable", "newConversationCreated", "realtimeConnected", "agentModeSelected",
            "realAgentCompleted", "responseNonEmpty", "routingVisible", "usageVisible",
            "completedToolVisible", "confirmationApprovedExactlyOnce", "persistedAfterReload",
            "approvedConfirmationRetained", "protectedInputUploaded", "sourceCitationVisible",
            "sourceCitationDownloaded", "protectedAgentArtifactVisible", "protectedAgentArtifactDownloaded",
        ):
            require(item[key] is True, f"{item.get('key')} Agent browser gate failed: {key}")
    require(owner["ownershipDenied"] is None and owner["eventOwnershipDenied"] is None, "owner isolation facts drifted")
    require(owner["actionableUnavailableVisible"] is True and owner["unavailableErrorCodeVisible"] is True,
            "owner actionable unavailable UI evidence is incomplete")
    require(member["ownershipDenied"] is True and member["eventOwnershipDenied"] is True, "ordinary-user ownership boundary is incomplete")
    require(member["actionableUnavailableVisible"] is None and member["unavailableErrorCodeVisible"] is None,
            "ordinary-user unavailable-state facts drifted")

    screenshot_paths: set[Path] = set()
    for item in journeys:
        screenshot = item["screenshot"]
        require(isinstance(screenshot, Mapping) and set(screenshot) == {"path", "digest"}, "Assistant Agent screenshot binding drifted")
        screenshot_path = repository_path(screenshot["path"], "Assistant Agent screenshot")
        screenshot_bytes = screenshot_path.read_bytes()
        require(
            screenshot_path.suffix == ".png" and screenshot_bytes.startswith(b"\x89PNG\r\n\x1a\n"),
            "Assistant Agent screenshot format is invalid",
        )
        require(
            screenshot["digest"] == digest(screenshot_bytes) and screenshot_path not in screenshot_paths,
            "Assistant Agent screenshot digest or uniqueness drifted",
        )
        screenshot_paths.add(screenshot_path)

    without_digest = dict(value)
    claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "Assistant Agent browser evidence canonical digest changed")
    return {
        "valid": True,
        "runId": value["runId"],
        "status": value["status"],
        "scope": value["scope"],
        "journeyCount": len(journeys),
        "screenshotCount": len(screenshot_paths),
        "deploymentRunId": deployment["runId"],
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
    except (AssistantAgentBrowserEvidenceError, json.JSONDecodeError, OSError) as error:
        print(f"Assistant Agent browser evidence invalid: {error}")
        raise SystemExit(1)
