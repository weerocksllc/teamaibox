#!/usr/bin/env python3
"""Create a deterministic manifest for an already-built offline ARM64 rootfs.

This tool never downloads or fabricates media binaries.  It is intentionally
unusable until the controlled build supplies every required executable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile


REQUIRED_EXECUTABLES = (
    "opt/teamaibox/bin/media-health",
    "opt/teamaibox/bin/teamaibox-media-supervisor",
    "usr/bin/gst-launch-1.0",
    "usr/bin/uxplay",
)
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def require_arm64_elf(path: Path) -> None:
    header = path.read_bytes()[:20]
    if len(header) < 20 or header[:4] != b"\x7fELF":
        raise ValueError(f"required executable is not ELF: {path.name}")
    if header[4] != 2:
        raise ValueError(f"required executable is not ELF64: {path.name}")
    little_endian = header[5] == 1
    if header[5] not in (1, 2):
        raise ValueError(f"ELF endianness is invalid: {path.name}")
    machine = int.from_bytes(header[18:20], "little" if little_endian else "big")
    if machine != 183:
        raise ValueError(f"required executable is not AArch64: {path.name}")


def create_manifest(rootfs: Path, *, source_lock_digest: str) -> dict[str, object]:
    if not DIGEST.fullmatch(source_lock_digest):
        raise ValueError("source lock digest must be sha256:<64 lowercase hex>")
    root = rootfs.resolve()
    if not root.is_dir():
        raise ValueError("rootfs is not a directory")
    files: list[dict[str, object]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            target = os.readlink(path)
            if target.startswith("/") or ".." in Path(target).parts:
                raise ValueError(f"unsafe rootfs symlink: {relative}")
            files.append({"path": relative, "type": "symlink", "target": target})
            continue
        if path.is_dir():
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"rootfs contains a non-regular entry: {relative}")
        mode = stat.S_IMODE(metadata.st_mode)
        if mode & (stat.S_ISUID | stat.S_ISGID):
            raise ValueError(f"setuid/setgid rootfs entry is forbidden: {relative}")
        if mode & stat.S_IWOTH:
            raise ValueError(f"world-writable rootfs entry is forbidden: {relative}")
        files.append(
            {
                "path": relative,
                "type": "file",
                "mode": f"{mode:04o}",
                "size": metadata.st_size,
                "sha256": sha256(path),
            }
        )
    by_path = {entry["path"]: entry for entry in files}
    for required in REQUIRED_EXECUTABLES:
        entry = by_path.get(required)
        if not entry or entry.get("type") != "file" or not int(str(entry["mode"]), 8) & 0o111:
            raise ValueError(f"required executable is missing: {required}")
        require_arm64_elf(root / required)
    canonical_files = json.dumps(files, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "schemaVersion": 1,
        "manifestId": "teamaibox.trusted-media-rootfs.v1",
        "architecture": "linux/arm64/v8",
        "sourceLockDigest": source_lock_digest,
        "fileCount": len(files),
        "totalRegularFileBytes": sum(int(entry.get("size", 0)) for entry in files),
        "requiredExecutables": list(REQUIRED_EXECUTABLES),
        "contentTreeDigest": "sha256:" + hashlib.sha256(canonical_files).hexdigest(),
        "files": files,
        "claimBoundary": {
            "manifestOnly": True,
            "imageBuilt": False,
            "deploymentPerformed": False,
            "task22_3Complete": False,
        },
    }


def atomic_write(path: Path, document: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8") + b"\n"
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".next", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rootfs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-lock-digest", required=True)
    arguments = parser.parse_args()
    if not DIGEST.fullmatch(arguments.source_lock_digest):
        raise SystemExit("source lock digest must be sha256:<64 lowercase hex>")
    atomic_write(arguments.output, create_manifest(arguments.rootfs, source_lock_digest=arguments.source_lock_digest))


if __name__ == "__main__":
    main()
