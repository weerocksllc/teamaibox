#!/usr/bin/env python3
"""Run the bounded initial-model coexistence plan on the allowlisted Spark."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import time
from typing import Any, Mapping, Sequence

try:
    from .run_spark_model_baseline import (
        ARTIFACT_VERIFIER,
        IMAGE,
        ROOT,
        SAFE_RUN_ID,
        Spark,
        artifact_manifest,
        canonical_digest,
        catalog_profile,
        core_services,
        ensure_internal_network,
        remove_server,
        require,
        safe_tail,
        server_name,
        start_server,
        utc_now,
        verify_preflight,
        wait_ready,
    )
    from .validate_model_coexistence_suite import SUITE, load, validate as validate_suite
    from .validate_model_soak_evidence import validate as validate_soak
except ImportError:
    from run_spark_model_baseline import (
        ARTIFACT_VERIFIER,
        IMAGE,
        ROOT,
        SAFE_RUN_ID,
        Spark,
        artifact_manifest,
        canonical_digest,
        catalog_profile,
        core_services,
        ensure_internal_network,
        remove_server,
        require,
        safe_tail,
        server_name,
        start_server,
        utc_now,
        verify_preflight,
        wait_ready,
    )
    from validate_model_coexistence_suite import SUITE, load, validate as validate_suite
    from validate_model_soak_evidence import validate as validate_soak


EVIDENCE_ROOT = ROOT / "evidence/validation/models"
IMAGE_LOCK = ROOT / "deploy/compose/images.arm64.json"
OWNER = "model-coexistence-validation"
REMOTE_PREFIX = "/tmp/teamaibox-model-coexistence-"
NAME_PREFIX = "teamaibox-coexist-"
SECRET = re.compile(r"(?i)(authorization|cookie|password|secret|token)(\s*[:=]\s*)([^\s,;]+)")
REMOTE_FLAT_SOURCES = (ROOT / "tools/model_artifact_manifest.py",)
REMOTE_TREE_SOURCES = (
    ROOT / "tools/model_coexistence_worker.mjs",
    ROOT / "tools/model_coexistence_probe.mjs",
    ROOT / "deploy/compose/core-service-objective.mjs",
    ROOT / "deploy/compose/resource-policy.json",
    ROOT / "apps/platform-api/src/authorization/admin-control-guard.mjs",
    ROOT / "apps/platform-api/src/authorization/authorization-service.mjs",
    ROOT / "apps/platform-api/src/authorization/memory-repository.mjs",
    ROOT / "apps/platform-api/src/identity/auth-service.mjs",
    ROOT / "apps/platform-api/src/identity/memory-repository.mjs",
    ROOT / "apps/platform-api/src/identity/password.mjs",
    ROOT / "apps/platform-api/src/identity/repository-error.mjs",
    ROOT / "packages/authorization/src/index.mjs",
    ROOT / "packages/observability/src/index.mjs",
    ROOT / "services/messaging/src/memory-repository.mjs",
    ROOT / "services/messaging/src/messaging-service.mjs",
    ROOT / "services/object-service/src/memory-blob-store.mjs",
    ROOT / "services/object-service/src/memory-file-repository.mjs",
    ROOT / "services/object-service/src/memory-grant-repository.mjs",
    ROOT / "services/object-service/src/memory-repository.mjs",
    ROOT / "services/object-service/src/object-service.mjs",
    ROOT / "services/object-service/src/buffered-media-budget.mjs",
    ROOT / "services/object-service/src/team-drive-service.mjs",
)
RELATIVE_IMPORT = re.compile(
    r"(?:from\s+|import\s*(?:\(\s*)?)(?P<quote>['\"])(?P<specifier>\.[^'\"]+)(?P=quote)",
)


class CoexistenceRunError(RuntimeError):
    pass


def network_name(run_id: str) -> str:
    return f"teamaibox-coexist-net-{run_id}"


def runtime_volume(run_id: str) -> str:
    return f"teamaibox-coexist-runtime-{run_id}"


def container_name(run_id: str, suffix: str) -> str:
    return f"{NAME_PREFIX}{run_id}-{suffix}"


def evidence_path_for_run(run_id: str, requested: pathlib.Path | None = None) -> pathlib.Path:
    if SAFE_RUN_ID.fullmatch(run_id) is None:
        raise CoexistenceRunError("coexistence run ID is invalid")
    expected = (EVIDENCE_ROOT / f"{run_id}.json").resolve()
    candidate = requested or expected
    candidate = candidate if candidate.is_absolute() else ROOT / candidate
    candidate = candidate.resolve()
    if candidate != expected:
        raise CoexistenceRunError("coexistence evidence path must match its run identity")
    if candidate.exists():
        raise CoexistenceRunError("coexistence evidence already exists and will not be overwritten")
    return candidate


def write_local(path: pathlib.Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    except FileExistsError as error:
        raise CoexistenceRunError("coexistence evidence already exists and will not be overwritten") from error


def strict_prerequisites() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    suite_result = validate_suite()
    soak_result = validate_soak()
    suite = load(SUITE)
    required = suite["prerequisites"]
    reports = soak_result.get("reports", [])
    if len(reports) != 1 or reports[0].get("runId") != required["soakRunId"] or reports[0].get("profileKey") != required["soakProfileKey"]:
        raise CoexistenceRunError("formal soak prerequisite does not match the coexistence suite")
    return suite, suite_result, soak_result


def scheduler_contract_evidence() -> dict[str, Any]:
    tests = [
        "services/scheduler/test/exclusive-job-coordinator.test.mjs",
        "services/scheduler/test/realtime-reservation-manager.test.mjs",
        "services/scheduler/test/unified-memory-guard.test.mjs",
    ]
    completed = subprocess.run(
        ["node", "--test", "--test-reporter=dot", *tests], cwd=ROOT, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=120,
    )
    if completed.returncode != 0:
        raise CoexistenceRunError("scheduler coexistence contract failed: " + " | ".join((completed.stdout + completed.stderr).splitlines()[-20:]))
    return {
        "passed": True,
        "testFiles": tests,
        "sourceDigest": canonical_digest({path: (ROOT / path).read_text(encoding="utf-8") for path in tests}),
        "outputDigest": canonical_digest(completed.stdout),
    }


def remote_source_material() -> dict[str, str]:
    material = {source.name: source.read_text(encoding="utf-8") for source in REMOTE_FLAT_SOURCES}
    material.update({
        source.relative_to(ROOT).as_posix(): source.read_text(encoding="utf-8")
        for source in REMOTE_TREE_SOURCES
    })
    declared = {source.resolve() for source in REMOTE_TREE_SOURCES}
    for source in REMOTE_TREE_SOURCES:
        for match in RELATIVE_IMPORT.finditer(source.read_text(encoding="utf-8")):
            dependency = (source.parent / match.group("specifier")).resolve()
            if dependency not in declared:
                relative = dependency.relative_to(ROOT).as_posix() if dependency.is_relative_to(ROOT) else dependency.name
                raise CoexistenceRunError(f"coexistence remote source closure is missing {relative}")
    return material


def prepare_remote(spark: Spark, remote: str) -> str:
    material = remote_source_material()
    require(spark.run(["mkdir", "-m", "755", remote], 30), "coexistence staging creation")
    relative_paths = [source.relative_to(ROOT).as_posix() for source in REMOTE_TREE_SOURCES]
    directories = sorted({str(pathlib.PurePosixPath(path).parent) for path in relative_paths})
    require(spark.run(["mkdir", "-p", *[remote + "/" + path for path in directories]], 30), "coexistence source directory creation")
    for source in REMOTE_FLAT_SOURCES:
        require(spark.copy(source, remote + "/" + source.name), f"coexistence {source.name} copy")
    for source, relative in zip(REMOTE_TREE_SOURCES, relative_paths):
        require(spark.copy(source, remote + "/" + relative), f"coexistence {relative} copy")
    local_digest = canonical_digest(material)
    expressions = ",".join(repr(name) for name in material)
    code = (
        "import hashlib,json,pathlib; p=pathlib.Path(" + repr(remote) + "); names=[" + expressions + "]; "
        "v={n:(p/n).read_text() for n in names}; "
        "print('sha256:'+hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest())"
    )
    remote_digest = require(spark.run(["python3", "-c", code], 30), "coexistence staged-source digest").stdout.strip()
    if remote_digest != local_digest:
        raise CoexistenceRunError("coexistence staged source digest drifted")
    return local_digest


def create_boundaries(spark: Spark, run_id: str) -> None:
    network = network_name(run_id)
    volume = runtime_volume(run_id)
    if spark.run(["docker", "network", "inspect", network], 30).returncode == 0:
        raise CoexistenceRunError("coexistence network already exists")
    if spark.run(["docker", "volume", "inspect", volume], 30).returncode == 0:
        raise CoexistenceRunError("coexistence runtime volume already exists")
    require(spark.run([
        "docker", "network", "create", "--internal",
        "--label", f"io.teamaibox.owner={OWNER}", "--label", f"io.teamaibox.run-id={run_id}", network,
    ], 30), "coexistence internal network creation")
    require(spark.run([
        "docker", "volume", "create", "--label", f"io.teamaibox.owner={OWNER}",
        "--label", f"io.teamaibox.run-id={run_id}", "--label", "io.teamaibox.kind=runtime-cache", volume,
    ], 30), "coexistence runtime volume creation")
    require(spark.run([
        "docker", "run", "--rm", "--network", "none", "--mount", f"source={volume},target=/runtime-cache",
        "--entrypoint", "chown", IMAGE, "-R", "1000:1000", "/runtime-cache",
    ], 120), "coexistence runtime volume ownership")


def base_container(
    run_id: str, suffix: str, image: str, command: Sequence[str], *, alias: str,
    memory: int | str, cpus: float | str, pids: int, remote: str | None = None,
    extra: Sequence[str] = (),
) -> list[str]:
    arguments = [
        "docker", "run", "-d", "--name", container_name(run_id, suffix),
        "--label", f"io.teamaibox.owner={OWNER}", "--label", f"io.teamaibox.run-id={run_id}",
        "--label", f"io.teamaibox.role={suffix}", "--network", network_name(run_id),
        "--network-alias", alias, "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--memory", str(memory), "--cpus", str(cpus),
        "--pids-limit", str(pids), "--restart", "no",
    ]
    if remote:
        arguments += ["--mount", f"type=bind,source={remote},target=/validation,readonly"]
    arguments += list(extra) + [image] + list(command)
    return arguments


def start_core(spark: Spark, run_id: str, remote: str) -> list[str]:
    images = load(IMAGE_LOCK)["images"]
    node = images["node-runtime"]["reference"]
    names = []
    for suffix, alias, service, memory, cpus in (
        ("core-platform", "core-platform", "platform-api", "512m", "0.5"),
        ("core-web", "core-web", "web", "256m", "0.25"),
        ("core-object", "core-object", "object-service", "512m", "0.5"),
        ("core-messaging", "core-messaging", "messaging", "512m", "0.5"),
        ("core-scheduler", "core-scheduler", "scheduler", "512m", "0.5"),
    ):
        command = base_container(
            run_id, suffix, node, ("node", "/validation/deploy/compose/core-service-objective.mjs"), alias=alias,
            memory=memory, cpus=cpus, pids=96, remote=remote,
            extra=("--user", "1000:1000", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m", "--env", f"SERVICE_NAME={service}"),
        )
        require(spark.run(command, 60), f"{service} coexistence core start")
        names.append(container_name(run_id, suffix))
    postgres = base_container(
        run_id, "core-postgres", images["postgres"]["reference"], (), alias="core-postgres",
        memory="1g", cpus=1, pids=192,
        extra=(
            "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
            "--cap-add", "SETGID", "--cap-add", "SETUID",
            "--tmpfs", "/var/run/postgresql:rw,nosuid,nodev,size=16m",
            "--tmpfs", "/var/lib/postgresql:rw,nosuid,nodev,size=512m",
            "--env", "POSTGRES_DB=teamaibox", "--env", "POSTGRES_USER=teamaibox",
            "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
        ),
    )
    require(spark.run(postgres, 60), "coexistence PostgreSQL start")
    names.append(container_name(run_id, "core-postgres"))
    queue = base_container(
        run_id, "core-queue", images["nats"]["reference"],
        ("--jetstream", "--store_dir", "/data", "--http_port", "8222"), alias="core-queue",
        memory="256m", cpus="0.5", pids=96, extra=("--tmpfs", "/data:rw,nosuid,nodev,size=128m"),
    )
    require(spark.run(queue, 60), "coexistence NATS start")
    names.append(container_name(run_id, "core-queue"))
    return names


def inspect_core_containers(spark: Spark, run_id: str, names: Sequence[str]) -> list[dict[str, Any]]:
    suffixes = (
        "core-platform", "core-web", "core-object", "core-messaging",
        "core-scheduler", "core-postgres", "core-queue",
    )
    expected_names = [container_name(run_id, suffix) for suffix in suffixes]
    if list(names) != expected_names:
        raise CoexistenceRunError("coexistence core-container coverage drifted")
    boundaries = []
    for name, suffix in zip(expected_names, suffixes):
        raw = require(spark.run(["docker", "inspect", name], 30), f"{name} core-container inspection")
        document = json.loads(raw.stdout)[0]
        state, config, host = document["State"], document["Config"], document["HostConfig"]
        labels = config.get("Labels") or {}
        boundary = {
            "container": name,
            "containerId": document.get("Id"),
            "role": labels.get("io.teamaibox.role"),
            "owner": labels.get("io.teamaibox.owner"),
            "runId": labels.get("io.teamaibox.run-id"),
            "running": state.get("Running"),
            "oomKilled": state.get("OOMKilled"),
            "restarting": state.get("Restarting"),
            "networkMode": host.get("NetworkMode"),
            "restartPolicy": host.get("RestartPolicy", {}).get("Name"),
        }
        expected = {
            **boundary,
            "role": suffix,
            "owner": OWNER,
            "runId": run_id,
            "running": True,
            "oomKilled": False,
            "restarting": False,
            "networkMode": network_name(run_id),
            "restartPolicy": "no",
        }
        if boundary != expected:
            raise CoexistenceRunError(f"{name} core-container identity or runtime boundary drifted")
        if re.fullmatch(r"[0-9a-f]{64}", str(boundary["containerId"])) is None:
            raise CoexistenceRunError(f"{name} core-container ID is invalid")
        boundaries.append(boundary)
    if len({item["containerId"] for item in boundaries}) != len(boundaries):
        raise CoexistenceRunError("coexistence core-container IDs are not unique")
    return boundaries


def wait_core(spark: Spark, run_id: str) -> None:
    images = load(IMAGE_LOCK)["images"]
    name = container_name(run_id, "core-readiness")
    script = r"""
      (async () => {
      const net = require('node:net');
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const urls = [
        'http://core-platform:8080/health/ready', 'http://core-web:8080/health/ready',
        'http://core-object:8080/health/ready', 'http://core-messaging:8080/health/ready',
        'http://core-scheduler:8080/health/ready', 'http://core-queue:8222/healthz?js-enabled-only=true',
      ];
      const tcp = () => new Promise((resolve) => {
        const socket = net.createConnection({host:'core-postgres',port:5432});
        const done = (value) => { socket.destroy(); resolve(value); };
        socket.setTimeout(1000, () => done(false)); socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
      });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const http = await Promise.all(urls.map(async (url) => {
          try { return (await fetch(url, {signal:AbortSignal.timeout(1000)})).ok; } catch { return false; }
        }));
        if (http.every(Boolean) && await tcp()) process.exit(0);
        await sleep(1000);
      }
      process.exit(1);
      })().catch(() => process.exit(1));
    """
    command = [
        "docker", "run", "--rm", "--name", name,
        "--label", f"io.teamaibox.owner={OWNER}", "--label", f"io.teamaibox.run-id={run_id}",
        "--network", network_name(run_id), "--read-only", "--user", "1000:1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m",
        "--cpus", "0.5", "--pids-limit", "64", images["node-runtime"]["reference"],
        "node", "--input-type=commonjs", "--eval", script,
    ]
    require(spark.run(command, 90), "coexistence core readiness")


def start_envelope(
    spark: Spark, run_id: str, remote: str, capability: str, envelope: Mapping[str, Any], *, cpu_stress_workers: int = 0,
) -> str:
    images = load(IMAGE_LOCK)["images"]
    suffix = "worker-" + capability
    command = base_container(
        run_id, suffix, images["node-runtime"]["reference"],
        ("node", "/validation/tools/model_coexistence_worker.mjs"), alias=capability,
        memory=int(envelope["memoryLimitBytes"]), cpus=float(envelope["cpuCores"]), pids=max(96, 32 + cpu_stress_workers * 4), remote=remote,
        extra=(
            "--user", "1000:1000", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m",
            "--env", f"CAPABILITY={capability}", "--env", f"MEMORY_TOUCH_BYTES={envelope['memoryTouchBytes']}",
            "--env", f"CPU_STRESS_WORKERS={cpu_stress_workers}",
        ),
    )
    require(spark.run(command, 60), f"{capability} coexistence envelope start")
    name = container_name(run_id, suffix)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        state = spark.run(["docker", "inspect", name, "--format", "{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}"], 30)
        logs = spark.run(["docker", "logs", "--tail", "20", name], 30)
        if state.returncode == 0 and state.stdout.strip().startswith("true false") and "coexistence_worker_ready" in logs.stdout:
            return name
        if state.returncode == 0 and not state.stdout.strip().startswith("true"):
            raise CoexistenceRunError(f"{capability} envelope exited during allocation: {' | '.join(safe_tail(logs, 10))}")
        time.sleep(2)
    raise CoexistenceRunError(f"{capability} envelope readiness timed out")


def inspect_worker(spark: Spark, name: str, envelope: Mapping[str, Any]) -> dict[str, Any]:
    raw = require(spark.run(["docker", "inspect", name], 30), f"{name} inspection")
    document = json.loads(raw.stdout)[0]
    host = document["HostConfig"]
    state = document["State"]
    if host.get("Memory") != int(envelope["memoryLimitBytes"]) or host.get("NanoCpus") != int(float(envelope["cpuCores"]) * 1_000_000_000):
        raise CoexistenceRunError(f"{name} cgroup boundary drifted")
    config = document["Config"]
    stress_environment = next(
        (item for item in config.get("Env", []) if item.startswith("CPU_STRESS_WORKERS=")), None,
    )
    if stress_environment is None:
        raise CoexistenceRunError(f"{name} CPU stress declaration is missing")
    expected_pids = max(96, 32 + int(stress_environment.split("=", 1)[1]) * 4)
    if (
        config.get("User") != "1000:1000"
        or host.get("ReadonlyRootfs") is not True
        or host.get("Privileged") is not False
        or host.get("CapDrop") != ["ALL"]
        or "no-new-privileges" not in (host.get("SecurityOpt") or [])
        or host.get("NetworkMode") != network_name(document["Config"]["Labels"]["io.teamaibox.run-id"])
        or host.get("PidsLimit") != expected_pids
        or host.get("RestartPolicy", {}).get("Name") != "no"
    ):
        raise CoexistenceRunError(f"{name} runtime security boundary drifted")
    cgroup = require(spark.run([
        "docker", "exec", name, "sh", "-c",
        "printf '%s %s' \"$(cat /sys/fs/cgroup/memory.current)\" \"$(cat /sys/fs/cgroup/memory.peak)\"",
    ], 30), f"{name} cgroup memory inspection").stdout.strip().split()
    if len(cgroup) != 2 or not all(value.isdigit() for value in cgroup):
        raise CoexistenceRunError(f"{name} cgroup memory counters are invalid")
    return {
        "container": name, "containerId": document["Id"], "running": state.get("Running"), "oomKilled": state.get("OOMKilled"),
        "exitCode": state.get("ExitCode"), "memoryLimitBytes": host["Memory"], "cpuNanoCores": host["NanoCpus"],
        "memoryCurrentBytes": int(cgroup[0]), "memoryPeakBytes": int(cgroup[1]),
        "user": config["User"], "readOnlyRootFilesystem": host["ReadonlyRootfs"],
        "privileged": host["Privileged"], "capDrop": host["CapDrop"],
        "noNewPrivileges": True, "networkMode": host["NetworkMode"],
        "pidsLimit": host["PidsLimit"], "restartPolicy": host["RestartPolicy"]["Name"],
    }


def host_sample(spark: Spark) -> dict[str, Any]:
    code = (
        "import json; m={line.split(':',1)[0]:int(line.split()[1])*1024 for line in open('/proc/meminfo') "
        "if line.startswith(('MemTotal:','MemAvailable:'))}; print(json.dumps(m))"
    )
    memory = json.loads(require(spark.run(["python3", "-c", code], 30), "coexistence host memory sample").stdout)
    gpu = require(spark.run([
        "nvidia-smi", "--query-gpu=temperature.gpu,power.draw,utilization.gpu", "--format=csv,noheader,nounits",
    ], 30), "coexistence accelerator sample").stdout.strip().split(",")
    if len(gpu) != 3:
        raise CoexistenceRunError("coexistence accelerator telemetry is invalid")
    return {
        "observedAt": utc_now(), "memoryTotalBytes": memory["MemTotal"], "memoryAvailableBytes": memory["MemAvailable"],
        "temperatureCelsius": float(gpu[0].strip()), "powerWatts": float(gpu[1].strip()),
        "utilizationPercent": float(gpu[2].strip()),
    }


def run_phase(
    spark: Spark, run_id: str, remote: str, phase: Mapping[str, Any], *, model: str | None = None,
) -> dict[str, Any]:
    images = load(IMAGE_LOCK)["images"]
    phase_id = str(phase["phaseId"])
    name = container_name(run_id, "probe-" + phase_id)
    command = [
        "docker", "run", "-d", "--name", name,
        "--label", f"io.teamaibox.owner={OWNER}", "--label", f"io.teamaibox.run-id={run_id}",
        "--label", f"io.teamaibox.role=probe-{phase_id}", "--network", network_name(run_id),
        "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--memory", "512m", "--cpus", "1", "--pids-limit", "96", "--restart", "no",
        "--mount", f"type=bind,source={remote},target=/validation,readonly",
        images["node-runtime"]["reference"], "node", "/validation/tools/model_coexistence_probe.mjs",
        "--phase", phase_id, "--rounds", str(phase["probeRounds"]),
    ]
    if model is not None:
        command += ["--model", model]
    require(spark.run(command, 60), f"{phase_id} probe start")
    samples = []
    deadline = time.monotonic() + 300
    state: dict[str, Any] = {}
    while time.monotonic() < deadline:
        raw = require(spark.run(["docker", "inspect", name, "--format", "{{json .State}}"], 30), f"{phase_id} probe state")
        state = json.loads(raw.stdout)
        samples.append(host_sample(spark))
        if state.get("Running") is not True:
            break
        time.sleep(2)
    else:
        raise CoexistenceRunError(f"{phase_id} probe timed out")
    logs = spark.run(["docker", "logs", name], 30)
    try:
        probe = json.loads(logs.stdout)
    except json.JSONDecodeError as error:
        raise CoexistenceRunError(f"{phase_id} probe returned invalid JSON: {' | '.join(safe_tail(logs, 20))}") from error
    if state.get("ExitCode") != 0 or probe.get("passed") is not True:
        raise CoexistenceRunError(f"{phase_id} probe failed")
    require(spark.run(["docker", "rm", name], 30), f"{phase_id} probe removal")
    return {
        "phaseId": phase_id, "probe": probe, "resourceSamples": samples,
        "resourceSamplesDigest": canonical_digest(samples),
        "minimumHostAvailableMemoryBytes": min(item["memoryAvailableBytes"] for item in samples),
        "peakTemperatureCelsius": max(item["temperatureCelsius"] for item in samples),
        "peakPowerWatts": max(item["powerWatts"] for item in samples),
    }


def drain_workers(spark: Spark, names: Sequence[str]) -> list[dict[str, Any]]:
    drained = []
    for name in names:
        before_raw = require(spark.run(["docker", "inspect", name, "--format", "{{json .State}}"], 30), f"{name} pre-drain inspection")
        require(spark.run(["docker", "stop", "--time", "15", name], 60), f"{name} drain")
        after_raw = require(spark.run(["docker", "inspect", name, "--format", "{{json .State}}"], 30), f"{name} post-drain inspection")
        before, after = json.loads(before_raw.stdout), json.loads(after_raw.stdout)
        if before.get("Running") is not True or after.get("Running") is not False or after.get("OOMKilled") is not False or after.get("ExitCode") != 0:
            raise CoexistenceRunError(f"{name} did not drain cooperatively")
        drained.append({"container": name, "beforeRunning": True, "afterRunning": False, "exitCode": 0, "oomKilled": False})
        require(spark.run(["docker", "rm", name], 30), f"{name} drained removal")
    return drained


def start_shared(spark: Spark, run_id: str, remote: str, suite: Mapping[str, Any]) -> tuple[list[str], list[dict[str, Any]]]:
    names, boundaries = [], []
    for envelope in suite["sharedCapabilityEnvelopes"]:
        name = start_envelope(spark, run_id, remote, str(envelope["capability"]), envelope)
        names.append(name)
        boundaries.append({"capability": envelope["capability"], **inspect_worker(spark, name, envelope)})
    return names, boundaries


def cleanup(spark: Spark, run_id: str, profile: Mapping[str, Any], remote: str) -> list[str]:
    errors = []
    containers = spark.run([
        "docker", "ps", "-a", "--filter", f"label=io.teamaibox.owner={OWNER}",
        "--filter", f"label=io.teamaibox.run-id={run_id}", "--format", "{{.Names}}",
    ], 30)
    if containers.returncode == 0:
        for name in filter(None, containers.stdout.splitlines()):
            result = spark.run(["docker", "rm", "-f", name], 120)
            if result.returncode != 0:
                errors.append(f"container cleanup failed: {name}")
    else:
        errors.append("container ownership listing failed")
    try:
        remove_server(spark, profile)
    except BaseException as error:
        errors.append(str(error))
    for kind, command in (
        ("runtime volume", ["docker", "volume", "rm", runtime_volume(run_id)]),
        ("network", ["docker", "network", "rm", network_name(run_id)]),
        ("staging", ["rm", "-r", "--", remote]),
    ):
        result = spark.run(command, 120)
        if result.returncode != 0:
            errors.append(f"{kind} cleanup failed")
    return errors


def residual(spark: Spark, run_id: str, profile: Mapping[str, Any], remote: str) -> dict[str, Any]:
    containers = spark.run([
        "docker", "ps", "-a", "--filter", f"label=io.teamaibox.owner={OWNER}",
        "--filter", f"label=io.teamaibox.run-id={run_id}", "--format", "{{.Names}}",
    ], 30)
    checks = {
        "ownedContainersRemoved": containers.returncode == 0 and not containers.stdout.strip(),
        "modelRemoved": spark.run(["docker", "inspect", server_name(profile)], 30).returncode != 0,
        "runtimeVolumeRemoved": spark.run(["docker", "volume", "inspect", runtime_volume(run_id)], 30).returncode != 0,
        "networkRemoved": spark.run(["docker", "network", "inspect", network_name(run_id)], 30).returncode != 0,
        "stagingRemoved": spark.run(["test", "!", "-e", remote], 30).returncode == 0,
    }
    return {**checks, "passed": all(checks.values())}


def assert_acceptance(evidence: Mapping[str, Any], suite: Mapping[str, Any]) -> None:
    acceptance = suite["acceptance"]
    phases = {item["phaseId"]: item for item in evidence["phases"]}
    for phase in phases.values():
        core = phase["probe"]["core"]
        capabilities = phase["probe"]["capabilities"]
        if sum(item["failures"] for item in core.values()) > acceptance["maximumFailedCoreProbes"]:
            raise CoexistenceRunError("coexistence core probe failure gate failed")
        if sum(item["failures"] for item in capabilities.values()) > acceptance["maximumFailedCapabilityProbes"]:
            raise CoexistenceRunError("coexistence capability probe failure gate failed")
        if max(item["latencyMillisecondsP95"] for item in core.values()) > acceptance["maximumCoreLatencyMillisecondsP95"]:
            raise CoexistenceRunError("coexistence core latency gate failed")
        if phase["minimumHostAvailableMemoryBytes"] < acceptance["minimumHostAvailableMemoryBytes"]:
            raise CoexistenceRunError("coexistence core memory reserve failed")
        if phase["peakTemperatureCelsius"] > acceptance["maximumTemperatureCelsius"]:
            raise CoexistenceRunError("coexistence thermal gate failed")
    realtime = phases["shared-capabilities"]["probe"]["capabilities"]["realtime-speech-reservation"]
    if realtime["latencyMillisecondsP95"] > acceptance["maximumRealtimeLatencyMillisecondsP95"]:
        raise CoexistenceRunError("coexistence realtime latency gate failed")
    if phases["node-exclusive-llm"]["minimumHostAvailableMemoryBytes"] > acceptance["maximumLlmPhaseAvailableMemoryBytes"]:
        raise CoexistenceRunError("LLM phase did not reach the required bounded memory pressure")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--evidence-path", type=pathlib.Path)
    args = parser.parse_args()
    if not SAFE_RUN_ID.fullmatch(args.run_id):
        raise CoexistenceRunError("coexistence run ID is invalid")

    # This fail-closed prerequisite intentionally occurs before Spark is constructed or mutated.
    suite, suite_result, soak_result = strict_prerequisites()
    scheduler = scheduler_contract_evidence()
    catalog, profile = catalog_profile(suite["target"]["llmProfileKey"])
    evidence_path = evidence_path_for_run(args.run_id, args.evidence_path)
    remote = REMOTE_PREFIX + args.run_id
    spark = Spark()
    evidence: dict[str, Any] = {
        "schemaVersion": 1, "runId": args.run_id, "startedAt": utc_now(),
        "suiteId": suite["suiteId"], "suiteDigest": suite_result["suiteDigest"],
        "profileKey": profile["profileKey"], "soakPrerequisite": soak_result["reports"][0],
        "schedulerContracts": scheduler,
        "runnerSourceDigest": canonical_digest(pathlib.Path(__file__).read_text(encoding="utf-8")),
        "claimBoundary": "coexistence and exclusive resource-envelope stage only; security and final certification remain",
        "certificationClaimEligible": False,
    }
    outcome, exit_code = "failed", 1
    try:
        evidence["coreServicesBefore"] = core_services(spark)
        if evidence["coreServicesBefore"]["webHealthPassed"] is not True:
            raise CoexistenceRunError("appliance core Web health failed before coexistence")
        evidence["preflight"] = verify_preflight(spark, catalog, profile)
        evidence["stagedSourceDigest"] = prepare_remote(spark, remote)
        create_boundaries(spark, args.run_id)
        evidence["artifact"] = artifact_manifest(spark, remote, catalog, profile)
        evidence["coreContainers"] = start_core(spark, args.run_id, remote)
        wait_core(spark, args.run_id)
        evidence["coreContainerBoundariesBefore"] = inspect_core_containers(
            spark, args.run_id, evidence["coreContainers"],
        )

        phase_definitions = {item["phaseId"]: item for item in suite["phases"]}
        shared_names, shared_boundaries = start_shared(spark, args.run_id, remote, suite)
        shared_phase = run_phase(spark, args.run_id, remote, phase_definitions["shared-capabilities"])
        shared_phase["workerBoundaries"] = shared_boundaries
        shared_phase["drainForExclusive"] = drain_workers(spark, shared_names)

        ensure_internal_network(spark)
        start_server(spark, catalog, profile, runtime_volume=runtime_volume(args.run_id))
        model_load, _ = wait_ready(spark, profile)
        require(spark.run([
            "docker", "network", "connect", "--alias", "llm", network_name(args.run_id), server_name(profile),
        ], 30), "coexistence LLM network attachment")
        llm_pressure_definition = suite["exclusiveEnvelopes"]["llmPressure"]
        llm_pressure_name = start_envelope(spark, args.run_id, remote, "llm-pressure", llm_pressure_definition)
        llm_phase = run_phase(
            spark, args.run_id, remote, phase_definitions["node-exclusive-llm"], model=profile["servedModelName"],
        )
        llm_phase["modelLoad"] = model_load
        llm_phase["pressureBoundary"] = inspect_worker(spark, llm_pressure_name, llm_pressure_definition)
        llm_phase["pressureDrain"] = drain_workers(spark, [llm_pressure_name])
        model_state = json.loads(require(spark.run([
            "docker", "inspect", server_name(profile), "--format", "{{json .State}}",
        ], 30), "coexistence LLM final state").stdout)
        if model_state.get("Running") is not True or model_state.get("OOMKilled") is not False or model_state.get("Restarting") is not False:
            raise CoexistenceRunError("coexistence LLM crashed, restarted, or OOM-killed")
        llm_phase["modelFinalState"] = model_state
        remove_server(spark, profile)

        evidence["phases"] = [shared_phase, llm_phase]
        evidence["coreContainerBoundariesAfter"] = inspect_core_containers(
            spark, args.run_id, evidence["coreContainers"],
        )
        if evidence["coreContainerBoundariesAfter"] != evidence["coreContainerBoundariesBefore"]:
            raise CoexistenceRunError("coexistence core containers changed during AI saturation")
        assert_acceptance(evidence, suite)
        outcome, exit_code = "passed", 0
    except BaseException as error:
        evidence["failure"] = {
            "type": error.__class__.__name__,
            "message": SECRET.sub(lambda match: match.group(1) + match.group(2) + "[REDACTED]", str(error))[:2000],
        }
    finally:
        spark.run(["docker", "rm", "-f", ARTIFACT_VERIFIER], 120)
        evidence["cleanupErrors"] = cleanup(spark, args.run_id, profile, remote)
        evidence["residual"] = residual(spark, args.run_id, profile, remote)
        try:
            evidence["coreServicesAfter"] = core_services(spark)
        except BaseException as error:
            evidence.setdefault("cleanupErrors", []).append(str(error))
            evidence["coreServicesAfter"] = {"webHealthPassed": False}
        if evidence["cleanupErrors"] or evidence["residual"]["passed"] is not True or evidence["coreServicesAfter"].get("webHealthPassed") is not True:
            outcome, exit_code = "failed", 1
    evidence["finishedAt"] = utc_now()
    evidence["outcome"] = outcome
    evidence["evidenceDigest"] = canonical_digest(evidence)
    write_local(evidence_path, evidence)
    print(evidence_path)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
