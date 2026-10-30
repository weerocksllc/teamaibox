#!/usr/bin/env python3
"""Run the closed release user-journey suite and emit redacted evidence."""

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


CATALOG = ROOT / "architecture" / "validation" / "user-journey-suite.v1.json"
EVIDENCE_ROOT = ROOT / "evidence" / "validation" / "journeys"
RUN_ID = re.compile(r"journeys-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}")
EXPECTED_KEYS = [
    "assistant_agent", "drawing", "ocr", "asr", "translation",
    "messaging", "team_drive", "plugin_install", "offline_packages", "local_appliance_work",
    "external_overflow", "administrator_resource_control",
]


class UserJourneySuiteError(ValueError):
    pass


def validate_catalog(value: Mapping[str, Any]) -> dict[str, Any]:
    if set(value) != {"schemaVersion", "suiteId", "maximumFailures", "retainCommandOutput", "journeys"}:
        raise UserJourneySuiteError("user journey catalog fields drifted")
    if value.get("schemaVersion") != 1 or value.get("suiteId") != "release.user-journeys.v1":
        raise UserJourneySuiteError("user journey suite identity drifted")
    if value.get("maximumFailures") != 0 or value.get("retainCommandOutput") is not False:
        raise UserJourneySuiteError("user journey suite must fail closed and redact output")
    journeys = value.get("journeys")
    if not isinstance(journeys, list) or [item.get("key") for item in journeys if isinstance(item, Mapping)] != EXPECTED_KEYS:
        raise UserJourneySuiteError("user journey coverage or order drifted")
    for journey in journeys:
        if not isinstance(journey, Mapping) or set(journey) != {"key", "command"}:
            raise UserJourneySuiteError("user journey declaration is invalid")
        command = journey.get("command")
        if not isinstance(command, list) or command[:2] != ["node", "--test"] or not 3 <= len(command) <= 12:
            raise UserJourneySuiteError(f"user journey {journey.get('key')} command is invalid")
        files = command[2:]
        if len(set(files)) != len(files):
            raise UserJourneySuiteError(f"user journey {journey.get('key')} repeats a test file")
        for filename in files:
            if not isinstance(filename, str) or not re.fullmatch(r"(?:apps|services|packages)/[a-z0-9-]+/test/[a-z0-9-]+\.test\.mjs", filename):
                raise UserJourneySuiteError(f"user journey {journey.get('key')} test path is invalid")
            path = PurePosixPath(filename)
            if path.is_absolute() or ".." in path.parts or not (ROOT / path).is_file():
                raise UserJourneySuiteError(f"user journey {journey.get('key')} test file is missing")
    return dict(value)


def run_suite(catalog: Mapping[str, Any], run_id: str, timeout_seconds: int) -> dict[str, Any]:
    started_at = iso_now()
    journeys = []
    for declaration in catalog["journeys"]:
        started = time.monotonic()
        command = run_command(declaration["command"], timeout_seconds)
        journeys.append({
            "key": declaration["key"],
            "status": "passed" if command["exitCode"] == 0 else "failed",
            "durationMilliseconds": round((time.monotonic() - started) * 1000),
            "command": command,
        })
    failures = [item["key"] for item in journeys if item["status"] != "passed"]
    return {
        "schemaVersion": 1,
        "suiteId": catalog["suiteId"],
        "runId": run_id,
        "status": "passed" if len(failures) <= catalog["maximumFailures"] else "failed",
        "startedAt": started_at,
        "completedAt": iso_now(),
        "source": {**git_facts(), "catalogDigest": digest_bytes(canonical_bytes(catalog))},
        "failedJourneyKeys": failures,
        "journeys": journeys,
        "commandOutputRetained": False,
    }


def write_evidence(value: Mapping[str, Any], replace: bool) -> Path:
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    target = EVIDENCE_ROOT / f"{value['runId']}.json"
    if target.exists() and not replace:
        raise UserJourneySuiteError("user journey evidence already exists; use a new run id")
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
    if not RUN_ID.fullmatch(args.run_id):
        raise UserJourneySuiteError("run id must match journeys-YYYYMMDD-name")
    if not 10 <= args.timeout_seconds <= 900:
        raise UserJourneySuiteError("timeout must be between 10 and 900 seconds")
    catalog = validate_catalog(json.loads(CATALOG.read_text(encoding="utf-8")))
    evidence = run_suite(catalog, args.run_id, args.timeout_seconds)
    target = write_evidence(evidence, args.replace)
    print(json.dumps({
        "runId": evidence["runId"], "status": evidence["status"],
        "journeyCount": len(evidence["journeys"]), "failedJourneyKeys": evidence["failedJourneyKeys"],
        "evidence": target.relative_to(ROOT).as_posix(),
    }, sort_keys=True, separators=(",", ":")))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (UserJourneySuiteError, json.JSONDecodeError) as error:
        print(f"user journey suite failed: {error}", file=sys.stderr)
        raise SystemExit(2)
