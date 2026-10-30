#!/usr/bin/env python3
"""Fail closed over the two immutable DGX Spark model fault reports."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from .run_spark_model_baseline import CATALOG_PATH, canonical_digest
    from .validate_model_fault_suite import SUITE, validate as validate_suite
except ImportError:
    from run_spark_model_baseline import CATALOG_PATH, canonical_digest
    from validate_model_fault_suite import SUITE, validate as validate_suite


ROOT = Path(__file__).resolve().parents[1]
FAULT_REPORTS = {
    "llm.qwen36-35b-a3b.bf16.spark-reference-32k.v1": ROOT / "evidence/validation/models/faults-20260811-bf16-a1.json",
    "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1": ROOT / "evidence/validation/models/faults-20260811-nvfp4-a1.json",
}
BASELINES = {
    "llm.qwen36-35b-a3b.bf16.spark-reference-32k.v1": ROOT / "evidence/validation/models/baseline-20260811-bf16-a4.json",
    "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1": ROOT / "evidence/validation/models/baseline-20260811-nvfp4-a3.json",
}
NV_KERNEL = {
    "precision": "nvfp4",
    "nvfp4MoeBackend": "marlin",
    "fp8LinearKernel": "flashinfer_scaled_mm",
    "attentionBackend": "flashinfer",
    "nativeFp4ComputationObserved": False,
    "weightOnlyFallbackObserved": True,
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path.name} is not a JSON object")
    return value


def validate_report(
    profile: dict[str, Any], report: dict[str, Any], baseline: dict[str, Any],
    suite: dict[str, Any],
) -> dict[str, Any]:
    key = profile["profileKey"]
    require(report.get("outcome") == "passed" and not report.get("failure") and not report.get("cleanupErrors"), f"{key} fault outcome failed")
    digest = report.get("evidenceDigest")
    material = dict(report)
    material.pop("evidenceDigest", None)
    require(digest == canonical_digest(material), f"{key} evidence digest drifted")
    require(report.get("profileKey") == key, f"{key} profile identity drifted")
    catalog = load(CATALOG_PATH)
    expected_deployment = canonical_digest({"runtimeImage": catalog["runtimeImage"], "profile": profile})
    require(report.get("deploymentFingerprint") == expected_deployment, f"{key} deployment fingerprint drifted")
    require(report.get("profileFingerprint") == baseline.get("profileFingerprint"), f"{key} profile fingerprint drifted")
    for field in ("artifactDigest", "totalBytes", "fileCount"):
        require(report.get("artifact", {}).get(field) == baseline.get("artifact", {}).get(field), f"{key} artifact {field} drifted")
    require(report.get("suite", {}).get("suiteDigest") == canonical_digest(suite), f"{key} fault suite digest drifted")

    control = report.get("controlPlaneFaults", {})
    require(control.get("queueReplay", {}).get("passed") is True, f"{key} queue replay failed")
    require(control.get("nodeAgentRestart", {}).get("passed") is True and control["nodeAgentRestart"].get("replayedStartSameContainer") is True, f"{key} Node Agent restart failed")
    live = report.get("liveRequestFaults", {})
    malformed = live.get("malformedInput", {})
    require(malformed.get("passed") is True and len(malformed.get("cases", [])) == 2 and all(item.get("status") in (400, 422) and item.get("errorShape") is True for item in malformed["cases"]), f"{key} malformed-input gate failed")
    require(live.get("timeout", {}).get("passed") is True and live["timeout"].get("classification") == "client_timeout" and live["timeout"].get("drain", {}).get("passed") is True, f"{key} timeout gate failed")
    require(live.get("cancellation", {}).get("passed") is True and live["cancellation"].get("clientClosed") is True and live["cancellation"].get("drain", {}).get("passed") is True, f"{key} cancellation gate failed")
    pressure = live.get("cachePressure", {})
    limits = suite["limits"]
    require(pressure.get("passed") is True and pressure.get("concurrency") == limits["cachePressureConcurrency"] and pressure.get("completedRequests") == limits["cachePressureConcurrency"] and pressure.get("minimumPromptTokens", 0) >= limits["minimumCachePressurePromptTokens"] and pressure.get("maximumPromptTokens", 0) <= limits["maximumContextTokens"], f"{key} cache-pressure gate failed")
    integrity = live.get("resultIntegrity", {})
    expected_content = integrity.get("beforeContentDigest")
    require(integrity.get("passed") is True and integrity.get("afterContentDigest") == expected_content, f"{key} live result integrity failed")

    reserve = profile["scheduling"]["coreServiceReserveBytes"]
    require(live.get("resources", {}).get("minimumHostAvailableMemoryBytes", 0) >= reserve, f"{key} live memory reserve failed")
    for name in ("workerRestart", "coldUnloadReload"):
        stage = report.get(name, {})
        require(stage.get("passed") is True and stage.get("integrity", {}).get("contentDigest") == expected_content, f"{key} {name} integrity failed")
        require(stage.get("resourceGate", {}).get("passed") is True, f"{key} {name} resource gate failed")
    restart = report["workerRestart"]
    require(restart.get("signal") == "SIGKILL" and restart.get("observedExitCode") == 137 and restart.get("oomKilled") is False and restart.get("sameContainer") is True, f"{key} worker restart classification failed")
    require(report["coldUnloadReload"].get("newContainer") is True, f"{key} cold reload did not replace the container")

    oom = report.get("oom", {})
    require(oom.get("passed") is True and oom.get("classification") == "cgroup_oom_killed" and oom.get("oomKilled") is True and oom.get("memoryLimitBytes") == limits["oomWorkerMemoryBytes"], f"{key} OOM classification failed")
    require(oom.get("recoveryIntegrity", {}).get("contentDigest") == expected_content and oom.get("resourceGate", {}).get("passed") is True and oom.get("recoveryResourceGate", {}).get("passed") is True, f"{key} OOM recovery failed")
    require(report.get("coreServicesAfter", {}).get("webHealthPassed") is True, f"{key} core Web service did not survive")
    require(report.get("residual") == {"remainingContainers": [], "stagingRemoved": True}, f"{key} residual state failed")

    precision = profile["source"]["precision"]
    kernel_stages = [report["initialLoad"], restart["reload"], report["coldUnloadReload"]["reload"], oom["recoveryLoad"]]
    if precision == "nvfp4":
        require(all(stage.get("runtimeKernelObservations") == NV_KERNEL for stage in kernel_stages), f"{key} NVFP4 kernel identity drifted")
    else:
        require(all(stage.get("runtimeKernelObservations") == {"precision": "bf16", "nvfp4Applicability": "not_applicable"} for stage in kernel_stages), f"{key} BF16 kernel identity drifted")
    minimum = min(
        live["resources"]["minimumHostAvailableMemoryBytes"],
        *(stage["minimumHostAvailableMemoryBytes"] for stage in kernel_stages),
    )
    return {
        "profileKey": key,
        "precision": precision,
        "evidenceDigest": digest,
        "minimumHostAvailableMemoryBytes": minimum,
        "coreServiceReserveMarginBytes": minimum - reserve,
        "cachePressurePromptTokens": pressure["minimumPromptTokens"],
        "oomClassification": oom["classification"],
    }


def validate() -> dict[str, Any]:
    suite_result = validate_suite()
    suite = load(SUITE)
    catalog = load(CATALOG_PATH)
    profiles = {item["profileKey"]: item for item in catalog["profiles"]}
    require(list(FAULT_REPORTS) == suite["releaseCandidates"], "fault report set does not exactly cover release candidates")
    results = []
    for key, path in FAULT_REPORTS.items():
        require(path.is_file() and BASELINES[key].is_file(), f"{key} evidence is missing")
        results.append(validate_report(profiles[key], load(path), load(BASELINES[key]), suite))
    return {
        "valid": True,
        "suiteDigest": suite_result["suiteDigest"],
        "releaseCandidateCount": len(results),
        "caseCountPerCandidate": suite_result["caseCount"],
        "reports": results,
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
