#!/usr/bin/env python3
"""Emit content-free core-service and host aggregates during whole-product load."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import time
from typing import Any, Sequence


PROJECT = re.compile(r"^teamaibox_feature_(?:whole_product_load|encryption_suite)_[a-z0-9_]+$")
CORE_SERVICES = {
    "postgres", "event-bus", "object-service", "messaging-service", "catalog-health",
    "platform-api", "web", "maintenance-controller",
}
UNITS = {"B": 1, "kB": 1000, "KB": 1000, "KiB": 1024, "MB": 1000 ** 2, "MiB": 1024 ** 2,
         "GB": 1000 ** 3, "GiB": 1024 ** 3, "TB": 1000 ** 4, "TiB": 1024 ** 4}


class MonitorError(RuntimeError):
    pass


def command(arguments: Sequence[str], timeout: int = 30) -> bytes:
    result = subprocess.run(list(arguments), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=timeout, check=False)
    if result.returncode != 0:
        raise MonitorError(f"bounded command failed: {arguments[0]}")
    return result.stdout


def bytes_value(value: str) -> int:
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B)", value.strip())
    if match is None:
        raise MonitorError("Docker memory unit is invalid")
    return round(float(match.group(1)) * UNITS[match.group(2)])


def mem_available() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise MonitorError("host available memory is unavailable")


def runtime_inventory(project: str) -> list[dict[str, Any]]:
    listing = command(("docker", "ps", "--filter", f"label=com.docker.compose.project={project}",
                       "--format", "{{.Names}}"))
    names = [item for item in listing.decode().splitlines() if item]
    platform_name = f"{project}-platform-api-1"
    if platform_name not in names:
        candidate = json.loads(command(("docker", "inspect", platform_name), 90))[0]
        labels = candidate.get("Config", {}).get("Labels") or {}
        if (candidate.get("State", {}).get("Status") != "running"
                or labels.get("com.teamaibox.managed") != "true"
                or not labels.get("com.teamaibox.component")):
            raise MonitorError("replacement Platform API identity is invalid")
        names.append(platform_name)
    if len(names) < len(CORE_SERVICES):
        raise MonitorError("whole-product runtime inventory is incomplete")
    return json.loads(command(("docker", "inspect", *names), 90))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--seconds", type=int, default=240)
    parser.add_argument("--interval", type=float, default=2.0)
    args = parser.parse_args()
    if PROJECT.fullmatch(args.project) is None or not 30 <= args.seconds <= 600 or not 0.5 <= args.interval <= 10:
        raise MonitorError("monitor boundary is invalid")
    inspected = runtime_inventory(args.project)
    by_service = {}
    for item in inspected:
        labels = item["Config"].get("Labels") or {}
        service = labels.get("com.docker.compose.service")
        if item["Name"].removeprefix("/") == f"{args.project}-platform-api-1":
            service = "platform-api"
        if service:
            by_service[service] = item
    if not CORE_SERVICES.issubset(by_service):
        raise MonitorError("core-service inventory is incomplete")
    core = {service: by_service[service] for service in sorted(CORE_SERVICES)}
    core_names = [item["Name"].removeprefix("/") for item in core.values()]
    facts: dict[str, dict[str, Any]] = {}
    for service, item in core.items():
        facts[service] = {
            "containerId": item["Id"],
            "imageId": item["Image"],
            "memoryLimitBytes": item["HostConfig"].get("Memory", 0),
            "memoryReservationBytes": item["HostConfig"].get("MemoryReservation", 0),
            "nanoCpus": item["HostConfig"].get("NanoCpus", 0),
            "pidsLimit": item["HostConfig"].get("PidsLimit"),
            "maximumCpuPercent": 0.0,
            "maximumMemoryBytes": 0,
            "maximumMemoryPercent": 0.0,
            "unhealthySamples": 0,
            "maximumRestartCount": item.get("RestartCount", 0),
        }
    minimum_available = mem_available()
    maximum_load_one = float(Path("/proc/loadavg").read_text(encoding="utf-8").split()[0])
    sample_count = 0
    started = time.monotonic()
    deadline = started + args.seconds
    while True:
        current = json.loads(command(("docker", "inspect", *core_names), 90))
        current_by_name = {item["Name"].removeprefix("/"): item for item in current}
        statistics = command(("docker", "stats", "--no-stream", "--format", "{{json .}}", *core_names), 90)
        stats_by_name = {}
        for line in statistics.decode().splitlines():
            item = json.loads(line)
            stats_by_name[item.get("Name") or item.get("Container")] = item
        for service, initial in core.items():
            name = initial["Name"].removeprefix("/")
            item = current_by_name.get(name)
            if item is None or item["Id"] != facts[service]["containerId"] or item["Image"] != facts[service]["imageId"]:
                facts[service]["unhealthySamples"] += 1
                continue
            state = item["State"]
            health = state.get("Health", {}).get("Status", "none")
            if state.get("Status") != "running" or health not in {"healthy", "none"}:
                facts[service]["unhealthySamples"] += 1
            facts[service]["maximumRestartCount"] = max(facts[service]["maximumRestartCount"], item.get("RestartCount", 0))
            stat = stats_by_name.get(name)
            if stat:
                cpu = float(str(stat.get("CPUPerc", "0%")).removesuffix("%"))
                memory_text = str(stat.get("MemUsage", "0B / 0B")).split("/", 1)[0].strip()
                memory = bytes_value(memory_text)
                memory_percent = float(str(stat.get("MemPerc", "0%")).removesuffix("%"))
                facts[service]["maximumCpuPercent"] = max(facts[service]["maximumCpuPercent"], cpu)
                facts[service]["maximumMemoryBytes"] = max(facts[service]["maximumMemoryBytes"], memory)
                facts[service]["maximumMemoryPercent"] = max(facts[service]["maximumMemoryPercent"], memory_percent)
        minimum_available = min(minimum_available, mem_available())
        maximum_load_one = max(maximum_load_one, float(Path("/proc/loadavg").read_text(encoding="utf-8").split()[0]))
        sample_count += 1
        if time.monotonic() >= deadline:
            break
        time.sleep(min(args.interval, max(0.0, deadline - time.monotonic())))
    passed = sample_count >= 2 and all(item["unhealthySamples"] == 0 for item in facts.values())
    output = {
        "schemaVersion": 1,
        "status": "passed" if passed else "failed",
        "project": args.project,
        "durationMilliseconds": round((time.monotonic() - started) * 1000),
        "sampleCount": sample_count,
        "intervalMilliseconds": round(args.interval * 1000),
        "minimumHostAvailableMemoryBytes": minimum_available,
        "maximumHostLoadOne": maximum_load_one,
        "services": facts,
        "credentialsRetained": False,
        "commandOutputRetained": False,
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MonitorError, OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(json.dumps({"schemaVersion": 1, "status": "failed", "errorType": type(error).__name__},
                         sort_keys=True, separators=(",", ":")))
        raise SystemExit(1)
