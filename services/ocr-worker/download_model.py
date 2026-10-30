"""Fetch and verify the exact PaddleOCR-VL snapshot into a Docker volume."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import ssl
import urllib.request


REPOSITORY = os.environ.get("TEAMAIBOX_OCR_MODEL_REPOSITORY", "PaddlePaddle/PaddleOCR-VL-1.5")
REVISION = os.environ.get("TEAMAIBOX_OCR_MODEL_REVISION", "df2b114327c857f4db801d3d5b6741ad9a24fcd1")
MODEL_ROOT = Path(os.environ.get("TEAMAIBOX_OCR_MODEL_ROOT", "/models/paddleocr-vl-1.5"))
MANIFEST = MODEL_ROOT / "teamaibox-model-manifest.json"
EXPECTED = {
    # Populated only with publisher bytes from the immutable revision. A missing
    # or changed artifact fails closed before the model becomes visible.
    "added_tokens.json": "sha256:f59f889088e0fe21c523e7cf121bb6dca3b0bb148cb7159fbb4572c74dfc5644",
    "chat_template.jinja": "sha256:2f27812dab7f333e471884e0c803d807f11953d5453140dfb1aaba234f872bc8",
    "config.json": "sha256:ce7f4565f8b1db78532ad5d1b9ebe55c2139d49bd4cb04778b580a08a598f171",
    "configuration_paddleocr_vl.py": "sha256:753dd93654c3a9c8c85a3eaee1e3092dd12591b0f2dce0305e1abfb7a41ff160",
    "generation_config.json": "sha256:a6701d78ab3b4d972307cdec3b69d4c13f46e0d5140514f50ab7d84259324b94",
    "image_processing_paddleocr_vl.py": "sha256:a4fa521b9cb16e207f94b7f2d16427771776dfc634420d319fc4916ee58049ec",
    "model.safetensors": "sha256:d557c9d8997ae57ed3b1b33bdf347be878cc335687f32ca105341c16973f8958",
    "modeling_paddleocr_vl.py": "sha256:c5013dff57ca8b87dc1de64d0fd839a44313de09d230a4fb2d08289d2cad5111",
    "preprocessor_config.json": "sha256:111872ab1e8bb7fd040ac5087bfced7ab8f011f02139b088cba294964c3b1d0e",
    "processing_paddleocr_vl.py": "sha256:e29cb1e5f275f2bd3ce051bd5c9983a33894e693b2823a0e13d4c07c8c4f9e13",
    "processor_config.json": "sha256:1568858960a9760c54431dae693a6152e601ff55cdf6d2eab97a4a99958faea0",
    "special_tokens_map.json": "sha256:d3a125c03103deb2acaf7730791bdbbf196f620e5a2213b664511ff9b4b25bab",
    "tokenizer.json": "sha256:c8a215a59183d0d0781adc33bacd3ce6162716f7fd568fb30234a74d69803a7d",
    "tokenizer.model": "sha256:34ef7db83df785924fb83d7b887b6e822a031c56e15cff40aaf9b982988180df",
    "tokenizer_config.json": "sha256:1f979337347cc0cb72a6282d8a23ed183539aa81a87a906f022aee2bab83c7c5",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def verified() -> bool:
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if manifest.get("repository") != REPOSITORY or manifest.get("revision") != REVISION:
            return False
        files = {item["path"]: item["sha256"] for item in manifest["files"]}
        return files == EXPECTED and all(sha256(MODEL_ROOT / path) == expected for path, expected in EXPECTED.items())
    except (KeyError, OSError, ValueError, json.JSONDecodeError):
        return False


def fetch() -> None:
    if verified():
        print(json.dumps({"event": "ocr_model_verified", "revision": REVISION}), flush=True)
        return
    if any(value.startswith("__") for value in EXPECTED.values()):
        raise RuntimeError("model artifact hashes have not been audited")
    staging = MODEL_ROOT.with_name(MODEL_ROOT.name + ".staging")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, mode=0o750)
    context = ssl.create_default_context()
    records = []
    try:
        for name, expected in EXPECTED.items():
            destination = staging / name
            url = f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{name}"
            request = urllib.request.Request(url, headers={"user-agent": "teamaibox-model-fetcher/1"})
            with urllib.request.urlopen(request, timeout=120, context=context) as response, destination.open("wb") as output:
                shutil.copyfileobj(response, output, 8 * 1024 * 1024)
            actual = sha256(destination)
            if actual != expected:
                raise RuntimeError(f"model artifact digest mismatch: {name}")
            records.append({"path": name, "sha256": actual, "size": destination.stat().st_size})
        manifest = {"schemaVersion": 1, "repository": REPOSITORY, "revision": REVISION, "precision": "bf16", "files": records}
        encoded = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        manifest["manifestDigest"] = "sha256:" + hashlib.sha256(encoded).hexdigest()
        (staging / MANIFEST.name).write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if MODEL_ROOT.exists():
            shutil.rmtree(MODEL_ROOT)
        staging.rename(MODEL_ROOT)
        for directory in [MODEL_ROOT, *[path for path in MODEL_ROOT.rglob("*") if path.is_dir()]]:
            directory.chmod(0o755)
        for file in [path for path in MODEL_ROOT.rglob("*") if path.is_file()]:
            file.chmod(0o644)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    if not verified():
        raise RuntimeError("model snapshot verification failed after import")
    print(json.dumps({"event": "ocr_model_imported", "revision": REVISION, "fileCount": len(records)}), flush=True)


if __name__ == "__main__":
    fetch()
