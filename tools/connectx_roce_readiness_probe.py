#!/usr/bin/env python3
"""Collect a sanitized, read-only local ConnectX/RoCE readiness preflight."""

from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


INTERFACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
ACTIVE_STATE = re.compile(r"^4:\s+ACTIVE\b")


def read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip()
    except (FileNotFoundError, PermissionError, OSError):
        return None


def integer(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def link_target_name(path: Path) -> str | None:
    try:
        return path.resolve(strict=True).name
    except (FileNotFoundError, OSError):
        return None


def addresses(interface: str, runner: Callable[..., subprocess.CompletedProcess[str]]) -> dict[str, Any]:
    commands = [["/usr/sbin/ip", "-j", "address", "show", "dev", interface], ["/sbin/ip", "-j", "address", "show", "dev", interface], ["ip", "-j", "address", "show", "dev", interface]]
    for command in commands:
        try:
            result = runner(command, capture_output=True, text=True, timeout=5, check=False)
        except (FileNotFoundError, subprocess.SubprocessError):
            continue
        if result.returncode != 0:
            continue
        try:
            records = json.loads(result.stdout)
        except (json.JSONDecodeError, TypeError):
            continue
        families = {"inet": 0, "inet6": 0}
        for record in records if isinstance(records, list) else []:
            for item in record.get("addr_info", []):
                family = item.get("family")
                if family in families and item.get("scope") == "global":
                    families[family] += 1
        return {"probeAvailable": True, "globalIpv4Count": families["inet"], "globalIpv6Count": families["inet6"]}
    return {"probeAvailable": False, "globalIpv4Count": None, "globalIpv6Count": None, "errorCode": "address_probe_unavailable"}


def rdma_mapping(interface: str, sys_root: Path) -> dict[str, Any]:
    devices = []
    for match in sorted((sys_root / "class/infiniband").glob(f"*/device/net/{interface}")):
        rdma_name = match.parents[2].name
        ports_root = sys_root / "class/infiniband" / rdma_name / "ports"
        ports = []
        for port in sorted(ports_root.glob("[0-9]*"), key=lambda item: item.name):
            types = sorted({value for value in (read(item) for item in (port / "gid_attrs/types").glob("*")) if value})
            ports.append({
                "port": integer(port.name),
                "state": read(port / "state"),
                "physicalState": read(port / "phys_state"),
                "linkLayer": read(port / "link_layer"),
                "gidTypeCount": len(types),
                "roceModes": types,
            })
        devices.append({"rdmaDevice": rdma_name, "ports": ports})
    return {"mapped": bool(devices), "devices": devices}


def inspect_interface(interface: str, sys_root: Path, runner: Callable[..., subprocess.CompletedProcess[str]]) -> dict[str, Any]:
    if not INTERFACE.fullmatch(interface):
        raise ValueError("invalid interface name")
    root = sys_root / "class/net" / interface
    exists = root.exists()
    speed_mbps = integer(read(root / "speed")) if exists else None
    return {
        "interface": interface,
        "exists": exists,
        "operstate": read(root / "operstate") if exists else None,
        "carrier": integer(read(root / "carrier")) if exists else None,
        "speedMegabitsPerSecond": speed_mbps if speed_mbps is not None and speed_mbps >= 0 else None,
        "mtu": integer(read(root / "mtu")) if exists else None,
        "driver": link_target_name(root / "device/driver") if exists else None,
        "vendorId": read(root / "device/vendor") if exists else None,
        "deviceId": read(root / "device/device") if exists else None,
        "addressing": addresses(interface, runner) if exists else {"probeAvailable": False, "globalIpv4Count": None, "globalIpv6Count": None, "errorCode": "interface_missing"},
        "rdma": rdma_mapping(interface, sys_root) if exists else {"mapped": False, "devices": []},
    }


def probe(
    interfaces: list[str], *, sys_root: Path = Path("/sys"),
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    observed_at: str | None = None,
) -> dict[str, Any]:
    if not interfaces or len(interfaces) > 16 or len(set(interfaces)) != len(interfaces):
        raise ValueError("one to sixteen distinct interfaces are required")
    inspected = [inspect_interface(name, sys_root, runner) for name in interfaces]
    link_passed = all(item["exists"] and item["operstate"] == "up" and item["carrier"] == 1 and (item["speedMegabitsPerSecond"] or 0) >= 100_000 for item in inspected)
    mtu_passed = link_passed and all(item["mtu"] == 9000 for item in inspected)
    addressing_passed = mtu_passed and all(item["addressing"]["probeAvailable"] and ((item["addressing"]["globalIpv4Count"] or 0) + (item["addressing"]["globalIpv6Count"] or 0) > 0) for item in inspected)
    rdma_passed = addressing_passed and all(item["driver"] == "mlx5_core" and item["rdma"]["mapped"] and any(ACTIVE_STATE.match(port["state"] or "") and port["linkLayer"] == "Ethernet" for device in item["rdma"]["devices"] for port in device["ports"]) for item in inspected)
    roce_passed = rdma_passed and all(any("RoCE v2" in port["roceModes"] for device in item["rdma"]["devices"] for port in device["ports"]) for item in inspected)
    statuses = [
        {"gate": "link-health", "status": "passed" if link_passed else "failed"},
        {"gate": "mtu-consistency", "status": "passed" if mtu_passed else "blocked"},
        {"gate": "addressing-and-reachability", "status": "local-preflight-passed" if addressing_passed else "blocked"},
        {"gate": "rdma-device-mapping", "status": "local-preflight-passed" if rdma_passed else "blocked"},
        {"gate": "roce-gid-and-mode", "status": "local-preflight-passed" if roce_passed else "blocked"},
        {"gate": "topology", "status": "requires-peer-qualification"},
        {"gate": "rdma-bandwidth", "status": "requires-peer-qualification"},
        {"gate": "rdma-latency", "status": "requires-peer-qualification"},
        {"gate": "collective-communication", "status": "requires-peer-qualification"},
    ]
    return {
        "schemaVersion": 1,
        "suiteId": "cluster.connectx-roce-readiness.v1",
        "probeKind": "sanitized-local-read-only-preflight",
        "observedAt": observed_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "architecture": platform.machine(),
        "interfaces": inspected,
        "gates": statuses,
        "localPreflightPassed": roce_passed,
        "distributedProfilesEligible": False,
        "hostMutationPerformed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interfaces", required=True, help="comma-separated exact interface names")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    value = probe([item for item in args.interfaces.split(",") if item])
    print(json.dumps(value, sort_keys=True, indent=2 if args.pretty else None, separators=None if args.pretty else (",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
