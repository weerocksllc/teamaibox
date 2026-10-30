#!/usr/bin/env python3
"""Strictly validate one exact realtime ASR browser component smoke record."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools" / "run_realtime_asr_browser_smoke.mjs"
FIXTURE = ROOT / "deploy" / "application-catalog-e2e" / "asr-short-validation.wav"
TOP_KEYS = {
    "schemaVersion", "runnerId", "runId", "featureKey", "status", "classification",
    "releaseEvidenceEligible", "origin", "startedAt", "completedAt", "browser", "journeys",
    "console", "source", "deployment", "privacy", "failure", "evidenceDigest",
}
CURRENT_TOP_KEYS = TOP_KEYS | {"runtimeBinding"}
HISTORICAL_RUNNER_DIGESTS = {
    "sha256:d3ae8358a70f77fe8cdc25ad900d53723967efda858c507a531b27fa83af7650",
}
UTC = re.compile(r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))
from tools.validate_feature_arm64_deployment_evidence import validate_deployment


class RealtimeAsrBrowserEvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RealtimeAsrBrowserEvidenceError(message)


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
    require(evidence_path.is_file() and ROOT in evidence_path.parents, "realtime ASR browser evidence is missing or unscoped")
    value = json.loads(evidence_path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and frozenset(value) in {frozenset(TOP_KEYS), frozenset(CURRENT_TOP_KEYS)}, "realtime ASR browser evidence fields drifted")
    require(value["schemaVersion"] == 1 and value["runnerId"] == "teamaibox.realtime-asr-browser-smoke.v1", "realtime ASR browser evidence identity drifted")
    require(value["featureKey"] == "realtime.speech-websocket" and value["status"] == "passed" and value["failure"] is None, "realtime ASR browser smoke did not pass")
    require(value["classification"] == "component-canary-self-signed-https" and value["releaseEvidenceEligible"] is False, "realtime ASR browser evidence overstated release eligibility")
    require(value["origin"].startswith("https://") and value["origin"].endswith("/"), "realtime ASR browser origin is not HTTPS")
    require(UTC.fullmatch(value["startedAt"]) is not None and UTC.fullmatch(value["completedAt"]) is not None, "realtime ASR browser timestamps are invalid")
    require(value["console"] == {"errorCount": 0}, "realtime ASR browser console was not clean")
    require(value["privacy"] == {
        "credentialsRetained": False,
        "userContentRetained": False,
        "syntheticTranscriptScreenshotRetained": True,
        "commandOutputRetained": False,
        "syntheticContentOnly": True,
        "microphoneFixtureOnly": True,
    }, "realtime ASR browser privacy boundary drifted")
    browser = value["browser"]
    require(isinstance(browser, Mapping) and set(browser) == {"platform", "userAgent"} and "HeadlessChrome/" in browser["userAgent"], "real Chrome identity is missing")
    require(value["source"].get("runnerDigest") in HISTORICAL_RUNNER_DIGESTS | {digest(RUNNER.read_bytes())}
            and value["source"].get("audioFixtureDigest") == digest(FIXTURE.read_bytes())
            and set(value["source"]) == {"runnerDigest", "audioFixtureDigest"},
            "realtime ASR browser source binding drifted")

    binding = value["deployment"]
    require(isinstance(binding, Mapping) and set(binding) == {"evidencePath", "evidenceDigest", "runId", "webImageId", "asrImageId", "workerImageId"}, "realtime ASR deployment binding drifted")
    deployment_path = repository_path(binding["evidencePath"], "realtime ASR deployment evidence")
    deployment_bytes = deployment_path.read_bytes()
    require(binding["evidenceDigest"] == digest(deployment_bytes), "realtime ASR deployment evidence digest changed")
    deployment = json.loads(deployment_bytes)
    identity = re.fullmatch(r"[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})", binding["runId"])
    require(identity is not None, "realtime ASR deployment identity is invalid")
    plan_path = ROOT / "deploy" / "application-catalog-e2e" / f"plan-{identity.group(1)}-{identity.group(2)}.json"
    require(plan_path.is_file(), "realtime ASR deployment plan is missing")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    validate_deployment(deployment, plan)
    require(deployment["runId"] == binding["runId"] and plan["featureKey"] == "realtime.speech-websocket", "realtime ASR deployment identity drifted")
    images = {item["component"]: item["imageId"] for item in deployment["imageBindings"]}
    require(images.get("catalog-web") == binding["webImageId"] and images.get("catalog-asr") == binding["asrImageId"]
            and images.get("realtime-asr-worker") == binding["workerImageId"]
            and all(SHA256.fullmatch(item) is not None for item in binding.values() if isinstance(item, str) and item.startswith("sha256:")),
            "realtime ASR browser evidence is bound to different images")
    if "runtimeBinding" in value:
        current = value["runtimeBinding"]
        require(isinstance(current, Mapping)
                and set(current) == {"evidencePath", "evidenceDigest", "runId", "webImageId", "asrImageId", "workerImageId"},
                "realtime ASR current runtime binding fields drifted")
        current_path = repository_path(current["evidencePath"], "realtime ASR current runtime binding evidence")
        current_bytes = current_path.read_bytes()
        require(current["evidenceDigest"] == digest(current_bytes), "realtime ASR current runtime binding digest changed")
        checked = subprocess.run(
            ["python3", str(ROOT / "tools/validate_current_realtime_browser_binding.py"), "--evidence", str(current_path)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=480, check=False,
        )
        require(checked.returncode == 0, "realtime ASR current runtime binding failed strict validation")
        current_value = json.loads(current_bytes)
        require(current_value.get("runId") == current["runId"]
                and current_value.get("runtime", {}).get("web", {}).get("imageId") == current["webImageId"]
                and current_value.get("runtime", {}).get("asrPlugin", {}).get("imageId") == current["asrImageId"]
                and current_value.get("runtime", {}).get("realtimeWorker", {}).get("imageId") == current["workerImageId"],
                "realtime ASR current runtime image binding drifted")

    journeys = value["journeys"]
    require(isinstance(journeys, list) and [item.get("key") for item in journeys] == ["owner", "ordinary-user"], "realtime ASR browser role coverage is incomplete")
    expected_fields = {"key", "role", "launchable", "liveSurfaceVisible", "microphonePermissionExercised", "fixtureMicrophoneInjected", "websocketConnected", "transcriptCompleted", "segmentCount", "transcriptLength", "firstChunkBytes", "decodedRms", "stoppedAndReleased", "screenshot"}
    screenshots: set[Path] = set()
    for item, role in zip(journeys, ("owner", "member")):
        require(set(item) == expected_fields and item["role"] == role, f"realtime ASR {item.get('key')} fields drifted")
        require(all(item[key] is True for key in ("launchable", "liveSurfaceVisible", "microphonePermissionExercised", "fixtureMicrophoneInjected", "websocketConnected", "transcriptCompleted", "stoppedAndReleased")), f"realtime ASR {item['key']} journey is incomplete")
        require(isinstance(item["segmentCount"], int) and item["segmentCount"] >= 1 and isinstance(item["transcriptLength"], int) and item["transcriptLength"] >= 1, f"realtime ASR {item['key']} transcript is empty")
        require(isinstance(item["firstChunkBytes"], int) and item["firstChunkBytes"] >= 44
                and isinstance(item["decodedRms"], (int, float)) and not isinstance(item["decodedRms"], bool)
                and 0.001 < item["decodedRms"] <= 1, f"realtime ASR {item['key']} microphone fixture was silent or invalid")
        screenshot = item["screenshot"]
        require(isinstance(screenshot, Mapping) and set(screenshot) == {"path", "digest"}, "realtime ASR screenshot binding drifted")
        path = repository_path(screenshot["path"], "realtime ASR screenshot")
        content = path.read_bytes()
        require(path.suffix == ".png" and content.startswith(b"\x89PNG\r\n\x1a\n") and screenshot["digest"] == digest(content) and path not in screenshots, "realtime ASR screenshot changed or is invalid")
        screenshots.add(path)
    without_digest = dict(value)
    claimed = without_digest.pop("evidenceDigest")
    require(claimed == digest(canonical(without_digest)), "realtime ASR browser evidence canonical digest changed")
    return {"valid": True, "runId": value["runId"], "status": value["status"], "journeyCount": len(journeys), "screenshotCount": len(screenshots), "releaseEvidenceEligible": False}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RealtimeAsrBrowserEvidenceError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"realtime ASR browser evidence invalid: {error}")
        raise SystemExit(1)
