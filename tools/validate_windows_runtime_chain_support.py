#!/usr/bin/env python3
"""Strictly validate a Windows multi-predecessor runtime rollout."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
BASE = "sha256:05fcf79303d13c4858c6f5994912cad4c4ebb0d6a77f4004ff0171bd0330db1e"
INTERMEDIATE = "sha256:75e90b485a6de407338e69ad53fc5652446520a467e6f6203a21229a8b19a95d"
CURRENT = "sha256:b72497b9c5c7efb24cb797d517f900f9813661df245dbe6d03a21aac590fce40"


def need(value, message):
    if not value: raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args(); path = args.evidence if args.evidence.is_absolute() else ROOT / args.evidence
    value = json.loads(path.read_bytes())
    need(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.windows-runtime-chain-support.v1", "schema")
    need(re.fullmatch(r"windows-runtime-chain-support-\d{8}-a[1-9]\d*", value.get("runId", "")), "run_id")
    need(value.get("status") == "passed" and value.get("failure") is None and value.get("rollbackFailure") is None, "status")
    need(value.get("sourceTests") == {"passed": True}, "tests")
    for name, digest in value.get("sources", {}).items():
        source = ROOT / name; need(source.is_file(), "source_missing:" + name)
        need("sha256:" + hashlib.sha256(source.read_bytes()).hexdigest() == digest, "source_changed:" + name)
    before = value["configurationBefore"]["policy"]["runtimeUpdates"]["windows-11-arm64-25h2"]
    after = value["configurationAfter"]["policy"]["runtimeUpdates"]["windows-11-arm64-25h2"]
    need(before == {"from": INTERMEDIATE, "to": CURRENT}, "parent_update")
    need(after == {"from": [BASE, INTERMEDIATE], "to": CURRENT}, "successor_update")
    need(len(value["configurationAfter"]["installedNodes"]) == 1, "auxiliary_not_disabled")
    need(value["computersBefore"] == value["computersAfter"] and value["phonesBefore"] == value["phonesAfter"], "guest_changed")
    need(value.get("guestRestarted") is False and value.get("guestDataChanged") is False, "guest_claim")
    need(value["parent"]["id"] != value["successor"]["id"] and value["candidateImage"] == value["successor"]["image"], "cutover")
    print(json.dumps({"status": "passed", "runId": value["runId"], "evidence": str(path),
                      "evidenceSha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}))


if __name__ == "__main__": main()
