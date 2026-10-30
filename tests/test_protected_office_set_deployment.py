from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import tools.run_protected_office_set_deployment as deployment
import tools.validate_protected_office_set_deployment as strict_validator


RUN_ID = "protected-office-set-deployment-20260905-a999"
STAMP = "2026-09-05T00:00:00Z"
AFTER_STAMP = "2026-09-05T00:01:00Z"


def runtime_identity(name: str, digit: str, *, agent: bool = False) -> dict:
    image = "sha256:" + digit * 64
    manifest_digit = "e" if digit != "e" else "d"
    value = {
        "containerName": name, "containerId": digit * 64, "imageId": image,
        "imageReference": f"registry.local/{name}@sha256:{manifest_digit * 64}",
        "configDigest": "sha256:" + ("f" if digit != "f" else "e") * 64,
        "state": "running",
    }
    if agent:
        value.update({
            "stateVolume": "teamaibox-node-agent-state",
            "journalPath": "/var/lib/teamaibox-node-agent/protected-set-journal.json",
            "managedEndpoint": "https://10.64.0.20:19443",
            "certificatePin": "sha256:" + "d" * 64,
        })
    return value


def restart_observation(identity: dict, started_at: str) -> dict:
    return {
        "containerName": identity["containerName"],
        "containerId": identity["containerId"],
        "imageId": identity["imageId"],
        "imageReference": identity["imageReference"],
        "configDigest": identity["configDigest"],
        "status": "running", "health": "healthy", "startedAt": started_at,
    }


def exclusive_target(plan: dict, profile: dict) -> dict:
    by_slot = {item["slot"]: item for item in plan["set"]["profiles"]}
    return {
        "targetKey": profile["targetKey"], "workerId": profile["workerId"],
        "modelProfileId": profile["modelProfileId"],
        "containerName": profile["containerName"], "placementClass": "protected-resident",
        "maintenanceGeneration": plan["set"]["maintenanceGeneration"],
        "stageOrder": profile["stageOrder"],
        "dependsOnWorkerIds": [by_slot[slot]["workerId"] for slot in profile["dependsOnSlots"]],
        "requiredImageId": profile["imageId"],
        "requiredImageDigest": profile["imageReference"],
        "requiredConfigDigest": profile["configurationDigest"],
        "requiredLabels": deepcopy(profile["requiredLabels"]),
        "dependentContainers": deepcopy(profile["dependentContainers"]),
    }


def complete_runtime_fixture() -> dict:
    plan = json.loads(deployment.PLAN.read_text(encoding="utf-8"))
    plan["readyForExecution"] = True
    plan["target"].update({
        "nodeId": "00000000-0000-4000-8000-000000000101", "nodeGeneration": 7,
        "nodeAgentContainer": "teamaibox-node-agent-main",
        "platformIdentity": runtime_identity(plan["target"]["platformContainer"], "1"),
        "nodeAgentIdentity": runtime_identity("teamaibox-node-agent-main", "2", agent=True),
    })
    plan["parents"]["legacyCanonicalDeployment"].update({
        "path": "evidence/validation/feature-deployments/legacy-canonical-20260905-a1.json",
        "runId": "legacy-canonical-20260905-a1", "evidenceDigest": "sha256:" + "7" * 64,
        "validator": "tools/validate_protected_office_set_deployment.py",
    })
    plan["profileSetManifest"]["sha256"] = deployment.file_sha(deployment.MANIFEST)
    plan["set"].update({"desiredStateRevision": 11, "maintenanceGeneration": 13})
    for index, profile in enumerate(plan["set"]["profiles"], start=1):
        worker = f"00000000-0000-4000-8000-{index:012d}"
        profile["workerId"] = worker
        profile["attemptId"] = f"00000000-0000-4000-9000-{index:012d}"
        profile["containerName"] = "teamaibox-worker-" + worker
        document = json.loads((deployment.ROOT / profile["profileConfiguration"]).read_text())
        profile["profileKey"] = profile["profileKey"] or document["profileKey"]
        profile["modelProfileId"] = profile["modelProfileId"] or document["profileId"]
        profile["imageId"] = profile["imageId"] or "sha256:" + "6" * 64
        profile["declaredResidentBytes"] = profile["declaredResidentBytes"] or 9_077_809_152
        manifest_digit = format((index + 7) % 16, "x")
        profile["imageReference"] = f"registry.local/office-{index}@sha256:{manifest_digit * 64}"
        profile["configurationDigest"] = deployment.file_sha(
            deployment.ROOT / profile["profileConfiguration"]
        )
        profile["requiredLabels"] = {
            "com.teamaibox.worker-id": worker,
            "com.teamaibox.model-profile-id": profile["modelProfileId"],
            "com.teamaibox.placement-class": "protected-resident",
        }
        profile["workerStart"] = {
            "nodeId": plan["target"]["nodeId"], "nodeGeneration": 7,
            "workerId": worker, "attemptId": profile["attemptId"],
            "modelProfileId": profile["modelProfileId"], "workloadKind": "compute-worker",
            "image": profile["imageReference"], "network": "compute-internal",
            "placementClass": "protected-resident", "maintenanceGeneration": 13,
            "configDigest": profile["configurationDigest"],
            "limits": {"memoryBytes": profile["declaredResidentBytes"], "cpuQuotaMicros": 100000,
                       "pidsLimit": 256, "ephemeralBytes": 67108864, "openFilesLimit": 4096},
            "security": {"runAsUid": 65532, "runAsGid": 65532, "readOnlyRoot": True,
                         "dropAllCapabilities": True, "noNewPrivileges": True,
                         "privileged": False, "hostPid": False, "hostIpc": False,
                         "hostNetwork": False, "dockerSocket": False},
        }
        if profile["slot"] == "drawing-flux2":
            profile["workerStart"]["limits"]["memoryBytes"] = 8_809_373_696
    for index, profile in enumerate(plan["set"]["profiles"], start=1):
        profile["priorState"] = {"mode": "exact-canonical", "target": exclusive_target(plan, profile)}
    plan["controller"].update({
        "adapterDigest": deployment.file_sha(deployment.ADAPTER),
        "driverSourcePath": "apps/platform-api/server/protected-office-set-deployment-runtime.mjs",
        "driverModulePath": "/opt/teamaibox/apps/platform-api/server/protected-office-set-deployment-runtime.mjs",
        "driverModuleDigest": deployment.file_sha(
            deployment.ROOT / "apps/platform-api/server/protected-office-set-deployment-runtime.mjs"),
        "inspectionAdapterDigest": deployment.file_sha(deployment.INSPECTION_ADAPTER),
        "inspectorSourcePath": "apps/platform-api/server/protected-office-set-deployment-runtime.mjs",
        "inspectorModulePath": "/opt/teamaibox/apps/platform-api/server/protected-office-set-deployment-runtime.mjs",
        "inspectorModuleDigest": deployment.file_sha(
            deployment.ROOT / "apps/platform-api/server/protected-office-set-deployment-runtime.mjs"),
        "productionTestPaths": list(deployment.REQUIRED_PRODUCTION_TESTS),
    })
    return plan


def migration_plan_document(plan: dict) -> dict:
    return {
        "schemaVersion": 1,
        "planId": "legacy-office-fixture-a1",
        "targets": [{
            "targetKey": profile["targetKey"],
            "desiredWorkerId": profile["workerId"],
            "legacyPreviousTarget": {
                "primary": {"containerName": "legacy-" + profile["slot"]},
                "dependentContainers": ([{"containerName": "legacy-ocr-provider"}]
                                        if profile["slot"] == "ocr-hunyuan" else []),
            },
        } for profile in plan["set"]["profiles"]],
    }


def parent_documents(plan: dict) -> tuple[dict, dict, dict, dict]:
    by_slot = {item["slot"]: item for item in plan["set"]["profiles"]}
    total = sum(item["declaredResidentBytes"] for item in by_slot.values())
    aggregate = {"profileCount": 6, "comparableProfileCount": 6, "accountingBytes": total,
                 "remainingModelTargetBytes": 0, "withinModelTarget": True,
                 "completeSetMeasured": True, "unresolvedSlots": []}
    profile_parent = {
        "runnerId": "teamaibox.protected-office-profile-set-qualification.v1",
        "runId": deployment.PROFILE_SET_PARENT["runId"],
        "evidenceDigest": deployment.PROFILE_SET_PARENT["evidenceDigest"],
        "manifest": {
            "path": deployment.MANIFEST.relative_to(deployment.ROOT).as_posix(),
            "manifestId": "teamaibox.protected-office-profile-set.v1",
            "fileSha256": deployment.PROFILE_SET_MANIFEST_SHA256,
        },
        "claimBoundary": {"manifestComplete": True, "task21_3Complete": True,
                          "protectedOfficeSetDeployed": False, "task21_4Complete": False},
        "aggregate": aggregate,
        "profiles": [{"slot": slot, "resolutionState": "qualified", "ready": True,
                      "protectedSuccessor": {"profileId": by_slot[slot]["modelProfileId"],
                                             "profileKey": by_slot[slot]["profileKey"]},
                      "observedMemory": {
                          "aggregateAccountingBytes": by_slot[slot]["declaredResidentBytes"]}}
                     for slot in deployment.QUALIFICATION_SLOTS],
    }
    migration_plan = migration_plan_document(plan)
    migration_plan_digest = deployment.sha(json.dumps(
        migration_plan, sort_keys=True, separators=(",", ":")).encode())
    canonical_profiles = []
    for index, profile in enumerate(plan["set"]["profiles"], start=1):
        companions = []
        if profile["slot"] == "ocr-hunyuan":
            companions = [{
                "containerName": profile["dependentContainers"][0]["containerName"],
                "parentWorkerId": profile["workerId"], "network": "compute-internal",
                "state": "running", "health": "healthy",
            }]
        canonical_profiles.append({
            "slot": profile["slot"], "workerId": profile["workerId"],
            "containerName": profile["containerName"],
            "containerId": format(index, "x") * 64,
            "state": "running", "health": "healthy", "network": "compute-internal",
            "imageReference": profile["imageReference"], "imageConfigId": profile["imageId"],
            "runtimeLimitsExact": True, "companions": companions,
        })
    legacy_parent = {
        "runnerId": "teamaibox.legacy-to-canonical-protected-office-set.v1",
        "runId": "legacy-to-canonical-protected-office-set-20260905-a999",
        "status": "passed", "evidenceDigest": "sha256:" + "7" * 64,
        "migrationPlan": {
            "path": "deploy/compute/legacy-fixture.json",
            "sha256": migration_plan_digest, "planId": migration_plan["planId"],
        },
        "claimBoundary": {"canonicalSixDeployed": True,
                          "durableCutoverRecoveryQualified": True,
                          "aggregateCoexistenceQualified": False,
                          "task21_4Complete": False},
        "finalSet": {"aggregateHealthy": True, "restartPersistenceObserved": False,
                     "profiles": canonical_profiles},
        "legacyCleanup": {"originalContainersRemaining": [],
                          "rollbackContainersRemaining": [],
                          "transitionHelpersRemaining": [], "exactOwnedCleanup": True},
    }
    manifest = json.loads(deployment.MANIFEST.read_text())
    for item in manifest["profiles"]:
        item["resolutionState"] = "qualified"
        item["knownGaps"] = []
    manifest["aggregate"] = aggregate
    manifest["claimBoundary"] = profile_parent["claimBoundary"]
    return profile_parent, legacy_parent, manifest, migration_plan


def fake_parent_loader(plan: dict):
    profile_parent, legacy_parent, _, migration_plan = parent_documents(plan)
    documents = {
        "teamaibox.protected-office-profile-set-qualification.v1": profile_parent,
        "teamaibox.legacy-to-canonical-protected-office-set.v1": legacy_parent,
        "teamaibox.protected-office-set-schema-deployment.v1": {
            "runnerId": "teamaibox.protected-office-set-schema-deployment.v1", "status": "passed"},
    }

    def load(reference, *, run_validators):
        result = {"binding": {key: reference.get(key) for key in
                              ("path", "runId", "runnerId", "evidenceDigest", "validator")},
                  "value": deepcopy(documents[reference["runnerId"]])}
        if reference["runnerId"] == "teamaibox.legacy-to-canonical-protected-office-set.v1":
            result["migrationPlanDocument"] = deepcopy(migration_plan)
        return result
    return load


def proof(plan: dict, action: str) -> dict:
    action_id, idempotency = deployment.action_identity(RUN_ID, action)
    scheduler_id = str(deployment.uuid.uuid5(deployment.uuid.NAMESPACE_URL, f"scheduler:{action}"))
    value = {
        "actionJournal": {"runId": RUN_ID, "action": action, "actionId": action_id,
                          "idempotencyKey": idempotency, "revision": 3, "state": "succeeded",
                          "resultDigest": "sha256:" + "a" * 64, "persistedAt": STAMP},
        "audit": {"correlationId": f"protected-office-{action}",
                  "eventIds": ["00000000-0000-4000-8000-000000000301"],
                  "eventDigests": ["sha256:" + "b" * 64], "chainVerified": True},
        "metricSnapshot": {"nodeId": plan["target"]["nodeId"], "nodeGeneration": 7,
                           "sequence": 41, "snapshotDigest": "sha256:" + "c" * 64,
                           "observedAt": STAMP, "freshnessSeconds": 1.25},
        "schedulerTransaction": {
            "transactionId": scheduler_id, "setId": "office.baseline", "revision": 21,
            "state": "succeeded", "desiredStateRevision": 22, "maintenanceGeneration": 13,
            "manifestDigest": plan["profileSetManifest"]["sha256"], "completedAt": STAMP,
            "admissionSnapshot": {
                "metricSnapshotDigest": "sha256:" + "c" * 64, "metricSnapshotSequence": 41,
                "modelTargetBytes": 64 * 1024 ** 3, "coreServiceReserveBytes": 32 * 1024 ** 3,
                "transientMarginBytes": 16 * 1024 ** 3,
                "activeReservations": [], "activeCastingSessionCount": 0,
                "activeMediaReservationCount": 0,
            },
        },
        "setState": {"setId": "office.baseline", "revision": 9,
                     "desiredStateRevision": 22, "observedStateRevision": 22,
                     "recoveryState": "healthy", "lastTransactionId": scheduler_id,
                     "healthyIdentityDigest": "sha256:" + "d" * 64},
        "nodeAgentTransaction": {
            "commandId": "00000000-0000-4000-8000-000000000302",
            "transactionId": "00000000-0000-4000-8000-000000000303",
            "setId": "office.baseline", "nodeGeneration": 7, "journalRevision": 44,
            "phase": "complete", "nextOperationIndex": 0,
            "planDigest": "sha256:" + "e" * 64, "responseDigest": "sha256:" + "f" * 64},
    }
    if action == "preflight":
        value.update({
            "bootstrapReadiness": {
                "schemaVersion": 1, "phase": "pre-cold-boot", "state": "uninitialized",
                "setId": plan["set"]["setId"], "transactionAbsent": True,
                "setStateAbsent": True, "nodeAgentCheckpointAbsent": True,
                "activeTransactionCount": 0, "recoveryRequiredCount": 0,
                "exactCanonicalProfilesVerified": True, "latestMetricSnapshot": True,
                "mutationCount": 0,
            },
            "schedulerTransaction": None, "setState": None, "nodeAgentTransaction": None,
        })
    if action == "final-inspect":
        value["schedulerTransaction"]["admissionMetricSnapshot"] = {
            **deepcopy(value["metricSnapshot"]), "admittedAt": STAMP, "freshnessSeconds": 0,
        }
    return value


def action_result(plan: dict, action: str) -> dict:
    durable = proof(plan, action)
    metric = durable["metricSnapshot"]
    profiles = []
    for index, profile in enumerate(plan["set"]["profiles"], start=1):
        current, peak = profile["declaredResidentBytes"] - 2, profile["declaredResidentBytes"] - 1
        profiles.append({
            "slot": profile["slot"], "workerId": profile["workerId"],
            "modelProfileId": profile["modelProfileId"],
            "imageDigest": profile["imageReference"].rsplit("@", 1)[1],
            "configurationDigest": profile["configurationDigest"],
            "placementClass": "protected-resident", "maintenanceGeneration": 13,
            "containerName": profile["containerName"],
            "containerId": format(index, "x") * 64,
            "startedAt": STAMP,
            "declaredResidentBytes": profile["declaredResidentBytes"],
            "state": "running", "healthy": True,
            "memory": {
                "cgroup": {"currentBytes": current, "peakBytes": peak,
                           "events": {"high": 0, "max": 0, "oom": 0,
                                      "oomKill": 0, "oomGroupKill": 0}},
                "process": {"residentBytes": current - 1},
                "engine": {"status": "unavailable", "reason": "engine metric unsupported",
                           "allocatedBytes": None, "modelBytes": None, "cacheBytes": None,
                           "certifiedEnvelopeBytes": None},
                "observedResidentBytes": current, "observedPeakBytes": peak,
                "accountingBytes": peak, "metricSnapshot": deepcopy(metric),
                "oomCounterDelta": {"high": 0, "max": 0, "oom": 0,
                                    "oomKill": 0, "oomGroupKill": 0},
                "runtime": {"oomKilled": False},
            },
        })
    observed = sum(item["memory"]["accountingBytes"] for item in profiles)
    value = {
        "node": {"nodeId": plan["target"]["nodeId"], "nodeGeneration": 7,
                 "nodeAddress": "10.64.0.20", "nodeRole": "main-box"},
        "productionComponents": list(deployment.PRODUCTION_COMPONENTS),
        "nodeAgentTransport": "mtls-hmac", "schedulerRepository": "postgres",
        "nodeAgentJournalPersisted": True, "proof": durable, "profiles": profiles,
        "aggregateMemory": {
            "qualifiedModelAccountingBytes": 64 * 1024 ** 3,
            "observedModelAccountingBytes": observed, "modelTargetBytes": 64 * 1024 ** 3,
            "coreServiceReserveBytes": 32 * 1024 ** 3, "transientMarginBytes": 16 * 1024 ** 3,
            "ordinaryPerProfile96GiBGateApplied": False,
            "mediaReservationIncludedInAdmission": False,
            "metricSnapshot": deepcopy(metric), "hostTotalBytes": 128 * 1024 ** 3,
            "hostAvailableBytes": 16 * 1024 ** 3,
            "oomCounterDelta": {"high": 0, "max": 0, "oom": 0,
                                "oomKill": 0, "oomGroupKill": 0},
            "runtimeOomKilledCount": 0, "admitted": True,
        },
        "noCastObservation": {
            "state": "inactive", "activeCastingSessionCount": 0,
            "activeMediaReservationCount": 0,
            "mediaReservationIncludedInAdmission": False,
            "castingSessionRepositoryRevision": 5,
            "realtimeReservationRepositoryRevision": 8,
            "observedAt": STAMP,
        },
        "coreServicesHealthy": True, "oomEvents": [],
    }
    slots = list(deployment.STAGE_SLOTS)
    if action == "preflight":
        value.update({
            "priorProfiles": [{"slot": item["slot"], "desiredWorkerId": item["workerId"],
                               "canonicalContainerName": item["containerName"],
                               "canonicalState": "exact-canonical", "priorIdentityVerified": True,
                               "canonicalPreparationParentVerified": True}
                              for item in plan["set"]["profiles"]],
            "mutationCount": 0, "parentsValidated": True,
            "adapterDigest": plan["controller"]["adapterDigest"],
            "driverDigest": plan["controller"]["driverModuleDigest"]})
    elif action == "cold-boot":
        value["transition"] = {
            "operation": "protected-set.transition", "outcome": "succeeded",
            "schedulerTransactionId": durable["schedulerTransaction"]["transactionId"],
            "nodeAgentTransactionId": durable["nodeAgentTransaction"]["transactionId"],
            "stagedOrder": slots, "prewarmedSlots": slots,
            "journalPersisted": True, "restartPolicyPersisted": True}
    elif action == "concurrent-office":
        by_slot = {item["slot"]: item for item in plan["set"]["profiles"]}
        value.update({
            "capabilities": [{
                "capabilityId": capability, "status": "passed", "protocol": "real",
                "route": "/v1/" + capability.replace(".", "/"),
                "executionKind": deployment.CAPABILITY_EXECUTION_KINDS[capability],
                "executionId": f"00000000-0000-4000-a000-{index:012d}",
                "jobId": (f"00000000-0000-4000-a000-{index:012d}"
                          if deployment.CAPABILITY_EXECUTION_KINDS[capability] == "compute-job"
                          else None),
                "attemptId": (f"00000000-0000-4000-b000-{index:012d}"
                              if deployment.CAPABILITY_EXECUTION_KINDS[capability] == "compute-job"
                              else None),
                "workerId": by_slot[deployment.CAPABILITY_SLOTS[capability]]["workerId"],
                "modelProfileId": by_slot[deployment.CAPABILITY_SLOTS[capability]]["modelProfileId"],
                "startedAt": STAMP, "completedAt": STAMP,
                "requestDigest": "sha256:" + "1" * 64, "resultDigest": "sha256:" + "2" * 64}
                for index, capability in enumerate(deployment.CAPABILITIES, start=1)],
            "concurrencyWindows": [{"windowId": "00000000-0000-4000-8000-000000000401",
                                    "capabilityIds": ["assistant.answer", "translation"],
                                    "startedAt": STAMP, "completedAt": STAMP}],
            "maximumConcurrentCapabilities": 2,
            "ordinaryConflictingRequest": {"outcome": "queued", "protectedDrainCount": 0},
            "coreServiceInterruptionCount": 0})
    elif action == "bounded-maintenance":
        value.update({
            "maintenance": {"operation": "protected-set.maintenance",
                            "operationId": "00000000-0000-4000-8000-000000000402",
                            "outcome": "succeeded", "stoppedOrder": list(reversed(slots)),
                            "restoredOrder": slots, "exactIdentityRestored": True,
                            "degradationAnnounced": True, "newDependentWorkBlocked": True,
                            "drainCompleted": True, "warmProbesPassed": slots,
                            "capabilitiesReopened": True,
                            "signature": {"verified": True, "algorithm": "Ed25519",
                                          "keyId": "ops-main-1",
                                          "payloadDigest": "sha256:" + "3" * 64,
                                          "issuedAt": STAMP,
                                          "expiresAt": "2026-09-05T00:05:00Z",
                                          "workerIds": sorted(item["workerId"]
                                                        for item in plan["set"]["profiles"])}},
            "durationSeconds": 12.5})
    elif action == "restart-verify":
        platform_before = restart_observation(plan["target"]["platformIdentity"], STAMP)
        platform_after = restart_observation(plan["target"]["platformIdentity"], AFTER_STAMP)
        agent_before = restart_observation(plan["target"]["nodeAgentIdentity"], STAMP)
        agent_after = restart_observation(plan["target"]["nodeAgentIdentity"], AFTER_STAMP)
        action_id, idempotency_key = deployment.action_identity(RUN_ID, action)
        value["restart"] = {
            "platformOperationId": "00000000-0000-4000-8000-000000000403",
            "nodeAgentOperationId": "00000000-0000-4000-8000-000000000404",
            "lifecycleCommandId": "00000000-0000-4000-8000-000000000406",
            "protocol": deployment.RESTART_PROTOCOL,
            "actionId": action_id, "idempotencyKey": idempotency_key,
            "lifecycleCommandType": deployment.RESTART_COMMAND_TYPE,
            "controllerTransport": "mtls-hmac",
            "dockerMutationAuthority": "node-agent-only",
            "restartTargets": list(deployment.RESTART_TARGETS),
            "operationOrder": deployment.REQUIRED_RESTART_LIFECYCLE_INTERFACE[
                "operationOrder"],
            "lifecycleRequestDigest": "sha256:" + "4" * 64,
            "lifecycleJournalFsyncedBeforeMutation": True,
            "platformBefore": platform_before, "platformAfter": platform_after,
            "nodeAgentBefore": agent_before, "nodeAgentAfter": agent_after,
            "journalRevisionBefore": 10, "journalRevisionAfter": 11,
            "lifecycleJournalRevisionBefore": 7, "lifecycleJournalRevisionAfter": 9,
            "journalRecovered": True, "lifecycleJournalRecovered": True,
            "desiredStateRecovered": True, "exactIdentityRetained": True,
            "boundedDisconnectTolerated": True,
            "activeCastingSessionsBefore": 0, "activeCastingSessionsAfter": 0,
            "activeMediaReservationsBefore": 0, "activeMediaReservationsAfter": 0}
        value["externalRestartOrchestration"] = {
            "schemaVersion": 1, "protocol": deployment.RESTART_PROTOCOL,
            "mutationAuthority": "node-agent-only",
            "initialAttemptOutcome": "bounded-disconnect",
            "sameActionReplay": {"actionId": action_id,
                                 "idempotencyKey": idempotency_key,
                                 "invocationCount": 2},
            "observations": {
                "platformBefore": platform_before, "platformAfter": platform_after,
                "nodeAgentBefore": agent_before, "nodeAgentAfter": agent_after,
            },
            "verifiedAt": AFTER_STAMP,
        }
    elif action == "mid-sequence-failure":
        scheduler = durable["schedulerTransaction"]
        value["failureInjection"] = {
            "slot": "drawing-flux2", "failedAfterStageOrder": 5,
            "observedFailureCode": "protected_set_transition_stage_failed",
            "automaticExactRollback": True, "partialSuccessRetained": False,
            "previousIdentityRestored": True, "oomKilled": False,
            "failedTransaction": {"transactionId": "00000000-0000-4000-8000-000000000405",
                                  "state": "rolled-back", "desiredStateRevision": 21,
                                  "journalRevision": 43, "journalPhase": "recovered"},
            "reconcileTransaction": {"transactionId": scheduler["transactionId"],
                                     "state": "succeeded", "desiredStateRevision": 22,
                                     "journalRevision": 44},
            "finalState": {"recoveryState": "healthy", "exactDesiredState": True,
                           "activeTransactionCount": 0}}
    else:
        value["finalState"] = {"healthy": True, "activeTransactionCount": 0,
                               "recoveryRequiredCount": 0, "exactDesiredState": True}
        if action == "final-inspect":
            value.update({"readOnly": True, "mutationCount": 0,
                          "inspectionSources": list(deployment.INSPECTION_SOURCES)})
    return value


class RestartRemote:
    def __init__(self, plan: dict, *, initial_returncode: int = 137):
        self.plan = plan
        self.initial_returncode = initial_returncode
        self.restarted = False
        self.action_invocations = 0
        self.requests = []
        self.commands = []

    @staticmethod
    def result(returncode: int = 0, stdout: str = "", stderr: str = ""):
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)

    def _identity(self, name: str) -> dict:
        for key in ("platformIdentity", "nodeAgentIdentity"):
            identity = self.plan["target"][key]
            if identity["containerName"] == name:
                return identity
        raise AssertionError("unknown runtime identity")

    def _adapter_response(self, request: dict) -> str:
        result = action_result(self.plan, "restart-verify")
        result.pop("externalRestartOrchestration")
        return json.dumps({
            "schemaVersion": 1, "protocol": deployment.PROTOCOL,
            "runId": request["runId"], "action": request["action"],
            "actionId": request["actionId"], "idempotencyKey": request["idempotencyKey"],
            "nonce": request["nonce"], "status": "passed", "result": result,
        })

    def run(self, command, timeout=30):
        self.commands.append(tuple(command))
        if tuple(command[:5]) == ("sudo", "-n", "docker", "inspect", "--format"):
            identity = self._identity(command[-1])
            if "StartedAt" in command[5]:
                started = AFTER_STAMP if self.restarted else STAMP
                return self.result(stdout="|".join((
                    identity["containerId"], identity["imageId"], identity["imageReference"],
                    identity["configDigest"], "running", started, "healthy",
                )) + "\n")
            return self.result(stdout="|".join((
                identity["containerId"], identity["imageId"], identity["imageReference"],
                identity["configDigest"], "running",
            )) + "\n")
        if command[:4] == ("sudo", "-n", "docker", "exec") and "sha256sum" in command:
            return self.result(stdout=self.plan["controller"]["adapterDigest"][7:] + "  adapter\n")
        encoded = next(item.split("=", 1)[1] for item in command
                       if item.startswith("TEAMAIBOX_PROTECTED_OFFICE_SET_REQUEST_B64="))
        request = json.loads(deployment.base64.b64decode(encoded).decode())
        self.requests.append(request)
        self.action_invocations += 1
        if self.action_invocations == 1:
            if self.initial_returncode != 0:
                self.restarted = self.initial_returncode in deployment.RESTART_DISCONNECT_CODES
                return self.result(returncode=self.initial_returncode, stderr="connection closed")
            return self.result(stdout=self._adapter_response(request) + "\n")
        return self.result(stdout=self._adapter_response(request) + "\n")


class ProtectedOfficeSetDeploymentTests(unittest.TestCase):
    def test_identity_projection_uses_oci_manifest_not_config_image_id(self):
        plan = complete_runtime_fixture()
        projected = deployment._identity_projection(plan)
        for profile, identity in zip(plan["set"]["profiles"], projected):
            manifest = profile["imageReference"].rsplit("@", 1)[1]
            self.assertEqual(identity["imageDigest"], manifest)
            self.assertNotEqual(identity["imageDigest"], profile["imageId"])

    def test_checked_in_plan_is_desired_ready_but_final_deployment_fail_closed(self) -> None:
        plan = json.loads(deployment.PLAN.read_text(encoding="utf-8"))
        blockers = deployment.unresolved_fields(plan)
        self.assertTrue(plan["preMigrationDesiredReady"])
        self.assertFalse(plan["readyForExecution"])
        self.assertIn("readyForExecution", blockers)
        self.assertNotIn("parents.profileSetQualification.path", blockers)
        self.assertIn("parents.legacyCanonicalDeployment.path", blockers)
        self.assertNotIn("target.nodeId", blockers)
        self.assertNotIn("target.nodeGeneration", blockers)
        self.assertNotIn("target.nodeAgentContainer", blockers)
        self.assertRegex(plan["target"]["nodeId"], r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        self.assertEqual(plan["target"]["nodeGeneration"], 1)
        self.assertRegex(
            plan["target"]["nodeAgentContainer"],
            r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$",
        )
        self.assertFalse(any(item.startswith("parents.mediaRuntimeDeployment") for item in blockers))
        self.assertNotIn("mediaRuntimeDeployment", plan["parents"])
        self.assertEqual(plan["baselineMediaState"], {
            "requiredState": "inactive", "activeCastingSessionCount": 0,
            "activeMediaReservationCount": 0,
            "mediaReservationIncludedInAdmission": False,
            "mustRemainInactiveThroughScenarios": True,
            "castingCoexistenceOwnedByTask": "22.9",
        })
        self.assertNotIn("set.profiles[drawing-flux2].modelProfileId", blockers)
        self.assertNotIn("set.profiles[drawing-flux2].workerId", blockers)
        self.assertNotIn("set.profiles[drawing-flux2].imageReference", blockers)
        self.assertIn("set.profiles[drawing-flux2].priorState", blockers)
        self.assertNotIn("controller.adapterDigest", blockers)
        self.assertNotIn("controller.inspectionAdapterDigest", blockers)
        self.assertEqual(plan["controller"]["adapterDigest"], deployment.file_sha(deployment.ADAPTER))
        self.assertEqual(
            plan["controller"]["inspectionAdapterDigest"],
            deployment.file_sha(deployment.INSPECTION_ADAPTER),
        )
        self.assertNotIn("controller.driverModuleDigest", blockers)
        runtime_source = (
            deployment.ROOT
            / "apps/platform-api/server/protected-office-set-deployment-runtime.mjs"
        )
        self.assertEqual(
            plan["controller"]["driverSourcePath"],
            runtime_source.relative_to(deployment.ROOT).as_posix(),
        )
        self.assertEqual(
            plan["controller"]["inspectorSourcePath"],
            runtime_source.relative_to(deployment.ROOT).as_posix(),
        )
        # Planning and installed bundles are immutable snapshots. API-only
        # maintenance has since changed the driver; never rewrite the v5
        # snapshot just to make it appear current. Single-appliance source is
        # a new successor and must not reuse this historical deployment claim.
        for key in ("driverModuleDigest", "inspectorModuleDigest"):
            self.assertRegex(plan["controller"][key], r"^sha256:[0-9a-f]{64}$")
        current = json.loads((deployment.ROOT /
            "evidence/validation/feature-deployments/"
            "office-core-budget-runtime-deploy-20261009-a2.json").read_text())
        self.assertEqual(current["status"], "passed")
        driver = runtime_source.relative_to(deployment.ROOT).as_posix()
        self.assertNotEqual("sha256:" + current["sources"][driver], deployment.file_sha(runtime_source))
        self.assertFalse(current["coldBootAccepted"])
        self.assertFalse(current["fullOfficeRecoveryAccepted"])
        self.assertTrue(
            set(deployment.REQUIRED_PRODUCTION_TESTS).issubset(
                set(plan["controller"]["productionTestPaths"])
            )
        )
        with self.assertRaisesRegex(deployment.DeploymentError, "plan is unresolved"):
            deployment.validate_plan(plan, run_parent_validators=False)

    def test_unresolved_plan_never_creates_launch_or_run_evidence(self) -> None:
        plan = json.loads(deployment.PLAN.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(dir=deployment.ROOT / "tmp") as directory, \
                mock.patch.object(deployment, "EVIDENCE_ROOT", Path(directory)):
            with self.assertRaisesRegex(deployment.DeploymentError, "plan is unresolved"):
                deployment.execute(RUN_ID, plan_document=plan)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_completed_static_plan_binds_exact_six_and_64_gib(self) -> None:
        plan = complete_runtime_fixture()
        profile_parent, _, manifest, _ = parent_documents(plan)
        result = deployment.validate_plan(
            plan, run_parent_validators=False, parent_loader=fake_parent_loader(plan),
            manifest_document=manifest)
        self.assertEqual(result["profileCount"], 6)
        self.assertEqual(result["aggregateAccountingBytes"], 64 * 1024 ** 3)
        self.assertEqual(profile_parent["profiles"][-2]["slot"], "drawing-flux2")
        self.assertEqual({item["declaredResidentBytes"] for item in plan["set"]["profiles"]
                          if item["slot"] == "drawing-flux2"}, {9_077_809_152})
        flux = next(item for item in plan["set"]["profiles"] if item["slot"] == "drawing-flux2")
        self.assertEqual(flux["workerStart"]["limits"]["memoryBytes"], 8_809_373_696)

    def test_every_exact_action_contract_accepts_the_production_shape(self) -> None:
        plan = complete_runtime_fixture()
        for action in deployment.ACTIONS:
            with self.subTest(action=action):
                observed = action_result(plan, action)
                self.assertEqual(
                    deployment.validate_action_result(action, observed, plan, run_id=RUN_ID), observed)

    def test_maintenance_signed_scope_is_canonical_not_restore_order(self) -> None:
        plan = complete_runtime_fixture()
        value = action_result(plan, "bounded-maintenance")
        canonical = sorted(item["workerId"] for item in plan["set"]["profiles"])
        self.assertEqual(value["maintenance"]["signature"]["workerIds"], canonical)
        self.assertEqual(deployment.validate_action_result(
            "bounded-maintenance", value, plan, run_id=RUN_ID), value)
        for scope in (canonical[:-1], canonical + [canonical[0]],
                      list(reversed(canonical)), ["not-a-worker-id"] + canonical[1:]):
            with self.subTest(scope=scope):
                drifted = deepcopy(value)
                drifted["maintenance"]["signature"]["workerIds"] = scope
                with self.assertRaisesRegex(deployment.DeploymentError, "signed maintenance"):
                    deployment.validate_action_result(
                        "bounded-maintenance", drifted, plan, run_id=RUN_ID)
        for key in ("stoppedOrder", "restoredOrder", "warmProbesPassed"):
            with self.subTest(key=key):
                drifted = deepcopy(value)
                drifted["maintenance"][key].reverse()
                with self.assertRaisesRegex(deployment.DeploymentError, "signed maintenance"):
                    deployment.validate_action_result(
                        "bounded-maintenance", drifted, plan, run_id=RUN_ID)
        value["durationSeconds"] = 901
        with self.assertRaisesRegex(deployment.DeploymentError, "signed maintenance"):
            deployment.validate_action_result("bounded-maintenance", value, plan, run_id=RUN_ID)

    def test_post_migration_aggregate_proves_resident_continuity_and_keeps_casting_out(self) -> None:
        plan = complete_runtime_fixture()
        _, _, manifest, _ = parent_documents(plan)
        bindings = deployment.validate_plan(
            plan, run_parent_validators=False, parent_loader=fake_parent_loader(plan),
            manifest_document=manifest)
        actions = {action: action_result(plan, action) for action in deployment.ACTIONS}
        aggregate = deployment.aggregate_qualification(
            plan, actions, bindings["canonicalMigration"])
        self.assertEqual(aggregate["canonicalProfileCount"], 6)
        self.assertEqual(
            aggregate["ordinaryResidencyContinuity"]["repeatModelLoadCount"], 0)
        self.assertTrue(
            aggregate["ordinaryResidencyContinuity"]["sameContainerAndStartTime"])
        self.assertEqual(aggregate["computeNetwork"], {
            "name": "compute-internal", "allSixWorkersAttached": True,
        })
        self.assertEqual(aggregate["servingTopology"]["ocr"]["mode"],
                         "canonical-companion")
        self.assertEqual(aggregate["servingTopology"]["flux"]["mode"],
                         "direct-worker")
        self.assertEqual(len(aggregate["legacyCleanup"]["removedContainerNames"]), 7)
        self.assertFalse(aggregate["claimBoundary"]["task21_5Complete"])
        self.assertFalse(aggregate["claimBoundary"]["task22_9Complete"])
        self.assertFalse(aggregate["castingBoundary"]["castingCoexistenceQualified"])

    def test_post_migration_aggregate_rejects_an_ordinary_request_reload(self) -> None:
        plan = complete_runtime_fixture()
        _, _, manifest, _ = parent_documents(plan)
        bindings = deployment.validate_plan(
            plan, run_parent_validators=False, parent_loader=fake_parent_loader(plan),
            manifest_document=manifest)
        actions = {action: action_result(plan, action) for action in deployment.ACTIONS}
        actions["concurrent-office"]["profiles"][0]["startedAt"] = AFTER_STAMP
        with self.assertRaisesRegex(deployment.DeploymentError,
                                    "reloaded during ordinary office traffic"):
            deployment.aggregate_qualification(
                plan, actions, bindings["canonicalMigration"])

    def test_post_migration_parent_rejects_legacy_residue_and_network_drift(self) -> None:
        plan = complete_runtime_fixture()
        _, _, manifest, _ = parent_documents(plan)
        parent_loader = fake_parent_loader(plan)

        def residue_loader(reference, *, run_validators):
            result = parent_loader(reference, run_validators=run_validators)
            if reference["runnerId"] == "teamaibox.legacy-to-canonical-protected-office-set.v1":
                result["value"]["legacyCleanup"]["originalContainersRemaining"] = [
                    "legacy-assistant-qwen38"]
            return result

        with self.assertRaisesRegex(deployment.DeploymentError, "cleanup is incomplete"):
            deployment.validate_plan(
                plan, run_parent_validators=False, parent_loader=residue_loader,
                manifest_document=manifest)

        def network_loader(reference, *, run_validators):
            result = parent_loader(reference, run_validators=run_validators)
            if reference["runnerId"] == "teamaibox.legacy-to-canonical-protected-office-set.v1":
                result["value"]["finalSet"]["profiles"][0]["network"] = "bridge"
            return result

        with self.assertRaisesRegex(deployment.DeploymentError,
                                    "canonical migration runtime drifted"):
            deployment.validate_plan(
                plan, run_parent_validators=False, parent_loader=network_loader,
                manifest_document=manifest)

    def test_action_requires_real_container_instance_identity(self) -> None:
        plan = complete_runtime_fixture()
        observed = action_result(plan, "concurrent-office")
        observed["profiles"][0].pop("containerId")
        with self.assertRaisesRegex(deployment.DeploymentError, "exact profile identity"):
            deployment.validate_action_result(
                "concurrent-office", observed, plan, run_id=RUN_ID)

    def test_strict_validator_recomputes_the_aggregate_and_rejects_claim_tampering(self) -> None:
        plan = complete_runtime_fixture()
        _, _, manifest, _ = parent_documents(plan)
        expected = deployment.validate_plan(
            plan, run_parent_validators=False, parent_loader=fake_parent_loader(plan),
            manifest_document=manifest)
        actions = {action: action_result(plan, action) for action in deployment.ACTIONS}
        aggregate = deployment.aggregate_qualification(
            plan, actions, expected["canonicalMigration"])
        tests = {
            name: {"passed": True, "outputDigest": "sha256:" + digit * 64,
                   "outputRetained": False}
            for name, digit in (("node", "1"), ("python", "2"), ("production", "3"))
        }
        tests["production"]["testPaths"] = plan["controller"]["productionTestPaths"]
        claim = {
            "profileSetQualified": True, "protectedOfficeSetDeployed": True,
            "aggregateCoexistenceQualified": True, "noCastBaselineQualified": True,
            "task21_3Complete": True, "task21_4Complete": True,
            "drawingIntentRoutingQualified": False, "task21_5Complete": False,
            "castingCoexistenceQualified": False, "task22_9Complete": False,
        }
        with tempfile.TemporaryDirectory(dir=deployment.ROOT / "tmp") as directory:
            temporary = Path(directory)
            plan_path = temporary / "plan.json"
            manifest_path = temporary / "manifest.json"
            plan_path.write_text(json.dumps(plan), encoding="utf-8")
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            value = {
                "schemaVersion": 1, "runnerId": deployment.RUNNER_ID, "runId": RUN_ID,
                "status": "passed", "startedAt": STAMP, "completedAt": AFTER_STAMP,
                "target": {"nodeAddress": deployment.TARGET_ADDRESS, "nodeRole": "main-box",
                           "nodeId": plan["target"]["nodeId"], "nodeGeneration": 7},
                "plan": {"path": plan_path.relative_to(deployment.ROOT).as_posix(),
                         "fileSha256": deployment.file_sha(plan_path)},
                "manifest": {"path": manifest_path.relative_to(deployment.ROOT).as_posix(),
                             "fileSha256": deployment.file_sha(manifest_path)},
                "parents": expected["parents"], "budget": deployment.BUDGET,
                "canonicalMigration": expected["canonicalMigration"], "launch": {},
                "aggregateAccountingBytes": expected["aggregateAccountingBytes"],
                "profileCount": 6, "actionOrder": list(deployment.ACTIONS),
                "actions": actions, "recovery": None,
                "aggregateQualification": aggregate, "sourceTests": tests, "sources": [],
                "privacy": {"credentialsRetained": False, "userContentRetained": False,
                            "protocolBodiesRetained": False, "adapterOutputRetained": False},
                "claimBoundary": claim, "failure": None,
            }
            value["evidenceDigest"] = deployment.canonical_digest(value)
            patches = (
                mock.patch.object(strict_validator, "PLAN", plan_path),
                mock.patch.object(strict_validator, "MANIFEST", manifest_path),
                mock.patch.object(strict_validator, "validate_plan", return_value=expected),
                mock.patch.object(strict_validator, "source_binding", return_value=[]),
                mock.patch.object(strict_validator, "_validate_launch", return_value=None),
            )
            with patches[0], patches[1], patches[2], patches[3], patches[4]:
                result = strict_validator.validate_payload(
                    deepcopy(value), revalidate_plan=False)
                self.assertTrue(result["task21_4Complete"])
                self.assertFalse(result["task22_9Complete"])
                tampered = deepcopy(value)
                tampered["aggregateQualification"]["ordinaryResidencyContinuity"][
                    "repeatModelLoadCount"] = 1
                tampered.pop("evidenceDigest")
                tampered["evidenceDigest"] = deployment.canonical_digest(tampered)
                with self.assertRaisesRegex(ValueError, "aggregate coexistence"):
                    strict_validator.validate_payload(tampered, revalidate_plan=False)

    def test_restart_requires_external_started_at_observation_and_exact_replay(self) -> None:
        plan = complete_runtime_fixture()
        remote = RestartRemote(plan)
        result = deployment.PlatformAdapter(
            plan, remote=remote, sleeper=lambda _: None,
        ).invoke("restart-verify", RUN_ID)
        external = result["externalRestartOrchestration"]
        self.assertEqual(external["initialAttemptOutcome"], "bounded-disconnect")
        self.assertEqual(remote.action_invocations, 2)
        self.assertEqual(
            [(item["actionId"], item["idempotencyKey"]) for item in remote.requests],
            [deployment.action_identity(RUN_ID, "restart-verify")] * 2,
        )
        self.assertNotEqual(remote.requests[0]["nonce"], remote.requests[1]["nonce"])
        mutation_words = {"stop", "start", "restart", "rm", "create"}
        self.assertFalse(any(mutation_words.intersection(command) for command in remote.commands))

    def test_restart_rejects_a_single_platform_success_claim(self) -> None:
        plan = complete_runtime_fixture()
        remote = RestartRemote(plan, initial_returncode=0)
        with self.assertRaisesRegex(deployment.DeploymentError, "self-claimed"):
            deployment.PlatformAdapter(plan, remote=remote).invoke("restart-verify", RUN_ID)
        self.assertEqual(remote.action_invocations, 1)

    def test_restart_compares_docker_nanos_at_platform_millisecond_precision(self) -> None:
        plan = complete_runtime_fixture()
        observed = action_result(plan, "restart-verify")
        external = observed["externalRestartOrchestration"]["observations"]
        for key in ("platformBefore", "nodeAgentBefore", "platformAfter", "nodeAgentAfter"):
            stamp = observed["restart"][key]["startedAt"].removesuffix("Z")
            observed["restart"][key] = dict(observed["restart"][key], startedAt=stamp + ".123Z")
            external[key] = dict(external[key], startedAt=stamp + ".123802231Z")
        observed["externalRestartOrchestration"]["verifiedAt"] = external["platformAfter"]["startedAt"]
        result = deployment.validate_action_result("restart-verify", observed, plan, run_id=RUN_ID)
        self.assertEqual(result["externalRestartOrchestration"], observed["externalRestartOrchestration"])
        changed = deepcopy(observed)
        changed["restart"]["nodeAgentAfter"]["startedAt"] = \
            changed["restart"]["nodeAgentAfter"]["startedAt"].replace(".123Z", ".124Z")
        with self.assertRaisesRegex(deployment.DeploymentError, "restart persistence"):
            deployment.validate_action_result("restart-verify", changed, plan, run_id=RUN_ID)
        changed = deepcopy(observed)
        changed["restart"]["nodeAgentAfter"]["containerId"] = "f" * 64
        with self.assertRaisesRegex(deployment.DeploymentError, "restart persistence"):
            deployment.validate_action_result("restart-verify", changed, plan, run_id=RUN_ID)

    def test_restart_rejects_an_ordinary_adapter_failure_without_waiting(self) -> None:
        plan = complete_runtime_fixture()
        remote = RestartRemote(plan, initial_returncode=1)
        with self.assertRaisesRegex(deployment.DeploymentError, "before a bounded restart disconnect"):
            deployment.PlatformAdapter(plan, remote=remote).invoke("restart-verify", RUN_ID)
        self.assertEqual(remote.action_invocations, 1)

    def test_restart_evidence_rejects_a_nonadvancing_started_at(self) -> None:
        plan = complete_runtime_fixture()
        observed = action_result(plan, "restart-verify")
        observed["externalRestartOrchestration"]["observations"]["nodeAgentAfter"][
            "startedAt"] = STAMP
        observed["restart"]["nodeAgentAfter"]["startedAt"] = STAMP
        with self.assertRaisesRegex(deployment.DeploymentError, "StartedAt did not advance"):
            deployment.validate_action_result("restart-verify", observed, plan, run_id=RUN_ID)

    def test_missing_restart_api_contract_is_node_agent_only_and_fail_closed(self) -> None:
        contract = deployment.REQUIRED_RESTART_LIFECYCLE_INTERFACE
        self.assertEqual(contract["commandType"], "appliance.runtime.restart")
        self.assertEqual(contract["fixedTargets"], ["platform-api", "node-agent"])
        self.assertEqual(contract["journal"]["durability"], "fsync-before-first-mutation")
        self.assertEqual(contract["authority"], {
            "dockerMutation": "node-agent-only", "policyBoundTargets": True,
            "arbitraryContainerNames": False, "arbitraryDockerOperations": False,
        })

    def test_mixed_metric_snapshot_and_disguised_engine_zero_are_rejected(self) -> None:
        plan = complete_runtime_fixture()
        observed = action_result(plan, "final-inspect")
        observed["profiles"][0]["memory"]["metricSnapshot"]["sequence"] = 42
        with self.assertRaisesRegex(deployment.DeploymentError, "real bounded observation"):
            deployment.validate_action_result("final-inspect", observed, plan, run_id=RUN_ID)
        observed = action_result(plan, "final-inspect")
        observed["profiles"][0]["memory"]["engine"] = {
            "status": "unavailable", "reason": "", "allocatedBytes": 0,
            "modelBytes": 0, "cacheBytes": 0, "certifiedEnvelopeBytes": 0}
        with self.assertRaisesRegex(deployment.DeploymentError, "disguised"):
            deployment.validate_action_result("final-inspect", observed, plan, run_id=RUN_ID)

    def test_final_inspection_separates_fresh_current_and_exact_historical_admission(self) -> None:
        plan = complete_runtime_fixture()
        observed = action_result(plan, "final-inspect")
        current = observed["proof"]["metricSnapshot"]
        current.update(sequence=42, observedAt=AFTER_STAMP, freshnessSeconds=1,
                       snapshotDigest="sha256:" + "a" * 64)
        observed["aggregateMemory"]["metricSnapshot"] = deepcopy(current)
        for profile in observed["profiles"]:
            profile["memory"]["metricSnapshot"] = deepcopy(current)
        deployment.validate_action_result("final-inspect", observed, plan, run_id=RUN_ID)
        for field, invalid in (("sequence", 43), ("nodeGeneration", 999),
                               ("admittedAt", AFTER_STAMP), ("freshnessSeconds", 31),
                               ("snapshotDigest", "sha256:" + "b" * 64)):
            tampered = deepcopy(observed)
            tampered["proof"]["schedulerTransaction"]["admissionMetricSnapshot"][field] = invalid
            with self.subTest(field=field), self.assertRaises(deployment.DeploymentError):
                deployment.validate_action_result("final-inspect", tampered, plan, run_id=RUN_ID)

    def test_long_maintenance_keeps_exact_admission_separate_from_current_metric(self) -> None:
        plan = complete_runtime_fixture()
        admission = action_result(plan, "final-inspect")["proof"]["schedulerTransaction"]["admissionMetricSnapshot"]
        for action in ("bounded-maintenance", "mid-sequence-failure"):
            observed = action_result(plan, action)
            observed["proof"]["schedulerTransaction"]["admissionMetricSnapshot"] = deepcopy(admission)
            current = observed["proof"]["metricSnapshot"]
            current.update(sequence=42, observedAt=AFTER_STAMP, freshnessSeconds=1,
                           snapshotDigest="sha256:" + "a" * 64)
            observed["aggregateMemory"]["metricSnapshot"] = deepcopy(current)
            for profile in observed["profiles"]:
                profile["memory"]["metricSnapshot"] = deepcopy(current)
            deployment.validate_action_result(action, observed, plan, run_id=RUN_ID)
            observed["proof"]["schedulerTransaction"]["admissionMetricSnapshot"]["freshnessSeconds"] = 31
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_action_result(action, observed, plan, run_id=RUN_ID)

    def test_ordinary_96_gib_gate_and_active_media_are_rejected(self) -> None:
        plan = complete_runtime_fixture()
        observed = action_result(plan, "final-inspect")
        observed["aggregateMemory"]["ordinaryPerProfile96GiBGateApplied"] = True
        with self.assertRaisesRegex(deployment.DeploymentError, "aggregate admission"):
            deployment.validate_action_result("final-inspect", observed, plan, run_id=RUN_ID)
        observed = action_result(plan, "final-inspect")
        observed["noCastObservation"]["activeCastingSessionCount"] = 1
        with self.assertRaisesRegex(deployment.DeploymentError, "no-cast"):
            deployment.validate_action_result("final-inspect", observed, plan, run_id=RUN_ID)
        observed = action_result(plan, "final-inspect")
        observed["proof"]["schedulerTransaction"]["admissionSnapshot"][
            "activeMediaReservationCount"] = 1
        with self.assertRaisesRegex(deployment.DeploymentError, "no active cast"):
            deployment.validate_action_result("final-inspect", observed, plan, run_id=RUN_ID)

    def test_mid_sequence_failure_requires_higher_revision_reconcile(self) -> None:
        plan = complete_runtime_fixture()
        observed = action_result(plan, "mid-sequence-failure")
        observed["failureInjection"]["reconcileTransaction"]["desiredStateRevision"] = 21
        with self.assertRaisesRegex(deployment.DeploymentError, "higher-revision"):
            deployment.validate_action_result("mid-sequence-failure", observed, plan, run_id=RUN_ID)

    def test_action_identities_are_deterministic_and_launch_is_immutable(self) -> None:
        self.assertEqual(deployment.action_identity(RUN_ID, "cold-boot"),
                         deployment.action_identity(RUN_ID, "cold-boot"))
        plan = complete_runtime_fixture()
        with tempfile.TemporaryDirectory(dir=deployment.ROOT / "tmp") as directory, \
                mock.patch.object(deployment, "EVIDENCE_ROOT", Path(directory)):
            first = deployment._launch_binding(RUN_ID, plan=plan, bindings={"parents": {}})
            self.assertTrue((deployment.ROOT / first["path"]).is_file())
            with self.assertRaisesRegex(deployment.DeploymentError, "launch identity"):
                deployment._launch_binding(RUN_ID, plan=plan, bindings={"parents": {}})

    def test_harness_binds_exact_a3_profile_set_and_flux_v2_without_claiming_deployment(self) -> None:
        paths = [item.relative_to(deployment.ROOT).as_posix() for item in deployment.SOURCES]
        self.assertIn(
            "apps/platform-api/server/protected-office-set-production-scenarios.mjs", paths)
        self.assertIn(
            "services/scheduler/src/protected-office-set-node-agent-runtime.mjs", paths)
        self.assertNotIn("tools/run_flux2_klein_bf16_main_protected_profile_qualification.py", paths)
        self.assertNotIn("tools/validate_flux2_klein_bf16_main_protected_profile_qualification.py", paths)
        plan = json.loads(deployment.PLAN.read_text(encoding="utf-8"))
        self.assertEqual({key: plan["parents"]["profileSetQualification"].get(key)
                          for key in deployment.PROFILE_SET_PARENT}, deployment.PROFILE_SET_PARENT)
        self.assertEqual(plan["profileSetManifest"]["sha256"],
                         deployment.PROFILE_SET_MANIFEST_SHA256)
        flux = plan["set"]["profiles"][-1]
        self.assertTrue(all(flux.get(key) == value
                            for key, value in deployment.FLUX2_PROFILE.items()))
        self.assertNotIn("awaitingExactParent", flux)
        self.assertNotIn("requiresNewProfileIdentityAfterA14", flux)
        self.assertRegex(flux["workerId"], deployment.UUID)
        self.assertRegex(flux["imageReference"], deployment.IMAGE_REFERENCE)
        self.assertIsNone(flux["priorState"])
        self.assertTrue(plan["preMigrationDesiredReady"])
        self.assertFalse(plan["readyForExecution"])
        self.assertNotIn("mediaRuntimeDeployment", plan["parents"])
        self.assertNotIn("activeMediaReservation", plan)
        self.assertFalse(plan["claimBoundary"]["noCastBaselineQualified"])
        self.assertFalse(plan["claimBoundary"]["protectedOfficeSetDeployed"])
        self.assertFalse(plan["claimBoundary"]["task21_4Complete"])

    def test_static_profile_pins_and_canonical_desired_identities_match_a3(self) -> None:
        plan = json.loads(deployment.PLAN.read_text(encoding="utf-8"))
        parent, _ = deployment._canonical_evidence(
            deployment.ROOT / deployment.PROFILE_SET_PARENT["path"])
        parent_by_slot = {item["slot"]: item for item in parent["profiles"]}
        for profile in plan["set"]["profiles"]:
            with self.subTest(slot=profile["slot"]):
                qualified = parent_by_slot[profile["slot"]]
                self.assertEqual(profile["modelProfileId"],
                                 qualified["componentIdentity"]["profileId"])
                self.assertEqual(profile["profileKey"],
                                 qualified["componentIdentity"]["profileKey"])
                self.assertEqual(profile["imageId"], qualified["engine"]["imageDigest"])
                self.assertEqual(profile["declaredResidentBytes"],
                                 qualified["observedMemory"]["aggregateAccountingBytes"])
                configuration = deployment.ROOT / profile["profileConfiguration"]
                self.assertEqual(profile["configurationDigest"], deployment.file_sha(configuration))
                self.assertRegex(profile["workerId"], deployment.UUID)
                self.assertRegex(profile["attemptId"], deployment.UUID)
                self.assertEqual(profile["containerName"], "teamaibox-worker-" + profile["workerId"])
                self.assertRegex(profile["imageReference"], deployment.IMAGE_REFERENCE)
                self.assertIsInstance(profile["requiredLabels"], dict)
                self.assertIsInstance(profile["dependentContainers"], list)
                self.assertIsInstance(profile["workerStart"], dict)
                self.assertIsNone(profile["priorState"])


if __name__ == "__main__":
    unittest.main()
