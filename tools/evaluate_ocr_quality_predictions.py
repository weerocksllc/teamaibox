#!/usr/bin/env python3
"""Evaluate transient OCR predictions without retaining document content."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

try:
    from .ocr_quality_metrics import layout_scores, teds, text_error_counts
except ImportError:
    from ocr_quality_metrics import layout_scores, teds, text_error_counts


SLICE_ORDER = ("clean-print", "scan-photo", "complex-layout", "tables-formulas", "multilingual")
TEXT_SLICES = ("clean-print", "scan-photo", "multilingual")
THRESHOLDS = {
    "character-error-rate": {"direction": "maximum", "threshold": 0.08, "slices": TEXT_SLICES},
    "word-error-rate": {"direction": "maximum", "threshold": 0.15, "slices": TEXT_SLICES},
    "layout-block-f1": {"direction": "minimum", "threshold": 0.85, "slices": ("complex-layout",)},
    "table-structure-teds": {"direction": "minimum", "threshold": 0.8, "slices": ("tables-formulas",)},
    "reading-order-accuracy": {"direction": "minimum", "threshold": 0.9, "slices": ("complex-layout",)},
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def rounded(value: float) -> float:
    return round(value, 8)


def evaluate(value: dict[str, Any]) -> dict[str, Any]:
    cases = value.get("cases")
    require(value.get("schemaVersion") == 1 and isinstance(cases, list) and cases,
            "OCR prediction input is invalid")
    require(len({item.get("caseId") for item in cases}) == len(cases), "OCR prediction case IDs are duplicated")
    counts = {key: sum(item.get("slice") == key for item in cases) for key in SLICE_ORDER}
    per_case = []
    aggregates: dict[str, dict[str, list[dict[str, Any]]]] = {
        metric: {slice_key: [] for slice_key in contract["slices"]}
        for metric, contract in THRESHOLDS.items()
    }
    for item in cases:
        slice_key = item.get("slice")
        require(slice_key in SLICE_ORDER and isinstance(item.get("caseId"), str), "OCR prediction case identity drifted")
        require(str(item.get("inputDigest", "")).startswith("sha256:")
                and str(item.get("responseDigest", "")).startswith("sha256:"), "OCR case digest binding is invalid")
        result: dict[str, Any] = {
            "caseId": item["caseId"], "slice": slice_key, "inputDigest": item["inputDigest"],
            "responseDigest": item["responseDigest"], "elapsedMilliseconds": item["elapsedMilliseconds"],
            "pageCount": item["pageCount"], "blockCount": item["blockCount"],
        }
        if slice_key in TEXT_SLICES:
            counts_value = text_error_counts(item["referenceText"], item["predictionText"])
            require(counts_value["referenceCharacters"] > 0 and counts_value["referenceWords"] > 0,
                    "OCR text reference is empty")
            result.update(counts_value)
            aggregates["character-error-rate"][slice_key].append(counts_value)
            aggregates["word-error-rate"][slice_key].append(counts_value)
        elif slice_key == "complex-layout":
            layout = layout_scores(item["referenceBlocks"], item["predictionBlocks"])
            result.update(layout)
            aggregates["layout-block-f1"][slice_key].append(layout)
            aggregates["reading-order-accuracy"][slice_key].append(layout)
        elif slice_key == "tables-formulas":
            score = teds(item["referenceTableHtml"], item["predictionTableHtml"])
            result["teds"] = rounded(score)
            aggregates["table-structure-teds"][slice_key].append({"teds": score})
        per_case.append(result)

    measurements = {}
    all_passed = True
    for metric, contract in THRESHOLDS.items():
        slices = {}
        for slice_key, items in aggregates[metric].items():
            if metric == "character-error-rate":
                numerator = sum(item["characterErrors"] for item in items)
                denominator = sum(item["referenceCharacters"] for item in items)
                score = numerator / denominator if denominator else 1.0
            elif metric == "word-error-rate":
                numerator = sum(item["wordErrors"] for item in items)
                denominator = sum(item["referenceWords"] for item in items)
                score = numerator / denominator if denominator else 1.0
            elif metric == "layout-block-f1":
                score = sum(item["f1"] for item in items) / len(items) if items else 0.0
            elif metric == "reading-order-accuracy":
                correct = sum(item["correctOrderPairs"] for item in items)
                pairs = sum(item["orderPairCount"] for item in items)
                score = correct / pairs if pairs else 0.0
            else:
                score = sum(item["teds"] for item in items) / len(items) if items else 0.0
            enough = len(items) >= 80
            threshold_passed = score <= contract["threshold"] if contract["direction"] == "maximum" else score >= contract["threshold"]
            passed = enough and threshold_passed
            all_passed = all_passed and passed
            slices[slice_key] = {"sampleCount": len(items), "value": rounded(score),
                                 "minimumSamples": 80, "thresholdPassed": threshold_passed,
                                 "sampleCountPassed": enough, "passed": passed}
        measurements[metric] = {"direction": contract["direction"], "threshold": contract["threshold"],
                                "slices": slices, "passed": all(item["passed"] for item in slices.values())}
    full_corpus = len(cases) >= 400 and all(counts[key] >= 80 for key in SLICE_ORDER)
    passed = full_corpus and all_passed
    report = {
        "schemaVersion": 1, "evaluatorId": "teamaibox.ocr-quality-evaluator.v1",
        "status": "passed" if passed else "diagnostic", "caseCount": len(cases), "sliceCounts": counts,
        "fullCorpusMinimumPassed": full_corpus, "measurements": measurements,
        "cases": sorted(per_case, key=lambda item: item["caseId"]),
        "contentRetained": False, "passed": passed,
    }
    report["reportDigest"] = digest(json.dumps(report, ensure_ascii=False, sort_keys=True,
                                                separators=(",", ":")).encode())
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    args = parser.parse_args()
    value = json.loads(args.input.read_text(encoding="utf-8"))
    print(json.dumps(evaluate(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"OCR quality evaluation failed: {error}")
        raise SystemExit(1)
