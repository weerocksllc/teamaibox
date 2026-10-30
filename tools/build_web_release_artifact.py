#!/usr/bin/env python3
"""Build and record one deterministic, content-addressed Web release artifact."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT / "deploy/application-catalog-e2e/generated"
EVIDENCE_ROOT = ROOT / "evidence/validation/supply-chain"
SAFE_ID = re.compile(r"^web-release-20[0-9]{6}-a[1-9][0-9]*$")
SOURCE_ROOTS = (
    ROOT / "package.json",
    ROOT / "pnpm-lock.yaml",
    ROOT / "pnpm-workspace.yaml",
    ROOT / "apps/web",
    ROOT / "packages/authorization",
    ROOT / "packages/plugin-sdk",
    ROOT / "packages/ui-system",
)


class WebReleaseFailure(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def source_files() -> list[Path]:
    values: set[Path] = set()
    for root in SOURCE_ROOTS:
        candidates = [root] if root.is_file() else root.rglob("*")
        for path in candidates:
            if (path.is_file() and path.suffix != ".tsbuildinfo"
                    and not any(part in {"dist", "node_modules", "__pycache__"} for part in path.relative_to(ROOT).parts)):
                values.add(path)
    return sorted(values)


def source_digest(paths: list[Path]) -> str:
    value = hashlib.sha256()
    for path in paths:
        relative = path.relative_to(ROOT).as_posix().encode()
        payload = path.read_bytes()
        value.update(len(relative).to_bytes(4, "big") + relative + len(payload).to_bytes(8, "big") + payload)
    return "sha256:" + value.hexdigest()


def archive(dist: Path) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as output:
        for path in sorted(item for item in dist.rglob("*") if item.is_file()):
            relative = path.relative_to(dist).as_posix()
            info = tarfile.TarInfo(relative)
            payload = path.read_bytes()
            info.size = len(payload)
            info.mode = 0o644
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            output.addfile(info, io.BytesIO(payload))
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", filename="", mtime=0) as output:
        output.write(raw.getvalue())
    return compressed.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if SAFE_ID.fullmatch(args.run_id) is None:
        raise WebReleaseFailure("run ID is invalid")
    artifact = OUTPUT_ROOT / f"{args.run_id}.tar.gz"
    evidence_path = EVIDENCE_ROOT / f"{args.run_id}.json"
    if artifact.exists() or evidence_path.exists():
        raise WebReleaseFailure("artifact or evidence exists; use a new immutable run ID")
    files = source_files()
    completed = subprocess.run(
        ["pnpm", "--filter", "@teamaibox/web", "build"], cwd=ROOT,
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=600,
    )
    if completed.returncode != 0:
        raise WebReleaseFailure("Web production build failed")
    dist = ROOT / "apps/web/dist"
    if not (dist / "index.html").is_file():
        raise WebReleaseFailure("Web build did not produce index.html")
    payload = archive(dist)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(payload)
    evidence = {
        "schemaVersion": 1,
        "runnerId": "teamaibox.web-release-artifact.v1",
        "runId": args.run_id,
        "status": "passed",
        "sourceDigest": source_digest(files),
        "sourceFileCount": len(files),
        "buildCommand": ["pnpm", "--filter", "@teamaibox/web", "build"],
        "artifact": artifact.relative_to(ROOT).as_posix(),
        "artifactDigest": digest(payload),
        "artifactBytes": len(payload),
        "entrypoint": "index.html",
        "completedAt": now(),
        "commandOutputRetained": False,
        "credentialsRetained": False,
    }
    evidence["evidenceDigest"] = digest(json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode())
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(artifact, 0o444)
    print(json.dumps({"runId": args.run_id, "status": "passed", "artifact": evidence["artifact"], "artifactDigest": evidence["artifactDigest"]}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.TimeoutExpired, WebReleaseFailure) as error:
        print(f"Web release artifact failed: {error}")
        raise SystemExit(1)
