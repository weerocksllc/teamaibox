#!/usr/bin/env python3
"""Collect a sanitized, read-only DGX Spark inventory as JSON.

The collector deliberately uses allowlisted commands and fields. It never asks
for host names, network addresses, hardware serials, device UUIDs, machine IDs,
boot IDs, credentials, environment variables, process command lines, or user
paths/content.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence


COLLECTOR_NAME = "teamaibox-spark-inventory"
COLLECTOR_VERSION = "0.1.0"
SCHEMA_VERSION = "1.0"

_MAC_RE = re.compile(r"(?i)(?:^|[^0-9a-f])(?:[0-9a-f]{2}:){5}[0-9a-f]{2}(?:$|[^0-9a-f])")
_IPV4_RE = re.compile(
    r"(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)"
    r"(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])"
)
_FORBIDDEN_KEYS = {
    "address",
    "boot_id",
    "credential",
    "hostname",
    "ip",
    "mac",
    "machine_id",
    "password",
    "serial",
    "token",
    "uuid",
}
_SAFE_INTERFACE_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_SYSTEM_MOUNT_ROLES = {
    "/": "root",
    "/boot": "boot",
    "/boot/efi": "efi",
    "/srv/teamaibox": "platform-data",
    "/var/lib/teamaibox": "platform-data",
}


@dataclass(frozen=True)
class CommandOutput:
    status: str
    stdout: str = ""
    reason: str | None = None
    returncode: int | None = None


class CommandRunner:
    """Run allowlisted read-only commands with bounded execution time."""

    def capture(self, argv: Sequence[str], timeout: float = 5.0) -> CommandOutput:
        try:
            completed = subprocess.run(
                list(argv),
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=timeout,
                env={"PATH": os.environ.get("PATH", "/usr/sbin:/usr/bin:/sbin:/bin"), "LC_ALL": "C"},
            )
        except FileNotFoundError:
            return CommandOutput(status="unsupported", reason="command-not-found")
        except subprocess.TimeoutExpired:
            return CommandOutput(status="error", reason="command-timeout")
        except OSError:
            return CommandOutput(status="error", reason="command-execution-failed")

        if completed.returncode != 0:
            return CommandOutput(
                status="unsupported",
                reason="command-returned-nonzero",
                returncode=completed.returncode,
            )
        return CommandOutput(status="ok", stdout=completed.stdout.strip(), returncode=0)


def _read_text(path: str) -> str | None:
    try:
        return pathlib.Path(path).read_text(encoding="utf-8").strip()
    except (FileNotFoundError, PermissionError, OSError, UnicodeError):
        return None


def _parse_os_release(text: str | None) -> dict[str, Any]:
    if not text:
        return {"status": "unsupported", "reason": "os-release-unavailable"}

    parsed: dict[str, str] = {}
    for raw_line in text.splitlines():
        if "=" not in raw_line or raw_line.lstrip().startswith("#"):
            continue
        key, value = raw_line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if key in {"ID", "VERSION_ID", "PRETTY_NAME"}:
            parsed[key.lower()] = value
    return {"status": "ok", **parsed}


def _safe_int(value: str | int | None) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _safe_float(value: str | float | None) -> float | None:
    try:
        parsed = str(value).strip()
        if parsed in {"", "N/A", "[N/A]", "Not Supported"}:
            return None
        return float(parsed)
    except (TypeError, ValueError):
        return None


def _status_value(output: CommandOutput, value: Any = None) -> dict[str, Any]:
    result: dict[str, Any] = {"status": output.status}
    if output.status == "ok":
        result["value"] = value if value is not None else output.stdout
    elif output.reason:
        result["reason"] = output.reason
    return result


def _collect_platform(runner: CommandRunner) -> dict[str, Any]:
    kernel = runner.capture(["uname", "-r"])
    architecture = runner.capture(["uname", "-m"])
    secure_boot = runner.capture(["mokutil", "--sb-state"])
    secure_boot_value: bool | None = None
    if secure_boot.status == "ok":
        normalized = secure_boot.stdout.lower()
        if "enabled" in normalized:
            secure_boot_value = True
        elif "disabled" in normalized:
            secure_boot_value = False

    hardware: dict[str, Any] = {"status": "ok"}
    safe_sysfs = {
        "system_vendor": "/sys/devices/virtual/dmi/id/sys_vendor",
        "product_name": "/sys/devices/virtual/dmi/id/product_name",
    }
    found = False
    for field, path in safe_sysfs.items():
        value = _read_text(path)
        if value:
            hardware[field] = value
            found = True
    if not found:
        hardware = {"status": "unsupported", "reason": "safe-hardware-fields-unavailable"}

    return {
        "os": _parse_os_release(_read_text("/etc/os-release")),
        "kernel_release": _status_value(kernel),
        "architecture": _status_value(architecture),
        "hardware": hardware,
        "secure_boot": _status_value(secure_boot, secure_boot_value),
    }


def _collect_cpu(runner: CommandRunner) -> dict[str, Any]:
    output = runner.capture(["lscpu", "-J"])
    if output.status != "ok":
        return _status_value(output)
    try:
        rows = json.loads(output.stdout).get("lscpu", [])
    except (json.JSONDecodeError, AttributeError):
        return {"status": "error", "reason": "lscpu-json-invalid"}

    allowlist = {
        "Architecture:": "architecture",
        "CPU(s):": "logical_cpus",
        "On-line CPU(s) list:": "online_cpu_list",
        "Model name:": "model_name",
        "Vendor ID:": "vendor_id",
        "Socket(s):": "sockets",
        "Core(s) per socket:": "cores_per_socket",
        "Thread(s) per core:": "threads_per_core",
        "NUMA node(s):": "numa_nodes",
        "Byte Order:": "byte_order",
    }
    result: dict[str, Any] = {"status": "ok"}
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        destination = allowlist.get(str(row.get("field", "")))
        if destination:
            value = row.get("data")
            if destination in {"logical_cpus", "sockets", "cores_per_socket", "threads_per_core", "numa_nodes"}:
                value = _safe_int(value)
            if value is not None:
                result[destination] = value

    topology = runner.capture(["lscpu", "-J", "-e=CPU,MODELNAME"])
    if topology.status == "ok":
        try:
            cpu_rows = json.loads(topology.stdout).get("cpus", [])
        except (json.JSONDecodeError, AttributeError):
            cpu_rows = []
        model_counts: dict[str, int] = {}
        for row in cpu_rows:
            if not isinstance(row, Mapping):
                continue
            model_name = row.get("modelname")
            if isinstance(model_name, str) and model_name:
                model_counts[model_name] = model_counts.get(model_name, 0) + 1
        if model_counts:
            result["model_groups"] = [
                {"model_name": model_name, "logical_cpus": count}
                for model_name, count in sorted(model_counts.items())
            ]
    return result


def _collect_memory() -> dict[str, Any]:
    text = _read_text("/proc/meminfo")
    if not text:
        return {"status": "unsupported", "reason": "meminfo-unavailable"}
    selected = {
        "MemTotal": "total_bytes",
        "MemAvailable": "available_bytes",
        "SwapTotal": "swap_total_bytes",
        "HugePages_Total": "hugepages_total",
        "Hugepagesize": "hugepage_size_bytes",
    }
    result: dict[str, Any] = {"status": "ok", "memory_model": "system-or-unified"}
    for line in text.splitlines():
        key, separator, raw_value = line.partition(":")
        destination = selected.get(key)
        if not separator or not destination:
            continue
        parts = raw_value.strip().split()
        value = _safe_int(parts[0] if parts else None)
        if value is None:
            continue
        if len(parts) > 1 and parts[1].lower() == "kb":
            value *= 1024
        result[destination] = value
    return result


def _parse_csv_rows(text: str, fields: Sequence[str]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in text.splitlines():
        values = [value.strip() for value in line.split(",")]
        if len(values) != len(fields):
            continue
        rows.append(dict(zip(fields, values)))
    return rows


def _collect_nvidia(runner: CommandRunner) -> dict[str, Any]:
    identity_fields = ["index", "name", "driver_version", "compute_cap"]
    identity = runner.capture(
        [
            "nvidia-smi",
            "--query-gpu=" + ",".join(identity_fields),
            "--format=csv,noheader,nounits",
        ]
    )
    header = runner.capture(["nvidia-smi"], timeout=8.0)
    cuda_driver_api: str | None = None
    if header.status == "ok":
        match = re.search(r"CUDA Version:\s*([0-9.]+)", header.stdout)
        if match:
            cuda_driver_api = match.group(1)

    if identity.status != "ok":
        return {
            "status": identity.status,
            "reason": identity.reason or "nvidia-smi-unavailable",
            "cuda_driver_api": cuda_driver_api,
        }

    gpus: list[dict[str, Any]] = []
    for row in _parse_csv_rows(identity.stdout, identity_fields):
        gpus.append(
            {
                "index": _safe_int(row["index"]),
                "name": row["name"],
                "driver_version": row["driver_version"],
                "compute_capability": row["compute_cap"],
            }
        )

    metric_fields = [
        "index",
        "utilization.gpu",
        "temperature.gpu",
        "power.draw",
        "pstate",
        "utilization.encoder",
        "utilization.decoder",
    ]
    metrics = runner.capture(
        [
            "nvidia-smi",
            "--query-gpu=" + ",".join(metric_fields),
            "--format=csv,noheader,nounits",
        ]
    )
    metric_rows: list[dict[str, Any]] = []
    if metrics.status == "ok":
        for row in _parse_csv_rows(metrics.stdout, metric_fields):
            metric_rows.append(
                {
                    "index": _safe_int(row["index"]),
                    "gpu_utilization_percent": _safe_float(row["utilization.gpu"]),
                    "temperature_celsius": _safe_float(row["temperature.gpu"]),
                    "power_watts": _safe_float(row["power.draw"]),
                    "performance_state": None if row["pstate"] in {"N/A", "[N/A]"} else row["pstate"],
                    "encoder_utilization_percent": _safe_float(row["utilization.encoder"]),
                    "decoder_utilization_percent": _safe_float(row["utilization.decoder"]),
                }
            )

    dedicated_memory = runner.capture(
        [
            "nvidia-smi",
            "--query-gpu=index,memory.total,memory.used,memory.free",
            "--format=csv,noheader,nounits",
        ]
    )
    memory_visibility: dict[str, Any]
    memory_rows = _parse_csv_rows(
        dedicated_memory.stdout,
        ["index", "memory.total", "memory.used", "memory.free"],
    )
    memory_values_supported = bool(memory_rows) and all(
        _safe_float(row[field]) is not None
        for row in memory_rows
        for field in ("memory.total", "memory.used", "memory.free")
    )
    if dedicated_memory.status == "ok" and memory_values_supported:
        memory_visibility = {"status": "ok", "kind": "dedicated", "note": "reported-by-driver"}
    else:
        memory_visibility = {
            "status": "unsupported",
            "kind": "unified-memory-platform",
            "reason": "dedicated-gpu-memory-not-reported",
        }

    return {
        "status": "ok",
        "cuda_driver_api": cuda_driver_api,
        "gpus": gpus,
        "live_metrics": _status_value(metrics, metric_rows),
        "gpu_memory_visibility": memory_visibility,
    }


def _parse_version_line(text: str) -> str | None:
    match = re.search(r"\b(?:version\s*)?([0-9]+(?:\.[0-9]+){1,3}(?:[-+._A-Za-z0-9]*)?)", text, re.I)
    return match.group(1) if match else None


def _collect_container_stack(runner: CommandRunner) -> dict[str, Any]:
    docker_version = runner.capture(["docker", "version", "--format", "{{json .Server}}"])
    docker: dict[str, Any] = {"status": docker_version.status}
    if docker_version.status == "ok":
        try:
            server = json.loads(docker_version.stdout)
            docker.update(
                {
                    "version": server.get("Version"),
                    "api_version": server.get("ApiVersion"),
                    "go_version": server.get("GoVersion"),
                    "os": server.get("Os"),
                    "architecture": server.get("Arch"),
                }
            )
        except (json.JSONDecodeError, AttributeError):
            docker = {"status": "error", "reason": "docker-version-json-invalid"}
    else:
        docker["reason"] = docker_version.reason

    delimiter = "|"
    docker_info = runner.capture(
        [
            "docker",
            "info",
            "--format",
            delimiter.join(
                [
                    "{{.Driver}}",
                    "{{.DefaultRuntime}}",
                    "{{.CgroupDriver}}",
                    "{{.CgroupVersion}}",
                    "{{.OSType}}",
                    "{{.Architecture}}",
                    "{{.NCPU}}",
                    "{{.MemTotal}}",
                    "{{json .Runtimes}}",
                ]
            ),
        ]
    )
    if docker_info.status == "ok":
        parts = docker_info.stdout.split(delimiter, 8)
        if len(parts) == 9:
            try:
                runtime_names = sorted(json.loads(parts[8]).keys())
            except (json.JSONDecodeError, AttributeError):
                runtime_names = []
            docker["info"] = {
                "storage_driver": parts[0],
                "default_runtime": parts[1],
                "cgroup_driver": parts[2],
                "cgroup_version": parts[3],
                "os": parts[4],
                "architecture": parts[5],
                "logical_cpus": _safe_int(parts[6]),
                "memory_bytes": _safe_int(parts[7]),
                "runtime_names": runtime_names,
            }
        else:
            docker["info"] = {"status": "error", "reason": "docker-info-format-invalid"}
    else:
        docker["info"] = _status_value(docker_info)

    ctk = runner.capture(["nvidia-ctk", "--version"])
    toolkit_version = runner.capture(
        ["dpkg-query", "-W", "-f=${Version}", "nvidia-container-toolkit"]
    )
    cdi = runner.capture(["nvidia-ctk", "cdi", "list"])
    cdi_count: int | None = None
    if cdi.status == "ok":
        found = re.search(r"Found\s+(\d+)\s+CDI", cdi.stdout, re.I)
        if found:
            cdi_count = int(found.group(1))
        elif not cdi.stdout:
            cdi_count = 0

    return {
        "docker": docker,
        "nvidia_container_toolkit": {
            "command": _status_value(ctk, _parse_version_line(ctk.stdout)),
            "package": _status_value(toolkit_version),
            "cdi_inventory": _status_value(cdi, {"device_count": cdi_count}),
        },
    }


def _mount_roles(mountpoints: Iterable[Any]) -> list[str]:
    roles = {
        _SYSTEM_MOUNT_ROLES[mount]
        for mount in mountpoints
        if isinstance(mount, str) and mount in _SYSTEM_MOUNT_ROLES
    }
    return sorted(roles)


def _collect_storage(runner: CommandRunner) -> dict[str, Any]:
    output = runner.capture(
        ["lsblk", "-b", "-J", "-o", "TYPE,SIZE,FSTYPE,MOUNTPOINTS,ROTA,TRAN"]
    )
    if output.status != "ok":
        return _status_value(output)
    try:
        roots = json.loads(output.stdout).get("blockdevices", [])
    except (json.JSONDecodeError, AttributeError):
        return {"status": "error", "reason": "lsblk-json-invalid"}

    devices: list[dict[str, Any]] = []

    def visit(nodes: Iterable[Mapping[str, Any]]) -> None:
        for node in nodes:
            entry = {
                "type": node.get("type"),
                "size_bytes": _safe_int(node.get("size")),
                "filesystem": node.get("fstype") or None,
                "mount_roles": _mount_roles(node.get("mountpoints") or []),
                "rotational": bool(node.get("rota")) if node.get("rota") is not None else None,
                "transport": node.get("tran") or None,
            }
            devices.append(entry)
            children = node.get("children") or []
            if isinstance(children, list):
                visit(children)

    if isinstance(roots, list):
        visit(roots)
    return {"status": "ok", "devices": devices}


def _collect_network() -> dict[str, Any]:
    root = pathlib.Path("/sys/class/net")
    try:
        interfaces = sorted(root.iterdir(), key=lambda path: path.name)
    except (FileNotFoundError, PermissionError, OSError):
        return {"status": "unsupported", "reason": "network-sysfs-unavailable"}

    result: list[dict[str, Any]] = []
    for interface in interfaces:
        if not _SAFE_INTERFACE_NAME.fullmatch(interface.name):
            continue
        driver: str | None = None
        try:
            driver = (interface / "device/driver").resolve(strict=True).name
        except (FileNotFoundError, PermissionError, OSError):
            pass
        speed = _safe_int(_read_text(str(interface / "speed")))
        mtu = _safe_int(_read_text(str(interface / "mtu")))
        result.append(
            {
                "name": interface.name,
                "physical": (interface / "device").exists(),
                "state": _read_text(str(interface / "operstate")),
                "mtu": mtu,
                "speed_mbps": speed if speed is not None and speed >= 0 else None,
                "duplex": _read_text(str(interface / "duplex")),
                "driver": driver,
                "loopback": interface.name == "lo",
            }
        )
    return {"status": "ok", "interfaces": result}


def assert_sanitized(value: Any, path: str = "$") -> None:
    """Reject forbidden keys and values before serialized output is emitted."""

    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = str(key).strip().lower().replace("-", "_")
            if normalized in _FORBIDDEN_KEYS:
                raise ValueError(f"forbidden inventory key at {path}: {normalized}")
            assert_sanitized(child, f"{path}.{normalized}")
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            assert_sanitized(child, f"{path}[{index}]")
        return
    if isinstance(value, str):
        if _MAC_RE.search(value):
            raise ValueError(f"MAC-like value rejected at {path}")
        if _IPV4_RE.search(value):
            raise ValueError(f"IPv4-like value rejected at {path}")


def collect_inventory(runner: CommandRunner | None = None) -> dict[str, Any]:
    active_runner = runner or CommandRunner()
    report = {
        "schema_version": SCHEMA_VERSION,
        "collected_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "collector": {
            "name": COLLECTOR_NAME,
            "version": COLLECTOR_VERSION,
            "read_only": True,
            "sanitization": "explicit-field-allowlist",
        },
        "platform": _collect_platform(active_runner),
        "cpu": _collect_cpu(active_runner),
        "memory": _collect_memory(),
        "nvidia": _collect_nvidia(active_runner),
        "container_stack": _collect_container_stack(active_runner),
        "storage": _collect_storage(active_runner),
        "network": _collect_network(),
    }
    assert_sanitized(report)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true", help="Indent the JSON output")
    parser.add_argument("--validate-only", action="store_true", help="Collect and validate without printing")
    args = parser.parse_args(argv)

    report = collect_inventory()
    if not args.validate_only:
        print(
            json.dumps(
                report,
                ensure_ascii=False,
                indent=2 if args.pretty else None,
                sort_keys=True,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
