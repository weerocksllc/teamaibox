#!/usr/bin/env python3
"""Validate sanitized local or peer ConnectX readiness evidence fail closed."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

try:
    from .validate_connectx_roce_readiness_suite import GATES, SUITE, load, validate as validate_suite
except ImportError:
    from validate_connectx_roce_readiness_suite import GATES, SUITE, load, validate as validate_suite


FORBIDDEN = frozenset({"address", "addresses", "ip", "mac", "hostname", "hostName", "guid", "nodeGuid", "systemGuid"})


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def safe(value: Any, path: str = "evidence") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            require(str(key) not in FORBIDDEN, f"{path}.{key} retains network or host identity")
            safe(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            safe(child, f"{path}[{index}]")


def validate_local_preflight(document: Mapping[str, Any]) -> dict[str, Any]:
    suite_result = validate_suite(SUITE)
    require(document.get("schemaVersion") == 1 and document.get("suiteId") == suite_result["suiteId"], "ConnectX preflight identity is invalid")
    require(document.get("probeKind") == "sanitized-local-read-only-preflight" and document.get("hostMutationPerformed") is False, "ConnectX preflight was not read-only")
    interfaces = document.get("interfaces")
    require(isinstance(interfaces, list) and interfaces, "ConnectX preflight has no interfaces")
    require(all(item.get("driver") in {None, "mlx5_core"} and isinstance(item.get("rdma", {}).get("devices"), list) for item in interfaces), "ConnectX preflight driver/RDMA shape is invalid")
    gates = document.get("gates")
    require(isinstance(gates, list) and [item.get("gate") for item in gates] == GATES, "ConnectX preflight gate order drifted")
    require(document.get("distributedProfilesEligible") is False, "Local ConnectX preflight enabled distributed profiles")
    require(all(item.get("status") == "requires-peer-qualification" for item in gates[-4:]), "Local ConnectX preflight claimed peer qualification")
    safe(document)
    return {"valid": True, "suiteDigest": suite_result["suiteDigest"], "interfaceCount": len(interfaces), "localPreflightPassed": document.get("localPreflightPassed") is True, "distributedProfilesEligible": False}


def validate(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(document, dict), "ConnectX evidence is not an object")
    if document.get("probeKind") == "sanitized-local-read-only-preflight":
        return validate_local_preflight(document)
    raise ValueError("unsupported ConnectX evidence kind")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.path), sort_keys=True, separators=(",", ":")))
