#!/usr/bin/env python3
"""Strictly validate one exact Drawing and OCR real-browser smoke evidence file."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools" / "run_drawing_ocr_browser_smoke.mjs"
TOP_KEYS = {
    "schemaVersion", "runnerId", "runId", "featureKeys", "status", "classification",
    "releaseEvidenceEligible", "origin", "startedAt", "completedAt", "browser", "journeys",
    "console", "source", "deployment", "privacy", "limitations", "failure", "evidenceDigest",
}
RUN_ID = re.compile(r"drawing-ocr-browser-20[0-9]{6}-[a-z0-9][a-z0-9-]{1,63}")

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))
from tools.validate_feature_arm64_deployment_evidence import validate_deployment


class DrawingOcrBrowserEvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DrawingOcrBrowserEvidenceError(message)


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def repository_path(value: Any, label: str) -> Path:
    require(isinstance(value, str) and value, f"{label} is missing")
    path = (ROOT / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    require(path != ROOT and ROOT in path.parents, f"{label} escapes the repository")
    return path


def screenshot(binding: Any, label: str, seen: set[Path]) -> None:
    require(isinstance(binding, Mapping) and set(binding) == {"path", "digest"}, f"{label} screenshot binding drifted")
    path = repository_path(binding["path"], f"{label} screenshot")
    content = path.read_bytes()
    require(path.suffix == ".png" and content.startswith(b"\x89PNG\r\n\x1a\n"), f"{label} screenshot is not PNG")
    require(binding["digest"] == digest(content) and path not in seen, f"{label} screenshot changed or was reused")
    seen.add(path)


def validate(evidence_path: Path) -> Mapping[str, Any]:
    evidence_path = evidence_path.resolve()
    require(evidence_path.is_file() and ROOT in evidence_path.parents, "Drawing/OCR browser evidence is missing or unscoped")
    value = json.loads(evidence_path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == TOP_KEYS, "Drawing/OCR browser evidence fields drifted")
    require(value["schemaVersion"] == 1 and value["runnerId"] == "teamaibox.drawing-ocr-browser-smoke.v1", "Drawing/OCR browser evidence identity drifted")
    require(isinstance(value["runId"], str) and RUN_ID.fullmatch(value["runId"]) is not None, "Drawing/OCR run identity is invalid")
    require(value["featureKeys"] == ["official.drawing", "official.ocr"], "Drawing/OCR feature binding drifted")
    require(value["status"] == "passed" and value["failure"] is None, "Drawing/OCR browser smoke did not pass")
    require(value["classification"] == "component-canary-self-signed-https" and value["releaseEvidenceEligible"] is False,
            "Drawing/OCR evidence overstated release eligibility")
    require(isinstance(value["origin"], str) and value["origin"].startswith("https://") and value["origin"].endswith("/"),
            "Drawing/OCR browser origin is not HTTPS")
    require(value["console"] == {"errorCount": 0}, "Drawing/OCR browser console was not clean")
    require(value["privacy"] == {
        "credentialsRetained": False, "userContentRetained": False, "syntheticScreenshotsRetained": True,
        "commandOutputRetained": False, "syntheticContentOnly": True,
    }, "Drawing/OCR browser privacy boundary drifted")
    require(value["limitations"] == {"translationHandoff": "not_exercised_in_this_runner"},
            "OCR translation runner boundary was hidden or changed")

    browser = value["browser"]
    require(isinstance(browser, Mapping) and set(browser) == {"platform", "userAgent"}
            and "HeadlessChrome/" in str(browser["userAgent"]), "real Chrome identity is missing")
    source = value["source"]
    require(isinstance(source, Mapping) and set(source) == {"runnerDigest", "ocrFixtureDigest"}, "Drawing/OCR source binding drifted")
    require(source["runnerDigest"] == digest(RUNNER.read_bytes()), "Drawing/OCR browser runner changed")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", str(source["ocrFixtureDigest"])) is not None, "OCR fixture digest is invalid")

    binding = value["deployment"]
    require(isinstance(binding, Mapping) and set(binding) == {
        "evidencePath", "evidenceDigest", "runId", "webImageId", "drawingImageId", "ocrImageId",
    }, "Drawing/OCR deployment binding drifted")
    deployment_path = repository_path(binding["evidencePath"], "Drawing/OCR deployment evidence")
    deployment_bytes = deployment_path.read_bytes()
    require(binding["evidenceDigest"] == digest(deployment_bytes), "Drawing/OCR deployment evidence changed")
    deployment = json.loads(deployment_bytes)
    identity = re.fullmatch(r"[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})", str(binding["runId"]))
    require(identity is not None, "Drawing/OCR bound deployment identity is invalid")
    plan_path = ROOT / "deploy" / "application-catalog-e2e" / f"plan-{identity.group(1)}-{identity.group(2)}.json"
    require(plan_path.is_file(), "Drawing/OCR bound deployment plan is missing")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    validate_deployment(deployment, plan)
    require(deployment["runId"] == binding["runId"], "Drawing/OCR deployment identity drifted")
    required_images = {
        "catalog-web": binding["webImageId"], "catalog-drawing": binding["drawingImageId"], "catalog-ocr": binding["ocrImageId"],
    }
    actual = {item["component"]: item["imageId"] for item in deployment["imageBindings"]}
    actual.setdefault("catalog-web", plan["environment"].get("TEAMAIBOX_CATALOG_WEB_IMAGE"))
    actual.setdefault("catalog-drawing", plan["environment"].get("TEAMAIBOX_CATALOG_DRAWING_IMAGE"))
    actual.setdefault("catalog-ocr", plan["environment"].get("TEAMAIBOX_CATALOG_OCR_IMAGE"))
    require(all(actual.get(component) == image_id for component, image_id in required_images.items()),
            "Drawing/OCR browser evidence is bound to different images")
    require({"drawing-plugin", "ocr-plugin"}.issubset(set(plan["featureServices"])), "Drawing/OCR services are absent from the deployment")

    journeys = value["journeys"]
    require(isinstance(journeys, list) and [item.get("key") for item in journeys] == ["drawing-owner", "ocr-ordinary-user"],
            "Drawing/OCR browser journey coverage is incomplete")
    drawing, ocr = journeys
    drawing_fields = {"key", "account", "role", "launchable", "experimentalBadge", "generationCompleted", "editCompleted",
                      "exportDownloaded", "reloadRetained", "metadataFieldCount", "screenshot"}
    require(set(drawing) == drawing_fields and drawing["account"] == "owner" and drawing["role"] == "owner",
            "Drawing owner journey identity drifted")
    require(all(drawing[key] is True for key in ("launchable", "experimentalBadge", "generationCompleted", "editCompleted",
                                                  "exportDownloaded", "reloadRetained")) and drawing["metadataFieldCount"] >= 7,
            "Drawing generation/edit/export/reload journey is incomplete")
    ocr_fields = {"key", "account", "role", "launchable", "experimentalBadge", "fileSelected", "recognitionCompleted",
                  "layoutBlockCount", "correctionApplied", "exportDownloaded", "reloadRetained", "translationHandoffCompleted", "screenshot"}
    require(set(ocr) == ocr_fields and ocr["account"] == "ordinary-user" and ocr["role"] == "member",
            "OCR ordinary-user journey identity drifted")
    require(all(ocr[key] is True for key in ("launchable", "experimentalBadge", "fileSelected", "recognitionCompleted",
                                              "correctionApplied", "exportDownloaded", "reloadRetained"))
            and ocr["layoutBlockCount"] >= 2 and ocr["translationHandoffCompleted"] is False,
            "OCR recognition/correction/export/reload journey is incomplete or translation was overstated")
    screenshots: set[Path] = set()
    screenshot(drawing["screenshot"], "Drawing", screenshots)
    screenshot(ocr["screenshot"], "OCR", screenshots)
    without_digest = dict(value)
    claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "Drawing/OCR browser evidence canonical digest changed")
    return {"valid": True, "runId": value["runId"], "status": value["status"], "journeyCount": len(journeys),
            "screenshotCount": len(screenshots), "releaseEvidenceEligible": False,
            "translationHandoff": value["limitations"]["translationHandoff"],
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
    except (DrawingOcrBrowserEvidenceError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Drawing/OCR browser evidence invalid: {error}")
        raise SystemExit(1)
