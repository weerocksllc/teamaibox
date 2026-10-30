#!/usr/bin/env python3
"""Strictly validate an exact main-box protected FLUX.2 BF16 profile."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid
from typing import Any, Mapping, Sequence

try:
    from .run_flux2_klein_bf16_main_protected_profile_qualification import (
        CONFIG, PROBE, REMOTE, REPLICATION_PARENT, ROOT, RUN_ID, SERVER, SOURCES,
        aggregate_memory, build_profile_document, exposes_port, file_digest,
        database_identity,
        http_health, ledger_read, load_config, load_historical_parent, load_replication_parent,
        mem_available, measured_memory, network_snapshot, profile_package, query, require_protocol,
        route_facts, run_probe_with_memory,
        snapshot, declared_target_identity, target_identity,
    )
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_flux2_klein_bf16_main_protected_profile_qualification import (
        CONFIG, PROBE, REMOTE, REPLICATION_PARENT, ROOT, RUN_ID, SERVER, SOURCES,
        aggregate_memory, build_profile_document, exposes_port, file_digest,
        database_identity,
        http_health, ledger_read, load_config, load_historical_parent, load_replication_parent,
        mem_available, measured_memory, network_snapshot, profile_package, query, require_protocol,
        route_facts, run_probe_with_memory,
        snapshot, declared_target_identity, target_identity,
    )
    from run_spark_model_baseline import canonical_digest


EVIDENCE_ROOT = ROOT / "evidence/validation/model-profiles"


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


CREATED_AT_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"
)


def validated_created_at(document: Mapping[str, Any]) -> str:
    value = document.get("createdAt")
    require(isinstance(value, str) and CREATED_AT_PATTERN.fullmatch(value) is not None,
            "protected BF16 registration createdAt is not canonical UTC milliseconds")
    try:
        parsed = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as error:
        raise ValueError(
            "protected BF16 registration createdAt is not a valid UTC instant"
        ) from error
    require(parsed.microsecond % 1000 == 0,
            "protected BF16 registration createdAt precision drifted")
    return value


def validate_runtime_shape(value: Mapping[str, Any], config: Mapping[str, Any],
                           run_id: str) -> None:
    runtime = config["runtime"]
    mounts = value.get("mounts") or []
    expected_mounts = sorted([
        ("volume", config["artifact"]["targetVolume"], "/model", False),
        ("volume", config["artifact"]["runtimeBundleVolume"], "/runtime", False),
        ("volume", runtime["authenticationVolume"], "/run/secrets/auth", False),
        ("volume", runtime["offloadVolume"], runtime["offloadMountPath"], True),
    ])
    actual_mounts = sorted(
        (item.get("type"), item.get("name"), item.get("destination"), item.get("rw"))
        for item in mounts
    )
    expected_ports = {
        f"{runtime['containerPort']}/tcp": [{
            "HostIp": "127.0.0.1", "HostPort": str(runtime["hostPort"]),
        }]
    }
    healthcheck = value.get("healthcheck") or {}
    requests = value.get("deviceRequests") or []
    require(
        value.get("imageId") == config["engine"]["imageId"]
        and value.get("configuredImage") == config["engine"]["targetImageTag"]
        and value.get("running") is True
        and value.get("health") == "healthy"
        and value.get("oomKilled") is False
        and value.get("user") == runtime["processIdentity"]
        and value.get("readOnly") is True
        and value.get("privileged") is False
        and value.get("networkMode") == runtime["networkName"]
        and value.get("networks") == [runtime["networkName"]]
        and exposes_port(value, runtime["hostPort"], runtime["containerPort"])
        and value.get("portBindings") == expected_ports
        and value.get("memoryBytes") == runtime["hardMemoryBytes"]
        and value.get("memoryReservationBytes") == runtime["memoryReservationBytes"]
        and value.get("restartPolicy") == runtime["restartPolicy"]
        and value.get("restartCount") == 0
        and value.get("nanoCpus") == 12_000_000_000
        and value.get("pidsLimit") == 1024
        and value.get("shmSizeBytes") == 2 * 1024**3
        and len(requests) == 1
        and requests[0].get("Count") == -1
        and ["gpu"] in requests[0].get("Capabilities", [])
        and value.get("capDrop") == ["ALL"]
        and "no-new-privileges" in (value.get("securityOpt") or [])
        and value.get("tmpfs", {}).get("/tmp")
        == "rw,exec,nosuid,nodev,size=8g,uid=65532,gid=65532,mode=1770"
        and value.get("environment") == runtime["runtimeEnvironment"]
        and value.get("entrypoint") == ["python3"]
        and value.get("command") == ["/runtime/flux2_bf16_protected_server.py"]
        and healthcheck.get("Test") == [
            "CMD-SHELL", "python3 -c \"import pathlib,urllib.request;"
            "t=pathlib.Path('/run/secrets/auth/provider.token').read_text().strip();"
            "q=urllib.request.Request('http://127.0.0.1:8000/health',"
            "headers={'Authorization':'Bearer '+t});"
            "urllib.request.urlopen(q,timeout=3).read()\"",
        ]
        and healthcheck.get("Interval") == 10_000_000_000
        and healthcheck.get("Timeout") == 5_000_000_000
        and healthcheck.get("Retries") == 30
        and healthcheck.get("StartPeriod") == 1_200_000_000_000
        and actual_mounts == expected_mounts,
        "protected BF16 runtime hardening, image, memory or mounts drifted",
    )
    labels = value.get("labels") or {}
    require(
        labels.get("com.teamaibox.run-id") == run_id
        and labels.get("com.teamaibox.managed") == "true"
        and labels.get("com.teamaibox.component") == "drawing-flux2-klein-bf16-worker"
        and labels.get("com.teamaibox.profile-key") == config["profileKey"]
        and labels.get("com.teamaibox.placement-class") == "protected-resident"
        and labels.get("com.teamaibox.ordinary-drain-allowed") == "false"
        and labels.get("com.teamaibox.idle-unload") == "false",
        "protected BF16 residency labels drifted",
    )


def validate_cycle_memory(value: Mapping[str, Any], config: Mapping[str, Any], *,
                          require_exclusive: bool = True) -> None:
    fields = (
        "nvidiaProcessBytes", "containerCurrentBytes", "containerPeakBytes",
        "cudaPeakAllocatedBytes", "cudaPeakReservedBytes", "hostObservedDeltaBytes",
    )
    expected = max(int(value.get(field, -1)) for field in fields)
    control = config["qualificationControl"]
    psi_admission = value.get("psiAdmission") or {}
    require(
        value.get("nvidiaProcessBytes", 0) > 0
        and value.get("containerCurrentBytes", 0) > 0
        and value.get("containerPeakBytes", 0) >= value.get("containerCurrentBytes", 0)
        and value.get("cudaPeakAllocatedBytes", 0) > 0
        and value.get("cudaPeakReservedBytes", 0) >= value.get("cudaPeakAllocatedBytes", 0)
        and value.get("hostMemoryAvailableBeforeBytes", 0) > 0
        and value.get("hostMemoryAvailableAfterBytes", 0) > 0
        and value.get("minimumHostMemoryAvailableBytes", 0) > 0
        and value.get("hostObservedDeltaBytes")
        == max(0, value["hostMemoryAvailableBeforeBytes"]
               - value["minimumHostMemoryAvailableBytes"])
        and value.get("unifiedObservedBytes") == expected
        and value.get("accountingPolicy")
        == "continuous-maximum-plus-fixed-headroom-no-overlap-sum"
        and value.get("accountingHeadroomBytes") == 256 * 1024**2
        and value.get("accountedAdmissionBytes") == expected + 256 * 1024**2
        and value.get("doubleCountingAvoided") is True
        and value.get("continuousSampling") is True
        and value.get("sampleIntervalSeconds") == 2
        and value.get("sampleCount", 0) >= 2
        and isinstance(value.get("transientProcessExitRetries"), int)
        and value.get("transientProcessExitRetries", -1) >= 0
        and isinstance(value.get("sampleSetDigest"), str)
        and value["sampleSetDigest"].startswith("sha256:")
        and value.get("gpuPidOwnershipExact") is True
        and value.get("exclusiveGpuOwnershipRequired") is require_exclusive
        and (not require_exclusive or value.get("nonTargetGpuProcessCount") == 0)
        and value.get("oomEventsBefore", {}).get("oom") == 0
        and value.get("oomEventsBefore", {}).get("oom_kill") == 0
        and value.get("oomEventDelta") == {"oom": 0, "oom_kill": 0}
        and value.get("psiBefore", {}).get("fullAvg10", 2.0) <= 1.0
        and psi_admission.get("settled") is True
        and psi_admission.get("maximumAllowedFullAvg10")
        == control["maximumMemoryPsiFullAvg10"]
        and psi_admission.get("timeoutSeconds")
        == control["memoryPsiSettleTimeoutSeconds"]
        and psi_admission.get("pollIntervalSeconds")
        == control["memoryPsiSettlePollSeconds"]
        and psi_admission.get("requiredConsecutiveSamples")
        == control["memoryPsiSettleConsecutiveSamples"]
        and isinstance(psi_admission.get("observationCount"), int)
        and control["memoryPsiSettleConsecutiveSamples"]
        <= psi_admission.get("observationCount", 0)
        <= control["memoryPsiSettleTimeoutSeconds"]
        // control["memoryPsiSettlePollSeconds"] + 1
        and isinstance(psi_admission.get("initialObservation"), dict)
        and isinstance(psi_admission.get("settledObservation"), dict)
        and psi_admission.get("settledObservation") == value.get("psiBefore")
        and psi_admission.get("settledObservation", {}).get("fullAvg10", 2.0)
        <= control["maximumMemoryPsiFullAvg10"]
        and isinstance(psi_admission.get("waitMilliseconds"), int)
        and 0 <= psi_admission.get("waitMilliseconds", -1)
        <= (control["memoryPsiSettleTimeoutSeconds"]
            + control["memoryPsiSettlePollSeconds"]) * 1000
        and value.get("maximumPsiFullAvg10", 2.0) <= 1.0,
        "protected BF16 per-cycle unified-memory accounting drifted",
    )


def validate_memory(value: Mapping[str, Any], config: Mapping[str, Any]) -> None:
    require(
        value.get("accountingPolicy")
        == "continuous-maximum-plus-fixed-headroom-no-overlap-sum"
        and value.get("doubleCountingAvoided") is True
        and value.get("observedPeakBytes") == max(
            value.get("nvidiaProcessPeakBytes", 0),
            value.get("containerPeakBytes", 0),
            value.get("cudaAllocatedPeakBytes", 0),
            value.get("cudaReservedPeakBytes", 0),
            value.get("hostObservedDeltaPeakBytes", 0),
        )
        and value.get("accountingHeadroomBytes") == 256 * 1024**2
        and value.get("admissionBytes")
        == value.get("observedPeakBytes") + value.get("accountingHeadroomBytes")
        and value.get("continuousSampling") is True
        and value.get("sampleCount", 0) >= 4
        and isinstance(value.get("transientProcessExitRetries"), int)
        and value.get("transientProcessExitRetries", -1) >= 0
        and value.get("gpuPidOwnershipExact") is True
        and value.get("oomEventDelta") == {"oom": 0, "oom_kill": 0}
        and value.get("maximumPsiFullAvg10", 2.0) <= 1.0
        and 0 < value.get("admissionBytes", 0)
        <= config["runtime"]["protectedSlotAdmissionBytes"]
        == config["protectedOfficeSetBudget"]["fluxMaximumAdmissionBytes"]
        and config["protectedOfficeSetBudget"]["preFluxAccountedBytes"]
        + value.get("admissionBytes", 0)
        <= config["protectedOfficeSetBudget"]["modelResidentCeilingBytes"]
        and value.get("minimumHostMemoryAvailableBytes", 0)
        >= config["runtime"]["minimumCoreServiceReserveBytes"],
        "protected BF16 memory exceeds the exact 64 GiB office-set remainder or reserve",
    )


def expected_warm_probe() -> dict[str, Any]:
    return {
        "cycles": 2, "generation": True, "cancellation": True,
        "postCancellationRecovery": True,
        "generationOnly": True, "maximumConcurrentRequests": 1,
        "restartPersistence": True, "deterministicImageDigest": True,
        "ordinaryUnloadDenied": True, "warmAfterProbe": True,
        "bearerAuthentication": True, "ownerBoundCancellation": True,
        "linearizableLateCancellation": True, "wallClockWatchdog": True,
        "fatalCudaReadiness": True,
        "contentRetained": False,
    }


def registration_facts(config: Mapping[str, Any], document: Mapping[str, Any],
                       fingerprint: str, package_digest: str,
                       registration: Mapping[str, Any], run_id: str) -> dict[str, Any]:
    created_at = validated_created_at(document)
    canonical = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    warm = json.dumps(expected_warm_probe(), sort_keys=True, separators=(",", ":"))
    quant = json.dumps(document["quantizationRecipe"], sort_keys=True, separators=(",", ":"))
    compatibility = json.dumps(document["compatibility"], sort_keys=True, separators=(",", ":"))
    measured = json.dumps(document["runtime"]["measuredMemory"],
                          sort_keys=True, separators=(",", ":"))
    declared = json.dumps(document["resourceEnvelope"], sort_keys=True, separators=(",", ":"))
    refs = json.dumps(document["certification"]["evidenceRefs"], separators=(",", ":"))
    for marker in ("$profile$", "$quant$", "$compat$", "$warm$", "$measured$",
                   "$declared$", "$refs$", "$created$"):
        require(marker not in canonical, "unsafe protected BF16 validation delimiter")
    rows = query(f"""
SELECT (jsonb_build_object(
 'profileKey',profile.profile_key,
 'profileCapabilityId',profile.capability_id,
 'sourceModel',profile.source_model,
 'sourceRevision',profile.source_revision,
 'engine',profile.engine,
 'engineVersion',profile.engine_version,
 'precision',profile.precision,
 'artifactDigest',profile.artifact_digest,
 'quantizationEqual',profile.quantization_recipe=$quant${quant}$quant$::jsonb,
 'compatibilityEqual',profile.compatibility=$compat${compatibility}$compat$::jsonb,
 'declaredEqual',profile.declared_resources=$declared${declared}$declared$::jsonb,
 'measuredEqual',profile.measured_envelope=$measured${measured}$measured$::jsonb,
 'certificationState',profile.certification_state,
 'exclusive',profile.exclusive,
 'profilePlacementClass',profile.placement_class,
 'nodeGroupId',profile.placement_node_group_id,
 'profileDesiredRevision',profile.desired_state_revision,
 'profileObservedRevision',profile.observed_state_revision,
 'profileMaintenanceGeneration',profile.maintenance_generation,
 'profileRecoveryState',profile.recovery_state,
 'profileRecoveryReasonNull',profile.recovery_reason_code IS NULL,
 'profileLifecycleReason',profile.lifecycle_reason_key,
 'profileEvidenceRefsEqual',profile.lifecycle_evidence_refs=$refs${refs}$refs$::jsonb,
 'operationKey',registration.operation_key,
 'registrationRegisteredByNull',registration.registered_by IS NULL,
 'registrationCreatedAtEqual',registration.created_at=$created${created_at}$created$::timestamptz,
 'fingerprint',encode(registration.profile_fingerprint,'hex'),
 'documentEqual',registration.profile_document=$profile${canonical}$profile$::jsonb
 ) || jsonb_build_object(
 'placementRevisionId',placement.id,
 'placementNodeGroupId',placement.node_group_id,
 'placementRevision',placement.placement_revision,
 'placementPlacementClass',placement.placement_class,
 'placementDesiredRevision',placement.desired_state_revision,
 'placementObservedRevision',placement.observed_state_revision,
 'placementState',placement.placement_state,
 'placementRecoveryState',placement.recovery_state,
 'placementRecoveryReasonNull',placement.recovery_reason_code IS NULL,
 'placementMaintenanceGeneration',placement.maintenance_generation,
 'placementPreviousRevisionNull',placement.previous_revision_id IS NULL,
 'placementConfigurationDigest',encode(placement.configuration_digest,'hex'),
 'placementResourceEqual',placement.resource_envelope=$declared${declared}$declared$::jsonb,
 'warmProbeEqual',placement.warm_probe=$warm${warm}$warm$::jsonb,
 'evidenceRefsEqual',placement.evidence_refs=$refs${refs}$refs$::jsonb,
 'lifecycleId',lifecycle.id,
 'lifecycleProfileRevision',lifecycle.profile_revision,
 'lifecycleFrom',lifecycle.from_state,
 'lifecycleTo',lifecycle.to_state,
 'lifecycleReason',lifecycle.reason_key,
 'lifecycleEvidenceRefsEqual',lifecycle.evidence_refs=$refs${refs}$refs$::jsonb,
 'placementCount',(SELECT count(*) FROM compute.model_profile_placement_revisions x
                   WHERE x.model_profile_id=profile.id),
 'registrationCount',(SELECT count(*) FROM compute.model_profile_registrations x WHERE x.profile_id=profile.id),
 'lifecycleCount',(SELECT count(*) FROM compute.model_profile_lifecycle_events x WHERE x.model_profile_id=profile.id)
))::text
FROM compute.model_profiles profile
JOIN compute.model_profile_registrations registration ON registration.profile_id=profile.id
JOIN compute.model_profile_placement_revisions placement ON placement.model_profile_id=profile.id
JOIN compute.model_profile_lifecycle_events lifecycle ON lifecycle.model_profile_id=profile.id
WHERE profile.id='{config['profileId']}'::uuid
  AND registration.profile_key='{config['profileKey']}'
  AND placement.id='{config['placementRevisionId']}'::uuid
  AND lifecycle.id='{config['lifecycleEventId']}'::uuid
""")
    require(len(rows) == 1, "protected BF16 registration is absent or ambiguous")
    value = json.loads(rows[0])
    exact = (
        value.get("profileKey") == config["profileKey"]
        and value.get("profileCapabilityId") == config["capabilityId"]
        and value.get("sourceModel") == config["source"]["model"]
        and value.get("sourceRevision") == config["source"]["revision"]
        and value.get("engine") == config["engine"]["name"]
        and value.get("engineVersion") == config["engine"]["version"]
        and value.get("precision") == "bf16"
        and value.get("artifactDigest") == package_digest
        and value.get("quantizationEqual") is True
        and value.get("compatibilityEqual") is True
        and value.get("declaredEqual") is True
        and value.get("measuredEqual") is True
        and value.get("certificationState") == "validating"
        and value.get("exclusive") is False
        and value.get("profilePlacementClass") == "protected-resident"
        and value.get("nodeGroupId") == config["target"]["nodeGroupId"]
        and value.get("profileDesiredRevision") == 1
        and value.get("profileObservedRevision") == 0
        and value.get("profileMaintenanceGeneration") == registration["maintenanceGeneration"]
        and value.get("profileRecoveryState") == "healthy"
        and value.get("profileRecoveryReasonNull") is True
        and value.get("profileLifecycleReason")
        == "model.lifecycle.validating.flux2-bf16-main-protected"
        and value.get("profileEvidenceRefsEqual") is True
        and value.get("operationKey") == run_id
        and value.get("registrationRegisteredByNull") is True
        and value.get("registrationCreatedAtEqual") is True
        and value.get("fingerprint") == fingerprint
        and value.get("documentEqual") is True
        and value.get("placementRevisionId") == config["placementRevisionId"]
        and value.get("placementNodeGroupId") == config["target"]["nodeGroupId"]
        and value.get("placementRevision") == 1
        and value.get("placementPlacementClass") == "protected-resident"
        and value.get("placementDesiredRevision") == 1
        and value.get("placementObservedRevision") == 0
        and value.get("placementState") == "loading"
        and value.get("placementRecoveryState") == "healthy"
        and value.get("placementRecoveryReasonNull") is True
        and value.get("placementMaintenanceGeneration")
        == registration["maintenanceGeneration"]
        and value.get("placementPreviousRevisionNull") is True
        and value.get("placementConfigurationDigest") == package_digest.removeprefix("sha256:")
        and value.get("placementResourceEqual") is True
        and value.get("warmProbeEqual") is True
        and value.get("evidenceRefsEqual") is True
        and value.get("lifecycleId") == config["lifecycleEventId"]
        and value.get("lifecycleProfileRevision") == 1
        and value.get("lifecycleFrom") is None
        and value.get("lifecycleTo") == "validating"
        and value.get("lifecycleReason")
        == "model.lifecycle.validating.flux2-bf16-main-protected"
        and value.get("lifecycleEvidenceRefsEqual") is True
        and value.get("placementCount") == 1
        and value.get("registrationCount") == 1
        and value.get("lifecycleCount") == 1
    )
    return {"exact": exact, "facts": value}


def validate_payload(value: dict[str, Any], *, revalidate: bool) -> dict[str, Any]:
    unsigned = dict(value)
    recorded = unsigned.pop("evidenceDigest", None)
    require(recorded == canonical_digest(unsigned), "protected BF16 evidence digest drifted")
    run_id = str(value.get("runId", ""))
    require(
        value.get("schemaVersion") == 1
        and value.get("runnerId")
        == "teamaibox.flux2-klein-bf16-main-protected-profile-qualification.v1"
        and RUN_ID.fullmatch(run_id) is not None
        and value.get("status") == "passed"
        and value.get("failure") is None,
        "protected BF16 profile qualification did not pass",
    )
    config = load_config()
    require(value.get("targetIdentity") == declared_target_identity(config),
            "protected BF16 recorded main-box identity drifted")
    require(
        value.get("target") == config["target"]
        and value.get("profileId") == config["profileId"]
        and value.get("profileKey") == config["profileKey"],
        "protected BF16 target or profile identity drifted",
    )
    database = value.get("databaseIdentity") or {}
    require(
        database.get("imageId") == config["database"]["imageId"]
        and database.get("configuredImage") == config["database"]["configuredImage"]
        and database.get("systemIdentifier") == config["database"]["systemIdentifier"]
        and database.get("database") == config["database"]["database"]
        and database.get("user") == config["database"]["user"]
        and database.get("serverVersionNum") == config["database"]["serverVersionNum"]
        and database.get("schemaLedger") == config["database"]["schemaLedger"]
        and isinstance(database.get("containerId"), str)
        and re.fullmatch(r"[0-9a-f]{64}", database["containerId"]) is not None
        and database.get("running") is True and database.get("health") == "healthy"
        and database.get("readOnly") is True and database.get("privileged") is False,
        "protected BF16 exact Postgres container/image/system/schema binding drifted",
    )
    require(value.get("configuration") == {
        "path": CONFIG.relative_to(ROOT).as_posix(),
        "fileSha256": file_digest(CONFIG), "document": config,
    }, "protected BF16 configuration binding drifted")
    require(
        {item["path"]: item["sha256"] for item in value.get("sources", [])}
        == {item.relative_to(ROOT).as_posix(): file_digest(item) for item in SOURCES},
        "protected BF16 qualification source binding drifted",
    )
    parent = value.get("parent") or {}
    require(
        parent.get("runId") == config["artifact"]["replicationRunId"]
        and parent.get("path") == REPLICATION_PARENT.relative_to(ROOT).as_posix()
        and isinstance(parent.get("fileSha256"), str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", parent["fileSha256"]) is not None
        and isinstance(parent.get("evidenceDigest"), str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", parent["evidenceDigest"]) is not None
        and parent.get("offlineImmutableParentValidation") is True
        and parent.get("liveAuxiliaryDependency") is False
        and parent.get("artifactDigest") == config["artifact"]["weightsArtifactDigest"]
        and parent.get("volume") == config["artifact"]["targetVolume"]
        and parent.get("imageId") == config["engine"]["imageId"]
        and parent.get("imageTag") == config["engine"]["targetImageTag"],
        "protected BF16 exact replication parent drifted",
    )
    historical = value.get("historicalMeasurementParent") or {}
    require(
        historical.get("runId") == config["historicalMeasurementParent"]["runId"]
        and historical.get("role") == "historical-bf16-measurement-only"
        and historical.get("identityAuthority") is False,
        "protected BF16 historical measurement boundary drifted",
    )
    package = profile_package(config, parent)
    require(
        value.get("profilePackage") == package
        and package["digest"] != config["artifact"]["weightsArtifactDigest"],
        "protected BF16 profile-package identity drifted",
    )
    require(value.get("registrationPreflight") == {
        "profileIdAvailable": True, "profileKeyAvailable": True,
        "packageIdentityAvailable": True, "lifecycleEventIdAvailable": True,
        "placementRevisionIdAvailable": True, "operationKeyAvailable": True,
    }, "protected BF16 immutable registration preflight drifted")
    runtime_config = config["runtime"]
    admission = value.get("startAdmission") or {}
    require(
        admission.get("hostMemoryAvailableBytes", 0)
        >= runtime_config["minimumStandaloneQualificationAvailableBytes"]
        and admission.get("minimumProtectedStartAvailableBytes")
        == runtime_config["minimumProtectedStartAvailableBytes"]
        and admission.get("minimumStandaloneQualificationAvailableBytes")
        == runtime_config["minimumStandaloneQualificationAvailableBytes"]
        and admission.get("minimumCoreServiceReserveBytes")
        == runtime_config["minimumCoreServiceReserveBytes"]
        and admission.get("minimumTransientMarginBytes")
        == runtime_config["minimumTransientMarginBytes"]
        and admission.get("protectedSlotAdmissionBytes")
        == runtime_config["protectedSlotAdmissionBytes"]
        and admission.get("protectedOfficeSetModelCeilingBytes")
        == config["protectedOfficeSetBudget"]["modelResidentCeilingBytes"]
        and admission.get("preFluxProtectedOfficeSetBytes")
        == config["protectedOfficeSetBudget"]["preFluxAccountedBytes"]
        and admission.get("normalProtectedStartUsesPerProfile96GiBGate") is False
        and admission.get("explicitStandaloneQualificationGateApplied") is True
        and admission.get("measuredAfterExactGpuConflictDrain") is True,
        "protected BF16 exact 64 GiB remainder admission boundary drifted",
    )
    ledger = value.get("durableRunLedger") or {}
    lease = value.get("maintenanceLease") or {}
    maintenance = value.get("gpuMaintenance") or {}
    require(
        ledger.get("volume") == config["qualificationControl"]["ledgerVolume"]
        and ledger.get("mountpoint") == "redacted-host-managed-volume"
        and ledger.get("runId") == run_id
        and ledger.get("sourceSetDigest") == canonical_digest(value.get("sources") or [])
        and ledger.get("databaseContainerId") == database["containerId"]
        and ledger.get("databaseImageId") == database["imageId"]
        and ledger.get("databaseConfiguredImage") == database["configuredImage"]
        and ledger.get("databaseSystemIdentifier") == database["systemIdentifier"]
        and ledger.get("schemaLedger") == database["schemaLedger"]
        and ledger.get("driver") == "local" and ledger.get("fsyncRequired") is True
        and ledger.get("reconciliationRequired") is True
        and isinstance(ledger.get("finalRevision"), int) and ledger["finalRevision"] >= 5
        and ledger.get("finalState") == "passed",
        "protected BF16 durable run ledger/fync/reconciliation drifted",
    )
    require(
        lease == {
            "name": config["qualificationControl"]["maintenanceLeaseName"],
            "runId": run_id,
            "ttlSeconds": config["qualificationControl"]["maintenanceLeaseTtlSeconds"],
            "heartbeatSeconds":
                config["qualificationControl"]["maintenanceLeaseHeartbeatSeconds"],
            "fencedByLedgerRevision": True, "continuouslyRenewed": True,
            "released": True,
        }, "protected BF16 maintenance lease drifted",
    )
    containers = maintenance.get("containers") or []
    drained = maintenance.get("drainedContainerIds") or []
    planned_ids = [item.get("containerId") for item in containers]
    companion_ids = [companion.get("containerId") for item in containers
                     for companion in (item.get("dependentContainers") or [])]
    expected_drain_order = [identity
                            for item in containers
                            for identity in ([companion.get("containerId")
                                              for companion in item.get("dependentContainers", [])]
                                             + [item.get("containerId")])]
    expected_restore_order = [identity
                              for item in containers
                              for identity in ([item.get("containerId")]
                                               + [companion.get("containerId")
                                                  for companion in item.get(
                                                      "dependentContainers", [])])]
    identity_fields = tuple(config["qualificationControl"]["gpuContainerIdentityFields"])
    all_identities = [item for worker in containers
                      for item in (worker, *worker.get("dependentContainers", []))]
    owned_process_ids = {pid for item in all_identities
                         for pid in item.get("processIds", [])}
    observed_process_ids = maintenance.get("observedGpuProcessIds") or []
    require(
        maintenance.get("policy")
        == "inventory-and-drain-all-running-gpu-containers"
        and all(isinstance(item, dict) for item in containers)
        and all(re.fullmatch(r"[0-9a-f]{64}", str(item.get("containerId", "")))
                and item.get("running") is True
                and isinstance(item.get("containerName"), str) and item["containerName"]
                and re.fullmatch(r"sha256:[0-9a-f]{64}", str(item.get("imageId", "")))
                and isinstance(item.get("configuredImage"), str)
                and item["configuredImage"]
                and isinstance(item.get("restartPolicy"), str)
                and item["restartPolicy"]
                and all(field in item for field in identity_fields)
                and all(isinstance(pid, int) and pid > 1
                        for pid in item.get("processIds", []))
                for item in all_identities)
        and all(companion.get("networkMode") == "container:" + worker["containerId"]
                for worker in containers
                for companion in worker.get("dependentContainers", []))
        and len(set(planned_ids + companion_ids)) == len(planned_ids + companion_ids)
        and all(isinstance(pid, int) and pid > 1 for pid in observed_process_ids)
        and set(observed_process_ids).issubset(owned_process_ids)
        and maintenance.get("unknownGpuProcessIds") == []
        and maintenance.get("exactOwnership") is True
        and maintenance.get("leaseHeldForDrain") is True
        and drained == expected_drain_order
        and (maintenance.get("restoredContainerIds") or []) == expected_restore_order
        and maintenance.get("exactRestore") is True,
        "protected BF16 exact GPU drain/restore or PID ownership drifted",
    )
    authentication = value.get("authentication") or {}
    require(authentication == {
        "scheme": "Bearer", "ownerHeader": "X-TeamAIBox-Owner",
        "volume": runtime_config["authenticationVolume"], "runId": run_id,
        "file": "/run/secrets/auth/provider.token", "fileMode": "0400",
        "fileType": "regular-file", "hardLinkCount": 1,
        "processUid": 65532, "processGid": 65532, "readOnlyAtRuntime": True,
        "credentialRetained": False, "credentialDigestRetained": False,
    }, "protected BF16 Worker authentication evidence drifted")
    require(value.get("offloadCache") == {
        "volume": runtime_config["offloadVolume"], "runId": run_id, "driver": "local",
        "labels": {
            "com.teamaibox.managed": "true",
            "com.teamaibox.purpose": "protected-resident-disk-offload-cache",
            "com.teamaibox.component": "drawing-flux2-klein-bf16",
            "com.teamaibox.run-id": run_id,
        },
        "mountPath": runtime_config["offloadMountPath"], "fileMode": "0700",
        "processUid": 65532, "processGid": 65532, "disposable": True,
        "containsUserContent": False, "memoryStrategy": runtime_config["memoryStrategy"],
    }, "protected BF16 dedicated disk-offload cache evidence drifted")
    require(value.get("runtimeBundle") == {
        "volume": config["artifact"]["runtimeBundleVolume"], "runId": run_id,
        "driver": "local", "labels": {
            "com.teamaibox.managed": "true",
            "com.teamaibox.purpose": "protected-resident-runtime-bundle",
            "com.teamaibox.component": "drawing-flux2-klein-bf16",
            "com.teamaibox.run-id": run_id,
        },
        "serverPath": "/runtime/flux2_bf16_protected_server.py",
        "serverSha256": file_digest(SERVER), "readOnlyAtRuntime": True,
        "fileManifest": [{
            "path": "flux2_bf16_protected_server.py", "type": "regular-file",
            "sha256": file_digest(SERVER),
        }],
    }, "protected BF16 runtime bundle drifted")
    require(value.get("probeStaging") == {
        "path": "/tmp/teamaibox-" + run_id + "-probe.py",
        "sha256": file_digest(PROBE),
        "serverPath": "/tmp/teamaibox-" + run_id + "-server.py",
        "serverSha256": file_digest(SERVER),
        "removedAfterRun": True,
    }, "protected BF16 staged source identity drifted")
    network = value.get("network") or {}
    network_preflight = value.get("networkPreflight") or {}
    routes = network_preflight.get("routeBeforeNetworkCreate") or {}
    expected_ipam = [{
        "subnet": runtime_config["networkSubnet"],
        "gateway": runtime_config["networkGateway"],
    }]
    require(
        network_preflight.get("subnet") == runtime_config["networkSubnet"]
        and network_preflight.get("gateway") == runtime_config["networkGateway"]
        and network_preflight.get("isolation") == runtime_config["networkIsolation"]
        and network_preflight.get("overlapFree") is True
        and isinstance(network_preflight.get("occupiedSubnetCount"), int)
        and network_preflight["occupiedSubnetCount"] >= 0
        and isinstance(network_preflight.get("occupiedSubnetSetDigest"), str)
        and network_preflight["occupiedSubnetSetDigest"].startswith("sha256:")
        and network_preflight.get("routeBeforeNetworkCreate")
        == network_preflight.get("routeAfterNetworkCreate"),
        "protected BF16 private-network preflight or route boundary drifted",
    )
    require(routes.get("auxiliaryRuntimeDependency") is False
            and routes.get("liveAuxiliaryChecks") == []
            and routes.get("kernelRouteCount") == 2
            and isinstance(routes.get("kernelRouteTableDigest"), str)
            and routes["kernelRouteTableDigest"].startswith("sha256:")
            and routes.get("managementRoute", {}).get("dst")
            == config["sourceNode"]["managementAddress"]
            and routes.get("managementRoute", {}).get("prefsrc")
            == config["target"]["nodeAddress"]
            and isinstance(routes.get("managementRoute", {}).get("dev"), str)
            and bool(routes["managementRoute"]["dev"])
            and routes.get("fabricRoute", {}).get("dst")
            == config["sourceNode"]["fabricAddress"]
            and routes.get("fabricRoute", {}).get("dev")
            == config["sourceNode"]["fabricInterface"]
            and routes.get("fabricRoute", {}).get("prefsrc")
            == config["sourceNode"]["fabricSourceAddress"]
            and config["qualificationControl"]["auxiliaryRuntimeDependency"] is False,
            "protected BF16 qualification acquired a live auxiliary dependency")
    require(
        network.get("name") == runtime_config["networkName"]
        and isinstance(network.get("id"), str) and len(network["id"]) == 64
        and network.get("driver") == "bridge"
        and network.get("internal") is False
        and network.get("attachable") is False
        and network.get("ingress") is False
        and network.get("options") == {
            "com.docker.network.bridge.enable_icc": "false",
            "com.docker.network.bridge.enable_ip_masquerade": "false",
        }
        and network.get("ipam") == expected_ipam
        and network.get("labels", {}).get("com.teamaibox.managed") == "true"
        and network.get("labels", {}).get("com.teamaibox.purpose")
        == "protected-resident-loopback-only-network"
        and network.get("labels", {}).get("com.teamaibox.component")
        == "drawing-flux2-klein-bf16"
        and network.get("labels", {}).get("com.teamaibox.run-id") == run_id,
        "protected BF16 loopback-only no-masquerade network drifted",
    )
    isolation_probe = value.get("networkIsolationProbe") or {}
    isolation_targets = isolation_probe.get("targets") or []
    require(
        isolation_probe.get("passed") is True
        and isolation_probe.get("policy") == runtime_config["networkIsolation"]
        and isolation_probe.get("loopbackPublicationValidatedByRealProtocolProbe") is True
        and [(item.get("name"), item.get("address"), item.get("port"))
             for item in isolation_targets] == [
                 ("auxiliary-management", config["sourceNode"]["managementAddress"], 22),
                 ("auxiliary-fabric", config["sourceNode"]["fabricAddress"], 22),
                 ("external-internet", "1.1.1.1", 443),
             ]
        and all(item.get("reachable") is False
                and isinstance(item.get("connectCode"), int)
                and item["connectCode"] != 0 for item in isolation_targets),
        "protected BF16 runtime egress isolation proof drifted",
    )
    cycles = value.get("cycles") or []
    require(len(cycles) == 2 and [item.get("cycle") for item in cycles] == [1, 2],
            "protected BF16 requires exactly two runtime cycles")
    for cycle in cycles:
        validate_runtime_shape(cycle.get("runtime") or {}, config, run_id)
        try:
            require_protocol(cycle.get("protocol") or {}, runtime_config["servedModel"],
                             int(cycle["cycle"]))
        except Exception as error:
            raise ValueError(str(error)) from error
        validate_cycle_memory(cycle.get("memory") or {}, config)
    require(
        cycles[0]["runtime"].get("containerId")
        == cycles[1]["runtime"].get("containerId")
        and cycles[0]["runtime"].get("startedAt") != cycles[1]["runtime"].get("startedAt")
        and cycles[0]["protocol"]["generation"]["output"]["sha256"]
        == cycles[1]["protocol"]["generation"]["output"]["sha256"],
        "protected BF16 two-cycle restart determinism drifted",
    )
    require(network.get("containerIds") == [cycles[0]["runtime"].get("containerId")],
            "protected BF16 private network membership drifted")
    expected_memory = aggregate_memory([item["memory"] for item in cycles])
    require(value.get("memoryEnvelope") == expected_memory,
            "protected BF16 aggregate memory evidence drifted")
    validate_memory(expected_memory, config)
    office_budget = config["protectedOfficeSetBudget"]
    resulting_aggregate = office_budget["preFluxAccountedBytes"] + expected_memory["admissionBytes"]
    require(value.get("protectedOfficeSetBudget") == {
        "accountingPolicy": office_budget["accountingPolicy"],
        "modelResidentCeilingBytes": office_budget["modelResidentCeilingBytes"],
        "preFluxAccountedBytes": office_budget["preFluxAccountedBytes"],
        "fluxMaximumAdmissionBytes": office_budget["fluxMaximumAdmissionBytes"],
        "measuredFluxAdmissionBytes": expected_memory["admissionBytes"],
        "resultingAggregateAccountingBytes": resulting_aggregate,
        "componentAdmissionWithinRemainder": True,
        "aggregateCoexistenceMeasured": False,
        "aggregateCoexistenceRequiredBeforeRouting": True,
    } and resulting_aggregate <= office_budget["modelResidentCeilingBytes"],
            "protected BF16 64 GiB protected-office-set accounting evidence drifted")
    runtime = value.get("runtime") or {}
    validate_runtime_shape(runtime, config, run_id)
    require(
        runtime.get("containerId") == cycles[0]["runtime"].get("containerId")
        == cycles[1]["runtime"].get("containerId")
        and runtime.get("engineVersion") == config["engine"]["version"]
        and runtime.get("warm") is True
        and runtime.get("idleUnload") is False
        and runtime.get("ordinaryDrainAllowed") is False
        and runtime.get("generationOnly") is True
        and runtime.get("maximumConcurrentRequests") == 1
        and runtime.get("kvCache") == config["precision"]["kvCache"]
        and runtime.get("restartPersistence") == {
            "sameContainerId": True, "sameImageId": True,
            "startedAtAdvanced": True, "protocolPassed": True,
            "deterministicImageDigest": True,
        },
        "protected BF16 warm restart or disclosure evidence drifted",
    )
    registration = value.get("profileRegistration") or {}
    document = registration.get("document") or {}
    created_at = validated_created_at(document)
    expected_document = build_profile_document(
        config, parent, historical, package, runtime, expected_memory, run_id,
        created_at,
    )
    canonical = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    require(
        document == expected_document
        and document.get("artifactDigest") == package["digest"]
        and document.get("extensions", {}).get("weightsArtifactDigest")
        == config["artifact"]["weightsArtifactDigest"]
        and document.get("precision") == "bf16"
        and document.get("quantizationRecipe", {}).get("scheme") == "none"
        and document.get("placementClass") == "protected-resident"
        and document.get("target", {}).get("nodeRole") == "main-box"
        and registration.get("registered") is True
        and registration.get("transactional") is True
        and registration.get("profileFingerprint") == "sha256:" + fingerprint
        and registration.get("profilePackageArtifactDigest") == package["digest"]
        and registration.get("weightsArtifactDigest")
        == config["artifact"]["weightsArtifactDigest"]
        and registration.get("placementRevisionId") == config["placementRevisionId"]
        and registration.get("nodeGroupId") == config["target"]["nodeGroupId"]
        and isinstance(registration.get("maintenanceGeneration"), int)
        and registration["maintenanceGeneration"] >= 0,
        "protected BF16 transactional profile registration evidence drifted",
    )
    require(registration.get("placementState") == "loading"
            and registration.get("routingEligible") is False
            and registration.get("productAccepted") is False,
            "protected BF16 component qualification claimed premature routing readiness")
    reconciled = registration.get("reconciledFacts") or {}
    require(
        isinstance(registration.get("commitResponseObserved"), bool)
        and registration.get("reconciledState") == "exact"
        and all(reconciled.get(key) == 1 for key in (
            "anyProfileCount", "exactProfileCount",
            "anyRegistrationCount", "exactRegistrationCount",
            "anyPlacementCount", "exactPlacementCount",
            "anyLifecycleCount", "exactLifecycleCount",
        )),
        "protected BF16 immutable registration reconciliation drifted",
    )
    require(value.get("privacy") == {
        "credentialsRetained": False, "userContentRetained": False,
        "imageContentRetained": False, "syntheticContentOnly": True,
        "rawCommandOutputRetained": False,
        "redactedFailureDiagnosticRetained": False,
    }, "protected BF16 privacy boundary drifted")
    require(value.get("claimBoundary") == {
        "componentReady": False, "standaloneQualificationPassed": True,
        "profilePrepared": True, "protectedProfileRegistered": True,
        "aggregateCoexistenceQualified": False,
        "aggregateManifestUpdated": False, "protectedOfficeSetDeployed": False,
        "productRouted": False, "task21_3Complete": False, "task21_4Complete": False,
    }, "protected BF16 qualification claim boundary drifted")
    require(value.get("cleanup") == {
        "databaseCommitted": True,
        "registrationAttempted": True,
        "registrationStateAfterFailure": None,
        "registrationFactsAfterFailure": None,
        "successfulRuntimeRetained": True,
        "successfulRuntimeBundleRetained": True,
        "successfulAuthenticationVolumeRetained": True,
        "successfulOffloadVolumeRetained": True,
        "successfulPrivateNetworkRetained": True,
        "exactGpuConflictsRestored": True,
        "failedImmutableRegistrationAbsent": None,
        "failedExactRuntimeRemoved": None,
        "failedExactRuntimeBundleRemoved": None,
        "failedExactAuthenticationVolumeRemoved": None,
        "failedExactOffloadVolumeRemoved": None,
        "failedExactPrivateNetworkRemoved": None,
        "replicatedModelVolumeUntouched": True,
        "replicatedRuntimeImageUntouched": True,
    }, "protected BF16 success retention boundary drifted")
    if revalidate:
        require(value.get("targetIdentity") == target_identity(config),
                "protected BF16 live main-box SSH or machine identity drifted")
        require(database_identity(config, expected_container_id=database["containerId"]) == database,
                "protected BF16 live Postgres identity or schema drifted")
        ledger_result = REMOTE.run((
            "sudo", "docker", "volume", "inspect", config["qualificationControl"]["ledgerVolume"]
        ), 60)
        require(ledger_result.returncode == 0, "live protected BF16 ledger volume is absent")
        ledger_values = json.loads(ledger_result.stdout)
        require(len(ledger_values) == 1 and ledger_values[0].get("Driver") == "local"
                and (ledger_values[0].get("Labels") or {}) == {
                    "com.teamaibox.managed": "true",
                    "com.teamaibox.component": "drawing-flux2-klein-bf16",
                    "com.teamaibox.purpose": "qualification-run-ledger",
                }, "live protected BF16 ledger volume identity drifted")
        live_ledger = ledger_read({"mountpoint": ledger_values[0]["Mountpoint"]}, run_id)
        require(live_ledger.get("state") == "passed"
                and live_ledger.get("revision") == ledger["finalRevision"]
                and live_ledger.get("sourceSetDigest") == ledger["sourceSetDigest"]
                and live_ledger.get("databaseContainerId") == database["containerId"]
                and live_ledger.get("databaseImageId") == database["imageId"]
                and live_ledger.get("databaseConfiguredImage") == database["configuredImage"]
                and live_ledger.get("databaseSystemIdentifier") == database["systemIdentifier"]
                and live_ledger.get("schemaLedger") == database["schemaLedger"],
                "live protected BF16 durable ledger record drifted")
        lease_absent = REMOTE.run((
            "sudo", "test", "!", "-e", ledger_values[0]["Mountpoint"] + "/maintenance-lease.json"
        ), 30)
        require(lease_absent.returncode == 0,
                "protected BF16 maintenance lease was not released")
        for expected in all_identities:
            current_peer = snapshot(expected["containerName"])
            require(
                current_peer.get("containerId") == expected["containerId"]
                and current_peer.get("imageId") == expected["imageId"]
                and current_peer.get("configuredImage") == expected["configuredImage"]
                and current_peer.get("restartPolicy") == expected["restartPolicy"]
                and current_peer.get("networkMode") == expected["networkMode"]
                and current_peer.get("running") is True
                and (expected.get("health") != "healthy"
                     or current_peer.get("health") == "healthy"),
                "live protected BF16 restored GPU peer identity or health drifted",
            )
        require(load_replication_parent(config) == parent,
                "protected BF16 replication parent no longer validates")
        require(load_historical_parent(config) == historical,
                "protected BF16 historical parent no longer validates")
        image_result = REMOTE.run((
            "sudo", "docker", "image", "inspect", config["engine"]["targetImageTag"]
        ), 90)
        require(image_result.returncode == 0, "live protected BF16 runtime image is absent")
        image = json.loads(image_result.stdout)
        require(len(image) == 1
                and image[0].get("Id") == config["engine"]["imageId"]
                and image[0].get("Architecture") == "arm64"
                and image[0].get("Size") == config["engine"]["imageSizeBytes"],
                "live protected BF16 runtime image drifted")
        volume_result = REMOTE.run((
            "sudo", "docker", "volume", "inspect", config["artifact"]["targetVolume"]
        ), 60)
        require(volume_result.returncode == 0, "live protected BF16 model volume is absent")
        model_volume = json.loads(volume_result.stdout)
        require(len(model_volume) == 1
                and (model_volume[0].get("Labels") or {}).get("com.teamaibox.run-id")
                == parent["runId"], "live protected BF16 model volume drifted")
        bundle_result = REMOTE.run((
            "sudo", "docker", "volume", "inspect", config["artifact"]["runtimeBundleVolume"]
        ), 60)
        require(bundle_result.returncode == 0, "live protected BF16 runtime bundle is absent")
        bundle = json.loads(bundle_result.stdout)
        bundle_labels = (bundle[0].get("Labels") or {}) if len(bundle) == 1 else {}
        require(len(bundle) == 1
                and bundle[0].get("Name") == config["artifact"]["runtimeBundleVolume"]
                and bundle[0].get("Driver") == "local"
                and bundle_labels.get("com.teamaibox.managed") == "true"
                and bundle_labels.get("com.teamaibox.purpose")
                == "protected-resident-runtime-bundle"
                and bundle_labels.get("com.teamaibox.component")
                == "drawing-flux2-klein-bf16"
                and bundle_labels.get("com.teamaibox.run-id") == run_id,
                "live protected BF16 runtime bundle ownership drifted")
        installed = REMOTE.run((
            "sudo", "sha256sum",
            bundle[0]["Mountpoint"] + "/flux2_bf16_protected_server.py",
        ), 30)
        require(installed.returncode == 0
                and "sha256:" + installed.stdout.split()[0] == file_digest(SERVER),
                "live protected BF16 runtime server drifted")
        bundle_files = REMOTE.run((
            "sudo", "find", bundle[0]["Mountpoint"], "-mindepth", "1", "-maxdepth", "1",
            "-printf", "%f|%y\n",
        ), 30)
        require(bundle_files.returncode == 0
                and bundle_files.stdout.splitlines()
                == ["flux2_bf16_protected_server.py|f"],
                "live protected BF16 runtime bundle contains unexpected files")
        auth_result = REMOTE.run((
            "sudo", "docker", "volume", "inspect", runtime_config["authenticationVolume"]
        ), 60)
        require(auth_result.returncode == 0,
                "live protected BF16 authentication volume is absent")
        auth = json.loads(auth_result.stdout)
        auth_labels = (auth[0].get("Labels") or {}) if len(auth) == 1 else {}
        require(len(auth) == 1 and auth[0].get("Driver") == "local"
                and auth_labels == {
                    "com.teamaibox.managed": "true",
                    "com.teamaibox.purpose": "protected-resident-worker-auth",
                    "com.teamaibox.component": "drawing-flux2-klein-bf16",
                    "com.teamaibox.run-id": run_id,
                }, "live protected BF16 authentication volume ownership drifted")
        token_path = auth[0]["Mountpoint"] + "/provider.token"
        token_stat = REMOTE.run((
            "sudo", "stat", "-c", "%u|%g|%a|%s|%F|%h", token_path
        ), 30)
        require(token_stat.returncode == 0
                and token_stat.stdout.strip().split("|")[:3] == ["65532", "65532", "400"]
                and 64 <= int(token_stat.stdout.strip().split("|")[3]) <= 256
                and token_stat.stdout.strip().split("|")[4:] == ["regular file", "1"],
                "live protected BF16 bearer permissions drifted")
        offload_result = REMOTE.run((
            "sudo", "docker", "volume", "inspect", runtime_config["offloadVolume"]
        ), 60)
        require(offload_result.returncode == 0,
                "live protected BF16 disk-offload volume is absent")
        offload = json.loads(offload_result.stdout)
        offload_labels = (offload[0].get("Labels") or {}) if len(offload) == 1 else {}
        require(len(offload) == 1 and offload[0].get("Driver") == "local"
                and offload_labels == {
                    "com.teamaibox.managed": "true",
                    "com.teamaibox.purpose": "protected-resident-disk-offload-cache",
                    "com.teamaibox.component": "drawing-flux2-klein-bf16",
                    "com.teamaibox.run-id": run_id,
                }, "live protected BF16 disk-offload volume ownership drifted")
        offload_stat = REMOTE.run((
            "sudo", "stat", "-c", "%u|%g|%a|%F", offload[0]["Mountpoint"]
        ), 30)
        require(offload_stat.returncode == 0
                and offload_stat.stdout.strip() == "65532|65532|700|directory",
                "live protected BF16 disk-offload root permissions drifted")
        staging_absent = REMOTE.run((
            "sh", "-ceu", 'test ! -e "$1" && test ! -e "$2"', "sh",
            value["probeStaging"]["path"], value["probeStaging"]["serverPath"],
        ), 30)
        require(staging_absent.returncode == 0,
                "protected BF16 run staging paths were not removed")
        live = snapshot(runtime_config["containerName"])
        validate_runtime_shape(live, config, run_id)
        require(live.get("containerId") == runtime.get("containerId"),
                "live protected BF16 container identity drifted")
        live_network = network_snapshot(runtime_config["networkName"])
        require(live_network == network,
                "live protected BF16 private network identity or membership drifted")
        require(route_facts(config) == network_preflight["routeAfterNetworkCreate"],
                "live protected BF16 management or Fabric route drifted")
        health = http_health(runtime_config["hostPort"])
        require(health.get("status") == "ready" and health.get("loaded") is True
                and health.get("warm") is True
                and health.get("ordinary_drain_allowed") is False
                and health.get("fatal_cuda") is False
                and health.get("wall_clock_timeout_seconds") == 600,
                "live protected BF16 warm health drifted")
        version = REMOTE.run((
            "sudo", "docker", "exec", runtime_config["containerName"], "python3", "-c",
            "import diffusers;print(diffusers.__version__)",
        ), 60)
        require(version.returncode == 0
                and version.stdout.strip() == config["engine"]["version"],
                "live protected BF16 Diffusers version drifted")
        staging = "/tmp/teamaibox-" + run_id + "-strict-validator-probe.py"
        try:
            copied = REMOTE.copy(PROBE, staging, 60)
            require(copied.returncode == 0, "protected BF16 strict probe staging failed")
            staged_digest = REMOTE.run(("sha256sum", staging), 30)
            require(staged_digest.returncode == 0
                    and "sha256:" + staged_digest.stdout.split()[0] == file_digest(PROBE),
                    "protected BF16 strict staged probe drifted")
            live_protocol, current_memory = run_probe_with_memory(
                config, staging, 1, token_path, runtime_config["containerName"],
                live["containerId"], mem_available(),
                # Strict revalidation happens after the protected Worker has
                # joined the resident office set.  Other exact, Docker-owned
                # resident CUDA PIDs are expected then; unknown/host PIDs
                # still fail closed in the sampler.
                require_exclusive=False,
                # A validation retry must not collide with the Worker's
                # bounded in-memory tombstones from an earlier probe.
                probe_owner_id=str(uuid.uuid4()),
            )
            require(
                live_protocol["generation"]["output"]["sha256"]
                == cycles[0]["protocol"]["generation"]["output"]["sha256"],
                "live protected BF16 deterministic image identity drifted",
            )
        finally:
            removed = REMOTE.run(("rm", "-f", staging), 30)
            absent = REMOTE.run(("sh", "-ceu", "test ! -e \"$1\"", "sh", staging), 30)
            require(removed.returncode == 0 and absent.returncode == 0,
                    "protected BF16 strict probe staging cleanup failed")
        validate_cycle_memory(current_memory, config, require_exclusive=False)
        require(current_memory["accountedAdmissionBytes"]
                <= runtime_config["protectedSlotAdmissionBytes"]
                and config["protectedOfficeSetBudget"]["preFluxAccountedBytes"]
                + current_memory["accountedAdmissionBytes"]
                <= config["protectedOfficeSetBudget"]["modelResidentCeilingBytes"]
                and current_memory["minimumHostMemoryAvailableBytes"]
                >= runtime_config["minimumCoreServiceReserveBytes"],
                "live protected BF16 resident memory envelope drifted")
        facts = registration_facts(
            config, document, fingerprint, package["digest"], registration, run_id
        )
        require(facts["exact"], "live protected BF16 profile or placement drifted")
    return {
        "valid": True, "runId": run_id, "evidenceDigest": recorded,
        "profileId": config["profileId"], "profileKey": config["profileKey"],
        "profilePackageArtifactDigest": package["digest"],
        "weightsArtifactDigest": config["artifact"]["weightsArtifactDigest"],
        "admissionBytes": expected_memory["admissionBytes"],
        "resultingAggregateAccountingBytes": resulting_aggregate,
        "modelResidentCeilingBytes": office_budget["modelResidentCeilingBytes"],
        "aggregateCoexistenceQualified": False,
        "task21_3Complete": False, "task21_4Complete": False,
    }


def source_tests() -> None:
    result = subprocess.run(
        ["python3", "-m", "unittest",
         "tests.test_flux2_klein_bf16_main_protected_profile_qualification"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        timeout=120, check=False,
    )
    require(result.returncode == 0, "protected BF16 focused tests no longer pass")


def validate(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and resolved.parent == EVIDENCE_ROOT.resolve(),
            "protected BF16 evidence path is unscoped")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(resolved.name == str(value.get("runId")) + ".json",
            "protected BF16 evidence filename drifted")
    result = validate_payload(value, revalidate=True)
    source_tests()
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
