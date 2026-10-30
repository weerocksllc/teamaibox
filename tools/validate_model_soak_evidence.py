#!/usr/bin/env python3
"""Fail closed over the immutable DGX Spark initial-certification soak."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

try:
    from .run_spark_model_baseline import CATALOG_PATH, IMAGE, canonical_digest
    from .validate_model_soak_suite import SUITE, validate as validate_suite
except ImportError:
    from run_spark_model_baseline import CATALOG_PATH, IMAGE, canonical_digest
    from validate_model_soak_suite import SUITE, validate as validate_suite


ROOT = Path(__file__).resolve().parents[1]
FORMAL_REPORTS = {
    "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1":
        ROOT / "evidence/validation/models/soak-20260811-nvfp4-24h-a2.json",
}
BASELINES = {
    "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1":
        ROOT / "evidence/validation/models/baseline-20260811-nvfp4-a3.json",
}
PROBE_SOURCE = ROOT / "tools/model_soak_probe.py"
NV_KERNEL = {
    "precision": "nvfp4",
    "nvfp4MoeBackend": "marlin",
    "fp8LinearKernel": "flashinfer_scaled_mm",
    "attentionBackend": "flashinfer",
    "nativeFp4ComputationObserved": False,
    "weightOnlyFallbackObserved": True,
}
FORBIDDEN_RETAINED_KEYS = frozenset({"prompt", "output", "messages", "response", "content", "text"})


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_time(value: Any, field: str) -> dt.datetime:
    require(isinstance(value, str), f"{field} timestamp is missing")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field} timestamp is invalid") from error
    require(parsed.tzinfo is not None, f"{field} timestamp lacks a timezone")
    return parsed


def without_digest(document: Mapping[str, Any], field: str) -> dict[str, Any]:
    material = dict(document)
    material.pop(field, None)
    return material


def source_digest(path: Path = PROBE_SOURCE) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def assert_no_retained_text(value: Any, path: str = "evidence") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            require(str(key).lower() not in FORBIDDEN_RETAINED_KEYS, f"{path}.{key} retains request or response text")
            assert_no_retained_text(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_retained_text(child, f"{path}[{index}]")


def validate_series(series: Any, probe: Mapping[str, Any], configuration: Mapping[str, Any], *, smoke: bool) -> dict[str, Any]:
    require(isinstance(series, list) and series, "soak time series is empty")
    require(len(series) == probe.get("sampleCount"), "soak time-series sample count drifted")
    interval = float(configuration["sampleIntervalSeconds"])
    previous_time: dt.datetime | None = None
    previous_jobs = -1
    maximum_gap = 0.0
    for index, sample in enumerate(series, start=1):
        require(isinstance(sample, Mapping) and sample.get("ordinal") == index, "soak sample ordinals are not contiguous")
        observed = parse_time(sample.get("observedAt"), f"sample {index}")
        if previous_time is not None:
            gap = (observed - previous_time).total_seconds()
            require(gap > 0, "soak sample timestamps are not increasing")
            maximum_gap = max(maximum_gap, gap)
            require(gap <= interval * 2.5, "soak resource sampling contains an excessive gap")
        previous_time = observed
        require(sample.get("healthPassed") is True, "soak time series contains a failed health check")
        jobs = sample.get("jobs", {})
        completed = jobs.get("completed")
        require(isinstance(completed, int) and completed >= previous_jobs, "soak completed-job counter regressed")
        require(jobs.get("failed") == 0 and jobs.get("incomplete") == 0, "soak sample contains failed or incomplete work")
        previous_jobs = completed
        memory = sample.get("memory", {})
        require(memory.get("availableBytes", 0) >= int(configuration["coreReserveBytes"]), "soak sample breached the core reserve")
        thermal = sample.get("nvidia", {})
        require(thermal.get("status") == "measured", "soak accelerator telemetry is unsupported")
        require(isinstance(thermal.get("temperatureCelsius"), (int, float)), "soak temperature is missing")
        require(isinstance(thermal.get("powerWatts"), (int, float)), "soak power is missing")
        require(isinstance(thermal.get("utilizationPercent"), (int, float)), "soak utilization is missing")
    if not smoke:
        expected = int(int(configuration["durationSeconds"]) / interval)
        require(len(series) >= int(expected * 0.95), "formal soak has insufficient resource-sample coverage")
    return {"sampleCount": len(series), "maximumSampleGapSeconds": round(maximum_gap, 3)}


def validate_report(report_path: Path, suite: Mapping[str, Any], *, allow_smoke: bool = False) -> dict[str, Any]:
    report = load(report_path)
    require(isinstance(report, dict), "soak report is not a JSON object")
    smoke = report.get("smoke") is True
    require(allow_smoke or not smoke, "smoke evidence cannot satisfy the formal soak gate")
    require(report.get("outcome") == "passed" and not report.get("failure"), "soak outcome failed")
    require(not report.get("cleanupErrors"), "soak cleanup reported errors")
    require(report.get("certificationClaimEligible") is False, "soak evidence must not claim final certification")
    require(report.get("claimBoundary") == "soak stage only; coexistence, security, and final certification remain", "soak claim boundary drifted")
    require(report.get("evidenceDigest") == canonical_digest(without_digest(report, "evidenceDigest")), "soak evidence digest drifted")

    profile_key = report.get("profileKey")
    catalog = load(CATALOG_PATH)
    profiles = {item["profileKey"]: item for item in catalog["profiles"]}
    require(profile_key in profiles, "soak profile is not in the deployment catalog")
    profile = profiles[profile_key]
    selected = next((item for item in suite["profiles"] if item["profileKey"] == profile_key), None)
    require(selected is not None and selected.get("selection") == "initial_certification_candidate", "soak profile is not selected for initial certification")
    expected_suite_digest = canonical_digest(suite)
    require(report.get("suiteDigest") == expected_suite_digest, "soak suite digest drifted")
    require(report.get("suite", {}).get("suiteDigest") == expected_suite_digest, "embedded soak suite digest drifted")
    require(report.get("suite", {}).get("selectedProfileKey") == profile_key, "embedded soak profile drifted")
    expected_deployment = canonical_digest({"runtimeImage": catalog["runtimeImage"], "profile": profile})
    require(report.get("runtimeImage") == IMAGE, "soak runtime image drifted")
    require(report.get("deploymentFingerprint") == expected_deployment, "soak deployment fingerprint drifted")

    baseline_path = BASELINES.get(profile_key)
    require(baseline_path is not None and baseline_path.is_file(), "soak baseline evidence is missing")
    baseline = load(baseline_path)
    require(report.get("profileFingerprint") == baseline.get("profileFingerprint"), "soak profile fingerprint drifted")
    for field in ("artifactDigest", "totalBytes", "fileCount"):
        require(report.get("artifact", {}).get(field) == baseline.get("artifact", {}).get(field), f"soak artifact {field} drifted")

    launch_path = report_path.with_name(report_path.stem + "-launch.json")
    require(launch_path.is_file(), "soak launch evidence is missing")
    launch = load(launch_path)
    require(launch.get("launchDigest") == canonical_digest(without_digest(launch, "launchDigest")), "soak launch digest drifted")
    require(report.get("launchDigest") == launch.get("launchDigest"), "soak report is not bound to its launch")
    for field in ("runId", "launchedAt", "durationSeconds", "suiteDigest", "configurationDigest", "probeSourceDigest", "profileFingerprint", "deploymentFingerprint", "probeContainerDigest", "runtimeImage", "runtimeCache"):
        require(report.get(field) == launch.get(field), f"soak launch field {field} drifted")
    require(report.get("runtimeCache", {}).get("freshAtLaunch") is True, "soak did not use a fresh runtime cache")

    configuration = report.get("configuration", {})
    require(report.get("configurationDigest") == canonical_digest(configuration), "soak configuration digest drifted")
    require(configuration.get("maximumConcurrency") == suite["workload"]["maximumConcurrency"], "soak concurrency drifted")
    require(configuration.get("coreReserveBytes") == suite["acceptance"]["minimumHostAvailableMemoryBytes"], "soak core reserve drifted")
    if not smoke:
        require(report.get("durationSeconds") == selected["requiredDurationSeconds"] == suite["acceptance"]["minimumDurationSeconds"], "formal soak duration drifted")
        for field in ("requestIntervalSeconds", "sampleIntervalSeconds", "longEveryJobs", "maximumConcurrency"):
            require(configuration.get(field) == suite["workload"][field], f"formal soak workload {field} drifted")
        require(configuration.get("smoke") is False, "formal soak is marked as smoke")

    expected_source = source_digest()
    require(report.get("probeSourceDigest") == expected_source, "soak probe source no longer matches the launched executable")
    probe = report.get("probe", {})
    require(probe.get("evidenceDigest") == canonical_digest(without_digest(probe, "evidenceDigest")), "soak probe evidence digest drifted")
    require(probe.get("outcome") == "passed" and probe.get("analysis", {}).get("passed") is True, "soak probe outcome failed")
    for field in ("runId", "profileFingerprint", "deploymentFingerprint", "suiteDigest", "configurationDigest", "probeSourceDigest"):
        require(probe.get(field) == report.get(field), f"soak probe field {field} drifted")
    require(probe.get("requestedDurationSeconds") == report.get("durationSeconds"), "soak probe duration drifted")
    elapsed = (parse_time(probe.get("finishedAt"), "probe.finishedAt") - parse_time(probe.get("startedAt"), "probe.startedAt")).total_seconds()
    require(elapsed >= int(report["durationSeconds"]), "soak wall-clock duration was not reached")

    analysis = probe.get("analysis", {})
    acceptance = analysis.get("acceptance", {})
    require(acceptance and all(value is True for value in acceptance.values()), "one or more soak acceptance gates failed")
    require(analysis.get("longDurationTrendGateApplied") is (not smoke), "soak trend-gate applicability drifted")
    jobs = analysis.get("jobs", {})
    require(jobs.get("submitted", 0) > 0 and jobs.get("completed") == jobs.get("submitted"), "soak jobs did not all complete")
    require(jobs.get("failed") == 0 and jobs.get("incomplete") == 0 and jobs.get("lostJobs") == 0 and jobs.get("duplicateProviderResponses") == 0, "soak lost, duplicated, failed, or left work incomplete")
    require(jobs.get("completedJobSequenceDigest") == jobs.get("expectedJobSequenceDigest"), "soak job sequence integrity failed")
    limits = suite["acceptance"]
    memory = analysis.get("memory", {})
    require(memory.get("minimumAvailableBytes", 0) >= limits["minimumHostAvailableMemoryBytes"], "soak minimum memory failed")
    require(memory.get("growthBytes", limits["maximumMemoryGrowthBytes"] + 1) <= limits["maximumMemoryGrowthBytes"], "soak absolute memory growth failed")
    if not smoke:
        require(memory.get("linearGrowthBytesPerHour", limits["maximumLinearMemoryGrowthBytesPerHour"] + 1) <= limits["maximumLinearMemoryGrowthBytesPerHour"], "soak linear memory growth failed")
    thermal = analysis.get("thermal", {})
    require(thermal.get("status") == "measured" and thermal.get("peakTemperatureCelsius", limits["maximumTemperatureCelsius"] + 1) <= limits["maximumTemperatureCelsius"], "soak thermal gate failed")
    performance = analysis.get("performance", {})
    if not smoke:
        require(performance.get("throughputDegradationFraction", 1) <= limits["maximumThroughputDegradationFraction"], "soak throughput degraded")
        require(performance.get("latencyIncreaseFraction", 1) <= limits["maximumLatencyIncreaseFraction"], "soak latency degraded")

    time_series = report.get("timeSeries", {})
    series_path = ROOT / str(time_series.get("reference", ""))
    require(series_path.is_file() and ROOT in series_path.resolve().parents, "soak time-series reference is missing or escaped")
    series = load(series_path)
    require(time_series.get("digest") == canonical_digest(series) == probe.get("timeSeriesDigest"), "soak time-series digest drifted")
    coverage = validate_series(series, probe, configuration, smoke=smoke)
    supervisor = report.get("supervisor", {})
    require(supervisor.get("sampleCount", 0) > 0 and supervisor.get("allWebHealthPassed") is True, "soak supervisor health failed")
    require(supervisor.get("minimumHostAvailableMemoryBytes", 0) >= limits["minimumHostAvailableMemoryBytes"], "soak supervisor memory reserve failed")
    state = supervisor.get("modelFinalState", {})
    require(state.get("Status") == "running" and state.get("OOMKilled") is False and state.get("Restarting") is False, "soak worker crashed, restarted, or was OOM-killed")
    require(report.get("modelLoad", {}).get("runtimeKernelObservations") == NV_KERNEL, "soak NVFP4 kernel identity drifted")
    require(report.get("coreServicesBefore", {}).get("webHealthPassed") is True and report.get("coreServicesAfter", {}).get("webHealthPassed") is True, "core Web health failed around soak")
    require(report.get("residual") == {"evidenceVolumeRemoved": True, "modelRemoved": True, "passed": True, "probeRemoved": True, "runtimeVolumeRemoved": True, "stagingRemoved": True}, "soak residual cleanup failed")
    require(probe.get("workload", {}).get("retainPromptOrOutputText") is False, "soak retained prompt or output text")
    assert_no_retained_text({"probe": probe, "timeSeries": series})
    return {
        "profileKey": profile_key,
        "runId": report["runId"],
        "smoke": smoke,
        "evidenceDigest": report["evidenceDigest"],
        "durationSeconds": report["durationSeconds"],
        "completedJobs": jobs["completed"],
        "minimumHostAvailableMemoryBytes": min(memory["minimumAvailableBytes"], supervisor["minimumHostAvailableMemoryBytes"]),
        "peakTemperatureCelsius": thermal["peakTemperatureCelsius"],
        **coverage,
    }


def validate_formal_report_coverage(
    selected_profiles: list[str], reports: Mapping[str, Path] = FORMAL_REPORTS,
) -> None:
    require(
        list(reports) == selected_profiles,
        "formal soak report set does not exactly cover selected profiles",
    )


def validate() -> dict[str, Any]:
    suite_result = validate_suite()
    suite = load(SUITE)
    selected = [item["profileKey"] for item in suite["profiles"] if item.get("selection") == "initial_certification_candidate"]
    validate_formal_report_coverage(selected)
    reports = []
    for profile_key, path in FORMAL_REPORTS.items():
        require(path.is_file(), f"formal soak evidence is missing for {profile_key}")
        reports.append(validate_report(path, suite))
    return {
        "valid": True,
        "suiteDigest": suite_result["suiteDigest"],
        "selectedProfileCount": len(reports),
        "reports": reports,
    }


if __name__ == "__main__":
    print(json.dumps(validate(), sort_keys=True, separators=(",", ":")))
