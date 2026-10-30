#!/usr/bin/env python3
"""Load and fingerprint the exact offline COMET model directory."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from comet import download_model, load_from_checkpoint


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path)
    parser.add_argument("--model", default="Unbabel/wmt22-comet-da")
    args = parser.parse_args()
    checkpoint = Path(download_model(args.model, saving_directory=str(args.root)))
    loaded = load_from_checkpoint(str(checkpoint))
    artifact_root = args.artifact_root or args.root
    if not checkpoint.is_relative_to(artifact_root):
        raise ValueError("checkpoint is outside the artifact root")
    files: list[dict[str, object]] = []
    artifact = hashlib.sha256()
    total = 0
    for path in sorted(item for item in artifact_root.rglob("*") if item.is_file() and not item.is_symlink()):
        relative = str(path.relative_to(artifact_root))
        value = hashlib.sha256()
        size = 0
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                value.update(block)
                size += len(block)
        file_digest = value.hexdigest()
        total += size
        files.append({"path": relative, "bytes": size, "sha256": file_digest})
        artifact.update(f"{relative}\0{size}\0{file_digest}\n".encode())
    print(json.dumps({
        "model": args.model,
        "checkpoint": str(checkpoint.relative_to(artifact_root)),
        "fileCount": len(files),
        "totalBytes": total,
        "artifactDigest": "sha256:" + artifact.hexdigest(),
        "loaded": loaded is not None,
        "files": files,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
