#!/usr/bin/env python3
"""Build reproducible stripped Linux/ARM64 Node Agent release binaries."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "deploy/application-catalog-e2e/generated/node-agent"


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "arm64"}
    for command, name in (("./cmd/node-agent", "teamaibox-node-agent"), ("./cmd/node-enroll", "teamaibox-node-enroll")):
        target = OUTPUT / name
        subprocess.run(["go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", str(target), command],
                       cwd=ROOT / "services/node-agent", env=environment, check=True)
        target.chmod(0o755)
    manifest = {
        "schemaVersion": 1,
        "architecture": "linux/arm64/v8",
        "goModule": "teamaibox.local/node-agent",
        "artifacts": {name: digest(OUTPUT / name) for name in ("teamaibox-node-agent", "teamaibox-node-enroll")},
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(manifest, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
