#!/usr/bin/env python3
"""Validate the production boot/recovery and LUKS2 data-path boundary."""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
LAYOUT = ROOT / "deploy/storage/appliance-storage-layout.v1.json"
APPLIANCE_COMPOSE = ROOT / "deploy/appliance/compose.yaml"
CORE_COMPOSE = ROOT / "deploy/compose/core.yaml"
REQUIRED_CLASSES = {"database", "object", "model", "workspace", "plugin", "audit", "cache"}
REQUIRED_BOOT_FORBIDDEN = {
    "team_database", "object_blob", "model_artifact", "model_cache", "agent_workspace",
    "plugin_data", "plugin_cache", "audit_history", "platform_secret_ciphertext", "source_cache",
    "backup_payload", "recovery_key", "web_passphrase", "usb_private_material",
}
MODE = re.compile(r"^0[0-7]{3}$")
KEY = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
TEMPLATE_FIELD = re.compile(r"\{[a-z][A-Za-z0-9]*\}")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def safe_relative(value: Any, label: str, *, templates: bool = False) -> str:
    require(isinstance(value, str) and value and not value.startswith("/"), f"{label} must be relative")
    scrubbed = TEMPLATE_FIELD.sub("id", value) if templates else value
    path = PurePosixPath(scrubbed)
    require(".." not in path.parts and "." not in path.parts and "//" not in value, f"{label} escapes its root")
    require(all(part and part not in {".", ".."} for part in path.parts), f"{label} is invalid")
    return value


def top_level_blocks(source: str, section: str) -> dict[str, str]:
    marker = f"\n{section}:\n"
    start = source.rfind(marker)
    require(start >= 0, f"Compose section {section} is missing")
    lines = source[start + len(marker):].splitlines()
    blocks: dict[str, list[str]] = {}
    current: str | None = None
    for line in lines:
        if line and not line.startswith(" "):
            break
        match = re.fullmatch(r"  ([a-zA-Z0-9_-]+):", line)
        if match:
            current = match.group(1)
            blocks[current] = [line]
        elif current is not None:
            blocks[current].append(line)
    return {key: "\n".join(value) for key, value in blocks.items()}


def validate(path: Path = LAYOUT) -> dict[str, Any]:
    layout = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(layout, dict) and layout.get("schemaVersion") == 1, "storage layout schema is invalid")
    require(layout.get("layoutId") == "teamaibox.production-storage.v1", "storage layout identity drifted")
    require(isinstance(layout.get("claimBoundary"), str) and "LUKS2" in layout["claimBoundary"], "storage claim boundary is incomplete")

    boot = layout.get("bootRecovery", {})
    require(boot.get("root") == "/var/lib/teamaibox-unlock" and boot.get("services") == ["unlock-service"], "boot/recovery service boundary drifted")
    require(set(boot.get("forbiddenClasses", [])) == REQUIRED_BOOT_FORBIDDEN, "boot/recovery forbidden data classes are incomplete")
    artifacts = boot.get("artifacts")
    require(isinstance(artifacts, list) and artifacts, "boot/recovery artifacts are missing")
    artifact_paths: set[str] = set()
    for artifact in artifacts:
        item = safe_relative(artifact.get("path"), "boot artifact path")
        require(item not in artifact_paths, "boot artifact path is duplicated")
        artifact_paths.add(item)
        require(MODE.fullmatch(str(artifact.get("mode", ""))) is not None, "boot artifact mode is invalid")
        require(isinstance(artifact.get("purpose"), str) and artifact["purpose"], "boot artifact purpose is missing")
    automatic = [item for item in artifacts if item.get("path") == "automatic/key.bin"]
    require(len(automatic) == 1 and automatic[0].get("allowedOnlyWhen") == "startup_unlock_protection_disabled", "automatic key is not fenced by unlock mode")
    require(not any("recovery" in item.get("path", "") or "passphrase" in item.get("path", "") for item in artifacts), "offline recovery or passphrase material is mapped outside LUKS2")
    pending = [item for item in artifacts if item.get("path") == "audit/pending.jsonl"]
    require(len(pending) == 1 and pending[0].get("maximumBytes") == 1_048_576, "pre-unlock audit buffer is not bounded")

    volume = layout.get("protectedVolume", {})
    require(volume.get("environmentVariable") == "TEAMAIBOX_DATA_ROOT", "protected root environment contract drifted")
    require(volume.get("productionMountPoint") == "/srv/teamaibox/data" and volume.get("mapperName") == "teamaibox-data", "production mount or mapper identity drifted")
    require(volume.get("blockEncryption") == "luks2" and volume.get("encryptionRequired") is True, "LUKS2 is not mandatory")
    require(volume.get("filesystem") == "ext4" and set(volume.get("mountOptions", [])) >= {"nodev", "nosuid"}, "protected filesystem contract is invalid")
    require(volume.get("requiredBeforeProtectedServices") is True and volume.get("automaticUnlockDefault") is True, "protected service ordering or default unlock mode drifted")
    require(MODE.fullmatch(str(volume.get("rootMode", ""))) is not None, "protected root mode is invalid")

    mappings = layout.get("staticMappings")
    require(isinstance(mappings, list) and len(mappings) >= 20, "protected static path coverage is incomplete")
    keys: set[str] = set()
    paths: set[str] = set()
    volumes: set[str] = set()
    classes: set[str] = set()
    targets: list[str] = []
    for item in mappings:
        key = item.get("key")
        require(isinstance(key, str) and KEY.fullmatch(key) is not None and key not in keys, "protected mapping key is invalid or duplicated")
        keys.add(key)
        relative = safe_relative(item.get("relativePath"), f"{key} path")
        require(relative not in paths, "protected mapping path is duplicated")
        paths.add(relative)
        declared_classes = item.get("classes")
        require(isinstance(declared_classes, list) and declared_classes and all(isinstance(value, str) for value in declared_classes), f"{key} classes are invalid")
        classes.update(declared_classes)
        require(MODE.fullmatch(str(item.get("mode", ""))) is not None and int(item["mode"], 8) & 0o007 == 0, f"{key} grants access to other users")
        require(isinstance(item.get("owner"), str) and item["owner"], f"{key} owner is missing")
        compose_volume = item.get("composeVolume")
        require(isinstance(compose_volume, str) and compose_volume not in volumes, f"{key} Compose volume is invalid or duplicated")
        volumes.add(compose_volume)
        declared_targets = item.get("containerTargets")
        require(isinstance(declared_targets, list), f"{key} container targets are invalid")
        for target in declared_targets:
            require(isinstance(target, str) and ":/" in target, f"{key} container target is invalid")
            targets.append(f"{compose_volume}:{target.split(':', 1)[1]}")
    require(REQUIRED_CLASSES <= classes, "database/object/model/workspace/plugin/audit/cache coverage is incomplete")

    dynamic = layout.get("dynamicMappings")
    require(isinstance(dynamic, list) and len(dynamic) == 5, "dynamic plugin Agent and worker path coverage drifted")
    dynamic_keys: set[str] = set()
    for item in dynamic:
        key = item.get("key")
        require(isinstance(key, str) and KEY.fullmatch(key) is not None and key not in keys | dynamic_keys, "dynamic mapping key is invalid or duplicated")
        dynamic_keys.add(key)
        require(item.get("parentKey") in keys and item.get("allocator") == "node-agent", "dynamic path lacks a protected parent or Node Agent allocator")
        template = safe_relative(item.get("template"), f"{key} template", templates=True)
        require(TEMPLATE_FIELD.search(template) is not None and item.get("dockerStorage") == "protected-bind", "dynamic path is not an ID-scoped protected bind")

    docker = layout.get("dockerStoragePolicy", {})
    require(docker == {
        "preUnlockImageLayerStoreMayRemainOutsideProtectedVolume": True,
        "reason": "the minimal unlock container must start before the LUKS2 volume is open",
        "teamDataInImageLayerOrContainerWritableLayer": False,
        "persistentNamedVolumesOutsideProtectedRoot": False,
        "dynamicPluginAgentAndWorkerStorage": "protected-bind-only",
    }, "Docker pre-unlock and team-data storage boundary drifted")

    appliance_source = APPLIANCE_COMPOSE.read_text(encoding="utf-8")
    core_source = CORE_COMPOSE.read_text(encoding="utf-8")
    appliance_blocks = top_level_blocks(appliance_source, "volumes")
    core_blocks = top_level_blocks(core_source, "volumes")
    require(set(appliance_blocks) == volumes, "appliance Compose volume set differs from the protected layout")
    require(volumes <= set(core_blocks), "core Compose does not declare every protected volume")
    for item in mappings:
        expected = "device: ${TEAMAIBOX_DATA_ROOT:?set the mounted encrypted appliance data root}/" + item["relativePath"]
        block = appliance_blocks[item["composeVolume"]]
        require("type: none" in block and "o: bind" in block and expected in block, f"{item['composeVolume']} is not bound to its exact protected path")
    for target in targets:
        require(f"- {target}" in core_source, f"core Compose is missing protected container mount {target}")
    require("device:" not in "\n".join(line for line in appliance_source.splitlines() if "TEAMAIBOX_DATA_ROOT" not in line), "appliance Compose has a persistent device outside the protected root")

    return {
        "valid": True,
        "layoutId": layout["layoutId"],
        "staticPathCount": len(mappings),
        "dynamicPathCount": len(dynamic),
        "composeVolumeCount": len(volumes),
        "coveredClasses": sorted(REQUIRED_CLASSES),
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
