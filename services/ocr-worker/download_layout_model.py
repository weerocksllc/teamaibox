"""Fetch and verify the reviewed PP-DocLayoutV3 ONNX artifact."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import ssl
import urllib.request


MODEL_NAME = "PP-DocLayoutV3"
SOURCE_REPOSITORY = "PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models"
SOURCE_REVISION = "9027d49d3764d465c3d7c4e8506910fb8d9c1498"
SOURCE_PATH = "layout/PP-DocLayoutV3.onnx"
SOURCE_URL = f"https://media.githubusercontent.com/media/{SOURCE_REPOSITORY}/{SOURCE_REVISION}/{SOURCE_PATH}"
EXPECTED_SIZE = 129_920_689
EXPECTED_SHA256 = "sha256:dc5670ebbb42e2ba4e41395fc55e8217b007134e8b9e35023d592a8fe040a288"
MODEL_ROOT = Path(os.environ.get("TEAMAIBOX_OCR_LAYOUT_MODEL_ROOT", "/models/pp-doclayout-v3"))
MODEL_FILE = MODEL_ROOT / "PP-DocLayoutV3.onnx"
MANIFEST = MODEL_ROOT / "teamaibox-model-manifest.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def verified() -> bool:
    try:
        value = json.loads(MANIFEST.read_text(encoding="utf-8"))
        files = value["files"]
        return (
            value.get("model") == MODEL_NAME
            and value.get("sourceRepository") == SOURCE_REPOSITORY
            and value.get("sourceRevision") == SOURCE_REVISION
            and value.get("sourcePath") == SOURCE_PATH
            and files == [{"path": MODEL_FILE.name, "sha256": EXPECTED_SHA256, "size": EXPECTED_SIZE}]
            and MODEL_FILE.stat().st_size == EXPECTED_SIZE
            and sha256(MODEL_FILE) == EXPECTED_SHA256
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def fetch() -> None:
    if verified():
        print(json.dumps({"event": "ocr_layout_model_verified", "model": MODEL_NAME}), flush=True)
        return
    staging = MODEL_ROOT.with_name(MODEL_ROOT.name + ".staging")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, mode=0o750)
    destination = staging / MODEL_FILE.name
    context = ssl.create_default_context()
    try:
        request = urllib.request.Request(SOURCE_URL, headers={"user-agent": "teamaibox-model-fetcher/1"})
        with urllib.request.urlopen(request, timeout=300, context=context) as response, destination.open("wb") as output:
            shutil.copyfileobj(response, output, 8 * 1024 * 1024)
        if destination.stat().st_size != EXPECTED_SIZE or sha256(destination) != EXPECTED_SHA256:
            raise RuntimeError("layout ONNX artifact identity mismatch")
        manifest = {
            "schemaVersion": 1,
            "model": MODEL_NAME,
            "sourceRepository": SOURCE_REPOSITORY,
            "sourceRevision": SOURCE_REVISION,
            "sourcePath": SOURCE_PATH,
            "sourceUrl": SOURCE_URL,
            "format": "onnx",
            "conversionReview": {
                "repository": "PT-Perkasa-Pilar-Utama/ppu-doclayout",
                "revision": "c90694f9bbac9b4c11843c03f83781436109315f",
            },
            "files": [{"path": MODEL_FILE.name, "sha256": EXPECTED_SHA256, "size": EXPECTED_SIZE}],
        }
        encoded = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        manifest["manifestDigest"] = "sha256:" + hashlib.sha256(encoded).hexdigest()
        (staging / MANIFEST.name).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        if MODEL_ROOT.exists():
            shutil.rmtree(MODEL_ROOT)
        staging.rename(MODEL_ROOT)
        MODEL_ROOT.chmod(0o755)
        for path in MODEL_ROOT.iterdir():
            path.chmod(0o644)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    if not verified():
        raise RuntimeError("layout ONNX verification failed after import")
    print(json.dumps({"event": "ocr_layout_model_imported", "model": MODEL_NAME, "fileCount": 1}), flush=True)


if __name__ == "__main__":
    fetch()
