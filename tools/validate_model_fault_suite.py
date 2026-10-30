#!/usr/bin/env python3
"""Validate the immutable release-candidate model fault matrix."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "models" / "model-fault-suite.v1.json"
CATALOG = ROOT / "deploy" / "compute" / "model-baseline-deployments.v1.json"
EXPECTED_CASES = {
    "cancellation", "timeout", "malformed_input", "oom", "worker_restart",
    "node_agent_restart", "queue_replay", "cold_unload_reload", "cache_pressure",
    "result_integrity",
}


def canonical_digest(value):
    body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(body).hexdigest()


def validate() -> dict[str, object]:
    suite = json.loads(SUITE.read_text(encoding="utf-8"))
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    if suite.get("schemaVersion") != 1 or suite.get("suiteId") != "model.release-candidate-faults.v1":
        raise ValueError("fault suite identity is invalid")
    if suite.get("deploymentCatalogDigest") != canonical_digest(catalog):
        raise ValueError("fault suite deployment catalog digest drifted")
    candidates = suite.get("releaseCandidates")
    expected_candidates = [item["profileKey"] for item in catalog.get("profiles", [])]
    if candidates != expected_candidates or len(candidates) != len(set(candidates)):
        raise ValueError("fault suite does not cover every release candidate exactly once")
    cases = suite.get("cases")
    if not isinstance(cases, list) or {item.get("case") for item in cases} != EXPECTED_CASES or len(cases) != len(EXPECTED_CASES):
        raise ValueError("fault suite cases are missing or duplicated")
    if any(set(item) != {"case", "executor", "acceptance"} for item in cases):
        raise ValueError("fault suite case shape is invalid")
    limits = suite.get("limits", {})
    if limits.get("maximumContextTokens") != 32768 or limits.get("cachePressureConcurrency") != 2:
        raise ValueError("fault suite context/concurrency boundary drifted")
    if limits.get("oomWorkerMemoryBytes") != 8 * 1024**3:
        raise ValueError("fault suite OOM envelope drifted")
    if suite.get("dataHandling") != {
        "retainPromptOrOutputText": False,
        "retainResponseDigests": True,
        "externalNetwork": False,
    }:
        raise ValueError("fault suite data handling boundary is invalid")
    return {
        "valid": True,
        "suiteId": suite["suiteId"],
        "releaseCandidateCount": len(candidates),
        "caseCount": len(cases),
        "suiteDigest": canonical_digest(suite),
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
