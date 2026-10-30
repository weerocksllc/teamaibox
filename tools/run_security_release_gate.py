#!/usr/bin/env python3
"""Run the closed security release-gate catalog and emit redacted evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "architecture" / "validation" / "security-release-gate.v1.json"
EVIDENCE_ROOT = ROOT / "evidence" / "validation" / "security"
RUN_ID = re.compile(r"security-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}")
EXPECTED_KEYS = [
    "dependency", "image", "sbom", "signature", "secret", "vulnerability",
    "api_authorization", "container_isolation", "network_policy", "object_access",
    "log_redaction", "recovery_material",
]
ALLOWED_TOOLS = {"node", "pnpm", "python3"}


class SecurityGateError(ValueError):
    pass


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def validate_catalog(value: Mapping[str, Any]) -> dict[str, Any]:
    if set(value) != {"schemaVersion", "suiteId", "maximumFailures", "retainCommandOutput", "gates"}:
        raise SecurityGateError("security gate catalog fields drifted")
    if value.get("schemaVersion") != 1 or value.get("suiteId") != "security.release-gate.v1":
        raise SecurityGateError("security gate identity drifted")
    if value.get("maximumFailures") != 0 or value.get("retainCommandOutput") is not False:
        raise SecurityGateError("security gate must fail closed and redact command output")
    gates = value.get("gates")
    if not isinstance(gates, list) or [item.get("key") for item in gates if isinstance(item, Mapping)] != EXPECTED_KEYS:
        raise SecurityGateError("security gate coverage or order drifted")
    for gate in gates:
        if not isinstance(gate, Mapping) or set(gate) != {"key", "commands"}:
            raise SecurityGateError("security gate entry is invalid")
        commands = gate.get("commands")
        if not isinstance(commands, list) or not 1 <= len(commands) <= 4:
            raise SecurityGateError(f"security gate {gate.get('key')} commands are invalid")
        for command in commands:
            if not isinstance(command, list) or not 2 <= len(command) <= 16 or command[0] not in ALLOWED_TOOLS:
                raise SecurityGateError(f"security gate {gate.get('key')} command is invalid")
            for argument in command:
                if not isinstance(argument, str) or not 1 <= len(argument) <= 512 or any(ord(char) < 32 for char in argument):
                    raise SecurityGateError(f"security gate {gate.get('key')} argument is invalid")
                candidate = PurePosixPath(argument)
                if candidate.is_absolute() or ".." in candidate.parts:
                    raise SecurityGateError(f"security gate {gate.get('key')} path escapes the repository")
    return dict(value)


def git_facts() -> dict[str, Any]:
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout.decode("ascii").strip()
    status = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z"], cwd=ROOT, check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout
    return {"head": head, "worktreeDirty": bool(status), "changedPathCount": len([item for item in status.split(b"\0") if item])}


def iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def run_command(argv: Sequence[str], timeout_seconds: int) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            list(argv), cwd=ROOT, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout_seconds, env=os.environ.copy(),
        )
        exit_code = completed.returncode
        stdout, stderr = completed.stdout, completed.stderr
        timed_out = False
    except subprocess.TimeoutExpired as error:
        exit_code = 124
        stdout = error.stdout or b""
        stderr = error.stderr or b""
        timed_out = True
    return {
        "argvDigest": digest_bytes(canonical_bytes(list(argv))),
        "exitCode": exit_code,
        "timedOut": timed_out,
        "durationMilliseconds": round((time.monotonic() - started) * 1000),
        "stdoutDigest": digest_bytes(stdout),
        "stderrDigest": digest_bytes(stderr),
    }


def run_suite(catalog: Mapping[str, Any], run_id: str, timeout_seconds: int) -> dict[str, Any]:
    started_at = iso_now()
    results = []
    for gate in catalog["gates"]:
        gate_started = time.monotonic()
        commands = [run_command(command, timeout_seconds) for command in gate["commands"]]
        results.append({
            "key": gate["key"],
            "status": "passed" if all(item["exitCode"] == 0 for item in commands) else "failed",
            "durationMilliseconds": round((time.monotonic() - gate_started) * 1000),
            "commands": commands,
        })
    failures = [item["key"] for item in results if item["status"] != "passed"]
    return {
        "schemaVersion": 1,
        "suiteId": catalog["suiteId"],
        "runId": run_id,
        "status": "passed" if len(failures) <= catalog["maximumFailures"] else "failed",
        "startedAt": started_at,
        "completedAt": iso_now(),
        "source": {**git_facts(), "catalogDigest": digest_bytes(canonical_bytes(catalog))},
        "failedGateKeys": failures,
        "gates": results,
        "commandOutputRetained": False,
    }


def write_evidence(value: Mapping[str, Any], replace: bool) -> Path:
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    target = EVIDENCE_ROOT / f"{value['runId']}.json"
    if target.exists() and not replace:
        raise SecurityGateError("security gate evidence already exists; use a new run id")
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
        raise SecurityGateError("run id must match security-YYYYMMDD-name")
    if not 10 <= args.timeout_seconds <= 900:
        raise SecurityGateError("timeout must be between 10 and 900 seconds")
    catalog = validate_catalog(json.loads(CATALOG.read_text(encoding="utf-8")))
    evidence = run_suite(catalog, args.run_id, args.timeout_seconds)
    target = write_evidence(evidence, args.replace)
    print(json.dumps({
        "runId": evidence["runId"], "status": evidence["status"],
        "gateCount": len(evidence["gates"]), "failedGateKeys": evidence["failedGateKeys"],
        "evidence": target.relative_to(ROOT).as_posix(),
    }, sort_keys=True, separators=(",", ":")))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SecurityGateError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"security release gate failed: {error}", file=sys.stderr)
        raise SystemExit(2)
