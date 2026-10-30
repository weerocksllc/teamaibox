#!/usr/bin/env python3
"""Run the release-candidate LLM fault matrix on the allowlisted DGX Spark."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess
import time
from typing import Any, Mapping

try:
    from .run_spark_model_baseline import (
        ARTIFACT_VERIFIER, EVIDENCE_ROOT, IMAGE, NETWORK, ROOT, SAFE_RUN_ID,
        BaselineError, Spark, artifact_manifest, build_profile_declaration,
        canonical_digest, catalog_profile, core_services, ensure_runtime_boundary,
        remove_server, require, residual, server_name, start_server, utc_now,
        verify_preflight, wait_ready,
    )
    from .validate_model_fault_suite import SUITE as FAULT_SUITE_PATH, validate as validate_fault_suite
except ImportError:
    from run_spark_model_baseline import (
        ARTIFACT_VERIFIER, EVIDENCE_ROOT, IMAGE, NETWORK, ROOT, SAFE_RUN_ID,
        BaselineError, Spark, artifact_manifest, build_profile_declaration,
        canonical_digest, catalog_profile, core_services, ensure_runtime_boundary,
        remove_server, require, residual, server_name, start_server, utc_now,
        verify_preflight, wait_ready,
    )
    from validate_model_fault_suite import SUITE as FAULT_SUITE_PATH, validate as validate_fault_suite


REMOTE_PREFIX = "/tmp/teamaibox-model-faults-"
RUNNER_PREFIX = "teamaibox-model-fault-probe-"
PROBE_PHASES = ("live", "worker-restart", "cold-reload", "oom-recovery")
NODE_AGENT_EVIDENCE = EVIDENCE_ROOT / "node-agent-restart-20260811-a2.json"
CONTROL_PLANE_TESTS = (
    "apps/platform-api/test/durable-job-service.test.mjs",
    "services/scheduler/test/worker-lifecycle-manager.test.mjs",
)
OOM_MEMORY_BYTES = 8 * 1024**3


class FaultRunError(BaselineError):
    pass


def file_digest(path: pathlib.Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def control_plane_fault_contracts() -> dict[str, Any]:
    completed = subprocess.run(
        ["node", "--test", *CONTROL_PLANE_TESTS],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False, timeout=180,
    )
    combined = (completed.stdout + "\n" + completed.stderr).encode()
    if completed.returncode != 0:
        raise FaultRunError("durable queue replay or scheduler cancellation contract failed")
    if not NODE_AGENT_EVIDENCE.is_file():
        raise FaultRunError("Node Agent restart evidence is missing")
    node_agent = json.loads(NODE_AGENT_EVIDENCE.read_text(encoding="utf-8"))
    restart = node_agent.get("nodeAgentRestart", {})
    if node_agent.get("cleanup") != "passed" or restart.get("readyAfterRestart") is not True or restart.get("replayedStartSameContainer") is not True:
        raise FaultRunError("Node Agent restart evidence is not passing")
    return {
        "queueReplay": {
            "passed": True,
            "contracts": list(CONTROL_PLANE_TESTS),
            "testOutputDigest": "sha256:" + hashlib.sha256(combined).hexdigest(),
        },
        "nodeAgentRestart": {
            "passed": True,
            "evidenceRef": str(NODE_AGENT_EVIDENCE.relative_to(ROOT)),
            "evidenceDigest": file_digest(NODE_AGENT_EVIDENCE),
            "replayedStartSameContainer": True,
        },
    }


def prepare_remote(spark: Spark, remote: str) -> None:
    require(spark.run(["mkdir", "-m", "755", remote], 30), "fault staging creation")
    for source in (ROOT / "tools" / "model_artifact_manifest.py", ROOT / "tools" / "model_fault_probe.py"):
        require(spark.copy(source, remote + "/" + source.name), "fault source copy")


def resource_gate(spark: Spark, profile: Mapping[str, Any], label: str) -> dict[str, Any]:
    available = require(spark.run([
        "python3", "-c",
        "print(next(int(line.split()[1])*1024 for line in open('/proc/meminfo') if line.startswith('MemAvailable:')))",
    ], 30), f"{label} host memory inspection")
    if not available.stdout.strip().isdigit():
        raise FaultRunError(f"{label} host memory evidence is invalid")
    available_bytes = int(available.stdout.strip())
    reserve = int(profile["scheduling"]["coreServiceReserveBytes"])
    services = core_services(spark)
    if available_bytes < reserve or not services["webHealthPassed"]:
        raise FaultRunError(f"{label} violated the core-service survival gate")
    return {"passed": True, "hostAvailableMemoryBytes": available_bytes, "requiredReserveBytes": reserve, "coreServices": services}


def require_safe_load(load: Mapping[str, Any], profile: Mapping[str, Any], label: str) -> None:
    minimum = load.get("minimumHostAvailableMemoryBytes")
    if not isinstance(minimum, int) or minimum < int(profile["scheduling"]["coreServiceReserveBytes"]):
        raise FaultRunError(f"{label} violated the core-service memory reserve during load")


def run_fault_probe(
    spark: Spark,
    profile: Mapping[str, Any],
    remote: str,
    run_id: str,
    profile_fingerprint: str,
    deployment_fingerprint: str,
    *,
    phase: str,
    expected_integrity_digest: str | None = None,
    full_matrix: bool = False,
) -> dict[str, Any]:
    runner = RUNNER_PREFIX + run_id + "-" + phase
    arguments = [
        "docker", "run", "--rm", "--name", runner,
        "--label", "io.teamaibox.owner=model-validation",
        "--network", NETWORK, "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--memory", "2g", "--cpus", "2", "--pids-limit", "256",
        "--mount", "type=bind,source=/proc,target=/host-proc,readonly",
        "--mount", f"type=bind,source={remote},target=/validation,readonly",
        "--entrypoint", "python", IMAGE, "/validation/model_fault_probe.py",
        "--base-url", f"http://{server_name(profile)}:8000", "--model", str(profile["servedModelName"]),
        "--run-id", run_id + "-" + phase,
        "--profile-fingerprint", profile_fingerprint,
        "--deployment-fingerprint", deployment_fingerprint,
    ]
    if not full_matrix:
        arguments.append("--integrity-only")
    if expected_integrity_digest:
        arguments.extend(["--expected-integrity-digest", expected_integrity_digest])
    result = spark.run(arguments, 2400)
    try:
        document = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise FaultRunError("fault probe returned invalid JSON") from error
    if result.returncode != 0 or document.get("outcome") != "passed":
        failure = document.get("failure", {})
        raise FaultRunError(f"fault probe failed during {phase}: {failure.get('message', 'unknown failure')}")
    return document


def abrupt_worker_restart(spark: Spark, profile: Mapping[str, Any]) -> dict[str, Any]:
    server = server_name(profile)
    before = require(spark.run(["docker", "inspect", server, "--format", "{{.Id}}"], 30), "worker identity before restart").stdout.strip()
    require(spark.run(["docker", "kill", "--signal", "KILL", server], 60), "abrupt worker kill")
    state = json.loads(require(spark.run(["docker", "inspect", server, "--format", "{{json .State}}"], 30), "killed worker state").stdout)
    if state.get("OOMKilled") is not False or state.get("ExitCode") != 137:
        raise FaultRunError("abrupt worker restart did not preserve the non-OOM failure classification")
    require(spark.run(["docker", "start", server], 60), "worker restart")
    load, _logs = wait_ready(spark, profile)
    after = require(spark.run(["docker", "inspect", server, "--format", "{{.Id}}"], 30), "worker identity after restart").stdout.strip()
    if before != after:
        raise FaultRunError("worker process restart unexpectedly changed container identity")
    return {
        "passed": True, "signal": "SIGKILL", "observedExitCode": 137,
        "oomKilled": False, "sameContainer": True, "reload": load,
    }


def cold_reload(spark: Spark, catalog: Mapping[str, Any], profile: Mapping[str, Any]) -> dict[str, Any]:
    before = require(spark.run(["docker", "inspect", server_name(profile), "--format", "{{.Id}}"], 30), "worker identity before cold reload").stdout.strip()
    remove_server(spark, profile)
    time.sleep(2)
    start_server(spark, catalog, profile)
    load, _logs = wait_ready(spark, profile)
    after = require(spark.run(["docker", "inspect", server_name(profile), "--format", "{{.Id}}"], 30), "worker identity after cold reload").stdout.strip()
    if before == after:
        raise FaultRunError("cold unload/reload reused the removed container")
    return {"passed": True, "newContainer": True, "unloadDelaySeconds": 2, "reload": load}


def wait_for_oom(spark: Spark, profile: Mapping[str, Any], timeout_seconds: int = 600) -> dict[str, Any]:
    server = server_name(profile)
    started = time.monotonic()
    while time.monotonic() - started < timeout_seconds:
        raw = require(spark.run(["docker", "inspect", server, "--format", "{{json .State}}"], 30), "OOM worker state")
        state = json.loads(raw.stdout)
        if state.get("Status") in ("exited", "dead"):
            logs = spark.run(["docker", "logs", "--tail", "200", server], 30)
            combined = logs.stdout + "\n" + logs.stderr
            runtime_oom = bool(re.search(
                r"out[ _]?of[ _]?memory|outofmemory|cannot allocate memory|cuda error.*memory",
                combined, re.IGNORECASE,
            ))
            cgroup_oom = state.get("OOMKilled") is True
            if not cgroup_oom and not runtime_oom:
                raise FaultRunError("low-memory worker exited without an OOM classification")
            return {
                "passed": True,
                "memoryLimitBytes": OOM_MEMORY_BYTES,
                "classification": "cgroup_oom_killed" if cgroup_oom else "runtime_out_of_memory",
                "oomKilled": cgroup_oom,
                "exitCode": state.get("ExitCode"),
                "failureLogDigest": canonical_digest(combined),
                "observedAfterMs": round((time.monotonic() - started) * 1000, 3),
            }
        ready = spark.run([
            "docker", "exec", server, "python", "-c",
            "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)",
        ], 10)
        if ready.returncode == 0:
            raise FaultRunError("the deliberately undersized worker became ready instead of producing an OOM")
        time.sleep(5)
    raise FaultRunError("the deliberately undersized worker did not reach a bounded OOM terminal state")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=dt.datetime.now(dt.timezone.utc).strftime("faults-%Y%m%d-%H%M%S"))
    parser.add_argument("--evidence-path", type=pathlib.Path)
    parser.add_argument("--profile-key", required=True)
    args = parser.parse_args()
    if not SAFE_RUN_ID.fullmatch(args.run_id):
        raise FaultRunError("run ID is invalid")
    evidence_path = args.evidence_path or EVIDENCE_ROOT / f"{args.run_id}.json"
    catalog, profile = catalog_profile(args.profile_key)
    deployment_fingerprint = canonical_digest({"runtimeImage": catalog["runtimeImage"], "profile": profile})
    spark = Spark()
    remote = REMOTE_PREFIX + args.run_id
    evidence: dict[str, Any] = {
        "schemaVersion": 1, "runId": args.run_id, "startedAt": utc_now(),
        "target": "dgx-spark-dev-01", "profileKey": profile["profileKey"],
        "deploymentFingerprint": deployment_fingerprint,
    }
    outcome, exit_code = "failed", 1
    try:
        evidence["suite"] = validate_fault_suite()
        suite_document = json.loads(FAULT_SUITE_PATH.read_text(encoding="utf-8"))
        if profile["profileKey"] not in suite_document["releaseCandidates"]:
            raise FaultRunError("selected profile is not a release candidate in the pinned fault suite")
        evidence["controlPlaneFaults"] = control_plane_fault_contracts()
        evidence["preflight"] = verify_preflight(spark, catalog, profile)
        prepare_remote(spark, remote)
        manifest = artifact_manifest(spark, remote, catalog, profile)
        evidence["artifact"] = manifest
        declaration = build_profile_declaration(
            profile, manifest, deployment_fingerprint, evidence["preflight"]["environmentDigest"],
        )
        profile_fingerprint = canonical_digest(declaration)
        evidence["profileFingerprint"] = profile_fingerprint
        ensure_runtime_boundary(spark)
        evidence["coreServicesBefore"] = core_services(spark)
        if not evidence["coreServicesBefore"]["webHealthPassed"]:
            raise FaultRunError("core Web service was unhealthy before fault injection")

        start_server(spark, catalog, profile)
        initial_load, _logs = wait_ready(spark, profile)
        evidence["initialLoad"] = initial_load
        require_safe_load(initial_load, profile, "initial model load")
        live = run_fault_probe(
            spark, profile, remote, args.run_id, profile_fingerprint, deployment_fingerprint,
            phase="live", full_matrix=True,
        )
        evidence["liveRequestFaults"] = live
        expected_digest = live["integrity"]["contentDigest"]
        if live.get("resources", {}).get("minimumHostAvailableMemoryBytes", 0) < int(profile["scheduling"]["coreServiceReserveBytes"]):
            raise FaultRunError("live request faults violated the core-service memory reserve")
        evidence["liveRequestFaults"]["resourceGate"] = resource_gate(spark, profile, "live request faults")

        evidence["workerRestart"] = abrupt_worker_restart(spark, profile)
        require_safe_load(evidence["workerRestart"]["reload"], profile, "worker restart")
        evidence["workerRestart"]["integrity"] = run_fault_probe(
            spark, profile, remote, args.run_id, profile_fingerprint, deployment_fingerprint,
            phase="worker-restart", expected_integrity_digest=expected_digest,
        )["integrity"]
        evidence["workerRestart"]["resourceGate"] = resource_gate(spark, profile, "worker restart")

        evidence["coldUnloadReload"] = cold_reload(spark, catalog, profile)
        require_safe_load(evidence["coldUnloadReload"]["reload"], profile, "cold reload")
        evidence["coldUnloadReload"]["integrity"] = run_fault_probe(
            spark, profile, remote, args.run_id, profile_fingerprint, deployment_fingerprint,
            phase="cold-reload", expected_integrity_digest=expected_digest,
        )["integrity"]
        evidence["coldUnloadReload"]["resourceGate"] = resource_gate(spark, profile, "cold reload")

        remove_server(spark, profile)
        start_server(spark, catalog, profile, memory_bytes=OOM_MEMORY_BYTES)
        evidence["oom"] = wait_for_oom(spark, profile)
        evidence["oom"]["resourceGate"] = resource_gate(spark, profile, "model OOM")

        remove_server(spark, profile)
        start_server(spark, catalog, profile)
        recovery_load, _logs = wait_ready(spark, profile)
        recovery = run_fault_probe(
            spark, profile, remote, args.run_id, profile_fingerprint, deployment_fingerprint,
            phase="oom-recovery", expected_integrity_digest=expected_digest,
        )
        evidence["oom"]["recoveryLoad"] = recovery_load
        require_safe_load(recovery_load, profile, "OOM recovery")
        evidence["oom"]["recoveryIntegrity"] = recovery["integrity"]
        evidence["oom"]["recoveryResourceGate"] = resource_gate(spark, profile, "OOM recovery")
        outcome, exit_code = "passed", 0
    except BaseException as error:
        evidence["failure"] = {"type": error.__class__.__name__, "message": str(error)[:1000]}
    finally:
        spark.run(["docker", "rm", "-f", ARTIFACT_VERIFIER], 120)
        for phase in PROBE_PHASES:
            spark.run(["docker", "rm", "-f", RUNNER_PREFIX + args.run_id + "-" + phase], 120)
        try:
            remove_server(spark, profile)
        except BaselineError as error:
            evidence.setdefault("cleanupErrors", []).append(str(error))
            outcome, exit_code = "failed", 1
        spark.run(["rm", "-r", "--", remote], 30)
        try:
            evidence["coreServicesAfter"] = core_services(spark)
            evidence["residual"] = residual(spark, remote)
            if evidence["residual"]["remainingContainers"] or not evidence["residual"]["stagingRemoved"] or not evidence["coreServicesAfter"]["webHealthPassed"]:
                outcome, exit_code = "failed", 1
        except BaseException as error:
            evidence.setdefault("cleanupErrors", []).append(str(error))
            outcome, exit_code = "failed", 1
    evidence["finishedAt"] = utc_now()
    evidence["outcome"] = outcome
    evidence["certificationClaimEligible"] = False
    evidence["claimBoundary"] = "fault stage only; soak, coexistence, security, and certification stages remain"
    evidence["evidenceDigest"] = canonical_digest(evidence)
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(evidence_path)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
