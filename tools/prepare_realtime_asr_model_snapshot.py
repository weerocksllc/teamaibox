#!/usr/bin/env python3
"""Prepare one immutable, integrity-bound realtime ASR model build context."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import sys
import urllib.parse
import urllib.request


DEFAULT_REPOSITORY = "Systran/faster-whisper-small"
DEFAULT_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
REVISION = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]{1,96}/[A-Za-z0-9_.-]{1,96}$")


class SnapshotError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise SnapshotError(message)


def download(url: str, target: Path) -> dict[str, object]:
    temporary = target.with_suffix(target.suffix + ".partial")
    digest = hashlib.sha256()
    size = 0
    request = urllib.request.Request(url, headers={"User-Agent": "TeamAIBox-model-snapshot/1"})
    try:
        with urllib.request.urlopen(request, timeout=60, context=ssl.create_default_context()) as response, temporary.open("xb") as output:
            require(response.status == 200, f"model source returned HTTP {response.status}")
            while chunk := response.read(8 * 1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        require(size > 0, f"model source returned an empty file: {target.name}")
        os.replace(temporary, target)
        return {"path": target.name, "sizeBytes": size, "sha256": digest.hexdigest()}
    finally:
        temporary.unlink(missing_ok=True)


def prepare(output: Path, repository: str, revision: str) -> dict[str, object]:
    require(output.is_absolute() and not output.exists(), "output must be a new absolute directory")
    require(REPOSITORY.fullmatch(repository) is not None, "model repository is invalid")
    require(REVISION.fullmatch(revision) is not None, "model revision must be a full Git commit")
    output.mkdir(parents=True)
    try:
        files = []
        for name in FILES:
            url = "https://huggingface.co/" + urllib.parse.quote(repository, safe="/") \
                + "/resolve/" + revision + "/" + urllib.parse.quote(name)
            files.append(download(url, output / name))
        manifest = {"schemaVersion": 1, "repository": repository, "revision": revision, "files": files}
        (output / "teamaibox-model-manifest.v1.json").write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        return manifest
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repository", default=DEFAULT_REPOSITORY)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    args = parser.parse_args()
    result = prepare(args.output.resolve(), args.repository, args.revision)
    print(json.dumps({
        "repository": result["repository"],
        "revision": result["revision"],
        "fileCount": len(result["files"]),
        "sizeBytes": sum(item["sizeBytes"] for item in result["files"]),
        "output": str(args.output.resolve()),
    }, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SnapshotError, OSError, urllib.error.URLError) as error:
        print(f"realtime ASR model snapshot failed: {error}", file=sys.stderr)
        raise SystemExit(1)
