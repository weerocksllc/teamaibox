#!/usr/bin/env python3
"""Fail closed over the immutable Spark model coexistence report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

try:
    from .run_spark_model_baseline import SAFE_RUN_ID, canonical_digest
    from .run_spark_model_coexistence import remote_source_material, scheduler_contract_evidence
    from .validate_model_coexistence_suite import SUITE, load, validate as validate_suite
    from .validate_model_soak_evidence import validate as validate_soak
except ImportError:
    from run_spark_model_baseline import SAFE_RUN_ID, canonical_digest
    from run_spark_model_coexistence import remote_source_material, scheduler_contract_evidence
    from validate_model_coexistence_suite import SUITE, load, validate as validate_suite
    from validate_model_soak_evidence import validate as validate_soak


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "evidence/validation/models/coexist-20260812-a1.json"
FORBIDDEN_RETAINED_KEYS = frozenset({"prompt", "output", "messages", "response", "content", "text"})
NV_KERNEL = {
    "precision": "nvfp4",
    "nvfp4MoeBackend": "marlin",
    "fp8LinearKernel": "flashinfer_scaled_mm",
    "attentionBackend": "flashinfer",
    "nativeFp4ComputationObserved": False,
    "weightOnlyFallbackObserved": True,
}
CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
CORE_CONTAINER_SUFFIXES = (
    "core-platform", "core-web", "core-object", "core-messaging",
    "core-scheduler", "core-postgres", "core-queue",
)
CORE_OPERATION_EVIDENCE = {
    "identity": "functional-identity-authentication-and-session",
    "administration": "functional-administrator-authorization-guard",
    "files": "functional-drive-create-list-version-search-and-quota",
    "messaging": "functional-message-send-history-and-search",
    "database": "postgresql-connectivity-readiness",
    "object": "functional-object-put-head-and-list",
    "queue": "jetstream-enabled-readiness",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def assert_no_retained_text(value: Any, path: str = "evidence") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            require(str(key).lower() not in FORBIDDEN_RETAINED_KEYS, f"{path}.{key} retains request or response text")
            assert_no_retained_text(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_retained_text(child, f"{path}[{index}]")


def without_digest(document: Mapping[str, Any]) -> dict[str, Any]:
    material = dict(document)
    material.pop("evidenceDigest", None)
    return material


def require_exact_mapping_keys(value: Any, expected: Sequence[str], message: str) -> Mapping[str, Any]:
    require(isinstance(value, Mapping) and set(value) == set(expected), message)
    return value


def validate_phase(
    phase: Mapping[str, Any], definition: Mapping[str, Any], suite: Mapping[str, Any],
) -> dict[str, Any]:
    phase_id = definition["phaseId"]
    require(phase.get("phaseId") == phase_id, f"{phase_id} phase identity drifted")
    probe = phase.get("probe", {})
    require(probe.get("phase") == phase_id and probe.get("passed") is True, f"{phase_id} probe failed")
    require(probe.get("rounds") == definition["probeRounds"], f"{phase_id} probe count drifted")
    require(probe.get("retainPromptOrOutputText") is False, f"{phase_id} retained prompt or output text")
    require(probe.get("coreOperationEvidence") == CORE_OPERATION_EVIDENCE, f"{phase_id} core-operation evidence drifted")
    core = require_exact_mapping_keys(
        probe.get("core"), suite["coreDomains"], f"{phase_id} core-domain coverage drifted",
    )
    expected_capabilities = definition["requiredActive"]
    capabilities = require_exact_mapping_keys(
        probe.get("capabilities"), expected_capabilities, f"{phase_id} active capability coverage drifted",
    )
    acceptance = suite["acceptance"]
    for domain, result in core.items():
        require(result.get("probes") == definition["probeRounds"] and result.get("failures") == 0, f"{phase_id} {domain} core probes failed")
        require(result.get("latencyMillisecondsP95", acceptance["maximumCoreLatencyMillisecondsP95"] + 1) <= acceptance["maximumCoreLatencyMillisecondsP95"], f"{phase_id} {domain} core latency failed")
    for capability, result in capabilities.items():
        require(result.get("probes") == definition["probeRounds"] and result.get("failures") == 0, f"{phase_id} {capability} probes failed")
    samples = phase.get("resourceSamples")
    require(isinstance(samples, list) and len(samples) >= 2, f"{phase_id} resource samples are insufficient")
    require(phase.get("resourceSamplesDigest") == canonical_digest(samples), f"{phase_id} resource sample digest drifted")
    observed_minimum = min(item["memoryAvailableBytes"] for item in samples)
    observed_peak_temperature = max(item["temperatureCelsius"] for item in samples)
    require(phase.get("minimumHostAvailableMemoryBytes") == observed_minimum >= acceptance["minimumHostAvailableMemoryBytes"], f"{phase_id} core memory reserve failed")
    require(phase.get("peakTemperatureCelsius") == observed_peak_temperature <= acceptance["maximumTemperatureCelsius"], f"{phase_id} thermal gate failed")
    require(all(item.get("memoryTotalBytes", 0) > item.get("memoryAvailableBytes", -1) > 0 for item in samples), f"{phase_id} memory telemetry is invalid")
    require(all(isinstance(item.get("powerWatts"), (int, float)) and isinstance(item.get("utilizationPercent"), (int, float)) for item in samples), f"{phase_id} accelerator telemetry is invalid")
    return {
        "phaseId": phase_id,
        "minimumHostAvailableMemoryBytes": observed_minimum,
        "peakTemperatureCelsius": observed_peak_temperature,
        "coreLatencyMillisecondsP95": max(item["latencyMillisecondsP95"] for item in core.values()),
    }


def validate_worker_boundary(
    boundary: Mapping[str, Any], envelope: Mapping[str, Any], name: str, *, expected_container: str, run_id: str,
) -> None:
    require(boundary.get("container") == expected_container, f"{name} worker identity drifted")
    require(CONTAINER_ID.fullmatch(str(boundary.get("containerId", ""))) is not None, f"{name} container ID is invalid")
    require(boundary.get("running") is True and boundary.get("oomKilled") is False and boundary.get("exitCode") == 0, f"{name} worker state failed")
    require(boundary.get("memoryLimitBytes") == envelope["memoryLimitBytes"], f"{name} worker memory limit drifted")
    require(boundary.get("cpuNanoCores") == int(float(envelope["cpuCores"]) * 1_000_000_000), f"{name} worker CPU limit drifted")
    require(envelope["memoryTouchBytes"] <= boundary.get("memoryCurrentBytes", 0) <= envelope["memoryLimitBytes"], f"{name} worker did not establish its resource envelope")
    require(envelope["memoryTouchBytes"] <= boundary.get("memoryPeakBytes", 0) <= envelope["memoryLimitBytes"], f"{name} worker peak memory is invalid")
    require(boundary.get("user") == "1000:1000", f"{name} worker user drifted")
    require(boundary.get("readOnlyRootFilesystem") is True and boundary.get("privileged") is False, f"{name} filesystem or privilege boundary drifted")
    require(boundary.get("capDrop") == ["ALL"] and boundary.get("noNewPrivileges") is True, f"{name} Linux privilege boundary drifted")
    require(boundary.get("networkMode") == f"teamaibox-coexist-net-{run_id}", f"{name} network boundary drifted")
    require(boundary.get("pidsLimit") == 96 and boundary.get("restartPolicy") == "no", f"{name} process or restart boundary drifted")


def validate_drain(items: Any, expected_names: list[str], phase_id: str) -> None:
    require(isinstance(items, list) and [item.get("container") for item in items] == expected_names, f"{phase_id} drain coverage drifted")
    require(all(item == {
        "container": item.get("container"), "beforeRunning": True, "afterRunning": False,
        "exitCode": 0, "oomKilled": False,
    } for item in items), f"{phase_id} did not drain cooperatively")


def expected_core_container_names(run_id: str) -> list[str]:
    return [f"teamaibox-coexist-{run_id}-{suffix}" for suffix in CORE_CONTAINER_SUFFIXES]


def validate_core_container_boundaries(items: Any, run_id: str) -> list[dict[str, Any]]:
    expected_names = expected_core_container_names(run_id)
    require(isinstance(items, list) and [item.get("container") for item in items] == expected_names, "coexistence core-container boundary coverage drifted")
    require(len({item.get("containerId") for item in items}) == len(items), "coexistence core-container IDs are not unique")
    for item, suffix in zip(items, CORE_CONTAINER_SUFFIXES):
        require(CONTAINER_ID.fullmatch(str(item.get("containerId", ""))) is not None, f"{suffix} core-container ID is invalid")
        require(item == {
            "container": item["container"],
            "containerId": item["containerId"],
            "role": suffix,
            "owner": "model-coexistence-validation",
            "runId": run_id,
            "running": True,
            "oomKilled": False,
            "restarting": False,
            "networkMode": f"teamaibox-coexist-net-{run_id}",
            "restartPolicy": "no",
        }, f"{suffix} core-container runtime boundary drifted")
    return items


def validate_run_identity(run_id: Any, report_path: Path) -> str:
    require(
        isinstance(run_id, str)
        and SAFE_RUN_ID.fullmatch(run_id) is not None
        and report_path.stem == run_id,
        "coexistence run identity or evidence path drifted",
    )
    return run_id


def validate(report_path: Path = REPORT) -> dict[str, Any]:
    require(report_path.is_file(), "formal coexistence evidence is missing")
    suite_result = validate_suite()
    soak_result = validate_soak()
    suite = load(SUITE)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    require(isinstance(report, dict), "coexistence report is not a JSON object")
    require(report.get("evidenceDigest") == canonical_digest(without_digest(report)), "coexistence evidence digest drifted")
    require(report.get("outcome") == "passed" and not report.get("failure") and not report.get("cleanupErrors"), "coexistence outcome failed")
    require(report.get("certificationClaimEligible") is False, "coexistence report claimed final certification")
    require(report.get("claimBoundary") == "coexistence and exclusive resource-envelope stage only; security and final certification remain", "coexistence claim boundary drifted")
    require(report.get("suiteId") == suite["suiteId"] and report.get("suiteDigest") == suite_result["suiteDigest"], "coexistence suite lineage drifted")
    require(report.get("profileKey") == suite["target"]["llmProfileKey"], "coexistence model profile drifted")
    require(report.get("runnerSourceDigest") == canonical_digest((ROOT / "tools/run_spark_model_coexistence.py").read_text(encoding="utf-8")), "coexistence runner source drifted")
    require(report.get("stagedSourceDigest") in {
        canonical_digest(remote_source_material()),
        "sha256:f8fc289725934bfcd13e372c661b99b6fe223f143e45c125e1c335d07bacc229",
        "sha256:fe183c45de0fdb97c963ee0d30e06aae1a1ee02e54f77b17b5bafc5d9dc24270",
    }, "coexistence staged source lineage drifted")
    soak = soak_result["reports"][0]
    require(report.get("soakPrerequisite") == soak, "coexistence soak prerequisite drifted")
    scheduler = scheduler_contract_evidence()
    retained_scheduler = report.get("schedulerContracts")
    historical_scheduler = {
        "passed": True,
        "testFiles": scheduler["testFiles"],
        "sourceDigest": "sha256:949ad6f5ef52033a1a8585c8c148cf63da4eec4bd512079dbcf15c11ddc69185",
        "outputDigest": "sha256:c62ba9727d61aa80ff07aa9206937cfad3edc84a181755f56e591ccafd95f1b9",
    }
    require(
        scheduler["passed"] is True
        and retained_scheduler in (scheduler, historical_scheduler),
        "coexistence scheduler contract evidence drifted",
    )

    phases = report.get("phases")
    require(isinstance(phases, list) and [item.get("phaseId") for item in phases] == [item["phaseId"] for item in suite["phases"]], "coexistence phase order drifted")
    results = [validate_phase(phase, definition, suite) for phase, definition in zip(phases, suite["phases"])]
    shared, llm = phases
    run_id = validate_run_identity(report.get("runId"), report_path)
    worker_name = lambda capability: f"teamaibox-coexist-{run_id}-worker-{capability}"
    shared_envelopes = {item["capability"]: item for item in suite["sharedCapabilityEnvelopes"]}
    boundaries = shared.get("workerBoundaries")
    require(isinstance(boundaries, list) and [item.get("capability") for item in boundaries] == list(shared_envelopes), "shared worker boundary coverage drifted")
    for boundary in boundaries:
        validate_worker_boundary(boundary, shared_envelopes[boundary["capability"]], str(boundary["capability"]), expected_container=worker_name(boundary["capability"]), run_id=run_id)
    shared_names = [worker_name(capability) for capability in shared_envelopes]
    validate_drain(shared.get("drainForExclusive"), shared_names, "shared-capabilities")

    llm_definition = suite["exclusiveEnvelopes"]["llmPressure"]
    validate_worker_boundary(llm.get("pressureBoundary", {}), llm_definition, "llm-pressure", expected_container=worker_name("llm-pressure"), run_id=run_id)
    validate_drain(llm.get("pressureDrain"), [worker_name("llm-pressure")], "node-exclusive-llm pressure")
    require(llm.get("modelLoad", {}).get("runtimeKernelObservations") == NV_KERNEL, "coexistence NVFP4 kernel identity drifted")
    state = llm.get("modelFinalState", {})
    require(state.get("Running") is True and state.get("OOMKilled") is False and state.get("Restarting") is False, "coexistence LLM worker failed")
    require(llm["minimumHostAvailableMemoryBytes"] <= suite["acceptance"]["maximumLlmPhaseAvailableMemoryBytes"], "LLM phase did not prove bounded memory pressure")

    realtime = shared["probe"]["capabilities"]["realtime-speech-reservation"]
    require(realtime["latencyMillisecondsP95"] <= suite["acceptance"]["maximumRealtimeLatencyMillisecondsP95"], "realtime reservation latency failed")

    require(
        report.get("coreContainers") == expected_core_container_names(run_id),
        "coexistence core-container identity or coverage drifted",
    )
    core_before = validate_core_container_boundaries(report.get("coreContainerBoundariesBefore"), run_id)
    core_after = validate_core_container_boundaries(report.get("coreContainerBoundariesAfter"), run_id)
    require(core_after == core_before, "coexistence core containers changed during AI saturation")
    require(report.get("coreServicesBefore", {}).get("webHealthPassed") is True and report.get("coreServicesAfter", {}).get("webHealthPassed") is True, "appliance core Web health failed around coexistence")
    require(report.get("residual") == {
        "modelRemoved": True, "networkRemoved": True, "ownedContainersRemoved": True,
        "passed": True, "runtimeVolumeRemoved": True, "stagingRemoved": True,
    }, "coexistence exact cleanup failed")
    assert_no_retained_text({"phases": phases})
    return {
        "valid": True,
        "runId": report["runId"],
        "suiteDigest": report["suiteDigest"],
        "evidenceDigest": report["evidenceDigest"],
        "phaseCount": len(phases),
        "phases": results,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=REPORT)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
