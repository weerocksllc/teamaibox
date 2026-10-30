#!/usr/bin/env python3
"""Prepare or clean two bounded disposable LUKS2 files for Spark integration.

The primary volume contains the supported appliance data-root layout and has
automatic, recovery, and Web-passphrase key slots.  The spare volume exists
only to exercise verified encrypted storage-pool migration.  Neither target
can be redirected to a block device or outside the run-scoped /tmp roots.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
from typing import Any, Sequence

try:
    from .luks2_unlock_helper import RUN_ID, configuration
except ImportError:
    from luks2_unlock_helper import RUN_ID, configuration


SPARE_PREFIX = "/tmp/teamaibox-luks-storage-spare-"
SPARE_MAPPER_PREFIX = "teamaibox-luks-spare-"
MIN_INTEGRATION_VOLUME_MIB = 2048
MAX_INTEGRATION_VOLUME_MIB = 32768
VOLUME_NAMES = {
    "catalog_secrets": (0, 0, 0o711),
    "postgres_data": (999, 999, 0o1777),
    "object_data": (10001, 10001, 0o750),
    "event_bus_data": (10003, 10003, 0o700),
    "plugin_source_data": (0, 0, 0o755),
    "node_ca_private": (10005, 10005, 0o700),
    "node_federation_control": (0, 0, 0o711),
    "node_federation_gateway_private": (10006, 10006, 0o700),
    "provider_secret_ciphertext": (1000, 1000, 0o700),
    "local_node_agent_state": (10001, 10001, 0o700),
    "agent_control": (0, 0, 0o755),
    "agent_owner_runtime": (0, 0, 0o755),
    "agent_owner_model": (0, 0, 0o755),
    "agent_owner_workspace": (65532, 65532, 0o755),
    "agent_member_runtime": (0, 0, 0o755),
    "agent_member_model": (0, 0, 0o755),
    "agent_member_workspace": (65532, 65532, 0o755),
    "agent_validation": (65532, 65532, 0o700),
    "agent_source_cache": (65532, 65532, 0o700),
    "offline_media_runtime": (0, 0, 0o755),
    "backup_control": (1000, 1000, 0o700),
    "backup_restore_data": (1000, 1000, 0o700),
    "maintenance_controller_state": (10001, 10001, 0o700),
}


class IntegrationVolumeError(RuntimeError):
    pass


def paths(run_id: str) -> dict[str, Any]:
    primary = configuration(run_id)
    suffix = run_id.removeprefix("luks-unlock-integration-")
    spare_root = Path(SPARE_PREFIX + suffix)
    spare_mapper = SPARE_MAPPER_PREFIX + hashlib.sha256((run_id + ":spare").encode()).hexdigest()[:20]
    if spare_root.parent != Path("/tmp") or not str(spare_root).startswith(SPARE_PREFIX) or "/" in spare_mapper:
        raise IntegrationVolumeError("spare disposable target escaped its boundary")
    return {
        **primary,
        "primaryAutomatic": primary["root"] / "automatic.key",
        "primaryRecovery": primary["root"] / "recovery.key",
        "primaryWeb": primary["root"] / "web.key",
        "spareRoot": spare_root,
        "spareImage": spare_root / "volume.img",
        "spareMount": spare_root / "mount",
        "spareAutomatic": spare_root / "automatic.key",
        "spareMapper": spare_mapper,
        "spareMapped": Path("/dev/mapper") / spare_mapper,
    }


def run(arguments: Sequence[str], *, timeout: int = 300, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(list(arguments), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise IntegrationVolumeError(f"bounded command timed out: {arguments[0]}") from error
    if check and result.returncode != 0:
        raise IntegrationVolumeError(f"bounded command failed: {arguments[0]}")
    return result


def output(arguments: Sequence[str], *, timeout: int = 60) -> str:
    try:
        result = subprocess.run(list(arguments), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False, text=True)
    except subprocess.TimeoutExpired as error:
        raise IntegrationVolumeError(f"bounded command timed out: {arguments[0]}") from error
    if result.returncode != 0:
        raise IntegrationVolumeError(f"bounded command failed: {arguments[0]}")
    return result.stdout.strip()


def key(path: Path, *, web: bool = False) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        value = (base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=") if web else secrets.token_bytes(64))
        os.write(descriptor, value)
        os.fsync(descriptor)
        mutable = bytearray(value)
        mutable[:] = b"\0" * len(mutable)
    finally:
        os.close(descriptor)


def format_volume(image: Path, mapper: str, mount: Path, automatic: Path, size_mib: int) -> None:
    run(("truncate", "-s", f"{size_mib}M", str(image)))
    if not image.is_file() or image.is_symlink():
        raise IntegrationVolumeError("disposable backing target is not a regular file")
    run(("cryptsetup", "luksFormat", "--batch-mode", "--type", "luks2", "--pbkdf", "argon2id",
         "--key-slot", "0", "--key-file", str(automatic), str(image)))
    run(("cryptsetup", "open", "--type", "luks2", "--key-file", str(automatic), str(image), mapper))
    try:
        run(("mkfs.ext4", "-q", "-F", f"/dev/mapper/{mapper}"))
        run(("mount", "-o", "nodev,nosuid,noexec", f"/dev/mapper/{mapper}", str(mount)))
    except Exception:
        run(("cryptsetup", "close", mapper), check=False)
        raise


def slots(image: Path) -> list[int]:
    result = subprocess.run(("cryptsetup", "luksDump", "--dump-json-metadata", str(image)),
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60, check=False)
    if result.returncode != 0:
        raise IntegrationVolumeError("LUKS2 slot inventory failed")
    value = json.loads(result.stdout)
    return sorted(int(item) for item in value.get("keyslots", {}))


def prepare(run_id: str, size_mib: int) -> dict[str, Any]:
    if not isinstance(size_mib, int) or size_mib < MIN_INTEGRATION_VOLUME_MIB or size_mib > MAX_INTEGRATION_VOLUME_MIB:
        raise IntegrationVolumeError(
            f"integration volume must be between {MIN_INTEGRATION_VOLUME_MIB} and {MAX_INTEGRATION_VOLUME_MIB} MiB")
    value = paths(run_id)
    roots = (value["root"], value["spareRoot"])
    if any(root.exists() for root in roots) or value["mapped"].exists() or value["spareMapped"].exists():
        raise IntegrationVolumeError("disposable integration volume already exists")
    try:
        for root in roots:
            root.mkdir(mode=0o700)
            (root / "mount").mkdir(mode=0o700)
        key(value["primaryAutomatic"])
        key(value["primaryRecovery"])
        key(value["primaryWeb"], web=True)
        key(value["spareAutomatic"])
        format_volume(value["image"], value["mapper"], value["mount"], value["primaryAutomatic"], size_mib)
        run(("cryptsetup", "luksAddKey", "--key-file", str(value["primaryAutomatic"]), "--new-key-slot", "1",
             str(value["image"]), str(value["primaryRecovery"])))
        run(("cryptsetup", "luksAddKey", "--key-file", str(value["primaryAutomatic"]), "--new-key-slot", "2",
             str(value["image"]), str(value["primaryWeb"])))
        format_volume(value["spareImage"], value["spareMapper"], value["spareMount"], value["spareAutomatic"], size_mib)
        for name, (uid, gid, mode) in VOLUME_NAMES.items():
            directory = value["mount"] / name
            directory.mkdir(mode=mode)
            os.chown(directory, uid, gid)
            os.chmod(directory, mode)
        primary_pool = value["mount"] / "object_data" / "pools" / "local.data"
        additional_primary_pools = [
            value["mount"] / "object_data" / "pools" / pool_id
            for pool_id in ("browser.data", "failure.full", "failure.target")
        ]
        spare_pool = value["spareMount"] / "objects" / "local.spare"
        primary_pool.mkdir(parents=True, mode=0o750)
        for directory in additional_primary_pools:
            directory.mkdir(parents=True, mode=0o750)
        spare_pool.mkdir(parents=True, mode=0o750)
        os.chown(primary_pool, 10001, 10001)
        for directory in additional_primary_pools:
            os.chown(directory, 10001, 10001)
        os.chown(spare_pool.parent.parent, 10001, 10001)
        os.chown(spare_pool.parent, 10001, 10001)
        os.chown(spare_pool, 10001, 10001)
        os.sync()
        if slots(value["image"]) != [0, 1, 2] or slots(value["spareImage"]) != [0]:
            raise IntegrationVolumeError("disposable LUKS2 slot layout is incomplete")
        return status(run_id) | {"prepared": True, "sizeMiBEach": size_mib,
                                 "factorFilesPresent": True, "factorMaterialRetainedInOutput": False}
    except Exception:
        cleanup(run_id)
        raise


def filesystem_bytes(path: Path) -> tuple[int, int]:
    value = os.statvfs(path)
    return value.f_frsize * value.f_blocks, value.f_frsize * value.f_bavail


def validate_online_growth(size_mib: int, current_bytes: int, backing_available: int) -> int:
    """Initial fixture sizing is not a permanent capacity cap on active data."""
    if type(size_mib) is not int or size_mib < MIN_INTEGRATION_VOLUME_MIB:
        raise IntegrationVolumeError('online volume size must be a positive integer MiB capacity')
    target = size_mib * 1024 * 1024
    if target < current_bytes:
        raise IntegrationVolumeError('shrinking an active volume is not supported')
    if target - current_bytes > backing_available:
        raise IntegrationVolumeError('backing filesystem has insufficient available capacity for this growth')
    return target


def resize_primary(run_id: str, size_mib: int) -> dict[str, Any]:
    """Grow only the run-scoped regular-file primary volume and its mounted ext4 filesystem.

    Shrinking is intentionally unsupported. The exact run identity selects every
    path, and the loop backing file must resolve to that same disposable image.
    This operation never accepts a caller-supplied device, mapper, or mount path.
    """
    value = paths(run_id)
    image, mapped, mount = value["image"], value["mapped"], value["mount"]
    if not image.is_file() or image.is_symlink() or not mapped.exists() or not mount.is_dir() or mount.is_symlink():
        raise IntegrationVolumeError("primary disposable LUKS2 volume is not safely online")
    if run(("mountpoint", "-q", str(mount)), check=False).returncode != 0:
        raise IntegrationVolumeError("primary disposable LUKS2 filesystem is not mounted")
    run(("cryptsetup", "isLuks", "--type", "luks2", str(image)))
    status_text = output(("cryptsetup", "status", value["mapper"]))
    device_lines = [line.split(":", 1)[1].strip() for line in status_text.splitlines()
                    if line.strip().startswith("device:")]
    if len(device_lines) != 1 or not re.fullmatch(r"/dev/loop[0-9]+", device_lines[0]):
        raise IntegrationVolumeError("primary disposable LUKS2 loop device is ambiguous")
    loop_device = Path(device_lines[0])
    backing_path = Path("/sys/class/block") / loop_device.name / "loop/backing_file"
    if not backing_path.is_file():
        raise IntegrationVolumeError("primary disposable LUKS2 loop backing record is unavailable")
    recorded_backing = backing_path.read_text(encoding="utf-8").strip()
    if Path("/" + recorded_backing.lstrip("/")).resolve() != image.resolve():
        raise IntegrationVolumeError("primary disposable LUKS2 loop backing file differs from the run boundary")

    before_image_bytes = image.stat().st_size
    _, backing_available = filesystem_bytes(image.parent)
    target_bytes = validate_online_growth(size_mib, before_image_bytes, backing_available)
    before_mapped_bytes = int(output(("blockdev", "--getsize64", str(mapped))))
    before_filesystem_bytes, before_available_bytes = filesystem_bytes(mount)
    if target_bytes < before_image_bytes or target_bytes < before_mapped_bytes or target_bytes < before_filesystem_bytes:
        raise IntegrationVolumeError("shrinking a disposable LUKS2 volume is not supported")
    already_sized = before_image_bytes == target_bytes \
        and before_mapped_bytes >= target_bytes - 32 * 1024 * 1024 \
        and before_filesystem_bytes >= target_bytes - 256 * 1024 * 1024
    if already_sized:
        return {
            "schemaVersion": 1,
            "runId": run_id,
            "operation": "grow-primary-online",
            "targetKind": "disposable-regular-file-luks2",
            "activeRootDeviceTouched": False,
            "requestedSizeMiB": size_mib,
            "alreadySized": True,
            "before": {"imageBytes": before_image_bytes, "mappedBytes": before_mapped_bytes,
                       "filesystemBytes": before_filesystem_bytes, "availableBytes": before_available_bytes},
            "after": {"imageBytes": before_image_bytes, "mappedBytes": before_mapped_bytes,
                      "filesystemBytes": before_filesystem_bytes, "availableBytes": before_available_bytes},
            "primary": {"mapperActive": True, "mounted": True, "slotCount": len(slots(image))},
            "factorMaterialRetainedInOutput": False,
        }
    if target_bytes > before_image_bytes:
        run(("truncate", "-s", str(target_bytes), str(image)))
    run(("losetup", "--set-capacity", str(loop_device)))
    run(("cryptsetup", "resize", "--key-file", str(value["primaryAutomatic"]), value["mapper"]))
    run(("resize2fs", str(mapped)), timeout=600)
    os.sync()

    after_image_bytes = image.stat().st_size
    after_mapped_bytes = int(output(("blockdev", "--getsize64", str(mapped))))
    after_filesystem_bytes, after_available_bytes = filesystem_bytes(mount)
    if after_image_bytes != target_bytes or after_mapped_bytes <= before_mapped_bytes \
            or after_filesystem_bytes <= before_filesystem_bytes or after_available_bytes <= before_available_bytes:
        raise IntegrationVolumeError("primary disposable LUKS2 volume did not grow to the requested capacity")
    return {
        "schemaVersion": 1,
        "runId": run_id,
        "operation": "grow-primary-online",
        "targetKind": "disposable-regular-file-luks2",
        "activeRootDeviceTouched": False,
        "requestedSizeMiB": size_mib,
        "alreadySized": False,
        "before": {"imageBytes": before_image_bytes, "mappedBytes": before_mapped_bytes,
                   "filesystemBytes": before_filesystem_bytes, "availableBytes": before_available_bytes},
        "after": {"imageBytes": after_image_bytes, "mappedBytes": after_mapped_bytes,
                  "filesystemBytes": after_filesystem_bytes, "availableBytes": after_available_bytes},
        "primary": {"mapperActive": mapped.exists(), "mounted": True, "slotCount": len(slots(image))},
        "factorMaterialRetainedInOutput": False,
    }


def status(run_id: str) -> dict[str, Any]:
    value = paths(run_id)
    primary_mounted = run(("mountpoint", "-q", str(value["mount"])), check=False).returncode == 0
    spare_mounted = run(("mountpoint", "-q", str(value["spareMount"])), check=False).returncode == 0
    return {
        "schemaVersion": 1,
        "runId": run_id,
        "targetKind": "two-disposable-regular-file-luks2-volumes",
        "activeRootDeviceTouched": False,
        "primary": {"mapperActive": value["mapped"].exists(), "mounted": primary_mounted,
                    "slotCount": len(slots(value["image"])) if value["image"].is_file() else 0},
        "spare": {"mapperActive": value["spareMapped"].exists(), "mounted": spare_mounted,
                  "slotCount": len(slots(value["spareImage"])) if value["spareImage"].is_file() else 0},
        "dataRootClass": "/tmp/teamaibox-luks-unlock-integration-*/mount",
        "spareRootClass": "/tmp/teamaibox-luks-storage-spare-*/mount",
    }


def close_primary(run_id: str) -> dict[str, Any]:
    value = paths(run_id)
    if run(("mountpoint", "-q", str(value["mount"])), check=False).returncode == 0:
        run(("umount", str(value["mount"])))
    if value["mapped"].exists():
        run(("cryptsetup", "close", value["mapper"]))
    result = status(run_id)
    if result["primary"] != {"mapperActive": False, "mounted": False, "slotCount": 3}:
        raise IntegrationVolumeError("primary disposable volume did not close cleanly")
    return result


def cleanup(run_id: str) -> dict[str, Any]:
    value = paths(run_id)
    for mount, mapped, mapper in ((value["mount"], value["mapped"], value["mapper"]),
                                  (value["spareMount"], value["spareMapped"], value["spareMapper"])):
        if mount.exists() and run(("mountpoint", "-q", str(mount)), check=False).returncode == 0:
            run(("umount", str(mount)), check=False)
        if mapped.exists():
            run(("cryptsetup", "close", mapper), check=False)
    for root, prefix in ((value["root"], "/tmp/teamaibox-luks-unlock-integration-"),
                         (value["spareRoot"], SPARE_PREFIX)):
        if root.exists() and root.parent == Path("/tmp") and str(root).startswith(prefix):
            shutil.rmtree(root)
    passed = not value["root"].exists() and not value["spareRoot"].exists() \
        and not value["mapped"].exists() and not value["spareMapped"].exists()
    return {"schemaVersion": 1, "runId": run_id, "cleanup": {"passed": passed,
            "rootsRemoved": passed, "mappersClosed": passed}, "factorFilesPresent": False,
            "factorMaterialRetainedInOutput": False}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "status", "resize-primary", "close-primary", "cleanup"))
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--size-mib", type=int, default=4096)
    args = parser.parse_args(argv)
    if RUN_ID.fullmatch(args.run_id) is None:
        raise IntegrationVolumeError("integration run identity is invalid")
    if args.operation == "prepare":
        result = prepare(args.run_id, args.size_mib)
    elif args.operation == "status":
        result = status(args.run_id)
    elif args.operation == "resize-primary":
        result = resize_primary(args.run_id, args.size_mib)
    elif args.operation == "close-primary":
        result = close_primary(args.run_id)
    else:
        result = cleanup(args.run_id)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0 if result.get("cleanup", {}).get("passed", True) else 2


if __name__ == "__main__":
    raise SystemExit(main())
