#!/usr/bin/env python3
"""Restart isolated core-service containers and verify bounded persistence and availability."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import socket
import subprocess
import time
from typing import Any, Sequence


SAFE_PREFIX = re.compile(r"^teamaibox-restart-[a-z0-9][a-z0-9-]{5,54}-$")
DIGEST_IMAGE = re.compile(r"^[^\s@]+@sha256:[a-f0-9]{64}$")
LOOPBACK_PORT = re.compile(r"^127\.0\.0\.1:(?P<port>[0-9]{1,5})$")


class RestartProbeError(RuntimeError):
    pass


def run(arguments: Sequence[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(list(arguments), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=timeout)


def require(arguments: Sequence[str], description: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    result = run(arguments, timeout)
    if result.returncode != 0:
        raise RestartProbeError(f"{description} failed")
    return result


def wait_until(probe, description: str, timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if probe():
                return
        except (OSError, subprocess.SubprocessError, RestartProbeError):
            pass
        time.sleep(0.5)
    raise RestartProbeError(f"{description} did not become ready")


def node_ready(name: str) -> bool:
    result = run((
        "docker", "exec", name, "node", "-e",
        "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
    ), 5)
    return result.returncode == 0


def postgres_ready(name: str) -> bool:
    return run(("docker", "exec", name, "pg_isready", "-U", "teamaibox", "-d", "teamaibox"), 5).returncode == 0


def nats_ready(name: str) -> bool:
    return run(("docker", "exec", name, "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8222/healthz?js-enabled-only=true"), 5).returncode == 0


def nats_request(port: int, subject: str, payload: bytes) -> dict[str, Any]:
    inbox = "_INBOX.TEAMAIBOX.RESTART"
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        connection.settimeout(5)
        stream = connection.makefile("rwb", buffering=0)
        first = stream.readline()
        if not first.startswith(b"INFO "):
            raise RestartProbeError("NATS protocol greeting is invalid")
        stream.write(b'CONNECT {"verbose":false,"pedantic":false,"tls_required":false}\r\n')
        stream.write(b"SUB " + inbox.encode() + b" 1\r\n")
        stream.write(b"PUB " + subject.encode() + b" " + inbox.encode() + b" " + str(len(payload)).encode() + b"\r\n" + payload + b"\r\n")
        stream.write(b"PING\r\n")
        while True:
            line = stream.readline()
            if not line:
                raise RestartProbeError("NATS response ended early")
            if line.startswith(b"-ERR"):
                raise RestartProbeError("NATS request was rejected")
            if line.startswith(b"MSG "):
                parts = line.split()
                size = int(parts[-1])
                body = stream.read(size)
                if stream.read(2) != b"\r\n":
                    raise RestartProbeError("NATS response framing is invalid")
                value = json.loads(body)
                if not isinstance(value, dict) or value.get("error"):
                    raise RestartProbeError("NATS JetStream response is invalid")
                return value


def parse_loopback_port(value: str) -> int:
    match = LOOPBACK_PORT.fullmatch(value.strip())
    if match is None:
        raise RestartProbeError("NATS mapped port is invalid")
    port = int(match.group("port"))
    if port < 1 or port > 65535:
        raise RestartProbeError("NATS mapped port is invalid")
    return port


def wait_nats_request(port: int, subject: str, payload: bytes, description: str, timeout: float = 60) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return nats_request(port, subject, payload)
        except (OSError, ValueError, json.JSONDecodeError, RestartProbeError):
            time.sleep(0.5)
    raise RestartProbeError(f"{description} did not become ready")


def inspect_running(name: str) -> bool:
    result = run(("docker", "inspect", "--format", "{{.State.Running}}", name), 5)
    return result.returncode == 0 and result.stdout.strip() == "true"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--node-image", required=True)
    parser.add_argument("--postgres-image", required=True)
    parser.add_argument("--nats-image", required=True)
    parser.add_argument("--foundation-service", required=True, type=Path)
    args = parser.parse_args(argv)
    if SAFE_PREFIX.fullmatch(args.prefix) is None:
        raise RestartProbeError("unsafe core restart prefix")
    if any(DIGEST_IMAGE.fullmatch(value) is None for value in (args.node_image, args.postgres_image, args.nats_image)):
        raise RestartProbeError("core restart images must be digest pinned")
    foundation = args.foundation_service.resolve()
    if not foundation.is_file() or foundation.name != "foundation-service.mjs":
        raise RestartProbeError("foundation service source is invalid")

    names = {key: args.prefix + key for key in ("platform", "web", "object", "messaging", "scheduler", "postgres", "nats")}
    network = args.prefix.removesuffix("-") + "-network"
    postgres_volume = args.prefix.removesuffix("-") + "-postgres"
    nats_volume = args.prefix.removesuffix("-") + "-nats"
    resources = {"containers": list(names.values()), "volumes": [postgres_volume, nats_volume], "network": network}
    run_label = args.prefix.removesuffix("-")
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "controlled-core-service-restarts",
        "passed": False,
        "restartOrder": [],
        "databasePersistence": False,
        "eventBusPersistence": False,
        "otherCoreServicesAvailableDuringEachRestart": False,
        "objectProcessBoundary": "container-readiness plus deterministic encrypted-object state tier",
        "cleanup": None,
        "failure": None,
    }
    try:
        require(("docker", "network", "create", "--label", "com.teamaibox.validation=controlled-restart", network), "restart network creation")
        for volume in resources["volumes"]:
            require(("docker", "volume", "create", "--label", "com.teamaibox.validation=controlled-restart", volume), "restart volume creation")

        require((
            "docker", "run", "--detach", "--name", names["postgres"], "--network", network,
            "--label", "com.teamaibox.validation-run=" + run_label,
            "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE",
            "--cap-add", "FOWNER", "--cap-add", "SETGID", "--cap-add", "SETUID",
            "--security-opt", "no-new-privileges", "--pids-limit", "192", "--memory", "1g", "--cpus", "1",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m", "--tmpfs", "/var/run/postgresql:rw,nosuid,nodev,size=16m",
            "--volume", postgres_volume + ":/var/lib/postgresql",
            "--env", "POSTGRES_DB=teamaibox", "--env", "POSTGRES_USER=teamaibox", "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
            args.postgres_image,
        ), "PostgreSQL container start", 60)
        require((
            "docker", "run", "--detach", "--name", names["nats"], "--network", network,
            "--label", "com.teamaibox.validation-run=" + run_label,
            "--publish", "127.0.0.1::4222", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--pids-limit", "96", "--memory", "256m", "--cpus", "0.5",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", "--volume", nats_volume + ":/data",
            args.nats_image, "--jetstream", "--store_dir", "/data", "--http_port", "8222",
        ), "NATS container start", 30)
        for key in ("platform", "web", "object", "messaging", "scheduler"):
            require((
                "docker", "run", "--detach", "--name", names[key], "--network", network,
                "--label", "com.teamaibox.validation-run=" + run_label,
                "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--pids-limit", "64", "--memory", "256m", "--cpus", "0.25",
                "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
                "--mount", "type=bind,src=" + str(foundation) + ",dst=/opt/teamaibox/foundation-service.mjs,readonly",
                "--env", "SERVICE_NAME=" + ("object-service" if key == "object" else key),
                args.node_image, "node", "/opt/teamaibox/foundation-service.mjs",
            ), f"{key} container start", 30)

        wait_until(lambda: postgres_ready(names["postgres"]), "PostgreSQL")
        wait_until(lambda: nats_ready(names["nats"]), "NATS")
        for key in ("platform", "web", "object", "messaging", "scheduler"):
            wait_until(lambda key=key: node_ready(names[key]), key)
        require((
            "docker", "exec", names["postgres"], "psql", "-U", "teamaibox", "-d", "teamaibox", "-v", "ON_ERROR_STOP=1", "-c",
            "CREATE TABLE restart_probe(id integer PRIMARY KEY, digest text NOT NULL); INSERT INTO restart_probe VALUES (1, repeat('a',64));",
        ), "PostgreSQL durable seed")
        port_output = require(("docker", "port", names["nats"], "4222/tcp"), "NATS mapped port").stdout
        port = parse_loopback_port(port_output)
        created = nats_request(port, "$JS.API.STREAM.CREATE.TAIB_RESTART", json.dumps({
            "name": "TAIB_RESTART", "subjects": ["teamaibox.restart.fixture"], "storage": "file",
            "retention": "limits", "max_bytes": 1048576, "num_replicas": 1,
        }, separators=(",", ":")).encode())
        if created.get("config", {}).get("name") != "TAIB_RESTART":
            raise RestartProbeError("NATS durable stream creation failed")
        acknowledgement = nats_request(port, "teamaibox.restart.fixture", b"restart-probe")
        if acknowledgement.get("stream") != "TAIB_RESTART" or acknowledgement.get("seq") != 1:
            raise RestartProbeError("NATS durable message acknowledgement failed")

        probes = {
            "platform": lambda: node_ready(names["platform"]),
            "web": lambda: node_ready(names["web"]),
            "object": lambda: node_ready(names["object"]),
            "messaging": lambda: node_ready(names["messaging"]),
            "scheduler": lambda: node_ready(names["scheduler"]),
            "postgres": lambda: postgres_ready(names["postgres"]),
            "nats": lambda: nats_ready(names["nats"]),
        }
        all_others_passed = True
        for key in ("platform", "object", "messaging", "scheduler", "postgres", "nats", "web"):
            before = require(("docker", "inspect", "--format", "{{.Id}}", names[key]), f"{key} identity before restart").stdout.strip()
            require(("docker", "kill", "--signal", "KILL", names[key]), f"{key} abrupt stop")
            state = json.loads(require(("docker", "inspect", "--format", "{{json .State}}", names[key]), f"{key} stopped state").stdout)
            if state.get("ExitCode") != 137 or state.get("OOMKilled") is not False:
                raise RestartProbeError(f"{key} restart classification is invalid")
            for other, probe in probes.items():
                if other != key:
                    all_others_passed = all_others_passed and probe()
            require(("docker", "start", names[key]), f"{key} restart")
            wait_until(probes[key], key + " after restart")
            if key == "nats":
                port = parse_loopback_port(
                    require(("docker", "port", names["nats"], "4222/tcp"), "NATS mapped port after restart").stdout,
                )
            after = require(("docker", "inspect", "--format", "{{.Id}}", names[key]), f"{key} identity after restart").stdout.strip()
            if before != after:
                raise RestartProbeError(f"{key} container identity changed during process restart")
            report["restartOrder"].append({"service": key, "exitCode": 137, "oomKilled": False, "sameContainer": True, "readyAfterRestart": True})

        database = require((
            "docker", "exec", names["postgres"], "psql", "-U", "teamaibox", "-d", "teamaibox", "-Atc",
            "SELECT digest FROM restart_probe WHERE id=1",
        ), "PostgreSQL persistence verification").stdout.strip()
        info = wait_nats_request(port, "$JS.API.STREAM.INFO.TAIB_RESTART", b"", "NATS mapped JetStream API")
        report["databasePersistence"] = database == "a" * 64
        report["eventBusPersistence"] = info.get("config", {}).get("name") == "TAIB_RESTART" and info.get("state", {}).get("messages") == 1
        report["otherCoreServicesAvailableDuringEachRestart"] = all_others_passed
        report["passed"] = report["databasePersistence"] and report["eventBusPersistence"] and all_others_passed and len(report["restartOrder"]) == 7
        if not report["passed"]:
            raise RestartProbeError("one or more controlled core restart objectives failed")
    except Exception as error:
        report["failure"] = {"type": error.__class__.__name__, "message": str(error)[:300]}
    finally:
        containers_removed = True
        for name in reversed(resources["containers"]):
            result = run(("docker", "rm", "--force", name), 30)
            containers_removed = containers_removed and result.returncode in {0, 1}
        volumes_removed = True
        for volume in resources["volumes"]:
            result = run(("docker", "volume", "rm", "--force", volume), 30)
            volumes_removed = volumes_removed and result.returncode in {0, 1}
        network_result = run(("docker", "network", "rm", network), 30)
        residual = run(("docker", "ps", "--all", "--filter", "label=com.teamaibox.validation-run=" + run_label, "--format", "{{.Names}}"), 15)
        residual_volumes = all(run(("docker", "volume", "inspect", volume), 10).returncode != 0 for volume in resources["volumes"])
        residual_network = run(("docker", "network", "inspect", network), 10).returncode != 0
        cleanup = containers_removed and volumes_removed and network_result.returncode in {0, 1} and residual.returncode == 0 and not residual.stdout.strip() and residual_volumes and residual_network
        report["cleanup"] = {"containersRemoved": containers_removed, "volumesRemoved": volumes_removed, "networkRemoved": network_result.returncode in {0, 1}, "residualContainers": bool(residual.stdout.strip()), "residualVolumes": not residual_volumes, "residualNetwork": not residual_network, "passed": cleanup}
        report["passed"] = report["passed"] and cleanup
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
