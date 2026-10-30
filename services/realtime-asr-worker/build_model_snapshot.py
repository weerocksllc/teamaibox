#!/usr/bin/env python3
"""Download one immutable CTranslate2 Whisper snapshot and bind every runtime file."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from huggingface_hub import snapshot_download


REPOSITORY = os.environ["ASR_MODEL_REPOSITORY"]
REVISION = os.environ["ASR_MODEL_REVISION"]
TARGET = Path(os.environ.get("ASR_MODEL_TARGET", "/opt/model"))
ALLOWLIST = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


TARGET.mkdir(parents=True, exist_ok=False)
snapshot_download(
    repo_id=REPOSITORY,
    revision=REVISION,
    local_dir=TARGET,
    allow_patterns=list(ALLOWLIST),
)
files = []
for name in ALLOWLIST:
    path = TARGET / name
    if not path.is_file() or path.stat().st_size < 1:
        raise RuntimeError(f"model snapshot file is missing: {name}")
    files.append({"path": name, "sizeBytes": path.stat().st_size, "sha256": digest(path)})
manifest = {
    "schemaVersion": 1,
    "repository": REPOSITORY,
    "revision": REVISION,
    "files": files,
}
(TARGET / "teamaibox-model-manifest.v1.json").write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
