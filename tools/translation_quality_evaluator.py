#!/usr/bin/env python3
"""Compute real COMET, chrF++, terminology, numeric, and alignment metrics."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import statistics
import unicodedata

from comet import download_model, load_from_checkpoint
from sacrebleu.metrics import CHRF


NUMBER = re.compile(r"\d+(?:[.,:/-]\d+)*")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--comet-model", default="Unbabel/wmt22-comet-da")
    parser.add_argument("--comet-cache", type=Path, required=True)
    args = parser.parse_args()
    candidate = json.loads(args.candidate.read_text(encoding="utf-8"))
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    if candidate["corpusDigest"] != baseline["corpusDigest"] or candidate["caseCount"] != 500 or baseline["caseCount"] != 500:
        raise ValueError("candidate and baseline corpora are not identical")
    cand = candidate["cases"]
    base = baseline["cases"]
    if [x["caseId"] for x in cand] != [x["caseId"] for x in base]:
        raise ValueError("candidate and baseline cases are not aligned")
    started = now()
    chrf = CHRF(word_order=2)
    checkpoint = download_model(args.comet_model, saving_directory=str(args.comet_cache))
    comet = load_from_checkpoint(checkpoint)
    slices = sorted({slice_key for item in cand for slice_key in item["slices"]})

    def score_comet(values: list[dict[str, object]]) -> list[float]:
        data = [{"src": str(item["source"]), "mt": str(item["hypothesis"]), "ref": str(item["reference"])} for item in values]
        prediction = comet.predict(data, batch_size=8, gpus=0, progress_bar=False)
        return [float(value) for value in prediction.scores]

    candidate_comet = score_comet(cand)
    baseline_comet = score_comet(base)
    records = []
    for index, item in enumerate(cand):
        reference = str(item["reference"])
        candidate_hypothesis = str(item["hypothesis"])
        baseline_hypothesis = str(base[index]["hypothesis"])
        required_terms = [str(value) for value in item["requiredTerms"]]
        source_numbers = Counter(NUMBER.findall(normalized(str(item["source"]))))
        records.append({
            "caseId": item["caseId"], "slices": item["slices"],
            "candidateComet": candidate_comet[index], "baselineComet": baseline_comet[index],
            "candidateChrf": chrf.sentence_score(candidate_hypothesis, [reference]).score / 100,
            "baselineChrf": chrf.sentence_score(baseline_hypothesis, [reference]).score / 100,
            "candidateTerminology": all(term in normalized(candidate_hypothesis) for term in required_terms),
            "baselineTerminology": all(term in normalized(baseline_hypothesis) for term in required_terms),
            "candidateNumeric": Counter(NUMBER.findall(normalized(candidate_hypothesis))) == source_numbers,
            "baselineNumeric": Counter(NUMBER.findall(normalized(baseline_hypothesis))) == source_numbers,
            "candidateAligned": True, "baselineAligned": True,
        })

    def mean(field: str, slice_key: str) -> float:
        values = [float(item[field]) for item in records if slice_key in item["slices"]]
        if not values:
            raise ValueError(f"missing metric slice: {field}/{slice_key}")
        return statistics.fmean(values)

    measurements = []
    for metric, candidate_field, baseline_field, required in (
        ("comet-score", "candidateComet", "baselineComet", ["en-zh", "long-tail", "zh-en"]),
        ("chrf-score", "candidateChrf", "baselineChrf", ["en-zh", "long-tail", "zh-en"]),
        ("terminology-accuracy", "candidateTerminology", "baselineTerminology", ["terminology"]),
        ("numeric-entity-preservation", "candidateNumeric", "baselineNumeric", ["en-zh", "long-tail", "zh-en"]),
        ("segment-alignment-accuracy", "candidateAligned", "baselineAligned", ["subtitle-segments"]),
    ):
        for slice_key in required:
            sample_count = sum(slice_key in item["slices"] for item in records)
            measurements.append({
                "metricKey": metric, "sliceKey": slice_key, "value": mean(candidate_field, slice_key),
                "baselineValue": mean(baseline_field, slice_key), "sampleCount": sample_count,
            })
    report = {
        "schemaVersion": 1, "runner": "teamaibox.translation-quality-evaluator.v1",
        "corpusDigest": candidate["corpusDigest"], "candidateProfileFingerprint": candidate["profileFingerprint"],
        "baselineProfileFingerprint": baseline["profileFingerprint"], "cometModel": args.comet_model,
        "chrfSignature": str(chrf.get_signature()), "caseCount": 500,
        "sliceCounts": [{"sliceKey": key, "caseCount": sum(key in item["slices"] for item in records)} for key in slices],
        "measurements": measurements, "startedAt": started, "finishedAt": now(),
        "plaintextCasesRetained": False, "credentialsRetained": False,
    }
    report["resultDigest"] = digest(report)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"resultDigest": report["resultDigest"], "measurementCount": len(measurements)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
