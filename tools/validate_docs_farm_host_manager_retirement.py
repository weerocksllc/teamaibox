#!/usr/bin/env python3
"""Strictly validate the exact DocsFarm host-manager retirement."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from typing import Sequence

from retire_docs_farm_host_managers import EVIDENCE_ROOT, ROOT, UNITS, container_facts, unit_facts
from run_spark_model_baseline import canonical_digest


class ValidationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def digest(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    path = args.evidence.resolve()
    require(path.is_file() and path.is_relative_to(EVIDENCE_ROOT),
            "host-manager retirement evidence path is unsafe")
    value = json.loads(path.read_text(encoding="utf-8"))
    recorded = value.pop("evidenceDigest", None)
    require(recorded == canonical_digest(value), "host-manager retirement digest drifted")
    value["evidenceDigest"] = recorded
    require(value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.docs-farm-host-manager-retirement.v1"
            and value.get("status") == "passed" and value.get("failure") is None,
            "host-manager retirement identity drifted")
    require(value.get("scope") == {"unitCount": 19, "units": list(UNITS),
            "unitFilesDeleted": False, "containersDeleted": False,
            "volumesDeleted": False, "hostPackagesChanged": False},
            "host-manager retirement scope drifted")
    require(value.get("before", {}).get("retainedContainerCount")
            == value.get("after", {}).get("retainedContainerCount")
            and value["before"]["retainedContainerDigest"]
            == value["after"]["retainedContainerDigest"],
            "retained container identity changed during retirement")
    require(value.get("validation") == {"allUnitsInactiveAndDisabled": True,
            "allContainerIdentitiesUnchanged": True, "docsFarmContainerCount": 33,
            "teamAiBoxContainerCount": 66},
            "host-manager retirement validation coverage drifted")
    require(value.get("rollback") == {"performed": False, "available": True,
            "commandRetained": False, "unitFilesPreserved": True},
            "host-manager retirement rollback boundary drifted")
    for item in value.get("sources", []):
        selected = ROOT / item["path"]
        require(selected.is_file() and item.get("sha256") == digest(selected.read_bytes()),
                f"host-manager retirement source drifted: {item['path']}")
    require(value.get("privacy") == {"credentialsRetained": False,
            "environmentRetained": False, "commandOutputRetained": False,
            "userContentRetained": False}, "host-manager retirement privacy drifted")
    require(value.get("claimBoundary") == {"authorizedDocsFarmHostManagerRetirement": True,
            "hostAllowlistRenewed": False, "releaseEvidenceEligible": False,
            "productAccepted": False}, "host-manager retirement claim boundary drifted")
    live_units = unit_facts()
    require(all(row["ActiveState"] == "inactive" and row["UnitFileState"] == "disabled"
                and row["FragmentPath"] == f"/etc/systemd/system/{unit}"
                for unit, row in live_units.items()),
            "a retired DocsFarm host manager became active or enabled")
    live_containers = container_facts()
    require(len([name for name in live_containers if name.startswith(("docs-farm-", "serverdocsfarm-"))]) == 33
            and len([name for name in live_containers if name.startswith(("teamaibox_", "teamaibox-"))]) == 66
            and all("Up " in row["status"] for row in live_containers.values()),
            "retained DocsFarm or Team AI Box live containers drifted")
    tests = subprocess.run(("python3", "-m", "unittest",
                            "tests.test_validate_docs_farm_host_manager_retirement"),
                           cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=60, check=False)
    require(tests.returncode == 0, "host-manager retirement validator tests failed")
    print(json.dumps({"runId": value["runId"], "status": "passed",
                      "evidenceDigest": recorded, "unitCount": 19,
                      "containersPreserved": True}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"DocsFarm host-manager retirement validation failed: {error}")
