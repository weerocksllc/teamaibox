#!/usr/bin/env python3
"""Probe the seven core-service domains while a bounded AI cgroup is saturated."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time


SAFE_PREFIX = re.compile(r"^teamaibox-validation-[A-Za-z0-9][A-Za-z0-9.-]{2,100}-survival-$")
SAFE_RUN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
TARGET = "dgx-spark-dev-01"
CONTAINER_ROLES = (
    "platform", "web", "object", "messaging", "postgres", "queue", "scheduler", "ai",
)
CONTAINER_ID = re.compile(r"^[a-f0-9]{64}$")


class ProbeFailure(RuntimeError):
    pass


def run(arguments: list[str], timeout: float = 5.0) -> tuple[bool, int]:
    started = time.monotonic()
    completed = subprocess.run(
        arguments,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=timeout,
    )
    return completed.returncode == 0, round((time.monotonic() - started) * 1000)


def node_probe(container: str, objective: str) -> list[str]:
    return [
        "docker", "exec", container, "node", "--input-type=module", "-e",
        f"const r=await fetch('http://127.0.0.1:8080/objective/{objective}',{{method:'POST'}});"
        "const v=await r.json();if(!r.ok||v?.passed!==true)process.exit(1)",
    ]


def inspect_container(name: str, run_id: str) -> dict[str, object]:
    completed = subprocess.run(
        [
            "docker", "inspect", "--format",
            "{{.Id}} {{.State.Running}} {{index .Config.Labels \"com.teamaibox.validation-run\"}}",
            name,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
        timeout=5,
    )
    fields = completed.stdout.strip().split()
    if (
        completed.returncode != 0
        or len(fields) != 3
        or CONTAINER_ID.fullmatch(fields[0]) is None
        or fields[1:] != ["true", run_id]
    ):
        raise ProbeFailure(f"validation container identity drifted: {name}")
    return {
        "name": name,
        "containerId": fields[0],
        "running": True,
        "validationRunLabel": run_id,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--target", required=True, choices=[TARGET])
    parser.add_argument("--iterations", type=int, default=8)
    parser.add_argument("--policy", required=True, type=Path)
    args = parser.parse_args()
    if not SAFE_PREFIX.fullmatch(args.prefix):
        raise ProbeFailure("unsafe validation container prefix")
    if not SAFE_RUN_ID.fullmatch(args.run_id):
        raise ProbeFailure("unsafe validation run identity")
    if args.prefix != f"teamaibox-validation-{args.run_id}-survival-":
        raise ProbeFailure("validation prefix does not match the run identity")
    if args.iterations < 3 or args.iterations > 60:
        raise ProbeFailure("iterations must be between 3 and 60")
    try:
        policy = json.loads(args.policy.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProbeFailure("resource policy is unavailable") from error
    objectives = policy.get("serviceObjectives")
    required_domains = {"identity", "administration", "files", "messaging", "database", "object", "queue"}
    if not isinstance(objectives, dict) or set(objectives) != required_domains:
        raise ProbeFailure("resource policy service objectives are incomplete")
    for domain, objective in objectives.items():
        if (not isinstance(objective, dict) or objective.get("minimumSuccessRate") != 1
                or not isinstance(objective.get("maximumLatencyMilliseconds"), int)
                or objective["maximumLatencyMilliseconds"] < 1
                or objective["maximumLatencyMilliseconds"] > 5000):
            raise ProbeFailure(f"resource policy objective is invalid: {domain}")

    names = {suffix: args.prefix + suffix for suffix in CONTAINER_ROLES}
    containers = {
        role: inspect_container(name, args.run_id)
        for role, name in names.items()
    }
    probes = {
        "identity": node_probe(names["platform"], "identity"),
        "administration": node_probe(names["web"], "administration"),
        "files": node_probe(names["object"], "files"),
        "messaging": node_probe(names["messaging"], "messaging"),
        "database": ["docker", "exec", names["postgres"], "pg_isready", "-U", "teamaibox", "-d", "teamaibox"],
        "object": node_probe(names["object"], "object"),
        "queue": ["docker", "exec", names["queue"], "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8222/healthz?js-enabled-only=true"],
    }
    readiness_deadline = time.monotonic() + 45
    saturation_ready = None
    while time.monotonic() < readiness_deadline:
        ready, _ = run(["docker", "logs", names["ai"]], timeout=3)
        logs = subprocess.run(
            ["docker", "logs", names["ai"]], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, check=False, timeout=3,
        )
        if ready:
            for line in logs.stdout.splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event == {
                    "event": "ai_saturation_ready",
                    "workers": 4,
                    "touchedBytes": 536_870_912,
                }:
                    saturation_ready = event
                    break
        if saturation_ready is not None:
            break
        time.sleep(0.5)
    else:
        raise ProbeFailure("bounded AI saturation container did not become ready")

    core_readiness_deadline = time.monotonic() + 60
    with ThreadPoolExecutor(max_workers=len(probes)) as readiness_executor:
        while time.monotonic() < core_readiness_deadline:
            readiness = [readiness_executor.submit(run, command) for command in probes.values()]
            if all(future.result()[0] for future in readiness):
                break
            time.sleep(0.5)
        else:
            raise ProbeFailure("one or more core-service probes did not become ready")

    observations = {domain: [] for domain in probes}
    with ThreadPoolExecutor(max_workers=len(probes)) as executor:
        for _ in range(args.iterations):
            futures = {domain: executor.submit(run, command) for domain, command in probes.items()}
            for domain, future in futures.items():
                passed, latency = future.result()
                observations[domain].append({"passed": passed, "latencyMilliseconds": latency})
            time.sleep(0.25)

    domains = {}
    for domain, values in observations.items():
        passed_count = sum(1 for value in values if value["passed"])
        success_rate = passed_count / len(values)
        maximum_latency = max(value["latencyMilliseconds"] for value in values)
        objective = objectives[domain]
        domains[domain] = {
            "healthy": success_rate >= objective["minimumSuccessRate"]
            and maximum_latency <= objective["maximumLatencyMilliseconds"],
            "probes": len(values),
            "successRate": success_rate,
            "minimumSuccessRate": objective["minimumSuccessRate"],
            "maximumLatencyMilliseconds": maximum_latency,
            "maximumAllowedLatencyMilliseconds": objective["maximumLatencyMilliseconds"],
        }
    ai_running = subprocess.run(
        ["docker", "inspect", "--format", "{{.State.Running}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}", names["ai"]],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False, timeout=5,
    )
    stress_identity = ai_running.stdout.strip().split()
    stress_passed = ai_running.returncode == 0 and stress_identity == ["true", "1073741824", "2000000000"]
    passed = stress_passed and all(value["healthy"] for value in domains.values())
    report = {
        "schemaVersion": 1,
        "runId": args.run_id,
        "target": args.target,
        "passed": passed,
        "containers": containers,
        "domains": {domain: value["healthy"] for domain, value in domains.items()},
        "maximumLatencyMilliseconds": {
            domain: value["maximumLatencyMilliseconds"] for domain, value in domains.items()
        },
        "probesPerDomain": args.iterations,
        "objectives": domains,
        "stress": {
            "running": stress_passed,
            "memoryLimitBytes": 1_073_741_824,
            "cpuLimitCores": 2,
            "network": "none",
            "containerName": names["ai"],
            "workerCount": saturation_ready["workers"],
            "touchedBytes": saturation_ready["touchedBytes"],
        },
    }
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    attestation_material = {
        "containerIdentityDigest": "sha256:" + hashlib.sha256(json.dumps(
            containers, sort_keys=True, separators=(",", ":"),
        ).encode()).hexdigest(),
        "domains": sorted(domains),
        "functionalObjectives": True,
        "objectivePolicy": objectives,
        "passed": passed,
        "probesPerDomain": args.iterations,
        "runId": args.run_id,
        "target": args.target,
    }
    print(json.dumps({
        "schemaVersion": 1,
        "kind": "core-service-objectives",
        "passed": passed,
        "functionalObjectives": True,
        "runId": args.run_id,
        "target": args.target,
        "containerIdentityDigest": attestation_material["containerIdentityDigest"],
        "domains": sorted(domains),
        "probesPerDomain": args.iterations,
        "objectivePolicyDigest": "sha256:" + hashlib.sha256(json.dumps(
            objectives, sort_keys=True, separators=(",", ":"),
        ).encode()).hexdigest(),
        "resultDigest": "sha256:" + hashlib.sha256(json.dumps(
            attestation_material, sort_keys=True, separators=(",", ":"),
        ).encode()).hexdigest(),
    }, sort_keys=True, separators=(",", ":")))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProbeFailure, subprocess.TimeoutExpired) as error:
        print(json.dumps({"passed": False, "error": type(error).__name__}, sort_keys=True))
        raise SystemExit(1)
