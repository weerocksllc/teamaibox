#!/usr/bin/env python3
"""Validate fail-closed non-LLM low-precision applicability evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
from typing import Any, Mapping


ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_EVALUATION = ROOT / "models" / "non-llm-precision-applicability.v1.json"
DEFAULT_MATRIX = ROOT / "models" / "candidate-matrix.v1.json"
WORKLOADS = {"image_drawing", "ocr", "asr", "translation"}
OUTCOMES = {"applicable", "not_applicable", "failed"}
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")


class ApplicabilityError(RuntimeError):
    pass


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ApplicabilityError(message)


def keyed(items: list[Mapping[str, Any]], key: str, label: str) -> dict[str, Mapping[str, Any]]:
    result = {str(item.get(key)): item for item in items}
    require(len(result) == len(items) and "None" not in result, f"{label} identities must be unique")
    return result


def validate(evaluation: Mapping[str, Any], matrix: Mapping[str, Any]) -> dict[str, int]:
    require(evaluation.get("schemaVersion") == 1, "unsupported applicability schema")
    require(SHA256.fullmatch(str(evaluation.get("candidateMatrixDigest"))) is not None, "candidate matrix digest is invalid")
    require(evaluation["candidateMatrixDigest"] == canonical_digest(matrix), "candidate matrix digest drifted")
    policy = evaluation.get("policy", {})
    require(set(policy.get("workloads", [])) == WORKLOADS, "applicability workloads are incomplete")
    require(policy.get("noForcedConversion") is True, "forced conversion must be prohibited")
    require(policy.get("downloadDuringApplicabilityEvaluation") is False, "applicability must remain pre-artifact")
    require(policy.get("productionProfileRequiresExactModelEngineRecipe") is True, "exact recipe gate is required")
    require(policy.get("applicableIsNotCertified") is True, "applicable cannot imply certification")
    sources = evaluation.get("researchSources")
    require(isinstance(sources, list), "primary research evidence is incomplete")
    source_ids = keyed(sources, "sourceId", "research source")
    require({"comfy.nvfp4.current", "nvidia.spark.comfyui", "paddle.ocr.precision", "openai.whisper.release"}
            .issubset(source_ids), "primary inference research evidence is incomplete")
    for source in source_ids.values():
        require(str(source.get("uri", "")).startswith("https://"), "research evidence must be HTTPS")
        require(bool(source.get("finding")) and bool(source.get("retrievedAt")), "research evidence requires a finding and retrieval time")

    matrix_candidates = keyed(matrix.get("candidates", []), "candidateId", "matrix candidate")
    expected = {
        key for key, item in matrix_candidates.items()
        if WORKLOADS.intersection(item.get("useCases", []))
    }
    evaluations = keyed(evaluation.get("evaluations", []), "candidateId", "precision evaluation")
    require(set(evaluations) == expected, "precision evaluation does not cover every non-LLM candidate")
    counts = {"applicable": 0, "not_applicable": 0, "failed": 0}
    paths_total = 0
    for candidate_id, item in evaluations.items():
        reviewed = matrix_candidates[candidate_id]
        require(item.get("workload") in WORKLOADS and item["workload"] in reviewed["useCases"], f"{candidate_id} workload drifted")
        require(item.get("source") == {"repository": reviewed["source"]["repository"], "revision": reviewed["source"]["revision"]}, f"{candidate_id} source drifted")
        require(item.get("engine") == reviewed["engine"]["name"], f"{candidate_id} engine drifted")
        paths = item.get("paths")
        require(isinstance(paths, list) and len(paths) >= 2, f"{candidate_id} low-precision paths are incomplete")
        path_by_precision = keyed(paths, "precision", f"{candidate_id} path")
        require("nvfp4" in path_by_precision, f"{candidate_id} lacks an NVFP4 decision")
        nvfp4 = path_by_precision["nvfp4"]
        applicability = reviewed["precision"]["nvfp4Applicability"]
        if applicability.startswith("not-applicable"):
            require(nvfp4.get("outcome") in {"not_applicable", "failed"}, f"{candidate_id} forced an unsupported NVFP4 path")
        for path in paths:
            outcome = path.get("outcome")
            require(outcome in OUTCOMES, f"{candidate_id} path outcome is invalid")
            require(path.get("conversionAttempted") is False and path.get("artifactDownloaded") is False, f"{candidate_id} mutated artifacts during applicability")
            require(path.get("productionEligible") is False, f"{candidate_id} applicability became production eligibility")
            refs = path.get("evidenceRefs")
            require(isinstance(refs, list) and refs and all(str(ref).startswith("https://") for ref in refs), f"{candidate_id} path evidence is incomplete")
            if outcome == "applicable":
                require(path.get("exactRecipeAvailable") is True and isinstance(path.get("recipe"), dict), f"{candidate_id} applicable path lacks an exact recipe")
                require(reviewed["artifactDecision"]["status"] == "allowed" and reviewed["license"]["reviewStatus"] == "approved", f"{candidate_id} applicable path bypassed gates")
                require(reviewed["engine"]["compatibilityStatus"] == "documented-on-spark", f"{candidate_id} applicable path lacks Spark engine support")
                require(path.get("nextTask") == "7.15", f"{candidate_id} applicable path lacks its validation destination")
            else:
                require(path.get("exactRecipeAvailable") is False, f"{candidate_id} non-applicable path claims an exact recipe")
            if outcome == "failed":
                require(reviewed["artifactDecision"]["status"] == "blocked" or reviewed["selection"]["status"] in {"hold", "rejected"}, f"{candidate_id} failure has no fail-closed gate")
            counts[outcome] += 1
            paths_total += 1

    actual_summary = {
        "candidateCount": len(evaluations), "pathCount": paths_total,
        "applicable": counts["applicable"], "notApplicable": counts["not_applicable"],
        "failed": counts["failed"], "artifactsDownloaded": 0,
        "conversionsAttempted": 0, "productionProfilesEnabled": 0,
    }
    require(evaluation.get("summary") == actual_summary, "applicability summary drifted")
    return {"candidates": len(evaluations), "paths": paths_total, **counts}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evaluation", type=pathlib.Path, default=DEFAULT_EVALUATION)
    parser.add_argument("--matrix", type=pathlib.Path, default=DEFAULT_MATRIX)
    args = parser.parse_args()
    evaluation = json.loads(args.evaluation.read_text(encoding="utf-8"))
    matrix = json.loads(args.matrix.read_text(encoding="utf-8"))
    result = validate(evaluation, matrix)
    print(f"non-LLM precision applicability valid: {result['candidates']} candidates, {result['paths']} paths, {result['applicable']} applicable, {result['not_applicable']} not applicable, {result['failed']} failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
