#!/usr/bin/env python3
"""Run the exact Translation prompt contract against one internal OpenAI worker."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request


SYSTEM = ('You are a precise translation engine. Return only JSON: '
          '{"source_language":"BCP-47","translations":["..."]}. '
          'Preserve the input array length and order. Preserve every number, measurement, code, '
          'product name, and Latin-script proper noun exactly. Do not add commentary.')


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--served-model", required=True)
    parser.add_argument("--profile-key", required=True)
    parser.add_argument("--profile-fingerprint", required=True)
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_text(encoding="utf-8"))
    cases = corpus.get("cases")
    if not isinstance(cases, list) or len(cases) != 500 or not (1 <= args.batch_size <= 25):
        raise ValueError("corpus or bounded batch size is invalid")
    started = now()
    outputs: list[dict[str, object]] = []
    usage = {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0}
    request_count = 0
    recovery_splits = 0

    def infer(batch: list[dict[str, object]]) -> list[tuple[str, float]]:
        nonlocal request_count, recovery_splits
        direction = (batch[0]["sourceLanguage"], batch[0]["targetLanguage"])
        body = {
            "model": args.served_model,
            "stream": False,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": json.dumps({
                    "source_language": direction[0], "target_language": direction[1],
                    "segments": [item["source"] for item in batch],
                }, ensure_ascii=False, separators=(",", ":"))},
            ],
        }
        last_error: BaseException | None = None
        for _ in range(3):
            began = time.monotonic()
            request = urllib.request.Request(
                args.base_url.rstrip("/") + "/v1/chat/completions",
                data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(),
                headers={"accept": "application/json", "content-type": "application/json"}, method="POST",
            )
            request_count += 1
            try:
                with urllib.request.urlopen(request, timeout=args.timeout_seconds) as response:
                    raw = response.read(4 * 1024 * 1024 + 1)
                    if response.status != 200 or len(raw) > 4 * 1024 * 1024:
                        raise ValueError("translation worker response is invalid or oversized")
                value = json.loads(raw)
                response_usage = value.get("usage") or {}
                for source, target in (("prompt_tokens", "promptTokens"), ("completion_tokens", "completionTokens"), ("total_tokens", "totalTokens")):
                    amount = response_usage.get(source, 0)
                    if isinstance(amount, int) and amount >= 0:
                        usage[target] += amount
                content = value["choices"][0]["message"]["content"]
                translated = json.loads(content)
                translations = translated.get("translations")
                if not isinstance(translations, list) or len(translations) != len(batch) or any(
                        not isinstance(item, str) or not item.strip() for item in translations):
                    raise ValueError("translation output array is not aligned")
                per_case = round((time.monotonic() - began) * 1000 / len(batch), 3)
                return [(item.strip(), per_case) for item in translations]
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, KeyError,
                    TypeError, ValueError, json.JSONDecodeError) as error:
                last_error = error
        if len(batch) > 1:
            recovery_splits += 1
            middle = len(batch) // 2
            return infer(batch[:middle]) + infer(batch[middle:])
        raise RuntimeError(f"single-segment translation stayed invalid after retries: {last_error}")

    offset = 0
    while offset < len(cases):
        direction = (cases[offset]["sourceLanguage"], cases[offset]["targetLanguage"])
        end = offset
        while end < len(cases) and end - offset < args.batch_size and (
            cases[end]["sourceLanguage"], cases[end]["targetLanguage"]
        ) == direction:
            end += 1
        batch = cases[offset:end]
        if not batch or any(
            (item["sourceLanguage"], item["targetLanguage"]) != direction for item in batch
        ):
            raise ValueError("corpus direction grouping is invalid")
        translated = infer(batch)
        for case, (hypothesis, per_case) in zip(batch, translated):
            outputs.append({
                "caseId": case["caseId"], "sliceKey": case["sliceKey"],
                "sourceLanguage": case["sourceLanguage"], "targetLanguage": case["targetLanguage"],
                "source": case["source"], "reference": case["reference"],
                "hypothesis": hypothesis, "slices": case["slices"],
                "requiredTerms": case["requiredTerms"], "latencyMilliseconds": round(per_case, 3),
            })
        offset = end
    if len(outputs) != len(cases) or [item["caseId"] for item in outputs] != [item["caseId"] for item in cases]:
        raise ValueError("translation inference skipped or reordered cases")
    report = {
        "schemaVersion": 1, "runner": "teamaibox.translation-quality-inference.v1",
        "profileKey": args.profile_key, "profileFingerprint": args.profile_fingerprint,
        "servedModel": args.served_model, "promptContract": "teamaibox.translation.aligned-json.v1",
        "promptDigest": digest(SYSTEM), "corpusDigest": corpus["corpusDigest"],
        "caseCount": len(outputs), "requestCount": request_count, "batchSizeMaximum": args.batch_size,
        "alignmentRecoverySplits": recovery_splits,
        "usage": usage, "startedAt": started, "finishedAt": now(), "cases": outputs,
        "credentialsRetained": False,
    }
    report["resultDigest"] = digest(report)
    args.output.write_text(json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"caseCount": len(outputs), "requestCount": request_count,
                      "resultDigest": report["resultDigest"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
