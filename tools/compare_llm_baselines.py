#!/usr/bin/env python3
"""Fail-closed comparison of an NVFP4 Spark run with its pinned BF16 baseline."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
from typing import Any, Mapping, Sequence


ROOT = pathlib.Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "deploy" / "compute" / "model-baseline-deployments.v1.json"
CANDIDATE_PATH = ROOT / "models" / "candidate-matrix.v1.json"
REFERENCE_PROFILE = "llm.qwen36-35b-a3b.bf16.spark-reference-32k.v1"
CANDIDATE_PROFILE = "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1"
EXPECTED_PROBE_VERSION = "1.0.0"
EXPECTED_SEED = "1337"


class ComparisonError(RuntimeError):
    pass


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def read_evidence(path: pathlib.Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ComparisonError(f"evidence is unreadable: {path.name}") from error
    if not isinstance(value, dict):
        raise ComparisonError("evidence root must be an object")
    payload = dict(value)
    claimed = payload.pop("evidenceDigest", None)
    if claimed != canonical_digest(payload):
        raise ComparisonError(f"evidence digest mismatch: {path.name}")
    if value.get("outcome") != "passed" or value.get("certificationClaimEligible") is not False:
        raise ComparisonError("only passed non-certification baseline evidence is comparable")
    return value


def indexed(items: Sequence[Mapping[str, Any]], key: str, label: str) -> dict[str, Mapping[str, Any]]:
    result = {str(item.get(key)): item for item in items}
    if len(result) != len(items) or "None" in result:
        raise ComparisonError(f"{label} identities are missing or duplicated")
    return result


def argument_value(arguments: Sequence[str], name: str) -> str:
    if arguments.count(name) != 1:
        raise ComparisonError(f"engine argument {name} is missing or duplicated")
    position = arguments.index(name)
    if position + 1 >= len(arguments) or arguments[position + 1].startswith("--"):
        raise ComparisonError(f"engine argument {name} has no value")
    return arguments[position + 1]


def shared_engine_arguments(arguments: Sequence[str]) -> list[str]:
    precision_specific = {
        "--served-model-name", "--dtype", "--gpu-memory-utilization",
        "--kv-cache-dtype", "--attention-backend", "--moe-backend",
    }
    result: list[str] = []
    index = 0
    while index < len(arguments):
        item = arguments[index]
        if item in precision_specific:
            if index + 1 >= len(arguments) or arguments[index + 1].startswith("--"):
                raise ComparisonError(f"precision-specific engine argument {item} has no value")
            index += 2
            continue
        result.append(item)
        index += 1
    return result


def workload_identity(probe: Mapping[str, Any]) -> dict[str, Any]:
    benchmarks = probe.get("benchmarks")
    if not isinstance(benchmarks, list) or not benchmarks:
        raise ComparisonError("benchmark workload is missing")
    axes = []
    for item in benchmarks:
        warmup = item.get("warmupExcluded")
        if not isinstance(warmup, dict) or warmup.get("outcome") != "completed":
            raise ComparisonError("each scenario requires one successful excluded warmup")
        axes.append({
            "scenarioKey": item.get("scenarioKey"),
            "requests": item.get("requests"),
            "concurrency": item.get("concurrency"),
            "contextPayloadBytes": item.get("contextPayloadBytes"),
            "outputTokenLimit": item.get("outputTokenLimit"),
            "longContext": item.get("longContext"),
            "warmupRequests": 1,
        })
    return {
        "probeVersion": probe.get("probeVersion"),
        "seed": int(EXPECTED_SEED),
        "qualitySuite": probe.get("quality", {}).get("suiteKey"),
        "qualityInputSetDigest": probe.get("quality", {}).get("inputSetDigest"),
        "benchmarkAxes": axes,
        "stabilityRequests": probe.get("stability", {}).get("requested"),
    }


def finite_number(value: Any, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ComparisonError(f"metric is missing or invalid: {label}")
    return float(value)


def median(values: Sequence[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def delta(reference: Any, candidate: Any, label: str) -> dict[str, float | None]:
    reference_value = finite_number(reference, f"reference.{label}")
    candidate_value = finite_number(candidate, f"candidate.{label}")
    return {
        "reference": round(reference_value, 3),
        "candidate": round(candidate_value, 3),
        "absolute": round(candidate_value - reference_value, 3),
        "percent": None if reference_value == 0 else round((candidate_value - reference_value) * 100 / reference_value, 3),
    }


def compare(reference: Mapping[str, Any], candidate_run: Mapping[str, Any]) -> dict[str, Any]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    profiles = indexed(catalog.get("profiles", []), "profileKey", "profile")
    if reference.get("profileKey") != REFERENCE_PROFILE or candidate_run.get("profileKey") != CANDIDATE_PROFILE:
        raise ComparisonError("comparison profile roles are invalid")
    reference_profile = profiles.get(REFERENCE_PROFILE)
    candidate_profile = profiles.get(CANDIDATE_PROFILE)
    if reference_profile is None or candidate_profile is None:
        raise ComparisonError("comparison profiles are not committed")
    if canonical_digest({"runtimeImage": catalog["runtimeImage"], "profile": reference_profile}) != reference.get("deploymentFingerprint"):
        raise ComparisonError("reference deployment drifted from its immutable evidence")
    if canonical_digest({"runtimeImage": catalog["runtimeImage"], "profile": candidate_profile}) != candidate_run.get("deploymentFingerprint"):
        raise ComparisonError("candidate deployment drifted from its immutable evidence")
    for run, profile, precision in (
        (reference, reference_profile, "bf16"),
        (candidate_run, candidate_profile, "nvfp4"),
    ):
        declaration = run.get("profileDeclaration")
        if not isinstance(declaration, dict) or canonical_digest(declaration) != run.get("profileFingerprint"):
            raise ComparisonError("model profile declaration fingerprint is invalid")
        if declaration.get("profileKey") != profile.get("profileKey") or declaration.get("precision") != precision:
            raise ComparisonError("model profile declaration identity is invalid")
        if declaration.get("engine", {}).get("configurationDigest") != run.get("deploymentFingerprint"):
            raise ComparisonError("model profile deployment linkage is invalid")
        if run.get("probe", {}).get("profileFingerprint") != run.get("profileFingerprint") or run.get("probe", {}).get("deploymentFingerprint") != run.get("deploymentFingerprint"):
            raise ComparisonError("probe lineage does not match the run")

    matrix = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    candidates = indexed(matrix.get("candidates", []), "candidateId", "candidate")
    reference_candidate = candidates[reference_profile["candidateId"]]
    nvfp4_candidate = candidates[candidate_profile["candidateId"]]
    if nvfp4_candidate.get("precision", {}).get("baselineCandidateId") != reference_candidate.get("candidateId"):
        raise ComparisonError("NVFP4 candidate does not identify this BF16 baseline")
    if nvfp4_candidate.get("precision", {}).get("nvfp4Applicability") != "official-prequantized":
        raise ComparisonError("candidate is not an official prequantized NVFP4 profile")

    reference_probe = reference.get("probe", {})
    nvfp4_probe = candidate_run.get("probe", {})
    if reference_probe.get("probeVersion") != EXPECTED_PROBE_VERSION or nvfp4_probe.get("probeVersion") != EXPECTED_PROBE_VERSION:
        raise ComparisonError("probe implementation version differs")
    reference_workload = workload_identity(reference_probe)
    candidate_workload = workload_identity(nvfp4_probe)
    if reference_workload != candidate_workload:
        raise ComparisonError("corpus, warmup, context, output, batch, concurrency, or stability workload differs")
    if reference.get("preflight", {}).get("environmentDigest") != candidate_run.get("preflight", {}).get("environmentDigest"):
        raise ComparisonError("hardware/runtime environment differs")
    if argument_value(reference_profile["engineArguments"], "--seed") != EXPECTED_SEED or argument_value(candidate_profile["engineArguments"], "--seed") != EXPECTED_SEED:
        raise ComparisonError("engine seed differs from the comparison contract")
    if shared_engine_arguments(reference_profile["engineArguments"]) != shared_engine_arguments(candidate_profile["engineArguments"]):
        raise ComparisonError("non-precision engine arguments differ")

    reference_benchmarks = indexed(reference_probe["benchmarks"], "scenarioKey", "reference benchmark")
    candidate_benchmarks = indexed(nvfp4_probe["benchmarks"], "scenarioKey", "candidate benchmark")
    if set(reference_benchmarks) != set(candidate_benchmarks):
        raise ComparisonError("benchmark scenario sets differ")
    scenario_comparison = []
    for key in sorted(reference_benchmarks):
        left, right = reference_benchmarks[key], candidate_benchmarks[key]
        scenario_comparison.append({
            "scenarioKey": key,
            "ttftMsP50": delta(left.get("ttftMsP50"), right.get("ttftMsP50"), f"{key}.ttftMsP50"),
            "latencyMsP50": delta(left.get("latencyMsP50"), right.get("latencyMsP50"), f"{key}.latencyMsP50"),
            "tokenThroughputPerSecond": delta(left.get("tokenThroughputPerSecond"), right.get("tokenThroughputPerSecond"), f"{key}.tokenThroughputPerSecond"),
            "requestThroughputPerSecond": delta(left.get("requestThroughputPerSecond"), right.get("requestThroughputPerSecond"), f"{key}.requestThroughputPerSecond"),
            "promptTokensMinimum": delta(left.get("promptTokensMinimum"), right.get("promptTokensMinimum"), f"{key}.promptTokensMinimum"),
        })

    quality_left, quality_right = reference_probe["quality"], nvfp4_probe["quality"]
    cases_left = indexed(quality_left["cases"], "caseId", "reference quality case")
    cases_right = indexed(quality_right["cases"], "caseId", "candidate quality case")
    if set(cases_left) != set(cases_right):
        raise ComparisonError("quality case identities differ")
    acceptance = {
        "referenceQualityPassed": quality_left.get("passed") is True,
        "candidateQualityPassed": quality_right.get("passed") is True,
        "referenceBenchmarkErrors": reference_probe.get("summary", {}).get("benchmarkErrors"),
        "candidateBenchmarkErrors": nvfp4_probe.get("summary", {}).get("benchmarkErrors"),
        "referenceStabilityFailures": reference_probe.get("stability", {}).get("failed"),
        "candidateStabilityFailures": nvfp4_probe.get("stability", {}).get("failed"),
        "referenceLongContextReached": reference_probe.get("summary", {}).get("longContextMinimumReached") is True,
        "candidateLongContextReached": nvfp4_probe.get("summary", {}).get("longContextMinimumReached") is True,
    }
    passed = (
        acceptance["referenceQualityPassed"] and acceptance["candidateQualityPassed"]
        and acceptance["referenceBenchmarkErrors"] == 0 and acceptance["candidateBenchmarkErrors"] == 0
        and acceptance["referenceStabilityFailures"] == 0 and acceptance["candidateStabilityFailures"] == 0
        and acceptance["referenceLongContextReached"] and acceptance["candidateLongContextReached"]
    )
    result = {
        "schemaVersion": 1,
        "comparisonKind": "nvfp4-versus-bf16-identical-workload",
        "reference": {
            "runId": reference["runId"], "profileKey": reference["profileKey"],
            "profileFingerprint": reference["profileFingerprint"], "evidenceDigest": reference["evidenceDigest"],
        },
        "candidate": {
            "runId": candidate_run["runId"], "profileKey": candidate_run["profileKey"],
            "profileFingerprint": candidate_run["profileFingerprint"], "evidenceDigest": candidate_run["evidenceDigest"],
        },
        "comparability": {
            "environmentDigest": reference["preflight"]["environmentDigest"],
            "workload": reference_workload,
            "workloadDigest": canonical_digest(reference_workload),
            "sharedEngineArgumentsDigest": canonical_digest(shared_engine_arguments(reference_profile["engineArguments"])),
            "precisionSpecificDifferences": {
                "reference": {"precision": "bf16", "dtype": "bfloat16", "gpuMemoryUtilization": "0.75"},
                "candidate": {"precision": "nvfp4", "dtype": "auto", "gpuMemoryUtilization": "0.40", "kvCacheDtype": "fp8", "attentionBackend": "flashinfer", "moeBackend": "marlin"},
            },
        },
        "quality": {
            "referencePassedCases": quality_left["passedCases"],
            "candidatePassedCases": quality_right["passedCases"],
            "caseResults": [{
                "caseId": key,
                "referencePassed": cases_left[key].get("passed") is True,
                "candidatePassed": cases_right[key].get("passed") is True,
                "responseDigestEqual": cases_left[key].get("responseDigest") == cases_right[key].get("responseDigest"),
            } for key in sorted(cases_left)],
        },
        "performance": {
            "coldLoadTimeMsMedian": delta(
                median([finite_number(item.get("loadTimeMs"), "reference.coldLoadTimeMs") for item in reference["coldStartRuns"]]),
                median([finite_number(item.get("loadTimeMs"), "candidate.coldLoadTimeMs") for item in candidate_run["coldStartRuns"]]),
                "coldLoadTimeMsMedian",
            ),
            "scenarios": scenario_comparison,
            "peakHostUnifiedMemoryUsedBytes": delta(reference_probe["resources"].get("peakHostUnifiedMemoryUsedBytes"), nvfp4_probe["resources"].get("peakHostUnifiedMemoryUsedBytes"), "peakHostUnifiedMemoryUsedBytes"),
            "minimumHostAvailableMemoryBytes": delta(reference_probe["resources"].get("minimumHostAvailableMemoryBytes"), nvfp4_probe["resources"].get("minimumHostAvailableMemoryBytes"), "minimumHostAvailableMemoryBytes"),
            "temperatureCelsiusPeak": delta(reference_probe["resources"]["nvidia"].get("temperatureCelsiusPeak"), nvfp4_probe["resources"]["nvidia"].get("temperatureCelsiusPeak"), "temperatureCelsiusPeak"),
            "powerWattsPeak": delta(reference_probe["resources"]["nvidia"].get("powerWattsPeak"), nvfp4_probe["resources"]["nvidia"].get("powerWattsPeak"), "powerWattsPeak"),
        },
        "stability": {
            "referenceCompleted": reference_probe["stability"]["completed"],
            "candidateCompleted": nvfp4_probe["stability"]["completed"],
            "referenceFailed": reference_probe["stability"]["failed"],
            "candidateFailed": nvfp4_probe["stability"]["failed"],
        },
        "acceptance": acceptance,
        "outcome": "passed" if passed else "failed",
        "certificationClaimEligible": False,
        "claimBoundary": "bounded identical-workload comparison only; full quality, fault, soak, coexistence, security, and certification stages remain",
    }
    result["evidenceDigest"] = canonical_digest(result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, type=pathlib.Path)
    parser.add_argument("--candidate", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    result = compare(read_evidence(args.reference), read_evidence(args.candidate))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(args.output)
    return 0 if result["outcome"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
