#!/usr/bin/env python3
"""Bounded, content-free OpenAI-protocol probe for the protected LMT4 profile."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import time
import urllib.request


BASE_URL = "http://127.0.0.1:8000"
MODEL = "lmt-60-4b-nvfp4-mlp-edge"
SYSTEM = (
    "You are a precise translation engine. Return only JSON: "
    '{"source_language":"BCP-47","translations":["..."]}. '
    "Preserve input array length and order. Do not add commentary."
)


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def request(base_url: str, path: str, document: dict[str, object] | None = None) -> dict[str, object]:
    body = None if document is None else json.dumps(document, ensure_ascii=False).encode("utf-8")
    headers = {"accept": "application/json"}
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base_url.rstrip("/") + path, data=body, headers=headers,
                                 method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=180) as response:
        raw = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 1024 * 1024:
            raise RuntimeError("LMT4 returned an invalid or oversized response")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise RuntimeError("LMT4 returned a non-object response")
    return value


def infer(base_url: str, model: str, source_language: str, target_language: str,
          segments: list[str]) -> dict[str, object]:
    started = time.monotonic()
    value = request(base_url, "/v1/chat/completions", {
        "model": model,
        "stream": False,
        "temperature": 0,
        "max_tokens": 256,
        "response_format": {"type": "json_object"},
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps({
                "source_language": source_language,
                "target_language": target_language,
                "segments": segments,
            }, ensure_ascii=False, separators=(",", ":"))},
        ],
    })
    content = value.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str):
        raise RuntimeError("LMT4 completion content is missing")
    normalized = content.strip()
    if normalized.startswith("```json"):
        normalized = normalized[7:]
    elif normalized.startswith("```"):
        normalized = normalized[3:]
    if normalized.endswith("```"):
        normalized = normalized[:-3]
    aligned = json.loads(normalized.strip())
    # LMT4's native OpenAI response contract uses ``segments``.  The existing
    # product adapter translates that key to the platform's ``translations``
    # contract; accept either here so this low-level probe checks the model's
    # real protocol rather than duplicating adapter behavior.
    schema_key = "translations" if "translations" in aligned else "segments"
    outputs = aligned.get(schema_key)
    if not isinstance(outputs, list) or len(outputs) != len(segments) or not all(
        isinstance(item, str) and item.strip() for item in outputs
    ):
        raise RuntimeError("LMT4 completion did not preserve alignment")
    return {
        "sourceLanguage": source_language,
        "targetLanguage": target_language,
        "segmentCount": len(segments),
        "alignedCount": len(outputs),
        "nativeSchemaKey": schema_key,
        "outputHasCjk": any("\u4e00" <= char <= "\u9fff" for item in outputs for char in item),
        "outputHasLatin": any("a" <= char.lower() <= "z" for item in outputs for char in item),
        "outputDigest": sha256_text(json.dumps(outputs, ensure_ascii=False, separators=(",", ":"))),
        "latencyMilliseconds": round((time.monotonic() - started) * 1000, 3),
        "usagePresent": isinstance(value.get("usage"), dict),
        "contentRetained": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()
    models = request(args.base_url, "/v1/models")
    model_ids = [item.get("id") for item in models.get("data", []) if isinstance(item, dict)]
    if model_ids != [args.model]:
        raise RuntimeError("LMT4 model discovery drifted")
    cases = [
        ("en", "zh-CN", ["Team AI Box keeps office tools ready.", "The total is 128 GB."]),
        ("zh-CN", "en", ["团队智能盒子已经准备好。", "请保留产品名称 Team AI Box。"]),
        ("en", "zh-CN", ["Open the spreadsheet and summarize the result."]),
        ("zh-CN", "en", ["把会议记录翻译成英文。"]),
    ]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda item: infer(args.base_url, args.model, *item), cases))
    if not results[0]["outputHasCjk"] or not results[1]["outputHasLatin"]:
        raise RuntimeError("LMT4 language direction probe failed")
    print(json.dumps({
        "model": args.model,
        "modelDiscovered": True,
        "parallelRequestCount": len(results),
        "aligned": all(item["segmentCount"] == item["alignedCount"] for item in results),
        "usagePresent": all(item["usagePresent"] for item in results),
        "contentRetained": False,
        "results": results,
    }, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
