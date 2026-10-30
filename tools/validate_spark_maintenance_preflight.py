#!/usr/bin/env python3
"""Strictly validate one immutable Spark maintenance-preflight run."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re


ROOT = Path(__file__).resolve().parents[1]
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    path = Path(args.evidence)
    if not path.is_absolute():
        path = ROOT / path
    value = json.loads(path.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1 and value.get("evidenceClass") == "spark-host-maintenance-preflight" and value.get("status") == "passed", "evidence identity/state is invalid")
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{7,79}", str(value.get("runId", ""))) is not None and path.name == value["runId"] + ".json", "run identity is invalid")
    target = value.get("target")
    require(isinstance(target, dict) and target.get("key") in {"dgx-spark-dev-01", "dgx-spark-dev-02"} and target.get("architecture") == "linux/arm64/v8" and "address" not in target, "target evidence is invalid")
    require(SHA256.fullmatch(str(value.get("sourceDigest", ""))) is not None and SHA256.fullmatch(str(value.get("imageId", ""))) is not None, "source/image identity is invalid")
    bindings = value.get("sourceBindings")
    require(isinstance(bindings, dict) and len(bindings) >= 20, "source bindings are incomplete")
    for name, expected in bindings.items():
        pure = PurePosixPath(name)
        require(not pure.is_absolute() and ".." not in pure.parts and SHA256.fullmatch(str(expected)) is not None, "source binding is unsafe")
        source = ROOT / pure
        require(source.is_file() and "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest() == expected, f"source binding drifted: {name}")
    canonical = json.dumps(bindings, sort_keys=True, separators=(",", ":")).encode()
    require("sha256:" + hashlib.sha256(canonical).hexdigest() == value["sourceDigest"], "aggregate source digest drifted")
    transport = value.get("transport")
    require(isinstance(transport, dict) and transport == {"controllerSpiffe": "spiffe://teamaibox.local/controller/platform", "hmac": "sha256", "mutualTls": True, "planFenced": True, "tlsVersion": "TLSv1.3-minimum"}, "transport evidence is invalid")
    facts = value.get("compatiblePreflight")
    require(isinstance(facts, dict) and facts.get("passed") is True and facts.get("architecture") == "arm64" and facts.get("nodeGeneration") == 1 and SHA256.fullmatch(str(facts.get("evidenceDigest", ""))) is not None, "compatible preflight evidence is invalid")
    require(re.fullmatch(r"[0-9]{1,3}\.[0-9]{1,3}", str(facts.get("dockerApiVersion", ""))) is not None and isinstance(facts.get("nvidiaContainerIntegrationAvailable"), bool) and facts.get("nvidiaContainerIntegrationMode") in {"runtime", "cdi", "unavailable"} and facts.get("secureBootState") in {"enabled", "disabled", "unknown"}, "runtime facts are invalid")
    require(value.get("failureChecks") == {"duplicateSecureBootStateRejectedBeforeRuntime": True, "secureBootMismatchBlocked": True}, "failure checks are incomplete")
    boundary = value.get("mutationBoundary")
    require(isinstance(boundary, dict) and boundary.get("arbitraryCommandAccepted") is False and boundary.get("packagePlanAccepted") is False and boundary.get("imageMutationAccepted") is False and len(boundary.get("dockerRequests", [])) == 3, "mutation boundary is incomplete")
    require(value.get("logsRedacted") is True and value.get("cleanup") == {"passed": True, "residuals": []}, "redaction/cleanup evidence is incomplete")
    print(json.dumps({"valid": True, "runId": value["runId"], "target": target["key"], "secureBootState": facts["secureBootState"], "activeManagedWorkloads": facts["activeManagedWorkloads"]}, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
