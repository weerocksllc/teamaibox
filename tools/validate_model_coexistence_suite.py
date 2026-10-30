#!/usr/bin/env python3
"""Validate the bounded Spark model coexistence and exclusive-pressure plan."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from .run_spark_model_baseline import CATALOG_PATH, canonical_digest
except ImportError:
    from run_spark_model_baseline import CATALOG_PATH, canonical_digest


ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "models/model-coexistence-suite.v1.json"
CANDIDATES = ROOT / "models/candidate-matrix.v1.json"
EXPECTED_CAPABILITIES = ["drawing", "ocr", "asr", "translation", "realtime-speech-reservation"]
CAPABILITY_USE_CASES = {"drawing": "image_drawing", "ocr": "ocr", "asr": "asr", "translation": "translation"}
EXPECTED_PHASES = ["shared-capabilities", "node-exclusive-llm"]
EXPECTED_CORE_DOMAINS = ["identity", "administration", "files", "messaging", "database", "object", "queue"]
GIB = 1024**3


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path.name} is not a JSON object")
    return value


def validate() -> dict[str, Any]:
    suite = load(SUITE)
    candidates = load(CANDIDATES)
    catalog = load(CATALOG_PATH)
    require(suite.get("schemaVersion") == 1 and suite.get("suiteId") == "model.initial-certification-coexistence.v1", "coexistence suite identity is invalid")
    require(suite.get("coreDomains") == EXPECTED_CORE_DOMAINS, "coexistence core domains drifted")
    require(suite.get("target", {}).get("architecture") == "linux/arm64/v8", "coexistence architecture drifted")
    profile_key = suite.get("target", {}).get("llmProfileKey")
    profiles = {item["profileKey"]: item for item in catalog["profiles"]}
    require(profile_key in profiles and profiles[profile_key]["scheduling"]["nodeExclusive"] is True, "coexistence LLM profile must be node-exclusive")
    require(suite.get("prerequisites", {}).get("soakProfileKey") == profile_key, "coexistence soak profile drifted")
    require(suite.get("prerequisites", {}).get("requiredSoakOutcome") == "passed", "coexistence must require a passing soak")
    require(suite["target"].get("coreReserveBytes") == profiles[profile_key]["scheduling"]["coreServiceReserveBytes"], "coexistence core reserve drifted")

    candidate_map = {item["candidateId"]: item for item in candidates["candidates"]}
    envelopes = suite.get("sharedCapabilityEnvelopes")
    require(isinstance(envelopes, list) and [item.get("capability") for item in envelopes] == EXPECTED_CAPABILITIES, "coexistence shared capabilities drifted")
    total_touch = 0
    for envelope in envelopes:
        touch = envelope.get("memoryTouchBytes")
        limit = envelope.get("memoryLimitBytes")
        require(isinstance(touch, int) and isinstance(limit, int) and GIB <= touch < limit <= 16 * GIB, f"{envelope.get('capability')} coexistence envelope is unsafe")
        require(isinstance(envelope.get("cpuCores"), (int, float)) and 0 < envelope["cpuCores"] <= 4, "coexistence shared CPU envelope is invalid")
        candidate_id = envelope.get("candidateId")
        if candidate_id is not None:
            require(candidate_id in candidate_map and CAPABILITY_USE_CASES[envelope["capability"]] in candidate_map[candidate_id]["useCases"], f"{candidate_id} does not cover {envelope['capability']}")
            require(candidate_map[candidate_id]["artifactDecision"]["status"] == "allowed", f"{candidate_id} is not artifact-eligible")
        total_touch += touch
    require(total_touch <= 24 * GIB, "combined shared coexistence pressure is unsafe")

    exclusive = suite.get("exclusiveEnvelopes", {})
    llm_pressure = exclusive.get("llmPressure", {})
    for name, envelope, maximum in (("llmPressure", llm_pressure, 32 * GIB),):
        require(isinstance(envelope.get("memoryTouchBytes"), int) and envelope["memoryTouchBytes"] < envelope.get("memoryLimitBytes", 0) <= maximum, f"{name} coexistence envelope is unsafe")

    phases = suite.get("phases")
    require(isinstance(phases, list) and [item.get("phaseId") for item in phases] == EXPECTED_PHASES, "coexistence phase order drifted")
    require(phases[0].get("requiredActive") == EXPECTED_CAPABILITIES and phases[0].get("requiredDrained") == [], "shared coexistence phase drifted")
    require(phases[1].get("requiredActive") == ["llm", "llm-pressure"] and phases[1].get("requiredDrained") == EXPECTED_CAPABILITIES, "exclusive LLM drain phase drifted")
    require(all(isinstance(item.get("probeRounds"), int) and 8 <= item["probeRounds"] <= 60 for item in phases), "coexistence probe count is invalid")

    acceptance = suite.get("acceptance", {})
    require(acceptance.get("maximumFailedCapabilityProbes") == acceptance.get("maximumFailedCoreProbes") == acceptance.get("maximumWorkerCrashes") == 0, "coexistence failure gates must be zero")
    require(acceptance.get("minimumHostAvailableMemoryBytes") == suite["target"]["coreReserveBytes"], "coexistence memory floor drifted")
    require(100 <= acceptance.get("maximumRealtimeLatencyMillisecondsP95", 0) <= acceptance.get("maximumCoreLatencyMillisecondsP95", 0) <= 2000, "coexistence latency gates are invalid")
    require(60 <= acceptance.get("maximumTemperatureCelsius", 0) <= 90, "coexistence thermal gate is invalid")
    require(acceptance.get("maximumLlmPhaseAvailableMemoryBytes", 0) <= candidates["target"]["unifiedMemoryBytes"] / 2, "LLM pressure proof is too weak")
    require(acceptance.get("requireSchedulerContractEvidence") is True and acceptance.get("requireExactCleanup") is True, "coexistence strict gates are disabled")
    return {
        "valid": True,
        "suiteId": suite["suiteId"],
        "suiteDigest": canonical_digest(suite),
        "profileKey": profile_key,
        "sharedCapabilityCount": len(envelopes),
        "phaseCount": len(phases),
        "totalSharedMemoryTouchBytes": total_touch,
        "maximumExclusiveMemoryTouchBytes": llm_pressure["memoryTouchBytes"],
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
