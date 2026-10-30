#!/usr/bin/env python3
"""Pack only manifest-bound regular files, without host filesystem metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def pack(bundle: Path, output: Path) -> int:
    bundle = bundle.resolve(strict=True)
    manifest_path = bundle / "bundle-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    entries = [*manifest["files"], {
        "path": "bundle-manifest.json",
        "sha256": "sha256:" + hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
    }]
    sources = []
    seen = set()
    for entry in entries:
        name = entry["path"]
        path = PurePosixPath(name)
        if (not name or path.is_absolute() or str(path) != name
                or any(p in (".", "..") or p.startswith("._") for p in path.parts)
                or "\\" in name or name in seen):
            raise ValueError("unsafe or duplicate bundle member")
        source = bundle / name
        if (source.is_symlink() or not source.is_file()
                or not source.resolve().is_relative_to(bundle)):
            raise ValueError("bundle member is not a bounded regular file")
        if "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("bundle member digest drifted: " + name)
        seen.add(name)
        sources.append((name, source))
    # Python tarfile does not synthesize macOS AppleDouble (._*) sidecars.
    # Set every header explicitly, so no xattrs, ACLs or local ownership escape.
    with output.open("xb") as destination:
        with tarfile.open(fileobj=destination, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, source in sorted(sources):
                info = tarfile.TarInfo(name)
                info.size = source.stat().st_size
                info.mode = 0o444
                with source.open("rb") as data:
                    archive.addfile(info, data)
    return len(sources)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps({"memberCount": pack(args.bundle, args.output), "metadataIncluded": False}))
