#!/usr/bin/env python3
"""Run concurrent mixed product workloads and emit bounded latency evidence."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
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


CATALOG = ROOT / "architecture" / "validation" / "mixed-workload-load-suite.v1.json"
EVIDENCE_ROOT = ROOT / "evidence" / "validation" / "load"
RUN_ID = re.compile(r"mixed-load-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}")
EXPECTED_KEYS = [
    "ordinary_users", "local_asr_queue", "drawing_model_swaps", "llm_context_pressure",
    "realtime_speech_reservations", "team_file_transfers", "messaging", "administrator_dashboard",
]


class MixedLoadSuiteError(ValueError):
    pass


def validate_catalog(value: Mapping[str, Any]) -> dict[str, Any]:
    expected = {"schemaVersion", "suiteId", "maximumFailures", "maximumSuiteSeconds", "retainCommandOutput", "workloads"}
    if set(value) != expected:
        raise MixedLoadSuiteError("mixed load catalog fields drifted")
    if value.get("schemaVersion") != 1 or value.get("suiteId") != "load.mixed-workloads.v1":
        raise MixedLoadSuiteError("mixed load suite identity drifted")
    if value.get("maximumFailures") != 0 or value.get("retainCommandOutput") is not False:
        raise MixedLoadSuiteError("mixed load suite must fail closed and redact output")
    if not isinstance(value.get("maximumSuiteSeconds"), int) or not 10 <= value["maximumSuiteSeconds"] <= 300:
        raise MixedLoadSuiteError("mixed load suite duration budget is invalid")
    workloads = value.get("workloads")
    if not isinstance(workloads, list) or [item.get("key") for item in workloads if isinstance(item, Mapping)] != EXPECTED_KEYS:
        raise MixedLoadSuiteError("mixed load coverage or order drifted")
    total_instances = 0
    for workload in workloads:
        if not isinstance(workload, Mapping) or set(workload) != {"key", "instances", "maximumP95Milliseconds", "command"}:
            raise MixedLoadSuiteError("mixed load workload declaration is invalid")
        instances = workload.get("instances")
        budget = workload.get("maximumP95Milliseconds")
        command = workload.get("command")
        if not isinstance(instances, int) or not 2 <= instances <= 8:
            raise MixedLoadSuiteError(f"mixed load {workload.get('key')} concurrency is invalid")
        if not isinstance(budget, int) or not 1000 <= budget <= value["maximumSuiteSeconds"] * 1000:
            raise MixedLoadSuiteError(f"mixed load {workload.get('key')} latency budget is invalid")
        if not isinstance(command, list) or command[:2] != ["node", "--test"] or not 4 <= len(command) <= 12:
            raise MixedLoadSuiteError(f"mixed load {workload.get('key')} command is invalid")
        for filename in command[2:]:
            if not isinstance(filename, str) or not re.fullmatch(r"(?:apps|services|packages)/[a-z0-9-]+/test/[a-z0-9-]+\.test\.mjs", filename):
                raise MixedLoadSuiteError(f"mixed load {workload.get('key')} test path is invalid")
            path = PurePosixPath(filename)
            if path.is_absolute() or ".." in path.parts or not (ROOT / path).is_file():
                raise MixedLoadSuiteError(f"mixed load {workload.get('key')} test file is missing")
        total_instances += instances
    if not 16 <= total_instances <= 64:
        raise MixedLoadSuiteError("mixed load total concurrency is invalid")
    return dict(value)


def percentile(values: Sequence[int], fraction: float) -> int:
    if not values:
        raise MixedLoadSuiteError("cannot calculate an empty latency percentile")
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1))]


def run_suite(catalog: Mapping[str, Any], run_id: str) -> dict[str, Any]:
    started_at = iso_now()
    started = time.monotonic()
    declarations = {item["key"]: item for item in catalog["workloads"]}
    futures = {}
    total_instances = sum(item["instances"] for item in catalog["workloads"])
    with ThreadPoolExecutor(max_workers=total_instances, thread_name_prefix="mixed-load") as executor:
        for workload in catalog["workloads"]:
            timeout = min(catalog["maximumSuiteSeconds"], max(10, math.ceil(workload["maximumP95Milliseconds"] / 1000) + 10))
            for instance in range(1, workload["instances"] + 1):
                future = executor.submit(run_command, workload["command"], timeout)
                futures[future] = (workload["key"], instance)
        samples: dict[str, list[dict[str, Any]]] = {key: [] for key in EXPECTED_KEYS}
        for future in as_completed(futures):
            key, instance = futures[future]
            samples[key].append({"instance": instance, **future.result()})
    wall_milliseconds = round((time.monotonic() - started) * 1000)
    workloads = []
    for key in EXPECTED_KEYS:
        declaration = declarations[key]
        results = sorted(samples[key], key=lambda item: item["instance"])
        latencies = [item["durationMilliseconds"] for item in results]
        failure_count = sum(item["exitCode"] != 0 for item in results)
        p95 = percentile(latencies, 0.95)
        workloads.append({
            "key": key,
            "status": "passed" if failure_count == 0 and p95 <= declaration["maximumP95Milliseconds"] else "failed",
            "instanceCount": declaration["instances"],
            "failureCount": failure_count,
            "latencyMillisecondsP50": percentile(latencies, 0.50),
            "latencyMillisecondsP95": p95,
            "maximumP95Milliseconds": declaration["maximumP95Milliseconds"],
            "samples": results,
        })
    failures = [item["key"] for item in workloads if item["status"] != "passed"]
    if wall_milliseconds > catalog["maximumSuiteSeconds"] * 1000:
        failures.append("suite_duration")
    return {
        "schemaVersion": 1,
        "suiteId": catalog["suiteId"],
        "runId": run_id,
        "status": "passed" if len(failures) <= catalog["maximumFailures"] else "failed",
        "startedAt": started_at,
        "completedAt": iso_now(),
        "wallDurationMilliseconds": wall_milliseconds,
        "maximumSuiteSeconds": catalog["maximumSuiteSeconds"],
        "peakDeclaredConcurrency": total_instances,
        "source": {**git_facts(), "catalogDigest": digest_bytes(canonical_bytes(catalog))},
        "failedWorkloadKeys": failures,
        "workloads": workloads,
        "commandOutputRetained": False,
    }


def write_evidence(value: Mapping[str, Any], replace: bool) -> Path:
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    target = EVIDENCE_ROOT / f"{value['runId']}.json"
    if target.exists() and not replace:
        raise MixedLoadSuiteError("mixed load evidence already exists; use a new run id")
    temporary = target.with_suffix(".json.tmp")
    temporary.write_bytes(canonical_bytes(value) + b"\n")
    os.replace(temporary, target)
    return target


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args(argv)
    if not RUN_ID.fullmatch(args.run_id):
        raise MixedLoadSuiteError("run id must match mixed-load-YYYYMMDD-name")
    catalog = validate_catalog(json.loads(CATALOG.read_text(encoding="utf-8")))
    evidence = run_suite(catalog, args.run_id)
    target = write_evidence(evidence, args.replace)
    print(json.dumps({
        "runId": evidence["runId"], "status": evidence["status"], "peakDeclaredConcurrency": evidence["peakDeclaredConcurrency"],
        "wallDurationMilliseconds": evidence["wallDurationMilliseconds"], "failedWorkloadKeys": evidence["failedWorkloadKeys"],
        "evidence": target.relative_to(ROOT).as_posix(),
    }, sort_keys=True, separators=(",", ":")))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MixedLoadSuiteError, json.JSONDecodeError) as error:
        print(f"mixed workload load suite failed: {error}", file=sys.stderr)
        raise SystemExit(2)
