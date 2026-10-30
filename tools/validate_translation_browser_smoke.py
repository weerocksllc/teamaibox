#!/usr/bin/env python3
"""Strictly validate one exact Translation real-browser component smoke evidence file."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools" / "run_translation_browser_smoke.mjs"
AUDIO = ROOT / "deploy" / "application-catalog-e2e" / "asr-short-validation.wav"
TOP_KEYS = {"schemaVersion", "runnerId", "runId", "featureKey", "status", "classification",
            "releaseEvidenceEligible", "origin", "startedAt", "completedAt", "browser", "journeys",
            "console", "source", "deployment", "privacy", "limitations", "failure", "evidenceDigest"}

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))
from tools.validate_feature_arm64_deployment_evidence import validate_deployment


class TranslationBrowserEvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise TranslationBrowserEvidenceError(message)


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def repository_path(value: Any, label: str) -> Path:
    require(isinstance(value, str) and value, f"{label} is missing")
    path = (ROOT / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    require(path != ROOT and ROOT in path.parents, f"{label} escapes the repository")
    return path


def validate_screenshot(value: Any, label: str, seen: set[Path]) -> None:
    require(isinstance(value, Mapping) and set(value) == {"path", "digest"}, f"{label} screenshot binding drifted")
    path = repository_path(value["path"], f"{label} screenshot")
    content = path.read_bytes()
    require(path.suffix == ".png" and content.startswith(b"\x89PNG\r\n\x1a\n")
            and value["digest"] == digest(content) and path not in seen, f"{label} screenshot changed or is invalid")
    seen.add(path)


def validate(evidence_path: Path) -> Mapping[str, Any]:
    evidence_path = evidence_path.resolve()
    require(evidence_path.is_file() and ROOT in evidence_path.parents, "Translation browser evidence is missing or unscoped")
    value = json.loads(evidence_path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_KEYS, "Translation browser evidence fields drifted")
    require(value["schemaVersion"] == 1 and value["runnerId"] == "teamaibox.translation-browser-smoke.v1",
            "Translation browser evidence identity drifted")
    require(re.fullmatch(r"translation-browser-20[0-9]{6}-[a-z0-9][a-z0-9-]{1,63}", str(value["runId"])) is not None,
            "Translation browser run identity is invalid")
    require(value["featureKey"] == "official.translation" and value["status"] == "passed" and value["failure"] is None,
            "Translation browser smoke did not pass")
    require(value["classification"] == "component-canary-self-signed-https" and value["releaseEvidenceEligible"] is False,
            "Translation browser evidence overstated release eligibility")
    require(str(value["origin"]).startswith("https://") and str(value["origin"]).endswith("/"), "Translation browser origin is not HTTPS")
    require(value["console"] == {"errorCount": 0}, "Translation browser console was not clean")
    require(value["privacy"] == {"credentialsRetained": False, "userContentRetained": False,
            "syntheticScreenshotsRetained": True, "commandOutputRetained": False, "syntheticContentOnly": True},
            "Translation browser privacy boundary drifted")
    require(value["limitations"] == {"trustedHttps": "human-infrastructure-gate", "videoTranslation": "not-deployed",
            "translationModelCertification": "experimental"}, "Translation limitations were hidden or changed")
    browser = value["browser"]
    require(isinstance(browser, Mapping) and set(browser) == {"platform", "userAgent"}
            and "HeadlessChrome/" in str(browser["userAgent"]), "real Chrome identity is missing")
    source = value["source"]
    require(isinstance(source, Mapping) and set(source) == {"runnerDigest", "pdfFixtureDigest", "audioFixtureDigest"},
            "Translation browser source binding drifted")
    require(source["runnerDigest"] == digest(RUNNER.read_bytes()) and source["audioFixtureDigest"] == digest(AUDIO.read_bytes())
            and re.fullmatch(r"sha256:[0-9a-f]{64}", str(source["pdfFixtureDigest"])) is not None,
            "Translation runner or fixture binding changed")

    binding = value["deployment"]
    require(isinstance(binding, Mapping) and set(binding) == {"evidencePath", "evidenceDigest", "runId", "webImageId",
            "translationImageId", "ocrImageId", "asrImageId"}, "Translation deployment binding drifted")
    deployment_path = repository_path(binding["evidencePath"], "Translation deployment evidence")
    deployment_bytes = deployment_path.read_bytes()
    require(binding["evidenceDigest"] == digest(deployment_bytes), "Translation deployment evidence changed")
    deployment = json.loads(deployment_bytes)
    identity = re.fullmatch(r"[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})", str(binding["runId"]))
    require(identity is not None, "Translation deployment identity is invalid")
    plan_path = ROOT / "deploy" / "application-catalog-e2e" / f"plan-{identity.group(1)}-{identity.group(2)}.json"
    require(plan_path.is_file(), "Translation deployment plan is missing")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    validate_deployment(deployment, plan)
    require(deployment["runId"] == binding["runId"], "Translation deployment run drifted")
    images = {item["component"]: item["imageId"] for item in deployment["imageBindings"]}
    images.setdefault("catalog-web", plan["environment"].get("TEAMAIBOX_CATALOG_WEB_IMAGE"))
    images.setdefault("catalog-translation", plan["environment"].get("TEAMAIBOX_CATALOG_TRANSLATION_IMAGE"))
    images.setdefault("catalog-ocr", plan["environment"].get("TEAMAIBOX_CATALOG_OCR_IMAGE"))
    images.setdefault("catalog-asr", plan["environment"].get("TEAMAIBOX_CATALOG_ASR_IMAGE"))
    expected = {"catalog-web": binding["webImageId"], "catalog-translation": binding["translationImageId"],
                "catalog-ocr": binding["ocrImageId"], "catalog-asr": binding["asrImageId"]}
    require(all(images.get(component) == image_id for component, image_id in expected.items()),
            "Translation browser evidence is bound to different images")
    require({"translation-plugin", "ocr-plugin", "asr-plugin"}.issubset(set(plan["featureServices"])),
            "Translation composition services are absent from the deployment")

    journeys = value["journeys"]
    require(isinstance(journeys, list) and [item.get("key") for item in journeys]
            == ["owner-text", "member-direct-composition", "member-cross-app-handoff"],
            "Translation browser journey coverage is incomplete")
    text, direct, handoff = journeys
    require(set(text) == {"key", "account", "role", "launchable", "experimentalBadge", "completed", "alignedSegments",
            "exported", "reloadRetained", "screenshot"} and text["account"] == "owner" and text["role"] == "owner"
            and all(text[key] is True for key in ("launchable", "experimentalBadge", "completed", "exported", "reloadRetained"))
            and text["alignedSegments"] >= 1, "Translation owner text journey is incomplete")
    require(set(direct) == {"key", "account", "role", "document", "audio", "screenshot"}
            and direct["account"] == "ordinary-user" and direct["role"] == "member", "Translation direct composition identity drifted")
    require(direct["document"] == {"completed": True, "stages": 2, "intermediateVisible": True},
            "Translation document OCR composition is incomplete")
    require(direct["audio"].get("completed") is True and direct["audio"].get("stages") == 3
            and direct["audio"].get("subtitleSegments", 0) >= 1 and direct["audio"].get("intermediateVisible") is True,
            "Translation audio ASR/subtitle composition is incomplete")
    require(set(handoff) == {"key", "account", "role", "ocr", "asr", "screenshot"}
            and handoff["account"] == "ordinary-user" and handoff["role"] == "member", "Translation handoff identity drifted")
    require(handoff["ocr"] == {"sourceCompleted": True, "routeChanged": True, "scopedReferenceAccepted": True,
            "extractionReused": True, "translated": True}, "OCR-to-Translation browser handoff is incomplete")
    require(handoff["asr"].get("sourceCompleted") is True and handoff["asr"].get("routeChanged") is True
            and handoff["asr"].get("scopedReferenceAccepted") is True and handoff["asr"].get("transcriptionReused") is True
            and handoff["asr"].get("translated") is True and handoff["asr"].get("subtitleSegments", 0) >= 1,
            "ASR-to-Translation browser handoff is incomplete")
    screenshots: set[Path] = set()
    validate_screenshot(text["screenshot"], "owner text", screenshots)
    validate_screenshot(direct["screenshot"], "member direct composition", screenshots)
    validate_screenshot(handoff["screenshot"], "member handoff", screenshots)
    without_digest = dict(value); claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "Translation browser evidence canonical digest changed")
    return {"valid": True, "runId": value["runId"], "status": value["status"], "journeyCount": len(journeys),
            "screenshotCount": len(screenshots), "releaseEvidenceEligible": False,
            "deploymentRunId": deployment["runId"]}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (TranslationBrowserEvidenceError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Translation browser evidence invalid: {error}")
        raise SystemExit(1)
