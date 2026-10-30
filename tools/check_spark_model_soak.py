#!/usr/bin/env python3
"""Read-only lineage and progress check for a detached Spark model soak."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any, Mapping

try:
    from .run_spark_model_baseline import canonical_digest
    from .run_spark_model_soak import (
        EVIDENCE_ROOT,
        Spark,
        inspect_owned,
        inspect_runtime_volume,
        inspect_volume,
        probe_name,
        read_volume_text,
    )
    from .validate_model_soak_evidence import (
        SUITE as SOAK_SUITE,
        load as load_soak_json,
        validate_report as validate_formal_soak_report,
    )
except ImportError:
    from run_spark_model_baseline import canonical_digest
    from run_spark_model_soak import (
        EVIDENCE_ROOT,
        Spark,
        inspect_owned,
        inspect_runtime_volume,
        inspect_volume,
        probe_name,
        read_volume_text,
    )
    from validate_model_soak_evidence import (
        SUITE as SOAK_SUITE,
        load as load_soak_json,
        validate_report as validate_formal_soak_report,
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def parse_time(value: Any) -> dt.datetime:
    require(isinstance(value, str), "soak timestamp is missing")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None, "soak timestamp lacks a timezone")
    return parsed


def validate_checkpoint(launch: Mapping[str, Any], checkpoint: Mapping[str, Any], now: dt.datetime) -> dict[str, Any]:
    material = dict(checkpoint)
    digest = material.pop("checkpointDigest", None)
    require(digest == canonical_digest(material), "soak checkpoint digest drifted")
    for field in ("runId", "profileFingerprint", "deploymentFingerprint", "suiteDigest", "configurationDigest", "probeSourceDigest"):
        require(checkpoint.get(field) == launch.get(field), f"soak checkpoint {field} drifted")
    started = parse_time(checkpoint.get("startedAt"))
    deadline = parse_time(checkpoint.get("deadlineAt"))
    checked = parse_time(checkpoint.get("checkpointAt"))
    require(started <= checked <= now + dt.timedelta(minutes=2), "soak checkpoint time is invalid")
    require((deadline - started).total_seconds() == int(launch["durationSeconds"]), "soak checkpoint deadline drifted")
    jobs = checkpoint.get("jobs", {})
    require(jobs.get("submitted", 0) >= jobs.get("completed", -1) >= 0, "soak checkpoint job counters are invalid")
    require(jobs.get("failed") == 0 and jobs.get("incomplete") == 0, "soak checkpoint reports failed or incomplete jobs")
    require(checkpoint.get("sampleCount", 0) > 0, "soak checkpoint has no resource samples")
    reserve = int(launch["configuration"]["coreReserveBytes"])
    require(checkpoint.get("minimumHostAvailableMemoryBytes", 0) >= reserve, "soak checkpoint breached the core reserve")
    elapsed = max(0.0, (checked - started).total_seconds())
    duration = int(launch["durationSeconds"])
    return {
        "runId": launch["runId"],
        "state": "running" if checked < deadline else "deadline_reached",
        "startedAt": checkpoint["startedAt"],
        "checkpointAt": checkpoint["checkpointAt"],
        "deadlineAt": checkpoint["deadlineAt"],
        "checkpointAgeSeconds": round(max(0.0, (now - checked).total_seconds()), 3),
        "progressFraction": round(min(1.0, elapsed / duration), 6),
        "jobs": dict(jobs),
        "sampleCount": checkpoint["sampleCount"],
        "minimumHostAvailableMemoryBytes": checkpoint["minimumHostAvailableMemoryBytes"],
        "checkpointDigest": digest,
    }


def validate_finalized(
    launch: Mapping[str, Any], report_path: Path,
) -> dict[str, Any]:
    """Validate immutable local evidence before accepting cleaned remote state."""
    report = load_soak_json(report_path)
    validated = validate_formal_soak_report(report_path, load_soak_json(SOAK_SUITE))
    require(validated.get("runId") == launch.get("runId"), "finalized soak run identity drifted")
    require(report.get("launchDigest") == launch.get("launchDigest"), "finalized soak launch lineage drifted")
    probe = report.get("probe", {})
    started = parse_time(probe.get("startedAt"))
    finished = parse_time(probe.get("finishedAt"))
    duration = int(validated["durationSeconds"])
    deadline = started + dt.timedelta(seconds=duration)
    require(finished >= deadline, "finalized soak ended before its deadline")
    completed = int(validated["completedJobs"])
    return {
        "runId": launch["runId"],
        "state": "finalized",
        "startedAt": probe["startedAt"],
        "finalizedAt": probe["finishedAt"],
        "deadlineAt": deadline.isoformat().replace("+00:00", "Z"),
        "progressFraction": 1.0,
        "jobs": {"submitted": completed, "completed": completed, "failed": 0, "incomplete": 0},
        "sampleCount": validated["sampleCount"],
        "minimumHostAvailableMemoryBytes": validated["minimumHostAvailableMemoryBytes"],
        "peakTemperatureCelsius": validated["peakTemperatureCelsius"],
        "evidenceDigest": validated["evidenceDigest"],
        "launchDigest": launch["launchDigest"],
        "container": {"state": "cleaned-after-finalization"},
        "runtimeResourcesRetained": False,
    }


def check(run_id: str, now: dt.datetime | None = None) -> dict[str, Any]:
    launch_path = EVIDENCE_ROOT / f"{run_id}-launch.json"
    require(launch_path.is_file(), "soak launch evidence is missing")
    launch = json.loads(launch_path.read_text(encoding="utf-8"))
    material = dict(launch)
    launch_digest = material.pop("launchDigest", None)
    require(launch_digest == canonical_digest(material), "soak launch digest drifted")
    report_path = EVIDENCE_ROOT / f"{run_id}.json"
    if report_path.is_file():
        return validate_finalized(launch, report_path)
    spark = Spark()
    probe = inspect_owned(spark, probe_name(run_id), run_id, str(launch["profileKey"]))
    inspect_volume(spark, run_id)
    inspect_runtime_volume(spark, run_id)
    state = probe.get("State", {})
    checkpoint = json.loads(read_volume_text(spark, run_id, "checkpoint.json"))
    result = validate_checkpoint(launch, checkpoint, now or dt.datetime.now(dt.timezone.utc))
    deadline = parse_time(checkpoint["deadlineAt"])
    if (now or dt.datetime.now(dt.timezone.utc)) < deadline:
        require(state.get("Running") is True and state.get("Restarting") is False, "soak probe stopped before its deadline")
    result["container"] = {"running": state.get("Running"), "restarting": state.get("Restarting"), "exitCode": state.get("ExitCode")}
    result["launchDigest"] = launch_digest
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.run_id), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
