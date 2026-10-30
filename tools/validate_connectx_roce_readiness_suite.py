#!/usr/bin/env python3
"""Validate ConnectX/RoCE readiness gates and premature-enablement policy."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "architecture/validation/connectx-roce-readiness-suite.v1.json"
GATES = [
    "link-health", "mtu-consistency", "addressing-and-reachability",
    "rdma-device-mapping", "roce-gid-and-mode", "topology",
    "rdma-bandwidth", "rdma-latency", "collective-communication",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def load(path: Path = SUITE) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), "ConnectX readiness suite is not an object")
    return value


def validate(path: Path = SUITE) -> dict[str, Any]:
    suite = load(path)
    require(suite.get("schemaVersion") == 1 and suite.get("suiteId") == "cluster.connectx-roce-readiness.v1", "ConnectX readiness suite identity drifted")
    require(suite.get("claimBoundary") == "ConnectX/RoCE link and collective readiness only; distributed model profiles remain disabled until every gate passes for the exact topology and environment", "ConnectX claim boundary drifted")
    target = suite.get("target", {})
    require(target.get("minimumNodeCount", 0) >= 2 and target.get("architecture") == "linux/arm64/v8", "ConnectX target node/architecture gate is invalid")
    require(target.get("driver") == "mlx5_core" and target.get("linkLayer") == "Ethernet" and target.get("requiredRoceMode") == "RoCE v2", "ConnectX driver/RoCE gate drifted")
    require(target.get("minimumNegotiatedBitsPerSecond", 0) >= 100_000_000_000 and target.get("requiredMtu") == 9000, "ConnectX link/MTU gate is too weak")
    require(suite.get("orderedGates") == GATES, "ConnectX ordered gate coverage drifted")
    qualification = suite.get("qualification", {})
    require(qualification.get("minimumBidirectionalRdmaBitsPerSecond", 0) >= 80_000_000_000, "ConnectX RDMA bandwidth gate is too weak")
    require(0 < qualification.get("maximumRdmaLatencyMicrosecondsP95", 0) <= 50, "ConnectX RDMA latency gate is invalid")
    require(qualification.get("requiredCollective") == "all-reduce" and qualification.get("requiredPayloadBytes") == [1_048_576, 67_108_864, 1_073_741_824], "ConnectX collective coverage drifted")
    require(qualification.get("minimumCollectiveAlgorithmBytesPerSecond", 0) >= 8_000_000_000 and qualification.get("maximumCollectiveLatencyMillisecondsP95", 0) <= 5, "ConnectX collective performance gate is invalid")
    require(qualification.get("maximumLinkErrorsOrDrops") == 0 and qualification.get("requireStableTopologyDigest") is True and qualification.get("requireExactEnvironmentDigest") is True and qualification.get("requireExactCleanup") is True, "ConnectX strict qualification gates are incomplete")
    profile = suite.get("profileGate", {})
    require(profile.get("defaultDistributedProfilesEnabled") is False, "ConnectX distributed profiles default to enabled")
    require(all(profile.get(key) is True for key in ("enableOnlyAfterAllOrderedGatesPass", "enableOnlyForExactTopologyDigest", "enableOnlyForExactEnvironmentDigest", "invalidateOnLinkMtuAddressGidDriverFirmwareOrTopologyChange")), "ConnectX profile fencing policy is incomplete")
    return {"valid": True, "suiteId": suite["suiteId"], "suiteDigest": digest(suite), "gateCount": len(GATES)}


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
