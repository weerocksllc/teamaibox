#!/usr/bin/env python3
"""Probe safe, read-only telemetry counters on a DGX Spark appliance.

The output is deliberately limited to aggregate host counters, this probe's
own process/cgroup, NVIDIA device index metrics, physical block aggregates, and
interface byte/packet counters. It does not collect addresses, peer data,
process lists, command lines, identifiers, or user content.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import time
from typing import Any, Iterable, Mapping, Sequence


PROBE_NAME = "teamaibox-spark-telemetry-probe"
PROBE_VERSION = "0.2.0"
SCHEMA_VERSION = "1.0"
DEFAULT_SAMPLE_SECONDS = 0.25

_SAFE_INTERFACE_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
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


def _read_text(path: pathlib.Path | str) -> str | None:
    try:
        return pathlib.Path(path).read_text(encoding="utf-8").strip()
    except (FileNotFoundError, PermissionError, OSError, UnicodeError):
        return None


def _safe_int(value: str | int | None) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _entry(
    category: str,
    counter: str,
    source: str,
    value: Any = None,
    unit: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "category": category,
        "counter": counter,
        "source": source,
        "status": "supported" if reason is None else "unsupported",
    }
    if reason is None:
        result["value"] = value
        if unit:
            result["unit"] = unit
    else:
        result["reason"] = reason
    return result


def _parse_cpu_stat(text: str | None) -> dict[str, int] | None:
    if not text:
        return None
    first = text.splitlines()[0].split()
    if not first or first[0] != "cpu":
        return None
    values = [_safe_int(raw) for raw in first[1:11]]
    if len(values) < 4 or any(value is None for value in values):
        return None
    names = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal", "guest", "guest_nice"]
    return {name: int(value) for name, value in zip(names, values) if value is not None}


def _cpu_delta(before: Mapping[str, int], after: Mapping[str, int]) -> dict[str, Any] | None:
    deltas = {key: max(0, after.get(key, 0) - value) for key, value in before.items()}
    # Linux accounts guest time inside user/nice, so it must not be counted a
    # second time when deriving total elapsed CPU time.
    total = sum(value for key, value in deltas.items() if key not in {"guest", "guest_nice"})
    if total <= 0:
        return None
    idle = deltas.get("idle", 0) + deltas.get("iowait", 0)
    return {
        "busy_percent": round((total - idle) * 100.0 / total, 2),
        "total_jiffies": total,
        "idle_jiffies": idle,
    }


def _parse_status_memory(text: str | None) -> dict[str, int] | None:
    if not text:
        return None
    allowlist = {
        "VmRSS": "resident_bytes",
        "VmSize": "virtual_bytes",
        "RssAnon": "anonymous_resident_bytes",
        "RssFile": "file_resident_bytes",
        "RssShmem": "shared_resident_bytes",
    }
    result: dict[str, int] = {}
    for line in text.splitlines():
        key, separator, raw = line.partition(":")
        destination = allowlist.get(key)
        if not separator or not destination:
            continue
        parts = raw.strip().split()
        value = _safe_int(parts[0] if parts else None)
        if value is None:
            continue
        if len(parts) > 1 and parts[1].lower() == "kb":
            value *= 1024
        result[destination] = value
    return result or None


def _parse_host_memory(text: str | None) -> dict[str, int] | None:
    if not text:
        return None
    allowlist = {
        "MemTotal": "total_bytes",
        "MemAvailable": "available_bytes",
        "SwapTotal": "swap_total_bytes",
        "SwapFree": "swap_free_bytes",
    }
    result: dict[str, int] = {}
    for line in text.splitlines():
        key, separator, raw = line.partition(":")
        destination = allowlist.get(key)
        if not separator or destination is None:
            continue
        parts = raw.strip().split()
        value = _safe_int(parts[0] if parts else None)
        if value is None or value < 0:
            continue
        if len(parts) > 1 and parts[1].lower() == "kb":
            value *= 1024
        result[destination] = value
    if "total_bytes" not in result or "available_bytes" not in result:
        return None
    if result["available_bytes"] > result["total_bytes"]:
        return None
    return result


def _parse_memory_pressure(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    result: dict[str, Any] = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts or parts[0] not in {"some", "full"}:
            continue
        values: dict[str, int | float] = {}
        for raw in parts[1:]:
            key, separator, value = raw.partition("=")
            if not separator or key not in {"avg10", "avg60", "avg300", "total"}:
                continue
            try:
                values[key] = int(value) if key == "total" else float(value)
            except ValueError:
                continue
        if values:
            result[parts[0]] = values
    return result or None


def _current_cgroup_dir() -> pathlib.Path | None:
    membership = _read_text("/proc/self/cgroup")
    if not membership:
        return None
    relative: str | None = None
    for line in membership.splitlines():
        parts = line.split(":", 2)
        if len(parts) == 3 and parts[0] == "0" and parts[1] == "":
            relative = parts[2].lstrip("/")
            break
    if relative is None or ".." in pathlib.PurePosixPath(relative).parts:
        return None
    root = pathlib.Path("/sys/fs/cgroup").resolve()
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        return None
    return target


def _parse_flat_key_values(text: str | None) -> dict[str, int] | None:
    if not text:
        return None
    result: dict[str, int] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or not re.fullmatch(r"[a-z0-9_.-]+", parts[0]):
            continue
        value = _safe_int(parts[1])
        if value is not None:
            result[parts[0]] = value
    return result or None


def _collect_cgroup_memory() -> dict[str, Any] | None:
    directory = _current_cgroup_dir()
    if directory is None:
        return None
    result: dict[str, Any] = {}
    for filename, output_name in (
        ("memory.current", "current_bytes"),
        ("memory.peak", "peak_bytes"),
        ("memory.max", "max_bytes"),
        ("memory.swap.current", "swap_current_bytes"),
        ("memory.swap.max", "swap_max_bytes"),
    ):
        raw = _read_text(directory / filename)
        if raw is None:
            continue
        result[output_name] = raw if raw == "max" else _safe_int(raw)
    events = _parse_flat_key_values(_read_text(directory / "memory.events"))
    if events:
        result["events"] = events
    return result or None


def _run(argv: Sequence[str], timeout: float = 5.0) -> tuple[bool, str]:
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
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False, ""
    if completed.returncode != 0:
        return False, ""
    return True, completed.stdout.strip()


def _collect_nvidia_metric(field: str) -> list[float] | None:
    ok, output = _run(
        ["nvidia-smi", "--query-gpu=" + field, "--format=csv,noheader,nounits"],
        timeout=8.0,
    )
    if not ok or not output:
        return None
    values: list[float] = []
    for line in output.splitlines():
        raw = line.strip()
        if raw in {"", "N/A", "[N/A]", "Not Supported"}:
            return None
        try:
            values.append(float(raw))
        except ValueError:
            return None
    return values or None


def _whole_physical_disks(sys_block: pathlib.Path = pathlib.Path("/sys/class/block")) -> set[str]:
    result: set[str] = set()
    try:
        entries = list(sys_block.iterdir())
    except (FileNotFoundError, PermissionError, OSError):
        return result
    for entry in entries:
        if (entry / "partition").exists() or not (entry / "device").exists():
            continue
        result.add(entry.name)
    return result


def _parse_diskstats(text: str | None, devices: Iterable[str]) -> dict[str, int] | None:
    selected = set(devices)
    if not text or not selected:
        return None
    totals = {
        "device_count": 0,
        "reads_completed": 0,
        "sectors_read": 0,
        "writes_completed": 0,
        "sectors_written": 0,
        "io_in_progress": 0,
        "io_time_milliseconds": 0,
    }
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 14 or fields[2] not in selected:
            continue
        numeric = [_safe_int(value) for value in fields[3:14]]
        if any(value is None for value in numeric):
            continue
        totals["device_count"] += 1
        totals["reads_completed"] += int(numeric[0])
        totals["sectors_read"] += int(numeric[2])
        totals["writes_completed"] += int(numeric[4])
        totals["sectors_written"] += int(numeric[6])
        totals["io_in_progress"] += int(numeric[8])
        totals["io_time_milliseconds"] += int(numeric[9])
    return totals if totals["device_count"] else None


def _interface_counters(root: pathlib.Path = pathlib.Path("/sys/class/net")) -> list[dict[str, Any]] | None:
    counters = ("rx_bytes", "rx_packets", "rx_errors", "rx_dropped", "tx_bytes", "tx_packets", "tx_errors", "tx_dropped")
    result: list[dict[str, Any]] = []
    try:
        entries = list(root.iterdir())
    except (FileNotFoundError, PermissionError, OSError):
        return None
    for entry in sorted(entries, key=lambda item: item.name):
        if not _SAFE_INTERFACE_NAME.fullmatch(entry.name) or not (entry / "device").exists():
            continue
        values: dict[str, Any] = {"interface": entry.name}
        for counter in counters:
            value = _safe_int(_read_text(entry / "statistics" / counter))
            if value is not None:
                values[counter] = value
        speed = _safe_int(_read_text(entry / "speed"))
        if speed is not None and speed >= 0:
            values["speed_megabits_per_second"] = speed
        carrier = _safe_int(_read_text(entry / "carrier"))
        if carrier in {0, 1}:
            values["carrier"] = bool(carrier)
        if len(values) > 1:
            result.append(values)
    return result or None


def assert_sanitized(value: Any, path: str = "$") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in _FORBIDDEN_KEYS or any(
                part in _FORBIDDEN_KEYS for part in normalized.split("_")
            ):
                raise ValueError(f"forbidden key at {path}: {key}")
            assert_sanitized(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_sanitized(child, f"{path}[{index}]")
    elif isinstance(value, str):
        if _MAC_RE.search(value) or _IPV4_RE.search(value):
            raise ValueError(f"address-shaped value at {path}")


def collect(sample_seconds: float = DEFAULT_SAMPLE_SECONDS) -> dict[str, Any]:
    matrix: list[dict[str, Any]] = []

    cpu_before = _parse_cpu_stat(_read_text("/proc/stat"))
    time.sleep(max(0.05, min(sample_seconds, 2.0)))
    cpu_after = _parse_cpu_stat(_read_text("/proc/stat"))
    cpu_value = _cpu_delta(cpu_before, cpu_after) if cpu_before and cpu_after else None
    matrix.append(
        _entry("cpu", "host_utilization", "/proc/stat", cpu_value, reason=None if cpu_value else "counter-unavailable")
    )

    host_memory = _parse_host_memory(_read_text("/proc/meminfo"))
    matrix.append(
        _entry(
            "memory",
            "host_unified_memory",
            "/proc/meminfo",
            host_memory,
            reason=None if host_memory else "counter-unavailable",
        )
    )

    memory_pressure = _parse_memory_pressure(_read_text("/proc/pressure/memory"))
    matrix.append(
        _entry(
            "memory",
            "host_pressure_stall",
            "/proc/pressure/memory",
            memory_pressure,
            reason=None if memory_pressure else "counter-unavailable",
        )
    )

    process_memory = _parse_status_memory(_read_text("/proc/self/status"))
    matrix.append(
        _entry(
            "memory",
            "probe_process",
            "/proc/self/status",
            process_memory,
            reason=None if process_memory else "counter-unavailable",
        )
    )

    cgroup_memory = _collect_cgroup_memory()
    matrix.append(
        _entry(
            "memory",
            "current_cgroup_v2",
            "/sys/fs/cgroup/<current>/memory.*",
            cgroup_memory,
            reason=None if cgroup_memory else "counter-unavailable",
        )
    )

    nvidia_fields = (
        ("gpu_utilization", "utilization.gpu", "percent"),
        ("temperature", "temperature.gpu", "degrees_celsius"),
        ("power_draw", "power.draw", "watts"),
        ("encoder_utilization", "utilization.encoder", "percent"),
        ("decoder_utilization", "utilization.decoder", "percent"),
        ("dedicated_memory_total", "memory.total", "mebibytes"),
        ("dedicated_memory_used", "memory.used", "mebibytes"),
        ("dedicated_memory_free", "memory.free", "mebibytes"),
    )
    for counter, field, unit in nvidia_fields:
        values = _collect_nvidia_metric(field)
        matrix.append(
            _entry(
                "nvidia",
                counter,
                "nvidia-smi --query-gpu=" + field,
                values,
                unit=unit,
                reason=None if values is not None else "metric-not-reported",
            )
        )

    disks = _parse_diskstats(_read_text("/proc/diskstats"), _whole_physical_disks())
    matrix.append(
        _entry(
            "disk",
            "physical_device_io",
            "/proc/diskstats + /sys/class/block",
            disks,
            reason=None if disks else "counter-unavailable",
        )
    )

    network = _interface_counters()
    matrix.append(
        _entry(
            "network",
            "physical_interface_io",
            "/sys/class/net/*/statistics",
            network,
            reason=None if network else "counter-unavailable",
        )
    )

    report = {
        "schema_version": SCHEMA_VERSION,
        "collected_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "probe": {
            "name": PROBE_NAME,
            "version": PROBE_VERSION,
            "read_only": True,
            "scope": "aggregate-host-and-self-only",
        },
        "sample_seconds": max(0.05, min(sample_seconds, 2.0)),
        "capabilities": matrix,
    }
    assert_sanitized(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true", help="indent JSON output")
    parser.add_argument("--sample-seconds", type=float, default=DEFAULT_SAMPLE_SECONDS)
    args = parser.parse_args()
    report = collect(args.sample_seconds)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
