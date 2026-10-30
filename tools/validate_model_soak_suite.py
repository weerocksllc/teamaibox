#!/usr/bin/env python3
"""Validate the initial certification and 24-hour risk soak selection."""

from __future__ import annotations

import json
from pathlib import Path

try:
    from .run_spark_model_baseline import CATALOG_PATH, canonical_digest
    from .validate_model_fault_evidence import validate as validate_faults
except ImportError:
    from run_spark_model_baseline import CATALOG_PATH, canonical_digest
    from validate_model_fault_evidence import validate as validate_faults


ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "models/model-soak-suite.v1.json"


def validate():
    suite = json.loads(SUITE.read_text(encoding="utf-8"))
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    fault = validate_faults()
    if suite.get("schemaVersion") != 1 or suite.get("suiteId") != "model.initial-certification-soak.v1":
        raise ValueError("model soak suite identity is invalid")
    if suite.get("faultSuiteDigest") != fault["suiteDigest"]:
        raise ValueError("model soak suite fault lineage drifted")
    profiles = suite.get("profiles")
    if not isinstance(profiles, list) or [item.get("profileKey") for item in profiles] != [item["profileKey"] for item in catalog["profiles"]]:
        raise ValueError("model soak suite does not classify every release candidate in order")
    selected = [item for item in profiles if item.get("selection") == "initial_certification_candidate"]
    if len(selected) != 1 or selected[0].get("profileKey") != "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1":
        raise ValueError("initial certification soak selection drifted")
    if selected[0].get("requiredDurationSeconds") != 86400 or set(selected[0].get("riskClasses", [])) != {"critical_local_llm", "high_unified_memory", "nvfp4"}:
        raise ValueError("NVFP4 risk-selected duration or classes drifted")
    reference = profiles[0]
    if reference.get("selection") != "not_selected_for_initial_certification" or "157081600" not in reference.get("reason", ""):
        raise ValueError("BF16 reference-only decision is not evidence bound")
    workload = suite.get("workload", {})
    if workload != {
        "requestIntervalSeconds": 5, "sampleIntervalSeconds": 60, "longEveryJobs": 12,
        "maximumConcurrency": 2, "deterministicSeed": 1337, "retainPromptOrOutputText": False,
    }:
        raise ValueError("model soak workload drifted")
    acceptance = suite.get("acceptance", {})
    exact = {
        "minimumDurationSeconds": 86400, "maximumFailedJobs": 0, "maximumLostJobs": 0,
        "maximumDuplicateProviderResponses": 0, "maximumHealthFailures": 0,
        "minimumHostAvailableMemoryBytes": 12884901888, "maximumMemoryGrowthBytes": 4294967296,
        "maximumLinearMemoryGrowthBytesPerHour": 536870912, "maximumTemperatureCelsius": 90,
        "maximumThroughputDegradationFraction": 0.2, "maximumLatencyIncreaseFraction": 0.5,
        "maximumWorkerCrashes": 0,
    }
    if acceptance != exact:
        raise ValueError("model soak acceptance policy drifted")
    return {
        "valid": True, "suiteId": suite["suiteId"], "suiteDigest": canonical_digest(suite),
        "selectedProfileKey": selected[0]["profileKey"], "requiredDurationSeconds": 86400,
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
