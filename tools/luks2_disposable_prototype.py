#!/usr/bin/env python3
"""Exercise the LUKS2 key lifecycle on one guarded disposable sparse file."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
from typing import Any, Sequence


SAFE_RUN_ID = re.compile(r"^luks2-prototype-[0-9]{8}-[a-z0-9][a-z0-9-]{1,31}$")
WORK_PREFIX = "/tmp/teamaibox-luks-prototype-"
MAPPER_PREFIX = "teamaibox-luks-prototype-"


class PrototypeFailure(RuntimeError):
    pass


class CommandRunner:
    def run(self, arguments: Sequence[str], *, timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess[str]:
        try:
            result = subprocess.run(
                list(arguments), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                check=False, timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise PrototypeFailure(f"command timed out: {arguments[0]}") from error
        if check and result.returncode != 0:
            tail = (result.stderr or result.stdout).splitlines()[-6:]
            raise PrototypeFailure(f"command failed: {arguments[0]}: {' | '.join(line[:300] for line in tail)}")
        return result


def validate_identity(run_id: str) -> tuple[Path, str]:
    if SAFE_RUN_ID.fullmatch(run_id) is None:
        raise PrototypeFailure("unsafe LUKS2 prototype run identity")
    work = Path(WORK_PREFIX + run_id)
    mapper = MAPPER_PREFIX + hashlib.sha256(run_id.encode()).hexdigest()[:20]
    if not str(work).startswith(WORK_PREFIX) or work.parent != Path("/tmp") or "/" in mapper:
        raise PrototypeFailure("prototype target escaped the disposable boundary")
    return work, mapper


def slots(document: dict[str, Any]) -> list[int]:
    values = document.get("keyslots")
    if not isinstance(values, dict):
        raise PrototypeFailure("cryptsetup did not return LUKS2 keyslot metadata")
    try:
        return sorted(int(value) for value in values)
    except (TypeError, ValueError) as error:
        raise PrototypeFailure("LUKS2 keyslot identity is invalid") from error


def write_key(path: Path) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, secrets.token_bytes(64))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def execute(run_id: str, *, size_mib: int = 768, runner: CommandRunner | None = None) -> dict[str, Any]:
    if not isinstance(size_mib, int) or not 512 <= size_mib <= 4096:
        raise PrototypeFailure("disposable volume size must be between 512 and 4096 MiB")
    runner = runner or CommandRunner()
    work, mapper = validate_identity(run_id)
    image = work / "volume.img"
    mountpoint = work / "mount"
    automatic_v1 = work / "automatic-v1.key"
    automatic_v2 = work / "automatic-v2.key"
    recovery = work / "offline-recovery.key"
    web = work / "web-passphrase.key"
    wrong = work / "wrong-passphrase.key"
    mapped = Path("/dev/mapper") / mapper
    cleanup = {"unmounted": True, "mapperClosed": True, "workDirectoryRemoved": False, "passed": False}
    evidence: dict[str, Any] = {
        "schemaVersion": 1,
        "runId": run_id,
        "targetKind": "disposable-regular-file",
        "backingPathClass": "/tmp/teamaibox-luks-prototype-*/volume.img",
        "activeRootDeviceTouched": False,
        "sizeMiB": size_mib,
        "filesystem": "ext4",
        "mapper": mapper,
    }
    mounted = False
    opened = False
    created = False
    try:
        if work.exists() or mapped.exists():
            raise PrototypeFailure("prototype work directory or mapper already exists")
        work.mkdir(mode=0o700)
        created = True
        mountpoint.mkdir(mode=0o700)
        for path in (automatic_v1, automatic_v2, recovery, web, wrong):
            write_key(path)
        runner.run(("truncate", "-s", f"{size_mib}M", str(image)))
        if not image.is_file() or image.is_symlink():
            raise PrototypeFailure("prototype backing target is not a regular file")
        runner.run((
            "cryptsetup", "luksFormat", "--batch-mode", "--type", "luks2",
            "--pbkdf", "argon2id", "--key-slot", "0", "--key-file", str(automatic_v1), str(image),
        ), timeout=300)
        runner.run(("cryptsetup", "luksAddKey", "--key-file", str(automatic_v1), "--new-key-slot", "1", str(image), str(recovery)), timeout=300)
        runner.run(("cryptsetup", "luksAddKey", "--key-file", str(automatic_v1), "--new-key-slot", "2", str(image), str(web)), timeout=300)
        initial_metadata = json.loads(runner.run(("cryptsetup", "luksDump", "--dump-json-metadata", str(image))).stdout)
        evidence["initialSlots"] = slots(initial_metadata)
        if evidence["initialSlots"] != [0, 1, 2]:
            raise PrototypeFailure("initial automatic recovery and Web slots are incomplete")
        wrong_factor = runner.run(("cryptsetup", "open", "--test-passphrase", "--key-file", str(wrong), str(image)), check=False)
        web_factor = runner.run(("cryptsetup", "open", "--test-passphrase", "--key-file", str(web), str(image)), check=False)
        if wrong_factor.returncode == 0 or web_factor.returncode != 0:
            raise PrototypeFailure("wrong-passphrase rejection or Web slot verification failed")

        runner.run(("cryptsetup", "open", "--type", "luks2", "--key-file", str(automatic_v1), str(image), mapper), timeout=300)
        opened = True
        runner.run(("mkfs.ext4", "-q", "-F", str(mapped)), timeout=300)
        runner.run(("mount", "-o", "nodev,nosuid", str(mapped), str(mountpoint)))
        mounted = True
        sentinel = mountpoint / "protected-sentinel"
        sentinel.write_bytes(b"teamaibox-luks2-disposable-v1\n")
        os.sync()
        evidence["sentinelSha256"] = "sha256:" + hashlib.sha256(sentinel.read_bytes()).hexdigest()
        runner.run(("umount", str(mountpoint)))
        mounted = False
        runner.run(("cryptsetup", "close", mapper))
        opened = False

        runner.run(("cryptsetup", "luksAddKey", "--key-file", str(recovery), "--new-key-slot", "3", str(image), str(automatic_v2)), timeout=300)
        runner.run(("cryptsetup", "luksKillSlot", "--batch-mode", "--key-file", str(recovery), str(image), "0"), timeout=300)
        old_automatic = runner.run(("cryptsetup", "open", "--test-passphrase", "--key-file", str(automatic_v1), str(image)), check=False)
        new_automatic = runner.run(("cryptsetup", "open", "--test-passphrase", "--key-file", str(automatic_v2), str(image)), check=False)
        if old_automatic.returncode == 0 or new_automatic.returncode != 0:
            raise PrototypeFailure("automatic key rotation did not revoke exactly the old factor")

        runner.run(("cryptsetup", "luksKillSlot", "--batch-mode", "--key-file", str(recovery), str(image), "2"), timeout=300)
        revoked_web = runner.run(("cryptsetup", "open", "--test-passphrase", "--key-file", str(web), str(image)), check=False)
        if revoked_web.returncode == 0:
            raise PrototypeFailure("revoked Web slot still unlocks the volume")
        final_metadata = json.loads(runner.run(("cryptsetup", "luksDump", "--dump-json-metadata", str(image))).stdout)
        evidence["finalSlots"] = slots(final_metadata)
        if evidence["finalSlots"] != [1, 3]:
            raise PrototypeFailure("final recovery and rotated automatic slots drifted")

        runner.run(("cryptsetup", "open", "--type", "luks2", "--key-file", str(recovery), str(image), mapper), timeout=300)
        opened = True
        runner.run(("mount", "-o", "nodev,nosuid,ro", str(mapped), str(mountpoint)))
        mounted = True
        recovered = (mountpoint / "protected-sentinel").read_bytes()
        if "sha256:" + hashlib.sha256(recovered).hexdigest() != evidence["sentinelSha256"]:
            raise PrototypeFailure("recovery unlock did not preserve protected content")
        runner.run(("umount", str(mountpoint)))
        mounted = False
        runner.run(("cryptsetup", "close", mapper))
        opened = False
        evidence["checks"] = {
            "automaticUnlock": True,
            "defaultCloseReopen": True,
            "wrongPassphraseRejected": True,
            "webPassphraseUnlock": True,
            "keySlotInventory": True,
            "automaticRotation": True,
            "oldAutomaticRevoked": True,
            "webSlotRevoked": True,
            "explicitClose": True,
            "offlineRecovery": True,
            "contentPreserved": True,
        }
        evidence["outcome"] = "passed"
    finally:
        if mounted:
            cleanup["unmounted"] = runner.run(("umount", str(mountpoint)), check=False).returncode == 0
        if opened:
            cleanup["mapperClosed"] = runner.run(("cryptsetup", "close", mapper), check=False).returncode == 0
        if created and work.exists() and str(work).startswith(WORK_PREFIX) and work.parent == Path("/tmp"):
            shutil.rmtree(work)
        cleanup["workDirectoryRemoved"] = created and not work.exists()
        cleanup["passed"] = cleanup["unmounted"] and cleanup["mapperClosed"] and cleanup["workDirectoryRemoved"]
        evidence["cleanup"] = cleanup
    if evidence.get("outcome") != "passed" or not cleanup["passed"]:
        raise PrototypeFailure("LUKS2 prototype or cleanup did not pass")
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--size-mib", type=int, default=768)
    args = parser.parse_args()
    print(json.dumps(execute(args.run_id, size_mib=args.size_mib), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
