#!/usr/bin/env python3
"""Content-minimising same-runtime probe for HunyuanOCR AR/DFlash comparison."""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import time
from pathlib import Path


PROMPT = (
    "提取文档图片中正文的所有信息用markdown格式表示，其中页眉、页脚部分忽略，"
    "表格用html格式表达，文档中公式用latex格式表示，按照阅读顺序组织进行解析。"
)


def sha256(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--expected-input-digest", required=True)
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args()
    raw = args.input.read_bytes()
    if sha256(raw) != args.expected_input_digest or not 2 <= args.runs <= 8:
        raise RuntimeError("benchmark input or run count is invalid")

    from worker_hunyuanocr.ocr_runtime import generate_markdown_batch, get_runtime

    started = time.monotonic()
    runtime = get_runtime()
    load_ms = round((time.monotonic() - started) * 1000)
    runs = []
    for ordinal in range(1, args.runs + 1):
        started = time.monotonic()
        generated = generate_markdown_batch([(args.input, PROMPT)])
        elapsed_ms = round((time.monotonic() - started) * 1000)
        if len(generated) != 1 or not isinstance(generated[0][0], str) or not generated[0][0].strip():
            raise RuntimeError("HunyuanOCR benchmark returned an empty result")
        text = generated[0][0].encode("utf-8")
        runs.append({"ordinal": ordinal, "elapsedMilliseconds": elapsed_ms,
                     "textCharacters": len(generated[0][0]), "textDigest": sha256(text)})
    print(json.dumps({
        "schemaVersion": 1, "mode": runtime.inference_mode,
        "backendVersion": runtime.backend_version, "dtype": runtime.dtype,
        "loadMilliseconds": load_ms, "runs": runs,
        "medianGenerationMilliseconds": statistics.median(item["elapsedMilliseconds"] for item in runs),
        "contentRetained": False,
    }, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
