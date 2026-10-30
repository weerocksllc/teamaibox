#!/usr/bin/env python3
"""Strictly validate one superseded disposable Encryption fixture cleanup record."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
UTC = re.compile(r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$")
FIELDS = {
    "schemaVersion", "runnerId", "cleanupId", "status", "target", "deployment", "plan",
    "projectCleanup", "protectedDeployment", "luksRunId", "rootsRemoved", "mappersClosed",
    "backupVolumeRemoved", "helperPathRemoved", "protectedContainers", "activeRootDeviceTouched",
    "completedAt", "credentialsRetained", "factorMaterialRetained", "commandOutputRetained", "evidenceDigest",
}

if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.run_feature_arm64_deployment import canonical_bytes, digest_bytes
from tools.validate_superseded_feature_deployment_cleanup import validate as validate_project_cleanup


class ValidationFailure(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailure(message)


def bound_file(binding: Any, fields: set[str], label: str) -> Mapping[str, Any]:
    require(isinstance(binding, Mapping) and set(binding) == fields, f"{label} binding fields drifted")
    relative = binding.get("path")
    require(isinstance(relative, str) and relative.startswith(("evidence/", "deploy/")) and ".." not in Path(relative).parts,
            f"{label} path is unsafe")
    path = ROOT / relative
    require(path.is_file() and binding.get("digest") == digest_bytes(path.read_bytes()), f"{label} digest changed")
    return json.loads(path.read_text(encoding="utf-8"))


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and ROOT in resolved.parents, "fixture cleanup evidence is unscoped")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(isinstance(value, Mapping) and set(value) == FIELDS and value.get("schemaVersion") == 1
            and value.get("runnerId") == "teamaibox.superseded-encryption-fixture-cleanup.v1"
            and value.get("status") == "passed", "fixture cleanup identity drifted")
    digest = value.get("evidenceDigest")
    payload = dict(value); payload.pop("evidenceDigest", None)
    require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None
            and digest == digest_bytes(canonical_bytes(payload)), "fixture cleanup digest changed")
    deployment = bound_file(value["deployment"], {"path", "digest", "runId"}, "deployment")
    plan = bound_file(value["plan"], {"path", "digest"}, "plan")
    project_cleanup = bound_file(value["projectCleanup"], {"path", "digest", "cleanupId"}, "project cleanup")
    protected = bound_file(value["protectedDeployment"], {"path", "digest", "runId"}, "protected deployment")
    validate_project_cleanup(ROOT / value["projectCleanup"]["path"])
    require(deployment.get("runId") == value["deployment"]["runId"] == plan.get("runId")
            and deployment.get("featureKey") == "admin.encryption" and project_cleanup.get("ownedRunId") == deployment["runId"]
            and project_cleanup.get("cleanupId") == value["projectCleanup"]["cleanupId"],
            "superseded deployment binding drifted")
    require(protected.get("runId") == value["protectedDeployment"]["runId"]
            and protected.get("featureKey") == "admin.encryption" and protected.get("status") == "passed"
            and protected.get("runId") != deployment.get("runId"), "protected deployment binding drifted")
    environment = plan.get("environment", {})
    data_root = environment.get("TEAMAIBOX_DATA_ROOT")
    primary = environment.get("TEAMAIBOX_LUKS_ROOT")
    if primary is None and isinstance(data_root, str) and data_root.endswith("/mount"):
        primary = str(Path(data_root).parent)
    spare = str(Path(environment.get("TEAMAIBOX_SPARE_DATA_ROOT", "/invalid")).parent)
    backup = environment.get("TEAMAIBOX_BACKUP_CONTROL_VOLUME")
    suffix = deployment["runId"].rsplit("-", 1)[-1]
    require(value.get("rootsRemoved") == [primary, spare]
            and isinstance(primary, str) and primary.startswith("/tmp/teamaibox-luks-unlock-integration-")
            and data_root == primary + "/mount"
            and spare.startswith("/tmp/teamaibox-luks-storage-spare-"), "fixture root scope drifted")
    require(value.get("luksRunId") == Path(primary).name.removeprefix("teamaibox-")
            and value.get("backupVolumeRemoved") == backup
            and value.get("helperPathRemoved") == f"/tmp/teamaibox-luks-{suffix}-tools",
            "fixture resource identity drifted")
    mappers = value.get("mappersClosed")
    require(isinstance(mappers, list) and len(mappers) == 2
            and all(isinstance(item, str) and item.startswith("/dev/mapper/teamaibox-luks-") for item in mappers),
            "fixture mapper scope drifted")
    containers = value.get("protectedContainers")
    require(isinstance(containers, list) and containers
            and all(isinstance(item, Mapping) and set(item) == {"name", "containerId", "imageId", "health"}
                    and item["name"].startswith(protected["composeProject"] + "-")
                    and SHA256.fullmatch(item["imageId"]) is not None
                    and item["health"] in {"healthy", "not-configured"} for item in containers),
            "protected container evidence drifted")
    require(value.get("target") == deployment.get("target") == "dgx-spark-dev-01"
            and value.get("activeRootDeviceTouched") is False and UTC.fullmatch(str(value.get("completedAt"))) is not None
            and value.get("credentialsRetained") is False and value.get("factorMaterialRetained") is False
            and value.get("commandOutputRetained") is False, "fixture cleanup safety facts drifted")
    return {"valid": True, "cleanupId": value["cleanupId"], "status": value["status"],
            "ownedRunId": deployment["runId"], "protectedRunId": protected["runId"], "luksRunId": value["luksRunId"]}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValidationFailure, ValueError, OSError, json.JSONDecodeError) as error:
        print(f"superseded Encryption fixture cleanup invalid: {error}")
        raise SystemExit(1)
