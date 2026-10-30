#!/usr/bin/env python3
"""Strictly validate one exact real-browser feature acceptance run."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "architecture/validation/feature-browser-acceptance-runner.v1.json"
CATALOG = ROOT / "architecture/validation/feature-acceptance-catalog.v1.json"
RUNNER = ROOT / "tools/run_feature_browser_acceptance.mjs"
HISTORICAL = ROOT / "architecture/validation/historical-feature-browser-digests.v1.json"
TOP_KEYS = {
    "schemaVersion", "runnerId", "runId", "featureKey", "status",
    "releaseEvidenceEligible", "classification", "origin", "startedAt",
    "completedAt", "browser", "matrix", "journeys", "operations",
    "privacy", "source", "failure", "evidenceDigest",
}
MATRIX_KEYS = {
    "combination", "account", "role", "viewport", "width", "scrollWidth", "contentWidth",
    "localeControlWidth", "themeControlWidth", "uploadControlWidth", "locale",
    "theme", "screenshot", "result",
}

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.validate_feature_arm64_deployment_evidence import accepted_catalog_digests, validate_deployment


class BrowserEvidenceError(RuntimeError):
    """Raised when browser evidence is missing, stale, or inconsistent."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BrowserEvidenceError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def accepted_browser_digests(key: str, current: Path) -> set[str]:
    value = load_json(HISTORICAL)
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.feature-browser-acceptance.v1",
            "historical browser digest registry drifted")
    entries = value.get(key)
    require(isinstance(entries, list), "historical browser digest entries are invalid")
    result = {digest_bytes(current.read_bytes())}
    for item in entries:
        require(isinstance(item, Mapping) and set(item) == {"digest", "retiredAt", "reason"}
                and isinstance(item.get("digest"), str) and len(item["digest"]) == 71
                and isinstance(item.get("retiredAt"), str) and item["retiredAt"].endswith("Z")
                and isinstance(item.get("reason"), str) and len(item["reason"]) >= 80,
                "historical browser digest entry is invalid")
        require(item["digest"] not in result, "historical browser digest is duplicated or still current")
        result.add(item["digest"])
    return result


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def repository_path(value: str, label: str) -> Path:
    require(isinstance(value, str) and value, f"{label} is missing")
    path = (ROOT / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    require(path != ROOT and ROOT in path.parents, f"{label} escapes the repository")
    return path


def timestamp(value: Any, label: str) -> datetime:
    require(isinstance(value, str) and value.endswith("Z"), f"{label} is not UTC")
    try:
        return datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise BrowserEvidenceError(f"{label} is invalid") from error


def validate_browser_evidence(
    evidence_path: Path,
    plan_path: Path,
) -> Mapping[str, Any]:
    evidence_path = evidence_path.resolve()
    plan_path = plan_path.resolve()
    require(evidence_path.is_file(), "browser evidence is missing")
    require(plan_path.is_file(), "browser plan is missing")
    require(ROOT in evidence_path.parents and ROOT in plan_path.parents, "browser evidence inputs escape the repository")

    evidence = load_json(evidence_path)
    plan = load_json(plan_path)
    policy = load_json(POLICY)
    catalog = load_json(CATALOG)
    require(isinstance(evidence, Mapping) and set(evidence) == TOP_KEYS, "browser evidence fields drifted")
    require(evidence["schemaVersion"] == 1 and evidence["runnerId"] == policy["runnerId"], "browser evidence identity drifted")
    require(evidence["runId"] == plan["runId"] and evidence["featureKey"] == plan["featureKey"], "browser evidence is bound to a different plan")
    require(any(item.get("key") == evidence["featureKey"] for item in catalog["features"]), "browser evidence feature is unknown")
    require(evidence["status"] == "passed" and evidence["failure"] is None, "browser evidence did not pass")
    require(evidence["origin"] == plan["origin"] and evidence["classification"] == plan["classification"], "browser origin or classification drifted")
    require(evidence["releaseEvidenceEligible"] is plan["releaseEvidenceEligible"], "browser release eligibility drifted")
    require(evidence["releaseEvidenceEligible"] is (evidence["classification"] == "supported-appliance-authenticated-https"), "browser release eligibility is dishonest")
    require(timestamp(evidence["completedAt"], "completedAt") >= timestamp(evidence["startedAt"], "startedAt"), "browser evidence elapsed time is invalid")
    require(evidence["privacy"] == policy["artifactPolicy"] == plan["privacy"], "browser privacy declaration drifted")
    browser = evidence["browser"]
    require(isinstance(browser, Mapping) and set(browser) == {"platform", "userAgent"}, "browser identity shape drifted")
    require(all(isinstance(browser[key], str) and browser[key] for key in browser), "browser identity values are invalid")

    source = evidence["source"]
    require(isinstance(source, Mapping) and set(source) == {
        "planDigest", "policyDigest", "catalogDigest", "runnerDigest",
        "uploadDigest", "deploymentEvidenceDigest", "deploymentPlanDigest",
        "deploymentImageId", "deploymentRunId",
    }, "browser source binding drifted")
    require(source["planDigest"] == digest_bytes(canonical_bytes(plan)), "browser plan digest changed")
    require(source["policyDigest"] in accepted_browser_digests("retiredPolicyDigests", POLICY), "browser policy digest changed")
    require(source["catalogDigest"] in accepted_catalog_digests(), "browser feature catalog digest changed")
    require(source["runnerDigest"] in accepted_browser_digests("retiredRunnerDigests", RUNNER), "browser runner digest changed")
    upload = repository_path(plan["artifacts"]["uploadFixture"], "upload fixture")
    require(upload.is_file(), "browser upload fixture is missing")
    require(source["uploadDigest"] == plan["artifacts"]["uploadDigest"] == digest_bytes(upload.read_bytes()), "browser upload fixture digest changed")
    deployment_binding = plan["deployment"]
    require(isinstance(deployment_binding, Mapping) and set(deployment_binding) == {
        "evidenceDigest", "evidencePath", "imageId", "planDigest", "planPath", "runId",
    }, "browser deployment binding fields drifted")
    deployment_path = repository_path(deployment_binding["evidencePath"], "deployment evidence")
    deployment_plan_path = repository_path(deployment_binding["planPath"], "deployment plan")
    require(deployment_path.is_file() and deployment_plan_path.is_file(), "browser deployment binding is missing")
    deployment = load_json(deployment_path)
    deployment_plan = load_json(deployment_plan_path)
    validate_deployment(deployment, deployment_plan)
    require(deployment_binding["evidenceDigest"] == digest_bytes(deployment_path.read_bytes()), "browser deployment evidence digest changed")
    require(deployment_binding["planDigest"] == digest_bytes(canonical_bytes(deployment_plan)) == deployment["planDigest"], "browser deployment plan digest changed")
    require(deployment_binding["runId"] == deployment["runId"] and deployment["featureKey"] == evidence["featureKey"], "browser deployment identity drifted")
    require(any(item["imageId"] == deployment_binding["imageId"] for item in deployment["imageBindings"]), "browser deployment image identity drifted")
    require(source["deploymentEvidenceDigest"] == deployment_binding["evidenceDigest"] and source["deploymentPlanDigest"] == deployment_binding["planDigest"], "browser deployment digest source binding drifted")
    require(source["deploymentImageId"] == deployment_binding["imageId"] and source["deploymentRunId"] == deployment_binding["runId"], "browser deployment identity source binding drifted")

    expected: list[dict[str, Any]] = []
    viewports = {item["key"]: item for item in plan["matrix"]["viewports"]}
    for account in plan["accounts"]:
        for viewport in plan["matrix"]["viewports"]:
            for locale in plan["matrix"]["locales"]:
                for theme in plan["matrix"]["themes"]:
                    expected.append({
                        "combination": f"{account['key']}.{viewport['key']}.{locale}.{theme}",
                        "account": account["key"],
                        "role": account["role"],
                        "viewport": viewport["key"],
                        "width": viewport["width"],
                        "locale": locale,
                        "theme": theme,
                    })

    matrix = evidence["matrix"]
    require(isinstance(matrix, list) and len(matrix) == len(expected), "browser matrix coverage is incomplete")
    require([item.get("combination") for item in matrix] == [item["combination"] for item in expected], "browser matrix order or identity drifted")
    screenshot_directory = repository_path(plan["artifacts"]["screenshotDirectory"], "screenshot directory")
    screenshot_paths: set[Path] = set()
    for item, expectation in zip(matrix, expected):
        require(isinstance(item, Mapping) and set(item) == MATRIX_KEYS, f"browser matrix {expectation['combination']} fields drifted")
        for key, value in expectation.items():
            require(item[key] == value, f"browser matrix {expectation['combination']} {key} drifted")
        minimum_content_width = min(item["width"] - (28 if item["width"] <= 520 else 64), 836)
        controls_usable = item["localeControlWidth"] >= 110 and item["themeControlWidth"] >= 110 and item["uploadControlWidth"] >= min(240, item["contentWidth"] - 36)
        require(item["result"] == "passed" and item["width"] == viewports[item["viewport"]]["width"] and item["scrollWidth"] <= item["width"] and item["contentWidth"] >= minimum_content_width and controls_usable, f"browser matrix {expectation['combination']} failed, overflowed, collapsed, or has unusable controls")
        screenshot = item["screenshot"]
        require(isinstance(screenshot, Mapping) and set(screenshot) == {"path", "digest"}, f"browser screenshot {expectation['combination']} fields drifted")
        screenshot_path = repository_path(screenshot["path"], f"screenshot {expectation['combination']}")
        require(screenshot_path.parent == screenshot_directory and screenshot_path.stem == expectation["combination"], f"browser screenshot {expectation['combination']} path drifted")
        require(screenshot_path.is_file(), f"browser screenshot {expectation['combination']} is missing")
        screenshot_bytes = screenshot_path.read_bytes()
        valid_format = (
            screenshot_path.suffix == ".png" and screenshot_bytes.startswith(b"\x89PNG\r\n\x1a\n")
        ) or (
            screenshot_path.suffix == ".jpg" and screenshot_bytes.startswith(b"\xff\xd8\xff")
        )
        require(valid_format, f"browser screenshot {expectation['combination']} format or extension is invalid")
        require(screenshot["digest"] == digest_bytes(screenshot_bytes), f"browser screenshot {expectation['combination']} digest changed")
        require(screenshot_path not in screenshot_paths, f"browser screenshot {expectation['combination']} is duplicated")
        screenshot_paths.add(screenshot_path)
    require({item for item in screenshot_directory.iterdir() if item.is_file()} == screenshot_paths, "browser screenshot directory contains unbound files")

    expected_steps = ["navigate", *policy["requiredJourneySteps"]]
    journeys = evidence["journeys"]
    require(isinstance(journeys, list) and len(journeys) == len(expected), "browser journey coverage is incomplete")
    require([item.get("combination") for item in journeys] == [item["combination"] for item in expected], "browser journey identities drifted")
    for journey in journeys:
        require(set(journey) == {"combination", "steps"}, f"browser journey {journey.get('combination')} fields drifted")
        require(journey["steps"] == [{"step": step, "passed": True} for step in expected_steps], f"browser journey {journey['combination']} steps drifted")

    operations = evidence["operations"]
    require(operations == {
        "uploadCount": len(plan["accounts"]),
        "downloadCount": len(plan["accounts"]),
        "sseCount": len(expected),
        "websocketCount": len(expected),
    }, "browser operation counts drifted")
    without_digest = dict(evidence)
    claimed_digest = without_digest.pop("evidenceDigest")
    require(claimed_digest == digest_bytes(canonical_bytes(without_digest)), "browser evidence digest changed")
    return evidence


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args(argv)
    evidence = validate_browser_evidence(args.evidence, args.plan)
    print(json.dumps({
        "runId": evidence["runId"],
        "status": evidence["status"],
        "combinationCount": len(evidence["matrix"]),
        "screenshotCount": len(evidence["matrix"]),
    }, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BrowserEvidenceError, OSError, json.JSONDecodeError) as error:
        print(f"feature browser acceptance evidence invalid: {error}")
        raise SystemExit(1)
