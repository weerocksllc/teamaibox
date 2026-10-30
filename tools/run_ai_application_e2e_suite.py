#!/usr/bin/env python3
"""Run the closed AI-application contract E2E suite and emit redacted evidence."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import time
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.run_security_release_gate import canonical_bytes, digest_bytes, git_facts, iso_now, run_command
from tools.validate_browser_regression import validate as validate_browser_regression


CATALOG = ROOT / "architecture" / "validation" / "ai-application-e2e-suite.v1.json"
EVIDENCE_ROOT = ROOT / "evidence" / "validation" / "journeys"
RUN_ID = re.compile(r"ai-applications-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}")
EXPECTED_SCENARIOS = [
    "queued", "preparing", "running", "cross_application_object_handoff", "cancellation",
    "errors", "permissions", "encrypted_output", "mobile_browser_layout", "model_unload_reload",
]
EXPECTED_SHARED = ["job_lifecycle", "object_security"]
EXPECTED_APPLICATIONS = ["assistant_agent", "drawing", "ocr", "asr", "translation"]
PATH = re.compile(r"(?:apps|services|packages)/[a-z0-9-]+/test/[a-z0-9-]+\.test\.mjs")


class AiApplicationSuiteError(ValueError):
    pass


def repository_file(value: str) -> Path:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or not (ROOT / path).is_file():
        raise AiApplicationSuiteError(f"repository file is invalid or missing: {value}")
    return ROOT / path


def command(value: Any, key: str) -> list[str]:
    if not isinstance(value, list) or value[:2] != ["node", "--test"] or not 3 <= len(value) <= 12:
        raise AiApplicationSuiteError(f"{key} command is invalid")
    files = value[2:]
    if len(set(files)) != len(files):
        raise AiApplicationSuiteError(f"{key} repeats a test file")
    for filename in files:
        if not isinstance(filename, str) or PATH.fullmatch(filename) is None:
            raise AiApplicationSuiteError(f"{key} test path is invalid")
        repository_file(filename)
    return list(value)


def validate_catalog(value: Mapping[str, Any]) -> dict[str, Any]:
    expected_fields = {"schemaVersion", "suiteId", "maximumFailures", "retainCommandOutput", "requiredScenarios", "browserEvidence", "sharedChecks", "applications"}
    if set(value) != expected_fields:
        raise AiApplicationSuiteError("AI application catalog fields drifted")
    if value.get("schemaVersion") != 1 or value.get("suiteId") != "ai-applications.contract-e2e.v1":
        raise AiApplicationSuiteError("AI application suite identity drifted")
    if value.get("maximumFailures") != 0 or value.get("retainCommandOutput") is not False:
        raise AiApplicationSuiteError("AI application suite must fail closed and redact output")
    if value.get("requiredScenarios") != EXPECTED_SCENARIOS:
        raise AiApplicationSuiteError("AI application scenario coverage or order drifted")
    browser = value.get("browserEvidence")
    if not isinstance(browser, Mapping) or set(browser) != {"path", "suiteId", "releaseEvidenceEligible"}:
        raise AiApplicationSuiteError("browser evidence declaration is invalid")
    if browser.get("suiteId") != "browser.visual-accessibility-e2e.v1" or browser.get("releaseEvidenceEligible") is not False:
        raise AiApplicationSuiteError("local browser evidence boundary drifted")
    repository_file(browser.get("path"))
    shared = value.get("sharedChecks")
    if not isinstance(shared, list) or [item.get("key") for item in shared if isinstance(item, Mapping)] != EXPECTED_SHARED:
        raise AiApplicationSuiteError("shared AI application checks drifted")
    shared_scenarios: dict[str, set[str]] = {}
    for item in shared:
        if set(item) != {"key", "scenarios", "command"}:
            raise AiApplicationSuiteError("shared AI application check is invalid")
        scenarios = item.get("scenarios")
        if not isinstance(scenarios, list) or not scenarios or len(set(scenarios)) != len(scenarios) or not set(scenarios) <= set(EXPECTED_SCENARIOS):
            raise AiApplicationSuiteError(f"shared check {item.get('key')} scenarios are invalid")
        shared_scenarios[item["key"]] = set(scenarios)
        command(item.get("command"), f"shared check {item['key']}")
    applications = value.get("applications")
    if not isinstance(applications, list) or [item.get("key") for item in applications if isinstance(item, Mapping)] != EXPECTED_APPLICATIONS:
        raise AiApplicationSuiteError("AI application coverage or order drifted")
    plugin_ids: set[str] = set()
    for item in applications:
        if set(item) != {"key", "pluginId", "browserSurface", "browserMatrixSurface", "command", "scenarioEvidence"}:
            raise AiApplicationSuiteError(f"AI application {item.get('key')} declaration is invalid")
        if not isinstance(item.get("pluginId"), str) or not item["pluginId"].startswith("official.") or item["pluginId"] in plugin_ids:
            raise AiApplicationSuiteError(f"AI application {item.get('key')} plugin id is invalid")
        plugin_ids.add(item["pluginId"])
        if not all(isinstance(item.get(field), str) and item[field] for field in ["browserSurface", "browserMatrixSurface"]):
            raise AiApplicationSuiteError(f"AI application {item['key']} browser mapping is invalid")
        command(item.get("command"), f"AI application {item['key']}")
        evidence = item.get("scenarioEvidence")
        if not isinstance(evidence, Mapping) or list(evidence) != EXPECTED_SCENARIOS:
            raise AiApplicationSuiteError(f"AI application {item['key']} scenario evidence drifted")
        for scenario, sources in evidence.items():
            if not isinstance(sources, list) or len(sources) < 2 or len(set(sources)) != len(sources) or "application" not in sources:
                raise AiApplicationSuiteError(f"AI application {item['key']} scenario {scenario} lacks its application contract")
            allowed = {"application", "browser", *EXPECTED_SHARED}
            if not set(sources) <= allowed:
                raise AiApplicationSuiteError(f"AI application {item['key']} scenario {scenario} has an unknown source")
            if scenario == "mobile_browser_layout":
                if "browser" not in sources:
                    raise AiApplicationSuiteError(f"AI application {item['key']} lacks mobile browser evidence")
            else:
                supporting = [source for source in sources if source in shared_scenarios and scenario in shared_scenarios[source]]
                if not supporting:
                    raise AiApplicationSuiteError(f"AI application {item['key']} scenario {scenario} lacks a matching shared check")
    return dict(value)


def validate_browser_input(catalog: Mapping[str, Any]) -> dict[str, Any]:
    path = repository_file(catalog["browserEvidence"]["path"])
    validate_browser_regression(evidence_path=path)
    evidence = json.loads(path.read_text(encoding="utf-8"))
    if evidence.get("suiteId") != catalog["browserEvidence"]["suiteId"] or evidence.get("releaseEvidenceEligible") is not False:
        raise AiApplicationSuiteError("browser evidence identity or release boundary drifted")
    surfaces = {item.get("key"): item for item in evidence.get("surfaceCoverage", [])}
    matrices = {item.get("pluginId"): item for item in evidence.get("applicationPluginMatrix", [])}
    mobile = {f"mobile.{locale}.{theme}" for locale in ["zh-CN", "en"] for theme in ["light", "dark"]}
    workbench_mobile = {item.get("combination") for item in evidence.get("workbenchMatrix", []) if item.get("result") == "passed" and str(item.get("combination", "")).startswith("mobile.")}
    for application in catalog["applications"]:
        surface = surfaces.get(application["browserSurface"])
        if not surface or surface.get("result") != "passed":
            raise AiApplicationSuiteError(f"browser surface did not pass: {application['browserSurface']}")
        if application["browserMatrixSurface"] == "workbench":
            combinations = workbench_mobile
        else:
            matrix = matrices.get(application["browserMatrixSurface"])
            combinations = set(matrix.get("testedCombinations", [])) if matrix and matrix.get("result") == "passed" else set()
        if not mobile <= combinations:
            raise AiApplicationSuiteError(f"mobile browser matrix is incomplete for {application['key']}")
    return {
        "path": catalog["browserEvidence"]["path"],
        "evidenceId": evidence.get("evidenceId"),
        "digest": digest_bytes(path.read_bytes()),
        "releaseEvidenceEligible": False,
        "applicationCount": len(catalog["applications"]),
        "mobileCombinationCountPerApplication": len(mobile),
        "status": "passed",
    }


def run_suite(catalog: Mapping[str, Any], run_id: str, timeout_seconds: int) -> dict[str, Any]:
    started_at = iso_now()
    browser = validate_browser_input(catalog)
    shared = []
    applications = []
    for declaration in catalog["sharedChecks"]:
        started = time.monotonic()
        result = run_command(declaration["command"], timeout_seconds)
        shared.append({"key": declaration["key"], "status": "passed" if result["exitCode"] == 0 else "failed", "durationMilliseconds": round((time.monotonic() - started) * 1000), "command": result})
    for declaration in catalog["applications"]:
        started = time.monotonic()
        result = run_command(declaration["command"], timeout_seconds)
        applications.append({"key": declaration["key"], "pluginId": declaration["pluginId"], "status": "passed" if result["exitCode"] == 0 else "failed", "durationMilliseconds": round((time.monotonic() - started) * 1000), "scenarioEvidence": declaration["scenarioEvidence"], "command": result})
    failures = [f"shared:{item['key']}" for item in shared if item["status"] != "passed"] + [f"application:{item['key']}" for item in applications if item["status"] != "passed"]
    return {
        "schemaVersion": 1,
        "suiteId": catalog["suiteId"],
        "runId": run_id,
        "status": "passed" if len(failures) <= catalog["maximumFailures"] else "failed",
        "startedAt": started_at,
        "completedAt": iso_now(),
        "source": {**git_facts(), "catalogDigest": digest_bytes(canonical_bytes(catalog))},
        "requiredScenarios": catalog["requiredScenarios"],
        "failedCheckKeys": failures,
        "browserEvidence": browser,
        "sharedChecks": shared,
        "applications": applications,
        "commandOutputRetained": False,
        "limitations": ["This development contract suite is not a substitute for the current DGX Spark soak, coexistence, or authenticated supported-appliance HTTPS evidence required by tasks 7.13, 7.14, and 15.11."],
    }


def write_evidence(value: Mapping[str, Any], replace: bool) -> Path:
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    target = EVIDENCE_ROOT / f"{value['runId']}.json"
    if target.exists() and not replace:
        raise AiApplicationSuiteError("AI application evidence already exists; use a new run id")
    temporary = target.with_suffix(".json.tmp")
    temporary.write_bytes(canonical_bytes(value) + b"\n")
    os.replace(temporary, target)
    return target


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args(argv)
    if RUN_ID.fullmatch(args.run_id) is None:
        raise AiApplicationSuiteError("run id must match ai-applications-YYYYMMDD-name")
    if not 10 <= args.timeout_seconds <= 900:
        raise AiApplicationSuiteError("timeout must be between 10 and 900 seconds")
    catalog = validate_catalog(json.loads(CATALOG.read_text(encoding="utf-8")))
    evidence = run_suite(catalog, args.run_id, args.timeout_seconds)
    target = write_evidence(evidence, args.replace)
    print(json.dumps({"runId": evidence["runId"], "status": evidence["status"], "applicationCount": len(evidence["applications"]), "failedCheckKeys": evidence["failedCheckKeys"], "evidence": target.relative_to(ROOT).as_posix()}, sort_keys=True, separators=(",", ":")))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AiApplicationSuiteError, json.JSONDecodeError, ValueError) as error:
        print(f"AI application E2E suite failed: {error}", file=sys.stderr)
        raise SystemExit(2)
