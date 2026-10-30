#!/usr/bin/env python3
"""Compare bounded translation prompt variants without changing production routing."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import urllib.request

from sacrebleu.metrics import CHRF


NUMBER = re.compile(r"\d+(?:[.,:/-]\d+)*")
PROMPTS = {
    "preserve": (
        "You are a precise translation engine. Return only JSON: "
        '{"source_language":"BCP-47","translations":["..."]}. '
        "Preserve the input array length and order. Preserve every number, measurement, code, product name, "
        "and Latin-script proper noun exactly. Do not add commentary."
    ),
    "literal": (
        "You are a precise literal translation engine. Return only JSON: "
        '{"source_language":"BCP-47","translations":["..."]}. '
        "Preserve the input array length, order, sentence boundaries, clause order, and all explicitly stated facts. "
        "Translate as directly as fluent Simplified Chinese permits; do not paraphrase, merge, summarize, explain, "
        "or add facts. Preserve every number, unit, code, product name, and Latin-script proper noun exactly."
    ),
    "benchmark-literal": (
        "Produce faithful benchmark-reference translations. Return only JSON: "
        '{"source_language":"BCP-47","translations":["..."]}. '
        "Use Mainland Simplified Chinese for zh-CN. Preserve array order, source sentence boundaries, clause order, "
        "and direct lexical meaning. Avoid stylistic rewriting. Never omit, infer, or add information. Preserve every "
        "number, measurement, code, product name, and Latin-script proper noun exactly."
    ),
}


def digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def infer(base_url: str, model: str, prompt: str, cases: list[dict[str, object]]) -> list[str]:
    body = {
        "model": model, "stream": False, "temperature": 0,
        "response_format": {"type": "json_object"},
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps({
                "source_language": "en", "target_language": "zh-CN",
                "segments": [item["source"] for item in cases],
            }, ensure_ascii=False, separators=(",", ":"))},
        ],
    }
    request = urllib.request.Request(
        base_url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(),
        headers={"content-type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        value = json.load(response)
    translations = json.loads(value["choices"][0]["message"]["content"])["translations"]
    if not isinstance(translations, list) or len(translations) != len(cases) or any(not isinstance(x, str) or not x for x in translations):
        raise ValueError("prompt ablation response is not aligned")
    return translations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--served-model", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cases", type=int, default=25)
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_text(encoding="utf-8"))
    cases = [item for item in corpus["cases"] if item["sourceLanguage"] == "en" and item["targetLanguage"] == "zh-CN"][:args.cases]
    if len(cases) != args.cases or not 1 <= args.cases <= 50:
        raise ValueError("bounded en-zh ablation corpus is invalid")
    chrf = CHRF(word_order=2)
    variants = []
    for key, prompt in PROMPTS.items():
        translations: list[str] = []
        for offset in range(0, len(cases), 5):
            translations.extend(infer(args.base_url, args.served_model, prompt, cases[offset:offset + 5]))
        scores = [chrf.sentence_score(hypothesis, [str(case["reference"])]).score / 100
                  for case, hypothesis in zip(cases, translations)]
        numeric = [Counter(NUMBER.findall(hypothesis.casefold())) == Counter(NUMBER.findall(str(case["source"]).casefold()))
                   for case, hypothesis in zip(cases, translations)]
        terminology = [all(str(term).casefold() in hypothesis.casefold() for term in case["requiredTerms"])
                       for case, hypothesis in zip(cases, translations)]
        variants.append({
            "key": key, "promptDigest": digest(prompt), "caseCount": len(cases),
            "meanChrf": sum(scores) / len(scores), "numericAccuracy": sum(numeric) / len(numeric),
            "terminologyAccuracy": sum(terminology) / len(terminology),
            "outputDigest": digest(translations),
        })
    report = {
        "schemaVersion": 1, "runner": "teamaibox.translation-prompt-ablation.v1",
        "corpusDigest": corpus["corpusDigest"], "servedModel": args.served_model,
        "selection": {"direction": "en-zh", "caseCount": len(cases),
                      "caseIdDigest": digest([item["caseId"] for item in cases])},
        "variants": variants, "plaintextCasesRetained": False,
    }
    report["resultDigest"] = digest(report)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
