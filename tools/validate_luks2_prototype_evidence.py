#!/usr/bin/env python3
"""Validate real disposable-media LUKS2 lifecycle evidence."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping

try:
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_spark_model_baseline import canonical_digest


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "evidence/validation/storage/luks2-prototype-latest.json"
SOURCE = ROOT / "tools/luks2_disposable_prototype.py"
RUN_ID = re.compile(r"^luks2-prototype-[0-9]{8}-[a-z0-9][a-z0-9-]{1,31}$")
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
FORBIDDEN_KEYS = frozenset({"key", "keyBytes", "passphrase", "secret", "token", "recoveryKey", "automaticKey", "webKey"})
CHECKS = {
    "automaticUnlock", "defaultCloseReopen", "wrongPassphraseRejected", "webPassphraseUnlock",
    "keySlotInventory", "automaticRotation", "oldAutomaticRevoked",
    "webSlotRevoked", "explicitClose", "offlineRecovery", "contentPreserved",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def without_digest(value: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(value)
    result.pop("evidenceDigest", None)
    return result


def assert_no_key_material(value: Any, path: str = "evidence") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            require(str(key) not in FORBIDDEN_KEYS, f"{path}.{key} retains unlock material")
            assert_no_key_material(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_key_material(child, f"{path}[{index}]")


def validate(path: Path = REPORT) -> dict[str, Any]:
    require(path.is_file(), "LUKS2 prototype evidence is missing")
    report = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(report, dict) and report.get("schemaVersion") == 1, "LUKS2 evidence schema is invalid")
    require(RUN_ID.fullmatch(str(report.get("runId", ""))) is not None, "LUKS2 run identity is invalid")
    require(report.get("target") in {"dgx-spark-dev-01", "dgx-spark-worker-02"}, "LUKS2 prototype did not run on an allowlisted development Spark")
    require(report.get("claimBoundary") == "disposable regular-file LUKS2 lifecycle only; no active development partition migration", "LUKS2 claim boundary drifted")
    require(report.get("outcome") == "passed" and report.get("claimEligible") is True and report.get("failure") is None, "LUKS2 prototype did not pass")
    require(report.get("evidenceDigest") == canonical_digest(without_digest(report)), "LUKS2 evidence digest drifted")
    expected_source = "sha256:" + hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    require(report.get("sourceDigest") == expected_source, "LUKS2 executable source drifted")
    require(isinstance(report.get("startedAt"), str) and isinstance(report.get("finishedAt"), str) and report["finishedAt"] > report["startedAt"], "LUKS2 timestamps are invalid")
    require(report.get("cleanup") == {"runnerStagingRemoved": True}, "LUKS2 runner staging was not removed")

    prototype = report.get("prototype", {})
    require(prototype.get("schemaVersion") == 1 and prototype.get("runId") == report["runId"], "LUKS2 prototype identity drifted")
    require(prototype.get("targetKind") == "disposable-regular-file" and prototype.get("backingPathClass") == "/tmp/teamaibox-luks-prototype-*/volume.img", "LUKS2 backing target is not disposable")
    require(prototype.get("activeRootDeviceTouched") is False, "LUKS2 prototype touched the active root device")
    require(isinstance(prototype.get("sizeMiB"), int) and 512 <= prototype["sizeMiB"] <= 4096, "LUKS2 prototype size is unsafe")
    require(prototype.get("filesystem") == "ext4" and str(prototype.get("mapper", "")).startswith("teamaibox-luks-prototype-"), "LUKS2 mapper or filesystem drifted")
    require(prototype.get("initialSlots") == [0, 1, 2] and prototype.get("finalSlots") == [1, 3], "LUKS2 slot lifecycle drifted")
    checks = prototype.get("checks", {})
    require(set(checks) == CHECKS and all(value is True for value in checks.values()), "LUKS2 lifecycle checks are incomplete")
    require(SHA256.fullmatch(str(prototype.get("sentinelSha256", ""))) is not None, "LUKS2 recovery content evidence is invalid")
    require(prototype.get("cleanup") == {"unmounted": True, "mapperClosed": True, "workDirectoryRemoved": True, "passed": True}, "LUKS2 disposable target cleanup failed")
    require(prototype.get("outcome") == "passed", "LUKS2 inner prototype failed")
    assert_no_key_material(report)
    return {
        "valid": True,
        "runId": report["runId"],
        "evidenceDigest": report["evidenceDigest"],
        "initialSlots": prototype["initialSlots"],
        "finalSlots": prototype["finalSlots"],
        "activeRootDeviceTouched": False,
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
