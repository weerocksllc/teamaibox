#!/usr/bin/env python3
"""Strictly validate one exact protected-office probe credential rotation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RUN_ID = re.compile(r"^protected-office-probe-credential-[0-9]{8}-a[1-9][0-9]*$")
SHA = re.compile(r"^sha256:[0-9a-f]{64}$")


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def canonical(value: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    path = Path(args.evidence).resolve()
    require(path.is_file() and path.parent == (ROOT / "evidence/validation/feature-deployments").resolve(),
            "credential evidence path is not exact")
    value = json.loads(path.read_text())
    recorded = value.pop("evidenceDigest", None)
    require(SHA.fullmatch(str(recorded or "")) is not None and recorded == canonical(value),
            "credential evidence digest drifted")
    value["evidenceDigest"] = recorded
    require(value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.protected-office-probe-credential.v1"
            and RUN_ID.fullmatch(str(value.get("runId", ""))) is not None
            and path.name == value["runId"] + ".json" and value.get("status") == "passed"
            and value.get("failure") is None, "credential evidence identity or status drifted")
    runner = ROOT / value["source"]["path"]
    require(runner.resolve() == (ROOT / "tools/rotate_protected_office_probe_credential.py").resolve()
            and value["source"]["digest"] == "sha256:" + hashlib.sha256(runner.read_bytes()).hexdigest(),
            "credential runner source drifted")
    require(value.get("protocol") == {"publicHttps": True, "status": 200,
                                      "authenticatedRead": True, "exactProbeJob": True},
            "credential public HTTPS proof is incomplete")
    require(value.get("cleanup") == {"stagingRemoved": True, "secretMaterialRetained": False}
            and value.get("privacy") == {"credentialRetainedInEvidence": False,
                                          "credentialRetainedInLogs": False},
            "credential cleanup or privacy boundary drifted")
    require(value.get("credential", {}).get("active") is True
            and value["credential"].get("kind") == "developer"
            and value["credential"].get("scope") == "ai:invoke",
            "credential facts are incomplete")
    print(json.dumps({"valid": True, "runId": value["runId"],
                      "credentialId": value["credential"]["credentialId"],
                      "probeJobId": value["target"]["probeJobId"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
