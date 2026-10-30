#!/usr/bin/env python3
"""Validate the exact LUKS2 startup/unlock security scenario contract."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "architecture/validation/luks2-security-suite.v1.json"
PROTOTYPE = ROOT / "tools/luks2_disposable_prototype.py"
EXPECTED = [
    "default-reboot", "wrong-and-rate-limited-passphrase", "web-unlock", "usb-unlock",
    "unplug-idle", "unplug-read", "unplug-write", "unplug-ai-load", "drain-timeout",
    "crash-recovery", "lost-usb", "offline-recovery", "slot-rotation", "no-data-service-locked",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(value: Mapping[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def validate(path: Path = SUITE) -> dict[str, Any]:
    suite = json.loads(path.read_text(encoding="utf-8"))
    require(suite.get("schemaVersion") == 1 and suite.get("suiteId") == "security.luks2-startup-unlock.v1", "LUKS2 suite identity drifted")
    tier = suite.get("executionTiers", {})
    require(tier == {"deterministicContractTestsRequired": True, "realSparkDisposableVolumeRequired": True, "realUsbSdkAndDeviceRequired": True, "activeDevelopmentRootAllowed": False, "retainUnlockFactorsInEvidence": False}, "LUKS2 execution tiers drifted")
    scenarios = suite.get("scenarios", [])
    require([item.get("scenarioId") for item in scenarios] == EXPECTED, "LUKS2 scenario coverage or order drifted")
    prototype = PROTOTYPE.read_text(encoding="utf-8")
    for scenario in scenarios:
        source_path = ROOT / str(scenario.get("source", ""))
        require(source_path.is_file() and ROOT in source_path.resolve().parents, f"LUKS2 scenario {scenario.get('scenarioId')} source is missing")
        source = source_path.read_text(encoding="utf-8")
        exact = scenario.get("exactTest")
        require(isinstance(exact, str) and (f'test("{exact}"' in source or f"def {exact}(" in source), f"LUKS2 scenario {scenario.get('scenarioId')} has no exact executable test")
        check = scenario.get("prototypeCheck")
        if check is not None:
            require(isinstance(check, str) and f'"{check}": True' in prototype, f"LUKS2 prototype check {check} is missing")
    acceptance = suite.get("acceptance", {})
    require(acceptance.get("maximumFailedScenarios") == 0, "LUKS2 suite permits failures")
    require(all(acceptance.get(key) is True for key in ("requireExactScenarioCoverage", "requireFactorRedaction", "requireBoundedDrain", "requireHeaderRollback", "requireZeroResidualMapperMountAndWorkdir", "requireNoProtectedServiceWhileLocked")), "LUKS2 acceptance gate is disabled")
    return {"valid": True, "suiteId": suite["suiteId"], "suiteDigest": digest(suite), "scenarioCount": len(scenarios), "requiresRealUsb": True}


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
