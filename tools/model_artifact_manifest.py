#!/usr/bin/env python3
"""Hash an exact, allowlisted model snapshot without following links."""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import pathlib
from typing import Any, Iterable


SCHEMA_VERSION = 1
TOOL_VERSION = "1.0.0"
DEFAULT_PATTERNS = ("*.json", "*.jinja", "*.safetensors", "*.model", "tokenizer*")
REQUIRED_RUNTIME_FILES = frozenset({
    "chat_template.jinja", "config.json", "generation_config.json",
    "model.safetensors.index.json", "tokenizer.json", "tokenizer_config.json", "vocab.json",
})


class ManifestError(RuntimeError):
    pass


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(16 * 1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def canonical_digest(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def collect(
    root: pathlib.Path, patterns: Iterable[str], maximum_bytes: int,
    required_runtime_files: Iterable[str] = REQUIRED_RUNTIME_FILES,
) -> tuple[list[dict[str, Any]], int]:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ManifestError("model snapshot root must be a directory")
    allowed = tuple(patterns)
    files: list[dict[str, Any]] = []
    total = 0
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if ".cache" in relative.parts:
            continue
        if path.is_symlink():
            raise ManifestError(f"model snapshot cannot contain symlinks: {relative.as_posix()}")
        if not path.is_file():
            continue
        name = relative.as_posix()
        if not any(fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(path.name, pattern) for pattern in allowed):
            raise ManifestError(f"model snapshot contains a file outside the discovery allowlist: {name}")
        size = path.stat().st_size
        if size < 1:
            raise ManifestError(f"model artifact file is empty: {name}")
        total += size
        if total > maximum_bytes:
            raise ManifestError("model snapshot exceeds its reviewed download limit")
        files.append({"path": name, "sizeBytes": size, "digest": sha256_file(path)})
    if not files or not any(item["path"].endswith(".safetensors") for item in files):
        raise ManifestError("model snapshot is incomplete")
    names = {item["path"] for item in files}
    required = frozenset(required_runtime_files)
    if any(not isinstance(name, str) or not name or "/" in name or name in {".", ".."} for name in required):
        raise ManifestError("required runtime file declaration is invalid")
    missing_runtime = sorted(required - names)
    if missing_runtime:
        raise ManifestError(f"model snapshot is missing {len(missing_runtime)} required runtime files")
    index_path = root / "model.safetensors.index.json"
    if index_path.exists():
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
            weight_map = index["weight_map"]
        except (json.JSONDecodeError, KeyError, OSError, UnicodeError) as error:
            raise ManifestError("safetensors index is invalid") from error
        if not isinstance(weight_map, dict) or not weight_map or not all(isinstance(value, str) for value in weight_map.values()):
            raise ManifestError("safetensors index weight map is invalid")
        referenced = set(weight_map.values())
        if any("/" in name or not name.endswith(".safetensors") for name in referenced):
            raise ManifestError("safetensors index references an unsafe shard")
        missing = sorted(referenced - names)
        if missing:
            raise ManifestError(f"model snapshot is missing {len(missing)} indexed safetensors shards")
        unexpected = sorted({name for name in names if name.endswith(".safetensors")} - referenced)
        if unexpected:
            raise ManifestError(f"model snapshot contains {len(unexpected)} unindexed safetensors files")
    elif "model.safetensors" not in names:
        raise ManifestError("model snapshot has neither a complete shard index nor one weight file")
    return files, total


def build_manifest(
    root: pathlib.Path, *, candidate_id: str, repository: str, revision: str,
    maximum_bytes: int, patterns: Iterable[str] = DEFAULT_PATTERNS,
    required_runtime_files: Iterable[str] = REQUIRED_RUNTIME_FILES,
) -> dict[str, Any]:
    required = tuple(sorted(required_runtime_files))
    files, total = collect(root, patterns, maximum_bytes, required)
    artifact_identity = {
        "candidateId": candidate_id,
        "repository": repository,
        "revision": revision,
        "files": files,
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "toolVersion": TOOL_VERSION,
        "candidateId": candidate_id,
        "repository": repository,
        "revision": revision,
        "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "allowPatterns": list(patterns),
        "requiredRuntimeFiles": list(required),
        "fileCount": len(files),
        "totalBytes": total,
        "files": files,
        "artifactDigest": canonical_digest(artifact_identity),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=pathlib.Path)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--maximum-bytes", required=True, type=int)
    parser.add_argument("--required-runtime-files-json")
    args = parser.parse_args()
    required_runtime_files = REQUIRED_RUNTIME_FILES
    if args.required_runtime_files_json is not None:
        try:
            value = json.loads(args.required_runtime_files_json)
        except json.JSONDecodeError as error:
            raise ManifestError("required runtime file declaration is invalid JSON") from error
        if not isinstance(value, list):
            raise ManifestError("required runtime file declaration must be an array")
        required_runtime_files = tuple(value)
    manifest = build_manifest(
        args.root,
        candidate_id=args.candidate_id,
        repository=args.repository,
        revision=args.revision,
        maximum_bytes=args.maximum_bytes,
        required_runtime_files=required_runtime_files,
    )
    print(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
