import hashlib
import json
import os
from pathlib import Path
import threading

from huggingface_hub import snapshot_download


repository = os.environ["TEAMAIBOX_DRAWING_MODEL_REPOSITORY"]
revision = os.environ["TEAMAIBOX_DRAWING_MODEL_REVISION"]
target = Path(os.environ["TEAMAIBOX_DRAWING_MODEL_ROOT"])
target.mkdir(parents=True, exist_ok=True)

resolved = snapshot_download(
    repo_id=repository,
    revision=revision,
    local_dir=target,
    allow_patterns=[
        "*.json", "*.txt", "*.model", "*.md", "LICENSE*",
        "*fp16*.safetensors", "scheduler/**", "tokenizer/**", "tokenizer_2/**",
    ],
)

files = []
total = 0
for path in sorted(Path(resolved).rglob("*")):
    if not path.is_file() or ".cache" in path.parts:
        continue
    size = path.stat().st_size
    total += size
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    files.append({
        "path": path.relative_to(resolved).as_posix(),
        "size": size,
        "sha256": "sha256:" + digest.hexdigest(),
    })
if total < 1 or total > 16_000_000_000:
    raise RuntimeError(f"model snapshot size outside approved envelope: {total}")

manifest = {
    "schemaVersion": 1,
    "repository": repository,
    "revision": revision,
    "variant": "fp16",
    "totalBytes": total,
    "files": files,
}
encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
manifest["manifestDigest"] = "sha256:" + hashlib.sha256(encoded).hexdigest()
(target / "teamaibox-model-manifest.json").write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8"
)
print(json.dumps({"status": "downloaded", "revision": revision, "totalBytes": total, "fileCount": len(files)}))
if os.environ.get("TEAMAIBOX_DOWNLOAD_KEEP_ALIVE") == "1":
    threading.Event().wait()
