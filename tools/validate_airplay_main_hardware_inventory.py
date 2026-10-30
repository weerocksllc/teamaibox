#!/usr/bin/env python3
"""Strictly validate the fail-closed AirPlay/HDMI hardware inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

try:
    from .run_airplay_main_hardware_inventory import ROOT, RUN_ID, SOURCES, inspect_live
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_airplay_main_hardware_inventory import ROOT, RUN_ID, SOURCES, inspect_live
    from run_spark_model_baseline import canonical_digest


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def validate(path: Path) -> dict[str, object]:
    resolved = path.resolve()
    require(resolved.is_file() and resolved.parent == (ROOT / "evidence/validation/hardware").resolve(),
            "AirPlay inventory evidence path invalid")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    recorded = value.get("evidenceDigest")
    unsigned = dict(value); unsigned.pop("evidenceDigest", None)
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", str(recorded)) is not None
            and recorded == canonical_digest(unsigned), "AirPlay inventory evidence digest drifted")
    require(value.get("runnerId") == "teamaibox.airplay-main-hardware-inventory.v1"
            and RUN_ID.fullmatch(value.get("runId", "")) is not None and value.get("status") == "passed",
            "AirPlay inventory status invalid")
    require({item["path"]: item["sha256"] for item in value.get("sources", [])}
            == {source.relative_to(ROOT).as_posix(): digest(source) for source in SOURCES},
            "AirPlay inventory sources drifted")
    inventory = value.get("inventory") or {}
    display = inventory.get("display") or {}
    gst = inventory.get("gstreamer") or {}
    decision = inventory.get("decision") or {}
    require(inventory.get("architecture") == "aarch64"
            and inventory.get("operatingSystem") == {"id": "ubuntu", "versionId": "24.04"}
            and display.get("hdmiConnectorPresent") is True
            and display.get("baseline1080p30Proven") is False
            and inventory.get("audio", {}).get("deviceNodesPresent") is True
            and inventory.get("discovery", {}).get("avahiActive") is True
            and inventory.get("discovery", {}).get("sameLayer2Required") is True
            and isinstance(gst.get("version"), str)
            and decision.get("supportedEnvironment") is False
            and decision.get("syntheticSubstitutionAllowed") is False
            and "physical_apple_sender_not_exercised" in decision.get("reasonCodes", []),
            "AirPlay fail-closed inventory facts invalid")
    claim = value.get("claimBoundary") or {}
    require(claim == {"inventoryComplete": True, "supportedEnvironment": False,
                      "realHdmiValidated": False, "realAppleSenderValidated": False,
                      "task22_2Complete": True, "task22_6Complete": False,
                      "task22_10Complete": False}, "AirPlay inventory claim boundary drifted")
    live = inspect_live()
    require(live["architecture"] == inventory["architecture"]
            and live["operatingSystem"] == inventory["operatingSystem"]
            and live["display"]["hdmiConnectorPresent"] is True
            and live["devices"]["/dev/dri/card0"]["present"] is True
            and live["devices"]["/dev/dri/renderD128"]["present"] is True
            and live["discovery"]["avahiActive"] is True,
            "stable live AirPlay hardware prerequisites drifted")
    return {"valid": True, "runId": value["runId"], "evidenceDigest": recorded,
            "supportedEnvironment": False, "reasonCodes": decision["reasonCodes"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
