#!/usr/bin/env python3
"""Validate real-browser authenticated HTTPS evidence from the supported appliance."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "architecture/validation/appliance-browser-acceptance.v1.json"
SHA256 = re.compile(r"sha256:[a-f0-9]{64}")
RUN_ID = re.compile(r"appliance-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,31}")
RELEASE_ID = re.compile(r"rc-[a-z0-9][a-z0-9.-]{2,95}")
SAFE_BROWSER = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9 ._+()/:-]{1,79}")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def timestamp(value: Any, label: str) -> dt.datetime:
    require(isinstance(value, str) and value.endswith("Z"), f"{label} is not UTC")
    try:
        return dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError(f"{label} is invalid") from error


def combinations(suite: Mapping[str, Any]) -> list[str]:
    return [
        f"{viewport['key']}.{locale}.{theme}"
        for viewport in suite["matrix"]["viewports"]
        for locale in suite["matrix"]["locales"]
        for theme in suite["matrix"]["themes"]
    ]


def validate_report(value: Mapping[str, Any], *, evaluated_at: dt.datetime | None = None, suite: Mapping[str, Any] | None = None) -> dict[str, Any]:
    suite = dict(suite or json.loads(SUITE.read_text(encoding="utf-8")))
    require(suite.get("schemaVersion") == 1 and suite.get("suiteId") == "browser.appliance-authenticated-https.v1" and suite.get("releaseBlocking") is True, "appliance browser suite identity drifted")
    require(set(value) == {
        "schemaVersion", "suiteId", "suiteDigest", "runId", "releaseCandidateId", "outcome",
        "releaseEvidenceEligible", "startedAt", "finishedAt", "target", "origin", "deployment",
        "hardwareCheckpoint", "browser", "matrix", "journeys", "privacy", "sourceEvidence",
        "evidenceDigest",
    }, "appliance browser evidence shape drifted")
    require(value.get("schemaVersion") == 1 and value.get("suiteId") == suite["suiteId"] and value.get("suiteDigest") == canonical_digest(suite), "appliance browser suite lineage drifted")
    require(RUN_ID.fullmatch(str(value.get("runId", ""))) is not None and RELEASE_ID.fullmatch(str(value.get("releaseCandidateId", ""))) is not None, "appliance browser evidence identity is invalid")
    require(value.get("outcome") == "passed" and value.get("releaseEvidenceEligible") is True, "appliance browser evidence did not pass")
    started = timestamp(value.get("startedAt"), "appliance browser start")
    finished = timestamp(value.get("finishedAt"), "appliance browser finish")
    require(started < finished <= (evaluated_at or dt.datetime.now(dt.timezone.utc)), "appliance browser evidence time interval is invalid")

    target = value.get("target")
    require(target == {
        "nodeId": suite["target"]["nodeId"],
        "architecture": suite["target"]["architecture"],
        "supportedContainerizedAppliance": True,
        "hostAllowlistConforming": True,
        "hostAllowlistDriftCount": 0,
    }, "appliance browser target or host conformance is invalid")
    origin = value.get("origin")
    require(isinstance(origin, Mapping) and set(origin) == {
        "url", "originClass", "certificateTrust", "certificateFingerprintSha256",
        "leafHostnameOrIpMatched", "browserTrustStoreVerified", "warningBypassUsed",
        "customClientCaUsed",
    }, "appliance browser origin shape drifted")
    parsed = urlsplit(str(origin.get("url", "")))
    effective_port = parsed.port or (443 if parsed.scheme == "https" else None)
    require(parsed.scheme == "https" and parsed.hostname not in {None, "localhost", "127.0.0.1", "::1"} and effective_port in suite["target"]["allowedHttpsPorts"], "appliance browser origin is not the supported HTTPS endpoint")
    require(parsed.username is None and parsed.password is None and parsed.query == "" and parsed.fragment == "" and parsed.path in {"", "/"}, "appliance browser origin is ambiguous")
    require(origin.get("originClass") == suite["origin"]["class"] and origin.get("certificateTrust") in suite["origin"]["allowedCertificateTrust"], "appliance browser certificate is not browser trusted")
    require(SHA256.fullmatch(str(origin.get("certificateFingerprintSha256", ""))) is not None and origin.get("leafHostnameOrIpMatched") is True and origin.get("browserTrustStoreVerified") is True, "appliance browser certificate verification is incomplete")
    require(origin.get("warningBypassUsed") is False and origin.get("customClientCaUsed") is False, "appliance browser trust used a forbidden bypass")

    deployment = value.get("deployment")
    require(isinstance(deployment, Mapping) and set(deployment) == {"releaseEvidenceEligible", "evidenceDigest"}, "supported appliance deployment evidence shape drifted")
    require(deployment.get("releaseEvidenceEligible") is True and SHA256.fullmatch(str(deployment.get("evidenceDigest", ""))) is not None, "supported appliance deployment evidence is invalid")
    hardware = value.get("hardwareCheckpoint")
    require(isinstance(hardware, Mapping) and set(hardware) == {"current", "capturedAt", "ageAtCompletionSeconds", "maximumAgeSeconds", "evidenceDigest"}, "hardware checkpoint shape drifted")
    captured = timestamp(hardware.get("capturedAt"), "hardware checkpoint")
    age = int((finished - captured).total_seconds())
    require(hardware.get("current") is True and hardware.get("ageAtCompletionSeconds") == age and 0 <= age <= hardware.get("maximumAgeSeconds", -1) == suite["hardwareCheckpointMaximumAgeSeconds"], "Spark hardware checkpoint is stale")
    require(SHA256.fullmatch(str(hardware.get("evidenceDigest", ""))) is not None, "hardware checkpoint digest is invalid")

    browser = value.get("browser")
    require(isinstance(browser, Mapping) and set(browser) == {"name", "version", "execution", "certificateErrorCount", "consoleErrorCount"}, "browser identity shape drifted")
    require(SAFE_BROWSER.fullmatch(str(browser.get("name", ""))) is not None and SAFE_BROWSER.fullmatch(str(browser.get("version", ""))) is not None and browser.get("execution") == "real-browser", "real browser identity is invalid")
    require(browser.get("certificateErrorCount") == 0 and browser.get("consoleErrorCount") == 0, "browser emitted certificate or console errors")

    expected = combinations(suite)
    matrix = value.get("matrix")
    widths = {item["key"]: item["width"] for item in suite["matrix"]["viewports"]}
    require(isinstance(matrix, list) and [item.get("combination") for item in matrix] == expected and len(matrix) == suite["matrix"]["requiredCombinationCount"], "appliance browser matrix is incomplete")
    for item in matrix:
        require(isinstance(item, Mapping) and set(item) == {"combination", "actualWidth", "documentLanguage", "effectiveTheme", "result"}, "appliance browser matrix item shape drifted")
        viewport, locale, theme = item["combination"].split(".")
        require(item == {"combination": item["combination"], "actualWidth": widths[viewport], "documentLanguage": locale, "effectiveTheme": theme, "result": "passed"}, f"appliance browser matrix item failed: {item['combination']}")

    journeys = value.get("journeys")
    require(isinstance(journeys, Mapping) and set(journeys) == {"administrator", "ordinaryUser", "transport"}, "appliance browser journey groups drifted")
    for key in ("administrator", "ordinaryUser", "transport"):
        expected_steps = suite["journeys"][key]
        items = journeys[key]
        require(isinstance(items, list) and [item.get("step") for item in items] == expected_steps, f"{key} browser journey coverage drifted")
        require(all(isinstance(item, Mapping) and set(item) == {"step", "result"} and item["result"] == "passed" for item in items), f"{key} browser journey failed")
    privacy = value.get("privacy")
    require(privacy == suite["artifactPolicy"], "appliance browser artifact privacy policy drifted")
    require(privacy["credentialsRetained"] is False and privacy["userContentRetained"] is False and privacy["commandOutputRetained"] is False, "appliance browser evidence retained protected content")
    sources = value.get("sourceEvidence")
    require(isinstance(sources, Mapping) and set(sources) == {"deploymentEvidenceDigest", "hostDriftEvidenceDigest", "hardwareEvidenceDigest", "browserArtifactDigest"}, "appliance browser source evidence shape drifted")
    require(all(SHA256.fullmatch(str(item)) is not None for item in sources.values()), "appliance browser source evidence digest is invalid")
    require(sources["deploymentEvidenceDigest"] == deployment["evidenceDigest"] and sources["hardwareEvidenceDigest"] == hardware["evidenceDigest"], "appliance browser source lineage drifted")
    require(value.get("evidenceDigest") == canonical_digest({key: item for key, item in value.items() if key != "evidenceDigest"}), "appliance browser evidence digest drifted")

    claims = {
        "releaseEvidenceEligible": True,
        "supportedContainerizedAppliance": True,
        "hostAllowlistConforming": True,
        "currentSparkHardwareCheckpoints": True,
        "authenticatedHttpsJourneys": True,
        "realBrowser": True,
        "administratorJourneyPassed": True,
        "ordinaryUserJourneyPassed": True,
        "localeThemeViewportMatrixPassed": True,
        "sessionAndCsrfPassed": True,
        "sseAndWebSocketPassed": True,
        "originClass": origin["originClass"],
        "origin": origin["url"],
        "target": target["nodeId"],
        "architecture": target["architecture"],
        "certificateTrust": origin["certificateTrust"],
        "browserName": browser["name"],
        "browserExecution": browser["execution"],
        "matrixCombinationCount": len(matrix),
        "administratorJourneyCount": len(journeys["administrator"]),
        "ordinaryUserJourneyCount": len(journeys["ordinaryUser"]),
        "hostAllowlistDriftCount": target["hostAllowlistDriftCount"],
        "hardwareCheckpointAgeSeconds": hardware["ageAtCompletionSeconds"],
        "hardwareCheckpointMaximumAgeSeconds": hardware["maximumAgeSeconds"],
        "deploymentEvidenceDigest": sources["deploymentEvidenceDigest"],
        "hostDriftEvidenceDigest": sources["hostDriftEvidenceDigest"],
        "hardwareEvidenceDigest": sources["hardwareEvidenceDigest"],
        "browserEvidenceDigest": value["evidenceDigest"],
    }
    return {"valid": True, "runId": value["runId"], "evidenceDigest": value["evidenceDigest"], "claims": claims}


def validate(path: Path, *, evaluated_at: dt.datetime | None = None) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping), "appliance browser evidence is not an object")
    return validate_report(value, evaluated_at=evaluated_at)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
