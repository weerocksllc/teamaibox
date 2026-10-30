#!/usr/bin/env python3
"""Launch, resume, and collect a pinned long-duration DGX Spark model soak."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import time
from typing import Any, Mapping

try:
    from .run_spark_model_baseline import (
        ARTIFACT_VERIFIER, EVIDENCE_ROOT, IMAGE, NETWORK, ROOT, SAFE_RUN_ID,
        BaselineError, Spark, artifact_manifest, build_profile_declaration,
        canonical_digest, catalog_profile, core_services, ensure_internal_network,
        remove_server, require, server_name, start_server, utc_now, verify_preflight,
        wait_ready,
    )
    from .validate_model_soak_suite import SUITE as SOAK_SUITE_PATH, validate as validate_soak_suite
except ImportError:
    from run_spark_model_baseline import (
        ARTIFACT_VERIFIER, EVIDENCE_ROOT, IMAGE, NETWORK, ROOT, SAFE_RUN_ID,
        BaselineError, Spark, artifact_manifest, build_profile_declaration,
        canonical_digest, catalog_profile, core_services, ensure_internal_network,
        remove_server, require, server_name, start_server, utc_now, verify_preflight,
        wait_ready,
    )
    from validate_model_soak_suite import SUITE as SOAK_SUITE_PATH, validate as validate_soak_suite


REMOTE_PREFIX = "/tmp/teamaibox-model-soak-"
PROBE_PREFIX = "teamaibox-model-soak-probe-"
VOLUME_PREFIX = "teamaibox-model-soak-evidence-"
RUNTIME_VOLUME_PREFIX = "teamaibox-model-soak-runtime-"
OWNER = "model-soak-validation"


class SoakRunError(BaselineError):
    pass


def probe_name(run_id: str) -> str:
    return PROBE_PREFIX + run_id


def evidence_volume(run_id: str) -> str:
    return VOLUME_PREFIX + run_id


def runtime_volume(run_id: str) -> str:
    return RUNTIME_VOLUME_PREFIX + run_id


def prepare_remote(spark: Spark, remote: str) -> None:
    require(spark.run(["mkdir", "-m", "755", remote], 30), "soak staging creation")
    for source in (ROOT / "tools/model_artifact_manifest.py", ROOT / "tools/model_soak_probe.py"):
        require(spark.copy(source, remote + "/" + source.name), "soak source copy")


def probe_source_digest(spark: Spark, remote: str) -> str:
    local = "sha256:" + hashlib.sha256((ROOT / "tools/model_soak_probe.py").read_bytes()).hexdigest()
    result = require(spark.run(["sha256sum", remote + "/model_soak_probe.py"], 30), "staged soak probe digest")
    fields = result.stdout.split()
    remote_digest = "sha256:" + fields[0] if len(fields) == 2 and len(fields[0]) == 64 else ""
    if remote_digest != local:
        raise SoakRunError("staged soak probe source digest drifted")
    return local


def create_evidence_volume(spark: Spark, run_id: str) -> None:
    name = evidence_volume(run_id)
    require(spark.run([
        "docker", "volume", "create", "--label", f"io.teamaibox.owner={OWNER}",
        "--label", f"io.teamaibox.run-id={run_id}", name,
    ], 30), "soak evidence volume creation")
    require(spark.run([
        "docker", "run", "--rm", "--network", "none",
        "--mount", f"source={name},target=/evidence", "--entrypoint", "chown", IMAGE,
        "-R", "1000:1000", "/evidence",
    ], 120), "soak evidence volume ownership")


def create_runtime_volume(spark: Spark, run_id: str) -> None:
    name = runtime_volume(run_id)
    require(spark.run([
        "docker", "volume", "create", "--label", f"io.teamaibox.owner={OWNER}",
        "--label", f"io.teamaibox.run-id={run_id}", "--label", "io.teamaibox.kind=runtime-cache", name,
    ], 30), "soak runtime cache creation")
    require(spark.run([
        "docker", "run", "--rm", "--network", "none",
        "--mount", f"source={name},target=/runtime-cache", "--entrypoint", "chown", IMAGE,
        "-R", "1000:1000", "/runtime-cache",
    ], 120), "soak runtime cache ownership")


def inspect_runtime_volume(spark: Spark, run_id: str) -> None:
    raw = require(spark.run(["docker", "volume", "inspect", runtime_volume(run_id)], 30), "soak runtime cache inspection")
    labels = (json.loads(raw.stdout)[0].get("Labels") or {})
    if labels != {"io.teamaibox.kind": "runtime-cache", "io.teamaibox.owner": OWNER, "io.teamaibox.run-id": run_id}:
        raise SoakRunError("soak runtime cache labels drifted")


def start_probe(
    spark: Spark, profile: Mapping[str, Any], remote: str, run_id: str,
    profile_fingerprint: str, deployment_fingerprint: str,
    suite_digest: str, configuration_digest: str, source_digest: str,
    duration_seconds: int, request_interval: float, sample_interval: float,
    long_every_jobs: int, *, smoke: bool,
) -> str:
    name = probe_name(run_id)
    arguments = [
        "docker", "run", "-d", "--name", name,
        "--label", f"io.teamaibox.owner={OWNER}", "--label", f"io.teamaibox.run-id={run_id}",
        "--label", f"io.teamaibox.profile={profile['profileKey']}",
        "--gpus", "all", "--network", NETWORK, "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "1000:1000",
        "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "256",
        "--restart", "no",
        "--mount", "type=bind,source=/proc,target=/host-proc,readonly",
        "--mount", f"type=bind,source={remote},target=/validation,readonly",
        "--mount", f"source={evidence_volume(run_id)},target=/evidence",
        "--entrypoint", "python", IMAGE, "/validation/model_soak_probe.py",
        "--base-url", f"http://{server_name(profile)}:8000", "--model", str(profile["servedModelName"]),
        "--run-id", run_id, "--profile-fingerprint", profile_fingerprint,
        "--deployment-fingerprint", deployment_fingerprint,
        "--suite-digest", suite_digest, "--configuration-digest", configuration_digest,
        "--probe-source-digest", source_digest,
        "--duration-seconds", str(duration_seconds),
        "--request-interval-seconds", str(request_interval),
        "--sample-interval-seconds", str(sample_interval),
        "--long-every-jobs", str(long_every_jobs),
        "--core-reserve-bytes", str(profile["scheduling"]["coreServiceReserveBytes"]),
    ]
    if smoke:
        arguments.append("--smoke")
    result = require(spark.run(arguments, 120), "soak probe creation")
    identity = result.stdout.strip()
    if len(identity) != 64 or any(character not in "0123456789abcdef" for character in identity):
        raise SoakRunError("Docker did not return the soak probe identity")
    return identity


def inspect_owned(spark: Spark, name: str, run_id: str, profile_key: str) -> dict[str, Any]:
    raw = require(spark.run(["docker", "inspect", name], 30), f"{name} inspection")
    document = json.loads(raw.stdout)[0]
    labels = document.get("Config", {}).get("Labels") or {}
    if labels.get("io.teamaibox.owner") != OWNER or labels.get("io.teamaibox.run-id") != run_id or labels.get("io.teamaibox.profile") != profile_key:
        raise SoakRunError("soak probe ownership labels drifted")
    host = document.get("HostConfig", {})
    if document.get("Config", {}).get("Image") != IMAGE or host.get("ReadonlyRootfs") is not True or host.get("NetworkMode") != NETWORK or host.get("RestartPolicy", {}).get("Name") != "no":
        raise SoakRunError("soak probe runtime boundary drifted")
    return document


def inspect_volume(spark: Spark, run_id: str) -> None:
    raw = require(spark.run(["docker", "volume", "inspect", evidence_volume(run_id)], 30), "soak evidence volume inspection")
    labels = (json.loads(raw.stdout)[0].get("Labels") or {})
    if labels.get("io.teamaibox.owner") != OWNER or labels.get("io.teamaibox.run-id") != run_id:
        raise SoakRunError("soak evidence volume labels drifted")


def read_volume_text(spark: Spark, run_id: str, filename: str) -> str:
    code = f"import pathlib; print(pathlib.Path('/evidence/{filename}').read_text(), end='')"
    result = require(spark.run([
        "docker", "run", "--rm", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--mount", f"source={evidence_volume(run_id)},target=/evidence,readonly",
        "--entrypoint", "python", IMAGE, "-c", code,
    ], 120), f"soak {filename} collection")
    return result.stdout


def host_available(spark: Spark) -> int:
    result = require(spark.run([
        "python3", "-c",
        "print(next(int(line.split()[1])*1024 for line in open('/proc/meminfo') if line.startswith('MemAvailable:')))",
    ], 30), "soak supervisor memory inspection")
    if not result.stdout.strip().isdigit():
        raise SoakRunError("soak supervisor memory evidence is invalid")
    return int(result.stdout.strip())


def wait_for_probe(
    spark: Spark, profile: Mapping[str, Any], run_id: str,
    duration_seconds: int, poll_seconds: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    started = time.monotonic()
    samples: list[dict[str, Any]] = []
    while time.monotonic() - started < duration_seconds + 900:
        probe = inspect_owned(spark, probe_name(run_id), run_id, str(profile["profileKey"]))
        model = require(spark.run(["docker", "inspect", server_name(profile), "--format", "{{json .State}}"], 30), "soak model state")
        raw_model_state = json.loads(model.stdout)
        model_state = {
            "Status": raw_model_state.get("Status"), "ExitCode": raw_model_state.get("ExitCode"),
            "OOMKilled": raw_model_state.get("OOMKilled"), "Restarting": raw_model_state.get("Restarting"),
        }
        services = core_services(spark)
        sample = {
            "observedAt": utc_now(), "probeStatus": probe["State"]["Status"],
            "modelStatus": model_state.get("Status"), "modelOOMKilled": model_state.get("OOMKilled"),
            "hostAvailableMemoryBytes": host_available(spark), "webHealthPassed": services["webHealthPassed"],
        }
        samples.append(sample)
        if probe["State"]["Status"] in ("exited", "dead"):
            return samples, model_state
        if model_state.get("Status") != "running" or model_state.get("OOMKilled") is not False or not services["webHealthPassed"]:
            raise SoakRunError("model or core Web service failed during soak")
        time.sleep(min(60, poll_seconds))
    raise SoakRunError("soak probe exceeded its bounded completion window")


def launch_path(run_id: str) -> pathlib.Path:
    return EVIDENCE_ROOT / f"{run_id}-launch.json"


def cleanup(spark: Spark, profile: Mapping[str, Any], run_id: str, remote: str) -> list[str]:
    errors = []
    for arguments, label in (
        (["docker", "rm", "-f", probe_name(run_id)], "probe"),
        (["docker", "rm", "-f", ARTIFACT_VERIFIER], "artifact verifier"),
    ):
        result = spark.run(arguments, 120)
        if result.returncode != 0 and "No such" not in result.stderr:
            errors.append(label + " cleanup failed")
    try:
        remove_server(spark, profile)
    except BaselineError:
        errors.append("model cleanup failed")
    volume = spark.run(["docker", "volume", "rm", evidence_volume(run_id)], 120)
    if volume.returncode != 0 and "no such volume" not in volume.stderr.lower():
        errors.append("evidence volume cleanup failed")
    runtime = spark.run(["docker", "volume", "rm", runtime_volume(run_id)], 120)
    if runtime.returncode != 0 and "no such volume" not in runtime.stderr.lower():
        errors.append("runtime cache cleanup failed")
    staging = spark.run(["rm", "-r", "--", remote], 30)
    if staging.returncode != 0 and "No such file" not in staging.stderr:
        errors.append("staging cleanup failed")
    return errors


def residual(spark: Spark, profile: Mapping[str, Any], run_id: str, remote: str) -> dict[str, Any]:
    checks = {
        "probeRemoved": spark.run(["docker", "inspect", probe_name(run_id)], 30).returncode != 0,
        "modelRemoved": spark.run(["docker", "inspect", server_name(profile)], 30).returncode != 0,
        "evidenceVolumeRemoved": spark.run(["docker", "volume", "inspect", evidence_volume(run_id)], 30).returncode != 0,
        "runtimeVolumeRemoved": spark.run(["docker", "volume", "inspect", runtime_volume(run_id)], 30).returncode != 0,
        "stagingRemoved": spark.run(["test", "!", "-e", remote], 30).returncode == 0,
    }
    return {**checks, "passed": all(checks.values())}


def write_local(path: pathlib.Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def require_clean_launch(spark: Spark, profile: Mapping[str, Any], run_id: str, remote: str) -> None:
    conflicts = []
    if spark.run(["docker", "inspect", probe_name(run_id)], 30).returncode == 0:
        conflicts.append("probe")
    if spark.run(["docker", "inspect", server_name(profile)], 30).returncode == 0:
        conflicts.append("model")
    if spark.run(["docker", "volume", "inspect", evidence_volume(run_id)], 30).returncode == 0:
        conflicts.append("evidence_volume")
    if spark.run(["docker", "volume", "inspect", runtime_volume(run_id)], 30).returncode == 0:
        conflicts.append("runtime_volume")
    if spark.run(["test", "-e", remote], 30).returncode == 0:
        conflicts.append("staging")
    if conflicts:
        raise SoakRunError("soak launch has conflicting residual state: " + ",".join(conflicts))


def launch_new(
    *, spark: Spark, catalog: Mapping[str, Any], profile: Mapping[str, Any],
    run_id: str, remote: str, evidence_path: pathlib.Path, launch_evidence_path: pathlib.Path,
    suite_result: Mapping[str, Any], configuration: Mapping[str, Any],
    configuration_digest: str, duration_seconds: int, request_interval: float,
    sample_interval: float, long_every: int, smoke: bool,
) -> dict[str, Any]:
    started_at = utc_now()
    try:
        require_clean_launch(spark, profile, run_id, remote)
        deployment_fingerprint = canonical_digest({"runtimeImage": catalog["runtimeImage"], "profile": profile})
        preflight = verify_preflight(spark, catalog, profile)
        prepare_remote(spark, remote)
        source_digest = probe_source_digest(spark, remote)
        manifest = artifact_manifest(spark, remote, catalog, profile)
        declaration = build_profile_declaration(profile, manifest, deployment_fingerprint, preflight["environmentDigest"])
        profile_fingerprint = canonical_digest(declaration)
        ensure_internal_network(spark)
        core_before = core_services(spark)
        if not core_before["webHealthPassed"]:
            raise SoakRunError("core Web service is unhealthy before soak")
        create_runtime_volume(spark, run_id)
        start_server(spark, catalog, profile, runtime_volume=runtime_volume(run_id))
        model_load, _logs = wait_ready(spark, profile)
        if model_load.get("minimumHostAvailableMemoryBytes", 0) < int(profile["scheduling"]["coreServiceReserveBytes"]):
            raise SoakRunError("model load violated the core-service reserve before soak")
        create_evidence_volume(spark, run_id)
        probe_identity = start_probe(
            spark, profile, remote, run_id, profile_fingerprint, deployment_fingerprint,
            str(suite_result["suiteDigest"]), configuration_digest, source_digest,
            duration_seconds, request_interval, sample_interval, long_every, smoke=smoke,
        )
        launch = {
            "schemaVersion": 1, "runId": run_id, "launchedAt": utc_now(),
            "profileKey": profile["profileKey"], "profileFingerprint": profile_fingerprint,
            "deploymentFingerprint": deployment_fingerprint, "durationSeconds": duration_seconds,
            "suiteDigest": suite_result["suiteDigest"], "configuration": dict(configuration),
            "configurationDigest": configuration_digest, "probeSourceDigest": source_digest,
            "runtimeImage": IMAGE,
            "runtimeCache": {"volume": runtime_volume(run_id), "freshAtLaunch": True},
            "smoke": smoke, "suite": dict(suite_result), "preflight": preflight,
            "artifact": manifest, "modelLoad": model_load, "coreServicesBefore": core_before,
            "probeContainerDigest": canonical_digest(probe_identity), "outcome": "running",
        }
        launch["launchDigest"] = canonical_digest(launch)
        write_local(launch_evidence_path, launch)
        return launch
    except BaseException as error:
        failed = {
            "schemaVersion": 1, "runId": run_id, "startedAt": started_at, "finishedAt": utc_now(),
            "profileKey": profile["profileKey"], "durationSeconds": duration_seconds,
            "configurationDigest": configuration_digest, "outcome": "failed",
            "failure": {"type": error.__class__.__name__, "message": str(error)[:1000]},
            "cleanupErrors": cleanup(spark, profile, run_id, remote),
        }
        failed["residual"] = residual(spark, profile, run_id, remote)
        failed["coreServicesAfter"] = core_services(spark)
        failed["certificationClaimEligible"] = False
        failed["evidenceDigest"] = canonical_digest(failed)
        write_local(evidence_path, failed)
        raise SoakRunError(f"soak launch failed; evidence retained at {evidence_path}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=dt.datetime.now(dt.timezone.utc).strftime("soak-%Y%m%d-%H%M%S"))
    parser.add_argument("--profile-key", required=True)
    parser.add_argument("--evidence-path", type=pathlib.Path)
    parser.add_argument("--duration-seconds", type=int)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--detach", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--poll-seconds", type=int, default=60)
    args = parser.parse_args()
    if not SAFE_RUN_ID.fullmatch(args.run_id) or not 10 <= args.poll_seconds <= 60 or (args.detach and args.resume):
        raise SoakRunError("soak runner arguments are invalid")
    suite_result = validate_soak_suite()
    suite = json.loads(SOAK_SUITE_PATH.read_text(encoding="utf-8"))
    catalog, profile = catalog_profile(args.profile_key)
    selected = next((item for item in suite["profiles"] if item["profileKey"] == args.profile_key), None)
    if not selected or selected.get("selection") != "initial_certification_candidate":
        raise SoakRunError("profile is not selected for initial certification soak")
    if args.smoke:
        duration_seconds = args.duration_seconds or 120
        if not 60 <= duration_seconds <= 900:
            raise SoakRunError("soak smoke duration must be between 60 and 900 seconds")
        request_interval, sample_interval, long_every = 2.0, 10.0, 6
    else:
        duration_seconds = args.duration_seconds or selected["requiredDurationSeconds"]
        if duration_seconds != selected["requiredDurationSeconds"]:
            raise SoakRunError("certification soak duration must equal the pinned 24-hour requirement")
        workload = suite["workload"]
        request_interval, sample_interval, long_every = float(workload["requestIntervalSeconds"]), float(workload["sampleIntervalSeconds"]), int(workload["longEveryJobs"])
    configuration = {
        "durationSeconds": duration_seconds, "requestIntervalSeconds": request_interval,
        "sampleIntervalSeconds": sample_interval, "longEveryJobs": long_every,
        "maximumConcurrency": 2, "coreReserveBytes": int(profile["scheduling"]["coreServiceReserveBytes"]),
        "smoke": args.smoke,
    }
    configuration_digest = canonical_digest(configuration)
    evidence_path = args.evidence_path or EVIDENCE_ROOT / f"{args.run_id}.json"
    remote = REMOTE_PREFIX + args.run_id
    spark = Spark()
    launch_evidence_path = launch_path(args.run_id)

    if args.resume:
        launch = json.loads(launch_evidence_path.read_text(encoding="utf-8"))
        if launch.get("runId") != args.run_id or launch.get("profileKey") != profile["profileKey"] or launch.get("durationSeconds") != duration_seconds:
            raise SoakRunError("soak launch evidence does not match resume arguments")
        if launch.get("suiteDigest") != suite_result["suiteDigest"] or launch.get("configurationDigest") != configuration_digest or launch.get("runtimeImage") != IMAGE:
            raise SoakRunError("soak launch suite, configuration, or runtime lineage drifted")
        inspect_owned(spark, probe_name(args.run_id), args.run_id, str(profile["profileKey"]))
        inspect_volume(spark, args.run_id)
        inspect_runtime_volume(spark, args.run_id)
        profile_fingerprint = launch["profileFingerprint"]
        deployment_fingerprint = launch["deploymentFingerprint"]
        source_digest = launch["probeSourceDigest"]
    else:
        if launch_evidence_path.exists():
            raise SoakRunError("soak launch evidence already exists; use --resume")
        launch = launch_new(
            spark=spark, catalog=catalog, profile=profile, run_id=args.run_id, remote=remote,
            evidence_path=evidence_path, launch_evidence_path=launch_evidence_path,
            suite_result=suite_result, configuration=configuration,
            configuration_digest=configuration_digest, duration_seconds=duration_seconds,
            request_interval=request_interval, sample_interval=sample_interval,
            long_every=long_every, smoke=args.smoke,
        )
        profile_fingerprint = launch["profileFingerprint"]
        deployment_fingerprint = launch["deploymentFingerprint"]
        source_digest = launch["probeSourceDigest"]
        if args.detach:
            print(launch_evidence_path)
            return 0

    evidence: dict[str, Any] = dict(launch)
    outcome, exit_code = "failed", 1
    try:
        supervisor_samples, model_state = wait_for_probe(spark, profile, args.run_id, duration_seconds, args.poll_seconds)
        probe_document = json.loads(read_volume_text(spark, args.run_id, "final.json"))
        series = json.loads(read_volume_text(spark, args.run_id, "samples.json"))
        time_series_path = EVIDENCE_ROOT / f"{args.run_id}-timeseries.json"
        write_local(time_series_path, series)
        evidence["probe"] = probe_document
        evidence["timeSeries"] = {
            "reference": str(time_series_path.relative_to(ROOT)),
            "digest": canonical_digest(series), "sampleCount": len(series),
        }
        evidence["supervisor"] = {
            "sampleCount": len(supervisor_samples),
            "minimumHostAvailableMemoryBytes": min(item["hostAvailableMemoryBytes"] for item in supervisor_samples),
            "allWebHealthPassed": all(item["webHealthPassed"] for item in supervisor_samples),
            "modelFinalState": model_state,
            "samplesDigest": canonical_digest(supervisor_samples),
        }
        if probe_document.get("outcome") != "passed" or probe_document.get("timeSeriesDigest") != evidence["timeSeries"]["digest"]:
            raise SoakRunError("soak probe or time-series integrity failed")
        if probe_document.get("suiteDigest") != launch["suiteDigest"] or probe_document.get("configurationDigest") != launch["configurationDigest"] or probe_document.get("probeSourceDigest") != launch["probeSourceDigest"]:
            raise SoakRunError("soak executable or configuration lineage failed")
        if model_state.get("Status") != "running" or model_state.get("OOMKilled") is not False or model_state.get("Restarting") is not False:
            raise SoakRunError("model worker crashed, restarted, or OOM-killed during soak")
        if not evidence["supervisor"]["allWebHealthPassed"] or evidence["supervisor"]["minimumHostAvailableMemoryBytes"] < int(profile["scheduling"]["coreServiceReserveBytes"]):
            raise SoakRunError("supervisor observed a core-service survival failure")
        outcome, exit_code = "passed", 0
    except BaseException as error:
        evidence["failure"] = {"type": error.__class__.__name__, "message": str(error)[:1000]}
        try:
            checkpoint = json.loads(read_volume_text(spark, args.run_id, "checkpoint.json"))
            evidence["lastCheckpoint"] = checkpoint
        except BaseException:
            pass
    finally:
        evidence["cleanupErrors"] = cleanup(spark, profile, args.run_id, remote)
        evidence["residual"] = residual(spark, profile, args.run_id, remote)
        evidence["coreServicesAfter"] = core_services(spark)
        if evidence["cleanupErrors"] or not evidence["residual"]["passed"] or not evidence["coreServicesAfter"]["webHealthPassed"]:
            outcome, exit_code = "failed", 1
    evidence["finishedAt"] = utc_now()
    evidence["outcome"] = outcome
    evidence["certificationClaimEligible"] = False
    evidence["claimBoundary"] = "soak stage only; coexistence, security, and final certification remain"
    evidence["evidenceDigest"] = canonical_digest(evidence)
    write_local(evidence_path, evidence)
    print(evidence_path)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
