#!/usr/bin/env python3
"""Run a content-free real OpenAI Embeddings probe against a protected Worker."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import math
import time
from typing import Any
from urllib import error, request


SYNTHETIC_INPUTS = (
    "A project status summary for the weekly office meeting.",
    "本周办公项目进度摘要与待办事项。",
    "Find the policy document about encrypted team storage.",
    "检索有关团队加密存储的制度文档。",
    "Meeting notes describing an approved purchase request.",
    "客户会议纪要与后续行动项。",
    "A short troubleshooting guide for a local network printer.",
    "局域网打印机故障排查说明。",
)


class ProbeError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ProbeError(message)


def call(base_url: str, model: str, values: list[str], timeout: int = 180) -> tuple[dict[str, Any], float]:
    body = json.dumps({"model": model, "input": values, "encoding_format": "float"},
                      separators=(",", ":")).encode()
    outgoing = request.Request(base_url.rstrip("/") + "/v1/embeddings", data=body,
                               headers={"Content-Type": "application/json", "Accept": "application/json"})
    started = time.perf_counter()
    try:
        with request.urlopen(outgoing, timeout=timeout) as response:
            require(response.status == 200, "embedding endpoint returned a non-200 response")
            payload = response.read(32 * 1024 * 1024 + 1)
    except error.HTTPError as exc:
        raise ProbeError(f"embedding endpoint returned HTTP {exc.code}") from exc
    require(len(payload) <= 32 * 1024 * 1024, "embedding response exceeded the probe limit")
    value = json.loads(payload)
    require(isinstance(value, dict), "embedding response was not an object")
    return value, round((time.perf_counter() - started) * 1000, 3)


def vectors(value: dict[str, Any], model: str, count: int) -> list[list[float]]:
    data = value.get("data")
    require(value.get("object") == "list" and value.get("model") == model
            and isinstance(data, list) and len(data) == count,
            "embedding response shape drifted")
    result: list[list[float]] = []
    for index, item in enumerate(data):
        vector = item.get("embedding") if isinstance(item, dict) else None
        require(item.get("object") == "embedding" and item.get("index") == index
                and isinstance(vector, list) and len(vector) == 1024
                and all(isinstance(number, (int, float)) and not isinstance(number, bool)
                        and math.isfinite(number) for number in vector),
                "embedding vector was invalid")
        result.append([float(number) for number in vector])
    return result


def vector_digest(vector: list[float]) -> str:
    canonical = json.dumps(vector, separators=(",", ":"), allow_nan=False).encode()
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def cosine(left: list[float], right: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(left, right))
    denominator = math.sqrt(sum(a * a for a in left) * sum(b * b for b in right))
    require(denominator > 0, "embedding vector norm was zero")
    return numerator / denominator


def run(base_url: str, model: str, concurrency: int) -> dict[str, Any]:
    require(1 <= concurrency <= 8, "probe concurrency is outside the bounded profile")
    with request.urlopen(base_url.rstrip("/") + "/v1/models", timeout=60) as response:
        models = json.loads(response.read(1024 * 1024))
    identifiers = sorted(item.get("id") for item in models.get("data", []) if isinstance(item, dict))
    require(model in identifiers, "served embedding model was not discoverable")

    first_body, first_ms = call(base_url, model, [SYNTHETIC_INPUTS[0]])
    second_body, second_ms = call(base_url, model, [SYNTHETIC_INPUTS[0]])
    first = vectors(first_body, model, 1)[0]
    second = vectors(second_body, model, 1)[0]
    maximum_difference = max(abs(a - b) for a, b in zip(first, second))
    repeat_cosine = cosine(first, second)
    require(maximum_difference <= 1e-6 and repeat_cosine >= 0.999999,
            "repeat embedding stability drifted")

    latencies: list[float] = []
    dimensions: list[int] = []
    digests: list[str] = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        pending = [pool.submit(call, base_url, model, [text]) for text in SYNTHETIC_INPUTS]
        for future in as_completed(pending):
            body, elapsed = future.result()
            vector = vectors(body, model, 1)[0]
            latencies.append(elapsed)
            dimensions.append(len(vector))
            digests.append(vector_digest(vector))
    require(len(latencies) == len(SYNTHETIC_INPUTS)
            and dimensions == [1024] * len(SYNTHETIC_INPUTS),
            "concurrent embedding matrix was incomplete")
    return {
        "passed": True,
        "model": model,
        "modelsEndpoint": {"httpStatus": 200, "modelPresent": True},
        "protocol": "openai.embeddings@v1",
        "nativeDimensions": 1024,
        "repeat": {
            "maximumAbsoluteDifference": maximum_difference,
            "minimumCosineSimilarity": repeat_cosine,
            "vectorDigest": vector_digest(first),
            "requestLatenciesMilliseconds": [first_ms, second_ms],
        },
        # The qualification runner consumes this transient synthetic vector to
        # compare warm-restart numerical equivalence, then removes it before
        # writing immutable evidence. A byte-exact digest is too strict across
        # CUDA process restarts even when the vector remains within the
        # separately enforced 2e-3/0.9999 semantic-equivalence tolerance.
        "comparisonVector": first,
        "concurrency": {
            "workers": concurrency,
            "requestCount": len(latencies),
            "failureCount": 0,
            "maximumLatencyMilliseconds": max(latencies),
            "uniqueVectorDigestCount": len(set(digests)),
        },
        "kvCache": {
            "applicable": False,
            "configuredBytes": None,
            "dtype": None,
            "reason": "pooling-only embedding inference does not retain autoregressive KV state",
        },
        "syntheticContentOnly": True,
        "contentRetained": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()
    print(json.dumps(run(args.base_url, args.model, args.concurrency),
                     sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProbeError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"passed": False, "error": type(exc).__name__,
                          "message": str(exc)[:800]}, sort_keys=True, separators=(",", ":")))
        raise SystemExit(1)
