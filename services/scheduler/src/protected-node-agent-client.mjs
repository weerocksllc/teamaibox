import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { PHONE_COMMAND_TIMEOUT, validateAndroidPhoneCommand, validateAndroidPhoneResult } from "./android-phone-command.mjs";
import {validatePhoneMediaCommand,validatePhoneMediaResult} from "./android-phone-media-command.mjs";
import { phoneStorageObservation } from "./phone-storage-observation.mjs";
import {validateComputerCommand,validateComputerCommandResult} from './computer-command.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE_REFERENCE = /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const LEGACY_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;
const ABSOLUTE_PATH = /^\/[^\0]*$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const LABEL_NAME = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/;
const DOCKER_API_VERSION = /^[0-9]{1,3}\.[0-9]{1,3}$/;
const PROTECTED_MAINTENANCE_MAXIMUM_TTL_MILLISECONDS = 15 * 60_000;
const PROTECTED_MAINTENANCE_RESPONSE_MARGIN_MILLISECONDS = 30_000;
const PROTECTED_MAINTENANCE_OPERATIONS = Object.freeze(["protected.stop", "protected.restore", "protected.verify"]);
const PROTECTED_TRANSITION_OPERATIONS = Object.freeze(["protected.inspect", "protected.stage", "protected.verify", "protected.commit"]);
export const MAXIMUM_WORKER_CONTROL_TIMEOUT_MILLISECONDS = 600_000;
export const MAXIMUM_PROTECTED_TRANSITION_TIMEOUT_MILLISECONDS = 4 * 60 * 60_000;
export const MAXIMUM_APPLIANCE_RESTART_WINDOW_MILLISECONDS = 15 * 60_000;

const PROTECTED_HEALTH_WAIT_DEFAULT_MILLISECONDS = 2 * 60_000;
const PROTECTED_HEALTH_WAIT_MARGIN_MILLISECONDS = 30_000;
const PROTECTED_HEALTH_WAIT_MAXIMUM_MILLISECONDS = 35 * 60_000;
const PROTECTED_TRANSITION_OVERHEAD_MILLISECONDS = 5 * 60_000;

const PROTECTED_OFFICE_INSPECTION_POLICY = Object.freeze([
  Object.freeze({ targetKey: "office.embedding-qwen3", legacyHostNetworkRemoved: false, tmpfsExecutable: true }),
  Object.freeze({ targetKey: "office.asr-whisper", legacyHostNetworkRemoved: false, tmpfsExecutable: false }),
  Object.freeze({ targetKey: "office.ocr-hunyuan", legacyHostNetworkRemoved: false, tmpfsExecutable: true }),
  Object.freeze({ targetKey: "office.translation-lmt4", legacyHostNetworkRemoved: true, tmpfsExecutable: true }),
  Object.freeze({ targetKey: "office.assistant-qwen38", legacyHostNetworkRemoved: false, tmpfsExecutable: true }),
  Object.freeze({ targetKey: "office.drawing-flux2", legacyHostNetworkRemoved: false, tmpfsExecutable: true }),
]);

function protectedHealthWaitMilliseconds(health) {
  if (health == null) return PROTECTED_HEALTH_WAIT_DEFAULT_MILLISECONDS;
  const milliseconds = (health.startPeriodNanoseconds / 1_000_000)
    + health.retries * ((health.intervalNanoseconds + health.timeoutNanoseconds) / 1_000_000)
    + PROTECTED_HEALTH_WAIT_MARGIN_MILLISECONDS;
  return Math.min(PROTECTED_HEALTH_WAIT_MAXIMUM_MILLISECONDS,
    Math.max(PROTECTED_HEALTH_WAIT_DEFAULT_MILLISECONDS, milliseconds));
}

function protectedTransitionTimeoutMilliseconds(targets) {
  const workerWait = targets.reduce((sum, value) => sum
    + protectedHealthWaitMilliseconds(value.desiredWorker.healthCheck), 0);
  const companionWait = targets.reduce((sum, value) => sum
    + (value.desiredCompanions ?? []).length * PROTECTED_HEALTH_WAIT_DEFAULT_MILLISECONDS, 0);
  return Math.min(MAXIMUM_PROTECTED_TRANSITION_TIMEOUT_MILLISECONDS,
    Math.max(60_000, workerWait + companionWait + PROTECTED_TRANSITION_OVERHEAD_MILLISECONDS));
}

function stable(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function authority(value, generation) {
  if (!UUID.test(value?.leaseId ?? "") || !Number.isSafeInteger(value?.fencingToken) || value.fencingToken < 1
      || value.nodeGeneration !== generation) {
    throw new TypeError("Node Agent command authority is invalid");
  }
  return value;
}

function instant(value, name) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${name} is invalid`);
  return result;
}

function sameStringArrays(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactStringMap(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 16
      || Object.entries(value).some(([key, item]) => !LABEL_NAME.test(key)
        || typeof item !== "string" || item.length < 1 || item.length > 256 || item.includes("\0"))) {
    throw new TypeError(`${name} is invalid`);
  }
  return structuredClone(value);
}

function maintenanceDependent(value, name) {
  if (!value || !CONTAINER_NAME.test(value.containerName ?? "") || !DIGEST.test(value.requiredImageId ?? "")
      || !IMAGE_REFERENCE.test(value.requiredImageDigest ?? "") || !DIGEST.test(value.requiredConfigDigest ?? "")
      || (value.requiredStartSpecDigest !== undefined && !DIGEST.test(value.requiredStartSpecDigest))) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({
    containerName: value.containerName,
    requiredImageId: value.requiredImageId,
    requiredImageDigest: value.requiredImageDigest,
    requiredConfigDigest: value.requiredConfigDigest,
    ...(value.requiredStartSpecDigest === undefined ? {} : { requiredStartSpecDigest: value.requiredStartSpecDigest }),
    requiredLabels: Object.freeze(exactStringMap(value.requiredLabels ?? {}, `${name}.requiredLabels`)),
  });
}

function maintenanceTarget(value, index, generation) {
  const name = `targets[${index}]`;
  if (!value || !TARGET_KEY.test(value.targetKey ?? "") || !UUID.test(value.workerId ?? "")
      || !UUID.test(value.modelProfileId ?? "") || !CONTAINER_NAME.test(value.containerName ?? "")
      || value.placementClass !== "protected-resident" || value.maintenanceGeneration !== generation
      || !Number.isSafeInteger(value.stageOrder) || value.stageOrder < 1
      || !DIGEST.test(value.requiredImageId ?? "") || !IMAGE_REFERENCE.test(value.requiredImageDigest ?? "")
      || !DIGEST.test(value.requiredConfigDigest ?? "") || !Array.isArray(value.dependsOnWorkerIds ?? [])
      || (value.requiredStartSpecDigest !== undefined && !DIGEST.test(value.requiredStartSpecDigest ?? ""))
      || new Set(value.dependsOnWorkerIds ?? []).size !== (value.dependsOnWorkerIds ?? []).length
      || (value.dependsOnWorkerIds ?? []).some((workerId) => !UUID.test(workerId ?? "") || workerId === value.workerId)
      || !Array.isArray(value.dependentContainers ?? []) || (value.dependentContainers ?? []).length > 8) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({
    targetKey: value.targetKey,
    workerId: value.workerId,
    modelProfileId: value.modelProfileId,
    containerName: value.containerName,
    placementClass: value.placementClass,
    maintenanceGeneration: value.maintenanceGeneration,
    stageOrder: value.stageOrder,
    dependsOnWorkerIds: Object.freeze([...(value.dependsOnWorkerIds ?? [])]),
    requiredImageId: value.requiredImageId,
    requiredImageDigest: value.requiredImageDigest,
    requiredConfigDigest: value.requiredConfigDigest,
    ...(value.requiredStartSpecDigest === undefined ? {} : { requiredStartSpecDigest: value.requiredStartSpecDigest }),
    requiredLabels: Object.freeze(exactStringMap(value.requiredLabels ?? {}, `${name}.requiredLabels`)),
    dependentContainers: Object.freeze((value.dependentContainers ?? []).map((item, dependentIndex) =>
      maintenanceDependent(item, `${name}.dependentContainers[${dependentIndex}]`))),
  });
}

function transitionFaultInjection(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "failureCode,injectionPoint,oneShot,stageOrder,targetKey"
      || !Number.isSafeInteger(value.stageOrder) || value.stageOrder < 1 || value.stageOrder > 32
      || !TARGET_KEY.test(value.targetKey ?? "")
      || value.injectionPoint !== "after-stage-health"
      || value.failureCode !== "protected_set_transition_stage_failed" || value.oneShot !== true) {
    throw new TypeError("protected set transition fault injection is invalid");
  }
  return Object.freeze(structuredClone(value));
}

function applianceRestartIdentity(value, name) {
  if (!exactObjectKeys(value, [
    "containerId", "imageId", "imageReference", "configurationDigest", "startedAt", "status", "health",
  ]) || !CONTAINER_ID.test(value.containerId ?? "") || !DIGEST.test(value.imageId ?? "")
      || typeof value.imageReference !== "string" || value.imageReference.length < 1
      || value.imageReference.length > 512 || value.imageReference.includes("\0")
      || !DIGEST.test(value.configurationDigest ?? "") || !Number.isFinite(Date.parse(value.startedAt ?? ""))
      || value.status !== "running" || value.health !== "healthy") {
    throw new PlatformError("node_agent_protocol_mismatch",
      `Node Agent returned an invalid ${name} restart identity`, { status: 502, retryable: true });
  }
  return Object.freeze(structuredClone(value));
}

function applianceRestartState(value, expected) {
  const complete = value?.phase === "complete";
  if (!exactObjectKeys(value, [
    "restartId", "policyDigest", "idempotencyKey", "phase", "pre", "post", "journalRevisions", "updatedAt",
  ].filter((key) => key !== "post" || value?.post !== undefined))
      || value.restartId !== expected.restartId || value.policyDigest !== expected.policyDigest
      || value.idempotencyKey !== expected.idempotencyKey
      || !new Set(["agent_restart_armed", "complete"]).has(value.phase)
      || !Number.isFinite(Date.parse(value.updatedAt ?? ""))
      || !exactObjectKeys(value.pre, ["platform", "nodeAgent"])
      || !exactObjectKeys(value.post, complete ? ["platform", "nodeAgent"] : ["platform"])) {
    throw new PlatformError("node_agent_protocol_mismatch",
      "Node Agent returned invalid appliance restart state", { status: 502, retryable: true });
  }
  const revisions = value.journalRevisions;
  const revisionKeys = ["prepared", "platformRestarting", "platformVerified", "agentRestartArmed",
    ...(complete ? ["complete"] : [])];
  if (!exactObjectKeys(revisions, revisionKeys)
      || revisions.prepared !== expected.journalRevision
      || revisions.platformRestarting !== expected.journalRevision + 1
      || revisions.platformVerified !== expected.journalRevision + 2
      || revisions.agentRestartArmed !== expected.journalRevision + 3
      || (complete && revisions.complete !== expected.journalRevision + 4)) {
    throw new PlatformError("node_agent_protocol_mismatch",
      "Node Agent returned invalid appliance restart journal revisions", { status: 502, retryable: true });
  }
  applianceRestartIdentity(value.pre.platform, "pre-Platform");
  applianceRestartIdentity(value.pre.nodeAgent, "pre-Node-Agent");
  applianceRestartIdentity(value.post.platform, "post-Platform");
  if (complete) applianceRestartIdentity(value.post.nodeAgent, "post-Node-Agent");
  return Object.freeze(structuredClone(value));
}

function exactObjectKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function protectedTransitionInspectionContainer(value, { desired = false } = {}) {
  // The Go snapshot includes the manifest for every digest-pinned image,
  // including recovered canonical companions, not only desired Workers.
  const pinnedImage = IMAGE_REFERENCE.test(value?.imageReference ?? "");
  const optional = [
    ...(desired || pinnedImage ? ["imageManifestDigest"] : []),
    ...(desired ? ["startSpecDigest"] : []),
  ];
  if (!exactObjectKeys(value, [
    "containerName", "containerId", "imageReference", "imageId", "runtimeDigest",
    "networkMode", "state", "health", "oomKilled", "exact", ...optional,
  ]) || !CONTAINER_NAME.test(value.containerName ?? "") || !CONTAINER_ID.test(value.containerId ?? "")
      || !DIGEST.test(value.imageId ?? "") || !DIGEST.test(value.runtimeDigest ?? "")
      || typeof value.imageReference !== "string" || value.imageReference.length < 1
      || value.imageReference.length > 512 || typeof value.networkMode !== "string"
      || value.networkMode.length < 1 || value.networkMode.length > 256
      || value.state !== "running" || value.health !== "healthy"
      || value.oomKilled !== false || value.exact !== true
      || (pinnedImage && value.imageManifestDigest !== value.imageReference.split("@").at(-1))
      || (desired && (!pinnedImage || !DIGEST.test(value.startSpecDigest ?? "")))) {
    throw new PlatformError("node_agent_protocol_mismatch",
      "Node Agent returned an invalid protected-set container inspection", { status: 502, retryable: true });
  }
  return Object.freeze(structuredClone(value));
}

function protectedTransitionInspectionResult(value, expected) {
  const qualificationBound = expected.qualificationId !== undefined;
  const bindingKeys = qualificationBound
    ? ["qualificationId", "qualificationDigest", "protectedTargetPolicyDigest"]
    : ["migrationPlanId", "migrationPlanDigest", "sourceSetDigest", "desiredSetDigest"];
  if (!exactObjectKeys(value, [
    "schemaVersion", "readOnly", "mutationCount", "nodeId", "nodeGeneration",
    "transactionId", "setId", ...bindingKeys, "runtimeState", "journal", "targets",
    "rollbackTargetKeys", "canonicalContainersRemaining", "rollbackContainersRemaining",
    "transitionHelpersRemaining", "oomKilled", "restartPersistenceObserved",
  ]) || value.schemaVersion !== 1 || value.readOnly !== true || value.mutationCount !== 0
      || value.nodeId !== expected.nodeId || value.nodeGeneration !== expected.nodeGeneration
      || value.transactionId !== expected.transactionId || value.setId !== "office.baseline"
      || (qualificationBound && (value.qualificationId !== expected.qualificationId
        || value.qualificationDigest !== expected.qualificationDigest
        || value.protectedTargetPolicyDigest !== expected.protectedTargetPolicyDigest))
      || (!qualificationBound && (value.migrationPlanId !== expected.migrationPlanId
        || value.migrationPlanDigest !== expected.migrationPlanDigest
        || !DIGEST.test(value.sourceSetDigest ?? "") || !DIGEST.test(value.desiredSetDigest ?? "")))
      || value.runtimeState !== (qualificationBound ? "canonical-exact"
        : expected.mode === "fault" ? "legacy-exact" : "desired-exact")
      || !Array.isArray(value.targets) || value.targets.length !== 6
      || !Array.isArray(value.rollbackTargetKeys)
      || !Array.isArray(value.canonicalContainersRemaining) || value.canonicalContainersRemaining.length !== 0
      || !Array.isArray(value.rollbackContainersRemaining) || value.rollbackContainersRemaining.length !== 0
      || !Array.isArray(value.transitionHelpersRemaining) || value.transitionHelpersRemaining.length !== 0
      || value.oomKilled !== false || value.restartPersistenceObserved !== false) {
    throw new PlatformError("node_agent_protocol_mismatch",
      "Node Agent returned an invalid protected-set inspection", { status: 502, retryable: true });
  }
  const journal = value.journal;
  const faultJournalKeys = ["failureCode", "faultInjectionConsumed", "faultInjectionStageOrder",
    "faultInjectionTargetKey", "faultInjectionAfterHealthy"];
  if (!exactObjectKeys(journal, [
    "transactionId", "setId", "desiredStateRevision", "maintenanceGeneration",
    "journalRevision", "phase", "nextOperation", "planDigest", "updatedAt",
    ...(expected.mode === "fault" ? faultJournalKeys : []),
  ]) || journal.transactionId !== expected.transactionId || journal.setId !== "office.baseline"
      || !Number.isSafeInteger(journal.desiredStateRevision) || journal.desiredStateRevision < 1
      || !Number.isSafeInteger(journal.maintenanceGeneration) || journal.maintenanceGeneration < 1
      || !Number.isSafeInteger(journal.journalRevision) || journal.journalRevision < 1
      || journal.nextOperation !== 0 || !DIGEST.test(journal.planDigest ?? "")
      || !Number.isFinite(Date.parse(journal.updatedAt ?? ""))
      || (expected.mode === "fault" && (journal.phase !== "recovered"
        || journal.failureCode !== expected.faultInjection.failureCode
        || journal.faultInjectionConsumed !== true
        || journal.faultInjectionStageOrder !== expected.faultInjection.stageOrder
        || journal.faultInjectionTargetKey !== expected.faultInjection.targetKey
        || journal.faultInjectionAfterHealthy !== true))
      || (expected.mode === "success" && journal.phase !== "complete")) {
    throw new PlatformError("node_agent_protocol_mismatch",
      "Node Agent returned an invalid protected-set inspection journal", { status: 502, retryable: true });
  }
  const targetKeys = [];
  for (let index = 0; index < value.targets.length; index += 1) {
    const target = value.targets[index];
    const desired = expected.mode === "success";
    const canonical = qualificationBound && expected.mode === "fault";
    const inspectionPolicy = PROTECTED_OFFICE_INSPECTION_POLICY[index];
    const keys = ["targetKey", "stageOrder", "workerId", "modelProfileId", "runtimeState",
      "desiredCompanions", "legacyDependents", "mountsExact", "readOnlyModelMount",
      "modelMaterialMode", "healthcheckExact", "runtimeLimitsExact", "legacyHostNetworkRemoved", "tmpfsExecutable",
      ...(desired ? ["desired"] : canonical ? ["canonicalPrevious"] : ["legacyPrimary"]),
      ...(canonical && target.canonicalDependents !== undefined ? ["canonicalDependents"] : [])];
    if (!exactObjectKeys(target, keys) || target.targetKey !== inspectionPolicy.targetKey
        || target.stageOrder !== index + 1 || !UUID.test(target.workerId ?? "")
        || !UUID.test(target.modelProfileId ?? "")
        || target.runtimeState !== (desired ? "desired-exact" : canonical ? "canonical-exact" : "legacy-exact")
        || !Array.isArray(target.desiredCompanions) || !Array.isArray(target.legacyDependents)
        || (desired && target.legacyDependents.length !== 0)
        || (!desired && target.desiredCompanions.length !== 0)
        || (desired && (target.mountsExact !== true || target.readOnlyModelMount !== true
          || !new Set(["image-contained", "read-only-mounts"]).has(target.modelMaterialMode)
          || target.healthcheckExact !== true || target.runtimeLimitsExact !== true))
        || (desired && (target.legacyHostNetworkRemoved !== inspectionPolicy.legacyHostNetworkRemoved
          || target.tmpfsExecutable !== inspectionPolicy.tmpfsExecutable))
        || (!desired && index !== 3
          && (target.legacyHostNetworkRemoved !== false || target.tmpfsExecutable !== false))) {
      throw new PlatformError("node_agent_protocol_mismatch",
        "Node Agent returned an invalid protected-set target inspection", { status: 502, retryable: true });
    }
    if (desired) {
      protectedTransitionInspectionContainer(target.desired, { desired: true });
      target.desiredCompanions.forEach((item) => protectedTransitionInspectionContainer(item, { desired: true }));
    } else if (canonical) {
      protectedTransitionInspectionContainer(target.canonicalPrevious, { desired: true });
      if (target.canonicalDependents !== undefined) {
        if (!Array.isArray(target.canonicalDependents)) throw new PlatformError("node_agent_protocol_mismatch",
          "Node Agent returned invalid canonical dependents", { status: 502, retryable: true });
        target.canonicalDependents.forEach((item) => protectedTransitionInspectionContainer(item));
      }
    } else {
      protectedTransitionInspectionContainer(target.legacyPrimary);
      target.legacyDependents.forEach((item) => protectedTransitionInspectionContainer(item));
    }
    targetKeys.push(target.targetKey);
  }
  if (new Set(targetKeys).size !== 6 || (expected.mode === "fault"
    ? value.rollbackTargetKeys.join(",") !== [...targetKeys].reverse().join(",")
    : value.rollbackTargetKeys.length !== 0)) {
    throw new PlatformError("node_agent_protocol_mismatch",
      "Node Agent returned an invalid protected-set rollback inspection", { status: 502, retryable: true });
  }
  return Object.freeze(structuredClone(value));
}

function transitionMount(value, name) {
  if (!value || !new Set(["bind", "volume"]).has(value.type)
      || typeof value.source !== "string" || value.source.length < 1 || value.source.length > 4096
      || typeof value.target !== "string" || value.target.length > 4096 || !ABSOLUTE_PATH.test(value.target)
      || typeof value.readOnly !== "boolean") {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({ type: value.type, source: value.source, target: value.target, readOnly: value.readOnly });
}

function legacyTransitionIdentity(value, name) {
  if (!value || !CONTAINER_NAME.test(value.containerName ?? "") || !CONTAINER_ID.test(value.containerId ?? "")
      || !DIGEST.test(value.requiredImageId ?? "") || !LEGACY_IMAGE_REFERENCE.test(value.requiredImageReference ?? "")
      || typeof value.requiredNetworkMode !== "string" || value.requiredNetworkMode.length < 1
      || value.requiredNetworkMode.length > 256 || !DIGEST.test(value.requiredRuntimeDigest ?? "")
      || !DIGEST.test(value.requiredEnvironmentDigest ?? "") || !DIGEST.test(value.requiredCommandDigest ?? "")
      || !DIGEST.test(value.requiredHealthcheckDigest ?? "") || !Array.isArray(value.requiredMounts)
      || value.requiredMounts.length > 16) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({
    containerName: value.containerName,
    containerId: value.containerId,
    requiredImageId: value.requiredImageId,
    requiredImageReference: value.requiredImageReference,
    requiredNetworkMode: value.requiredNetworkMode,
    requiredRuntimeDigest: value.requiredRuntimeDigest,
    requiredMounts: Object.freeze(value.requiredMounts.map((item, index) => transitionMount(item, `${name}.requiredMounts[${index}]`))),
    requiredEnvironmentDigest: value.requiredEnvironmentDigest,
    requiredCommandDigest: value.requiredCommandDigest,
    requiredHealthcheckDigest: value.requiredHealthcheckDigest,
    requiredLabels: Object.freeze(exactStringMap(value.requiredLabels, `${name}.requiredLabels`)),
  });
}

function legacyTransitionTarget(value, name) {
  if (!value || !Array.isArray(value.dependentContainers ?? []) || (value.dependentContainers ?? []).length > 4) {
    throw new TypeError(`${name} is invalid`);
  }
  const primary = legacyTransitionIdentity(value.primary, `${name}.primary`);
  const dependentContainers = (value.dependentContainers ?? []).map((item, index) =>
    legacyTransitionIdentity(item, `${name}.dependentContainers[${index}]`));
  if (new Set([primary.containerId, ...dependentContainers.map((item) => item.containerId)]).size
      !== dependentContainers.length + 1) {
    throw new TypeError(`${name} contains duplicate identities`);
  }
  return Object.freeze({ primary, dependentContainers: Object.freeze(dependentContainers) });
}

function positiveInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function transitionCompanion(value, name, workerId) {
  const limits = value?.limits;
  const security = value?.security;
  const health = value?.healthCheck;
  if (!value || !CONTAINER_NAME.test(value.containerName ?? "") || value.parentWorkerId !== workerId
      || !IMAGE_REFERENCE.test(value.image ?? "") || !DIGEST.test(value.requiredImageId ?? "")
      || !DIGEST.test(value.configDigest ?? "") || value.network !== "compute-internal"
      || !limits || !positiveInteger(limits.memoryBytes, 64 * (2 ** 20), 16 * (2 ** 30))
      || !positiveInteger(limits.cpuQuotaMicros, 1_000, 2_000_000)
      || !positiveInteger(limits.pidsLimit, 1, 4_096) || !positiveInteger(limits.ephemeralBytes, 1, Number.MAX_SAFE_INTEGER)
      || !positiveInteger(limits.openFilesLimit, 64, 1_048_576)
      || !security || !positiveInteger(security.runAsUid, 1, 4_294_967_295)
      || !positiveInteger(security.runAsGid, 1, 4_294_967_295)
      || security.readOnlyRoot !== true || security.dropAllCapabilities !== true || security.noNewPrivileges !== true
      || security.privileged !== false || security.hostPid !== false || security.hostIpc !== false
      || security.hostNetwork !== false || security.dockerSocket !== false
      || !Array.isArray(value.mounts ?? []) || (value.mounts ?? []).length > 16
      || !Array.isArray(value.publishedPorts ?? []) || (value.publishedPorts ?? []).length > 8
      || !value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)
      || Object.keys(value.environment).length > 64
      || Object.entries(value.environment).some(([key, item]) => !ENVIRONMENT_NAME.test(key)
        || typeof item !== "string" || item.length > 4096 || item.includes("\0"))
      || !Array.isArray(value.command ?? []) || (value.command ?? []).length > 128
      || (value.command ?? []).some((item) => typeof item !== "string" || item.length < 1 || item.length > 4096 || item.includes("\0"))
      || !health || !Array.isArray(health.test) || health.test.length < 2 || health.test.length > 32
      || !new Set(["CMD", "CMD-SHELL"]).has(health.test[0])
      || health.test.some((item) => typeof item !== "string" || item.length < 1 || item.length > 4096)
      || !positiveInteger(health.intervalNanoseconds, 1_000_000_000, 300_000_000_000)
      || !positiveInteger(health.timeoutNanoseconds, 1_000_000_000, 300_000_000_000)
      || !Number.isSafeInteger(health.startPeriodNanoseconds) || health.startPeriodNanoseconds < 0
      || health.startPeriodNanoseconds > 1_800_000_000_000 || !positiveInteger(health.retries, 1, 30)) {
    throw new TypeError(`${name} is invalid`);
  }
  const publishedPorts = (value.publishedPorts ?? []).map((item, index) => {
    if (!positiveInteger(item?.containerPort, 1_024, 65_535) || !positiveInteger(item?.hostPort, 1_024, 65_535)
        || typeof item.hostIp !== "string" || item.hostIp.length < 2 || item.hostIp.length > 64) {
      throw new TypeError(`${name}.publishedPorts[${index}] is invalid`);
    }
    return Object.freeze({ containerPort: item.containerPort, hostPort: item.hostPort, hostIp: item.hostIp });
  });
  return Object.freeze({
    containerName: value.containerName, parentWorkerId: value.parentWorkerId, image: value.image,
    requiredImageId: value.requiredImageId, configDigest: value.configDigest, network: value.network,
    limits: Object.freeze(structuredClone(limits)), security: Object.freeze(structuredClone(security)),
    mounts: Object.freeze((value.mounts ?? []).map((item, index) => transitionMount(item, `${name}.mounts[${index}]`))),
    publishedPorts: Object.freeze(publishedPorts), environment: Object.freeze({ ...value.environment }),
    command: Object.freeze([...(value.command ?? [])]), healthCheck: Object.freeze(structuredClone(health)),
    requiredLabels: Object.freeze(exactStringMap(value.requiredLabels, `${name}.requiredLabels`)),
  });
}

export class ProtectedNodeAgentClient {
  #nodeId;
  #generation;
  #transport;
  #signer;
  #specs;
  #clock;
  #id;
  #resolveGeneration;
  #allowRetainedRuntime;

  constructor({ nodeId, nodeGeneration, transport, commandSigner, workerSpecFactory, clock = () => new Date(), idFactory = randomUUID, resolveGeneration = null, allowRetainedRuntime = false }) {
    if (!UUID.test(nodeId ?? "") || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1
        || typeof transport?.postCommand !== "function" || typeof commandSigner?.sign !== "function"
        || typeof workerSpecFactory?.buildStartPayload !== "function" || typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("protected Node Agent client dependencies are incomplete");
    }
    this.#nodeId = nodeId;
    this.#generation = nodeGeneration;
    this.#transport = transport;
    this.#signer = commandSigner;
    this.#specs = workerSpecFactory;
    this.#clock = clock;
    this.#id = idFactory;
    if (resolveGeneration !== null && typeof resolveGeneration !== 'function') throw new TypeError('Invalid node generation resolver');
    this.#resolveGeneration = resolveGeneration;
    this.#allowRetainedRuntime = allowRetainedRuntime === true;
  }

  async #send({ type, payload, authority: input, correlationId, timeoutMilliseconds, maximumResponseBytes,
    issuedAt: explicitIssuedAt, deadlineAt: explicitDeadlineAt, commandId: explicitCommandId,
    idempotency = "keyed", acceptedStatuses = ["succeeded"], returnResponse = false }) {
    // A retained resident/plugin has a stable runtime identity. Only access to
    // that existing runtime can cross a reconnect; lifecycle/maintenance
    // commands continue to require exact current authority.
    const retained = this.#allowRetainedRuntime && (['worker.health', 'worker.control', 'worker.application.fetch'].includes(type)
      || type === 'worker.stop' && payload.applicationOnly === true);
    const generation = this.#resolveGeneration ? await this.#resolveGeneration() : this.#generation;
    if (!Number.isSafeInteger(generation) || generation < this.#generation
      || !Number.isSafeInteger(input?.nodeGeneration) || input.nodeGeneration < 1
      || input.nodeGeneration > generation || (!retained && input.nodeGeneration !== generation)) {
      throw new TypeError('Node Agent command authority is invalid');
    }
    const commandAuthority = authority(input, input.nodeGeneration);
    if (input.nodeGeneration !== generation) payload = {...payload, runtimeGeneration: input.nodeGeneration};
    const issuedAt = explicitIssuedAt === undefined ? instant(this.#clock(), "clock") : instant(explicitIssuedAt, "issuedAt");
    const commandWindowMilliseconds = Math.max(60_000, timeoutMilliseconds ?? 0);
    const deadlineAt = explicitDeadlineAt === undefined
      ? new Date(issuedAt.getTime() + commandWindowMilliseconds)
      : instant(explicitDeadlineAt, "deadlineAt");
    if (deadlineAt.getTime() <= issuedAt.getTime()) throw new TypeError("Node Agent command window is invalid");
    const commandId = explicitCommandId === undefined ? this.#id() : explicitCommandId;
    if (!UUID.test(commandId ?? "")) throw new TypeError("Node Agent command identity is invalid");
    if (typeof idempotency !== "string" || idempotency.length < 1 || idempotency.length > 128
        || idempotency.includes("\0") || !Array.isArray(acceptedStatuses) || acceptedStatuses.length < 1
        || acceptedStatuses.some((status) => typeof status !== "string" || status.length < 1)
        || typeof returnResponse !== "boolean") {
      throw new TypeError("Node Agent command replay policy is invalid");
    }
    const envelope = {
      protocolVersion: 1,
      commandId,
      nodeId: this.#nodeId,
      nodeGeneration: generation,
      type,
      issuedAt: issuedAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      correlationId: stable(correlationId, "correlationId"),
      leaseId: commandAuthority.leaseId,
      fencingToken: commandAuthority.fencingToken,
      idempotency,
      payload: structuredClone(payload),
    };
    const body = JSON.stringify(envelope);
    const proof = await this.#signer.sign({ body, commandId: envelope.commandId, deadlineAt: envelope.deadlineAt });
    if (!proof || typeof proof.keyId !== "string" || typeof proof.nonce !== "string" || typeof proof.signature !== "string") {
      throw new TypeError("Node Agent command signer returned invalid proof");
    }
    let response;
    try {
      response = await this.#transport.postCommand({
        path: "/v1/commands",
        body,
        headers: {
          "content-type": "application/json",
          "x-teamaibox-key-id": proof.keyId,
          "x-teamaibox-nonce": proof.nonce,
          "x-teamaibox-signature": proof.signature,
        },
        ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
        ...(maximumResponseBytes === undefined ? {} : { maximumResponseBytes }),
      });
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("node_agent_transport_unavailable", "Node Agent transport was unavailable", {
        cause: error, status: 502, retryable: true,
      });
    }
    if (!response || response.commandId !== envelope.commandId || response.nodeId !== this.#nodeId
        || response.nodeGeneration !== generation || response.fencingToken !== commandAuthority.fencingToken) {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent response did not match the fenced command", { status: 502, retryable: true });
    }
    if (!acceptedStatuses.includes(response.status)) {
      throw new PlatformError(response.errorCode || "node_agent_command_failed", "Node Agent rejected the worker operation", { status: 409, retryable: response.retryable === true });
    }
    return returnResponse
      ? Object.freeze({ status: response.status, payload: response.payload ?? response })
      : response.payload ?? response;
  }

  async startWorker({ worker, authority: input, correlationId }) {
    const payload = await this.#specs.buildStartPayload({ worker: structuredClone(worker) });
    return this.#send({ type: "worker.start", payload, authority: input, correlationId });
  }

  async workerHealth({ workerId, authority: input, correlationId }) {
    if (!UUID.test(workerId ?? "")) throw new TypeError("workerId is invalid");
    return this.#send({ type: "worker.health", payload: { workerId }, authority: input, correlationId });
  }

  async workerControl({ workerId, request, authority: input, correlationId, timeoutMilliseconds = 120_000 }) {
    if (!UUID.test(workerId ?? "") || !request || typeof request !== "object" || Array.isArray(request)
        || request.protocolVersion !== 1 || request.workerId !== workerId || !UUID.test(request.leaseId ?? "")
        || !Number.isSafeInteger(request.fencingToken) || request.fencingToken < 1
        || !Number.isSafeInteger(timeoutMilliseconds)
        || timeoutMilliseconds < 1_000 || timeoutMilliseconds > MAXIMUM_WORKER_CONTROL_TIMEOUT_MILLISECONDS) {
      throw new TypeError("worker control request is invalid");
    }
    let value;
    try {
      value = await this.#send({ type: "worker.control", payload: { workerId, request: structuredClone(request) }, authority: input,
        correlationId, timeoutMilliseconds });
    } catch (error) {
      if (!new Set([
        "worker_control_failed", "node_agent_transport_unavailable", "node_agent_transport_invalid",
        "node_agent_protocol_mismatch",
      ]).has(error?.code)) throw error;
      const failure = new PlatformError("worker_transport_lost", "Worker control transport was lost", {
        cause: error, status: 502, retryable: true,
      });
      failure.fatalWorker = true;
      throw failure;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid worker control content", { status: 502, retryable: true });
    }
    return Object.freeze(structuredClone(value));
  }

  async fetchApplication({ workerId, method, path, authority: input, correlationId }) {
    if (!UUID.test(workerId ?? "") || !new Set(["GET", "HEAD"]).has(method) || typeof path !== "string"
        || path.length < 10 || path.length > 4096 || !path.startsWith("/plugins/") || path.includes("#")) {
      throw new TypeError("application fetch request is invalid");
    }
    const value = await this.#send({ type: "worker.application.fetch", payload: { workerId, method, path }, authority: input,
      correlationId, timeoutMilliseconds: 30_000, maximumResponseBytes: 24 << 20 });
    if (!Number.isSafeInteger(value?.status) || value.status < 200 || value.status > 599
        || !value.headers || typeof value.headers !== "object" || Array.isArray(value.headers)
        || Object.entries(value.headers).some(([name, item]) => !new Set(["content-type", "cache-control", "etag", "last-modified", "content-language"]).has(name)
          || typeof item !== "string" || item.length > 1024 || /[\r\n]/.test(item))
        || (value.body !== undefined && typeof value.body !== "string")) {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid application content", { status: 502, retryable: true });
    }
    const body = value.body === undefined ? Buffer.alloc(0) : Buffer.from(value.body, "base64");
    if (body.byteLength > (16 << 20) || (value.body !== undefined && body.toString("base64") !== value.body)) {
      body.fill(0);
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid application content", { status: 502, retryable: true });
    }
    return Object.freeze({ status: value.status, headers: Object.freeze({ ...value.headers }), body });
  }

  async stopApplication({workerId,authority:input,gracePeriodSeconds,correlationId}) {
    if (!UUID.test(workerId??'') || !Number.isSafeInteger(gracePeriodSeconds) || gracePeriodSeconds<0 || gracePeriodSeconds>300) throw TypeError('Invalid application stop');
    return this.#send({type:'worker.stop',payload:{workerId,gracePeriodSeconds,applicationOnly:true},authority:input,correlationId,
      timeoutMilliseconds:Math.max(30_000,(gracePeriodSeconds+10)*1000)});
  }

  async stopWorker({ workerId, authority: input, gracePeriodSeconds, correlationId }) {
    if (!UUID.test(workerId ?? "") || !Number.isSafeInteger(gracePeriodSeconds) || gracePeriodSeconds < 0 || gracePeriodSeconds > 300) throw new TypeError("worker stop request is invalid");
    return this.#send({ type: "worker.stop", payload: { workerId, gracePeriodSeconds }, authority: input, correlationId,
      timeoutMilliseconds: Math.max(10_000, gracePeriodSeconds * 1_000 + 10_000) });
  }

  async executeComputerCommand({action,payload,correlationId,timeoutMilliseconds}) {
    const selected=validateComputerCommand(action,payload);
    if(!Number.isSafeInteger(timeoutMilliseconds)||timeoutMilliseconds<=0) throw TypeError('Computer command deadline required');
    const value=await this.#send({type:`virtual-computer.${action}`,payload:selected,
      authority:{leaseId:selected.computerId,fencingToken:selected.generation+1,nodeGeneration:this.#generation},
      correlationId,timeoutMilliseconds,maximumResponseBytes:16<<10});
    return validateComputerCommandResult(action,selected,value);
  }

  async executePhoneCommand({ action, payload, correlationId }) {
    const selected = validateAndroidPhoneCommand(action, payload);
    const value = await this.#send({ type: `android-phone.${action}`, payload: selected,
      authority: { leaseId: selected.phoneId, fencingToken: selected.generation + 1, nodeGeneration: this.#generation },
      correlationId, timeoutMilliseconds: PHONE_COMMAND_TIMEOUT[action], maximumResponseBytes: 16 << 10 });
    return validateAndroidPhoneResult(action, selected, value);
  }

  async transferPhoneFile({payload,chunks,signal,correlationId}) {
    const {validatePhoneFileCommand}=await import('./android-phone-file-command.mjs');
    const issuedAt=instant(this.#clock(),'clock'),selected=validatePhoneFileCommand(payload,{now:issuedAt.getTime()});
    if(typeof this.#transport.transferPhoneFile!=='function')throw TypeError('Phone files transport unavailable');
    const envelope={protocolVersion:1,commandId:selected.operationId,nodeId:this.#nodeId,nodeGeneration:this.#generation,type:'android-phone.file.transfer',
      issuedAt:issuedAt.toISOString(),deadlineAt:new Date(selected.deadline).toISOString(),correlationId:stable(correlationId,'correlationId'),
      leaseId:selected.phoneId,fencingToken:selected.generation+1,idempotency:'keyed',payload:selected};
    const body=JSON.stringify(envelope),proof=await this.#signer.sign({body,commandId:envelope.commandId,deadlineAt:envelope.deadlineAt});
    return this.#transport.transferPhoneFile({body,payload:selected,chunks,signal,headers:{'x-teamaibox-key-id':proof.keyId,'x-teamaibox-nonce':proof.nonce,'x-teamaibox-signature':proof.signature}});
  }

  async executeComputerInstallation({payload,chunks,signal,correlationId}){
    const selected=validateComputerCommand('installation',payload),issuedAt=instant(this.#clock(),'clock');
    if(typeof this.#transport.executeComputerInstallation!=='function')throw TypeError('Computer installation transport unavailable');
    const commandId=this.#id();if(!UUID.test(commandId))throw TypeError('Invalid computer command identity');
    const envelope={protocolVersion:1,commandId,nodeId:this.#nodeId,nodeGeneration:this.#generation,type:'virtual-computer.installation',
      issuedAt:issuedAt.toISOString(),deadlineAt:new Date(issuedAt.getTime()+15000).toISOString(),correlationId:stable(correlationId,'correlationId'),
      leaseId:selected.computerId,fencingToken:selected.generation+1,idempotency:'keyed',payload:selected};
    const body=JSON.stringify(envelope),proof=await this.#signer.sign({body,commandId,deadlineAt:envelope.deadlineAt});
    return validateComputerCommandResult('installation',selected,await this.#transport.executeComputerInstallation({body,payload:selected,chunks,signal,
      headers:{'x-teamaibox-key-id':proof.keyId,'x-teamaibox-nonce':proof.nonce,'x-teamaibox-signature':proof.signature}}));
  }

  async executePhoneCamera({payload,chunks,signal,correlationId}){
    const {validatePhoneCameraCommand,validatePhoneCameraResult}=await import('./android-phone-camera-command.mjs');
    const issuedAt=instant(this.#clock(),'clock'),selected=validatePhoneCameraCommand(payload,{now:issuedAt.getTime()});
    if(typeof this.#transport.executePhoneCamera!=='function')throw TypeError('Phone camera transport unavailable');
    const commandId=this.#id();if(!UUID.test(commandId))throw TypeError('Invalid camera command identity');
    const envelope={protocolVersion:1,commandId,nodeId:this.#nodeId,nodeGeneration:this.#generation,type:'android-phone.camera.input',
      issuedAt:issuedAt.toISOString(),deadlineAt:new Date(selected.deadline).toISOString(),correlationId:stable(correlationId,'correlationId'),
      leaseId:selected.phoneId,fencingToken:selected.generation+1,idempotency:'keyed',payload:selected};
    const body=JSON.stringify(envelope),proof=await this.#signer.sign({body,commandId,deadlineAt:envelope.deadlineAt});
    return validatePhoneCameraResult(selected,await this.#transport.executePhoneCamera({body,payload:selected,chunks,signal,
      headers:{'x-teamaibox-key-id':proof.keyId,'x-teamaibox-nonce':proof.nonce,'x-teamaibox-signature':proof.signature}}));
  }

  async executePhoneMedia({action,payload,correlationId}) {
    const issuedAt=instant(this.#clock(),"clock"),selected=validatePhoneMediaCommand(action,payload,{now:issuedAt.getTime()});
    const result=await this.#send({type:`android-phone.media.${action}`,payload:selected,issuedAt,
      // Keep one second below the node's five-second ceiling. Independent
      // synchronized hosts can still differ by milliseconds on a fast LAN.
      deadlineAt:new Date(issuedAt.getTime()+4000),authority:{leaseId:selected.phoneId,fencingToken:selected.generation+1,nodeGeneration:this.#generation},
      correlationId,timeoutMilliseconds:4000,maximumResponseBytes:8192});
    return validatePhoneMediaResult(action,selected,result);
  }

  async connectPhoneSignal({payload,correlationId,createWebSocket,onMessage,onClose,signal}) {
    const issuedAt=instant(this.#clock(),"clock"),selected=validatePhoneMediaCommand("renew",payload,{now:issuedAt.getTime()});
    if(typeof this.#transport.openPhoneSignal!=="function")throw TypeError("Phone signal transport is unavailable");
    const envelope={protocolVersion:1,commandId:this.#id(),nodeId:this.#nodeId,nodeGeneration:this.#generation,
      type:"android-phone.media.renew",issuedAt:issuedAt.toISOString(),deadlineAt:new Date(issuedAt.getTime()+4000).toISOString(),
      correlationId:stable(correlationId,"correlationId"),leaseId:selected.phoneId,fencingToken:selected.generation+1,idempotency:"keyed",payload:selected};
    if(!UUID.test(envelope.commandId))throw TypeError("Invalid phone signal identity");
    const body=JSON.stringify(envelope),proof=await this.#signer.sign({body,commandId:envelope.commandId,deadlineAt:envelope.deadlineAt});
    return this.#transport.openPhoneSignal({body,headers:{"x-teamaibox-key-id":proof.keyId,"x-teamaibox-nonce":proof.nonce,"x-teamaibox-signature":proof.signature},
      createWebSocket,onMessage,onClose,signal});
  }

  async connectPhoneADB({payload,correlationId,signal}) {
    const issuedAt=instant(this.#clock(),"clock"),selected=validatePhoneMediaCommand("renew",payload,{now:issuedAt.getTime()});
    if(selected.kind!=="adb" || typeof this.#transport.openPhoneADB!=="function")throw TypeError("Phone ADB transport is unavailable");
    const envelope={protocolVersion:1,commandId:this.#id(),nodeId:this.#nodeId,nodeGeneration:this.#generation,
      type:"android-phone.media.renew",issuedAt:issuedAt.toISOString(),deadlineAt:new Date(issuedAt.getTime()+4000).toISOString(),
      correlationId:stable(correlationId,"correlationId"),leaseId:selected.phoneId,fencingToken:selected.generation+1,idempotency:"keyed",payload:selected};
    if(!UUID.test(envelope.commandId))throw TypeError("Invalid phone ADB identity");
    const body=JSON.stringify(envelope),proof=await this.#signer.sign({body,commandId:envelope.commandId,deadlineAt:envelope.deadlineAt});
    return this.#transport.openPhoneADB({body,headers:{"x-teamaibox-key-id":proof.keyId,"x-teamaibox-nonce":proof.nonce,"x-teamaibox-signature":proof.signature},signal});
  }

  async readComputerBaseline({correlationId}) {
    const requestId=this.#id();
    const value=await this.#send({type:'virtual-computer.baseline',payload:{},
      authority:{leaseId:requestId,fencingToken:1,nodeGeneration:this.#generation},correlationId,commandId:requestId,
      timeoutMilliseconds:10000,maximumResponseBytes:1<<20});
    if(value?.nodeId!==this.#nodeId||value.nodeGeneration!==this.#generation||value.encryption!=='luks2'
      ||!Number.isSafeInteger(value.sampledAt)||!Array.isArray(value.volumes)||!Array.isArray(value.availableCpuGroups))
      throw new PlatformError('computer_capacity_unavailable','本机资源数据尚未就绪，请稍后重试。',{status:409,retryable:true});
    return Object.freeze(structuredClone(value));
  }

  async connectComputerDesktop({payload,correlationId,signal,kind}) {
    const issuedAt=instant(this.#clock(),'clock'),selected=validateComputerCommand('inspect',payload);
    if(selected.nodeId!==this.#nodeId||!selected.run?.containerId||!['rdp','console','audio'].includes(kind)
      ||typeof this.#transport.openComputerDesktop!=='function')throw TypeError('Computer desktop transport unavailable');
    const envelope={protocolVersion:1,commandId:this.#id(),nodeId:this.#nodeId,nodeGeneration:this.#generation,
      type:'virtual-computer.inspect',issuedAt:issuedAt.toISOString(),deadlineAt:new Date(issuedAt.getTime()+10000).toISOString(),
      correlationId:stable(correlationId,'correlationId'),leaseId:selected.computerId,fencingToken:selected.generation+1,idempotency:'keyed',payload:selected};
    if(!UUID.test(envelope.commandId))throw TypeError('Invalid desktop command identity');
    const body=JSON.stringify(envelope),proof=await this.#signer.sign({body,commandId:envelope.commandId,deadlineAt:envelope.deadlineAt});
    return this.#transport.openComputerDesktop({body,headers:{'x-teamaibox-key-id':proof.keyId,'x-teamaibox-nonce':proof.nonce,'x-teamaibox-signature':proof.signature},signal,kind});
  }

  async readPhoneBaseline({ correlationId }) {
    const requestId = this.#id();
    let value;
    try { value = await this.#send({ type: "android-phone.baseline", payload: {},
      authority: { leaseId: requestId, fencingToken: 1, nodeGeneration: this.#generation },
      correlationId, commandId: requestId, timeoutMilliseconds: 5_000, maximumResponseBytes: 32 << 10 }); }
    catch(error) {
      if(['phone_baseline_not_ready','phone_baseline_stale'].includes(error?.code))
        throw new PlatformError('phone_capacity_unavailable','本机资源数据尚未就绪，请稍后重试。',{status:409,retryable:true});
      throw error;
    }
    if (value?.nodeId !== this.#nodeId || value?.nodeGeneration !== this.#generation || !UUID.test(value?.bootId ?? "")
        || value.kvmApiVersion !== 12 || !Array.isArray(value.samples) || value.samples.length < 7 || value.samples.length > 128) {
      throw new PlatformError("phone_capacity_unavailable", "本机资源数据尚未就绪。", { status: 409, retryable: true });
    }
    return Object.freeze(structuredClone(value));
  }

  async readPhoneStorage({ correlationId }) {
    const requestId = this.#id();
    const value = await this.#send({ type: "android-phone.storage", payload: {},
      authority: { leaseId: requestId, fencingToken: 1, nodeGeneration: this.#generation },
      correlationId, commandId: requestId, timeoutMilliseconds: 5_000, maximumResponseBytes: 4096 });
    return phoneStorageObservation(value, { nodeId: this.#nodeId, nodeGeneration: this.#generation, now: this.#clock() });
  }

  async readPhoneUsbInventory({correlationId}) {
    const requestId=this.#id();
    const value=await this.#send({type:'android-phone.camera.usb.inventory',payload:{},
      authority:{leaseId:requestId,fencingToken:1,nodeGeneration:this.#generation},
      correlationId,commandId:requestId,timeoutMilliseconds:5000,maximumResponseBytes:65536});
    if(value?.nodeId!==this.#nodeId||!Array.isArray(value.data))throw new PlatformError('phone_camera_runtime_unavailable','无法读取本机摄像头。',{status:503,retryable:true});
    return value;
  }

  async inspectAppliance({ correlationId }) {
    const inspectionId = this.#id();
    const value = await this.#send({
      type: "appliance.inspect", payload: { inspectionId },
      authority: { leaseId: inspectionId, fencingToken: 1, nodeGeneration: this.#generation },
      correlationId, commandId: inspectionId, timeoutMilliseconds: 30_000,
    });
    if (!value || value.nodeId !== this.#nodeId || value.nodeGeneration !== this.#generation
        || typeof value.healthy !== "boolean" || !DIGEST.test(value.imageDigest ?? "")
        || !DIGEST.test(value.configurationDigest ?? "")) {
      throw new PlatformError("node_agent_protocol_mismatch", "Local agent returned invalid appliance identity", {status:502,retryable:true});
    }
    return Object.freeze(structuredClone(value));
  }

  async executeApplianceRuntimeRestart({ restartId, journalRevision, policyDigest, idempotencyKey,
    issuedAt, deadlineAt, correlationId }) {
    const at = instant(this.#clock(), "clock");
    const issued = instant(issuedAt, "issuedAt");
    const deadline = instant(deadlineAt, "deadlineAt");
    if (!UUID.test(restartId ?? "") || !Number.isSafeInteger(journalRevision) || journalRevision < 1
        || !DIGEST.test(policyDigest ?? "") || !DIGEST.test(idempotencyKey ?? "")
        || issued.getTime() > at.getTime() + 1_000 || deadline.getTime() <= at.getTime()
        || deadline.getTime() <= issued.getTime()
        || deadline.getTime() - issued.getTime() > MAXIMUM_APPLIANCE_RESTART_WINDOW_MILLISECONDS) {
      throw new TypeError("appliance runtime restart request is invalid");
    }
    const response = await this.#send({
      type: "appliance.runtime.restart",
      payload: { restartId, journalRevision, policyDigest, idempotencyKey },
      authority: { leaseId: restartId, fencingToken: journalRevision, nodeGeneration: this.#generation },
      correlationId, issuedAt: issued, deadlineAt: deadline, commandId: restartId,
      idempotency: idempotencyKey,
      acceptedStatuses: ["restart-required", "succeeded"],
      returnResponse: true,
      timeoutMilliseconds: Math.min(MAXIMUM_WORKER_CONTROL_TIMEOUT_MILLISECONDS,
        Math.max(1_000, deadline.getTime() - at.getTime())),
    });
    const value = applianceRestartState(response.payload,
      { restartId, journalRevision, policyDigest, idempotencyKey });
    if ((response.status === "restart-required") !== (value.phase === "agent_restart_armed")) {
      throw new PlatformError("node_agent_protocol_mismatch",
        "Node Agent appliance restart status disagreed with its durable phase", { status: 502, retryable: true });
    }
    return value;
  }

  async maintenancePreflight({ planId, kind, candidateDigest, requirements, authority: input, correlationId }) {
    if (!UUID.test(planId ?? "") || input?.leaseId !== planId || !new Set(["platform", "host"]).has(kind) || !DIGEST.test(candidateDigest ?? "")
        || !requirements || requirements.expectedArchitecture !== "arm64"
        || !DOCKER_API_VERSION.test(requirements.minimumDockerApiVersion ?? "")
        || typeof requirements.requireNvidiaContainerIntegration !== "boolean"
        || !Array.isArray(requirements.allowedSecureBootStates) || requirements.allowedSecureBootStates.length < 1
        || requirements.allowedSecureBootStates.length > 3
        || new Set(requirements.allowedSecureBootStates).size !== requirements.allowedSecureBootStates.length
        || requirements.allowedSecureBootStates.some((state) => !new Set(["enabled", "disabled", "unknown"]).has(state))) {
      throw new TypeError("maintenance preflight request is invalid");
    }
    const value = await this.#send({ type: "maintenance.preflight", payload: {
      planId, kind, candidateDigest, expectedArchitecture: requirements.expectedArchitecture,
      minimumDockerApiVersion: requirements.minimumDockerApiVersion,
      requireNvidiaContainerIntegration: requirements.requireNvidiaContainerIntegration,
      allowedSecureBootStates: [...requirements.allowedSecureBootStates],
    }, authority: input, correlationId, timeoutMilliseconds: 30_000 });
    if (!value || value.planId !== planId || value.nodeId !== this.#nodeId || value.nodeGeneration !== this.#generation
        || typeof value.passed !== "boolean" || !DIGEST.test(value.evidenceDigest ?? "")
        || value.architecture !== "arm64" || !DOCKER_API_VERSION.test(value.dockerApiVersion ?? "")
        || !new Set(["enabled", "disabled", "unknown"]).has(value.secureBootState)
        || typeof value.nvidiaContainerIntegrationAvailable !== "boolean"
        || !new Set(["runtime", "cdi", "unavailable"]).has(value.nvidiaContainerIntegrationMode)
        || !Number.isSafeInteger(value.activeManagedWorkloads)
        || value.activeManagedWorkloads < 0 || !Array.isArray(value.blockers) || !Array.isArray(value.warnings)
        || [...value.blockers, ...value.warnings].some((code) => typeof code !== "string" || !/^[a-z][a-z0-9_]{2,127}$/.test(code))) {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid maintenance preflight evidence", { status: 502, retryable: true });
    }
    return Object.freeze(structuredClone(value));
  }

  async executeProtectedMaintenanceTransaction({ transactionId, workerIds, allowedOperations, operationOrder,
    maintenanceGeneration, issuedAt, expiresAt, journalRevision, targets, authority: input, correlationId }) {
    const at = instant(this.#clock(), "clock");
    const issued = instant(issuedAt, "issuedAt");
    const expires = instant(expiresAt, "expiresAt");
    if (!UUID.test(transactionId ?? "") || input?.leaseId !== transactionId
        || input?.fencingToken !== journalRevision || !Number.isSafeInteger(maintenanceGeneration) || maintenanceGeneration < 1
        || !Number.isSafeInteger(journalRevision) || journalRevision < 1
        || !Array.isArray(workerIds) || workerIds.length < 1 || workerIds.length > 32
        || !Array.isArray(targets) || targets.length !== workerIds.length
        || !Array.isArray(allowedOperations) || allowedOperations.length !== 1
        || allowedOperations[0] !== "protected-set.maintenance"
        || !Array.isArray(operationOrder) || operationOrder.length !== PROTECTED_MAINTENANCE_OPERATIONS.length
        || operationOrder.some((value, index) => value !== PROTECTED_MAINTENANCE_OPERATIONS[index])
        || issued.getTime() > at.getTime() + 1_000 || expires.getTime() <= at.getTime()
        || expires.getTime() <= issued.getTime()
        || expires.getTime() - issued.getTime() > PROTECTED_MAINTENANCE_MAXIMUM_TTL_MILLISECONDS) {
      throw new TypeError("protected maintenance transaction is invalid");
    }
    const normalizedTargets = targets.map((value, index) => maintenanceTarget(value, index, maintenanceGeneration));
    if (new Set(workerIds).size !== workerIds.length || new Set(normalizedTargets.map((value) => value.workerId)).size !== normalizedTargets.length
        || new Set(normalizedTargets.map((value) => value.modelProfileId)).size !== normalizedTargets.length
        || new Set(normalizedTargets.map((value) => value.targetKey)).size !== normalizedTargets.length
        || new Set(normalizedTargets.map((value) => value.stageOrder)).size !== normalizedTargets.length
        || workerIds.some((workerId, index) => workerId !== normalizedTargets[index].workerId)
        || normalizedTargets.some((value, index) => index > 0 && (
          normalizedTargets[index - 1].stageOrder < value.stageOrder
          || (normalizedTargets[index - 1].stageOrder === value.stageOrder
            && normalizedTargets[index - 1].targetKey.localeCompare(value.targetKey) > 0)))
        || normalizedTargets.some((value) => value.dependsOnWorkerIds.some((dependencyWorkerId) => {
          const dependency = normalizedTargets.find((candidate) => candidate.workerId === dependencyWorkerId);
          return dependency == null || dependency.stageOrder >= value.stageOrder;
        }))) {
      throw new TypeError("protected maintenance target set is invalid");
    }
    const payload = Object.freeze({
      transactionId,
      workerIds: Object.freeze([...workerIds]),
      allowedOperations: Object.freeze([...allowedOperations]),
      operationOrder: Object.freeze([...operationOrder]),
      maintenanceGeneration,
      issuedAt: issued.toISOString(),
      expiresAt: expires.toISOString(),
      journalRevision,
      targets: Object.freeze(normalizedTargets),
    });
    const value = await this.#send({
      type: "maintenance.transaction.execute", payload, authority: input, correlationId,
      issuedAt: issued, deadlineAt: expires,
      // The transaction ID is also the stable command replay key. If the mTLS
      // response is lost after completion, an exact retry replays the Agent's
      // cached result instead of creating a second maintenance mutation.
      commandId: transactionId,
      // Full-set maintenance may use the whole signed 15-minute window.
      // The ordinary single-Worker 10-minute cap must not cancel restoration.
      // This only budgets the response: the signed admission deadline above
      // remains unchanged, and no expired transaction can start new mutation.
      timeoutMilliseconds: expires.getTime() - at.getTime()
        + PROTECTED_MAINTENANCE_RESPONSE_MARGIN_MILLISECONDS,
    });
    if (!value || value.transactionId !== transactionId || value.maintenanceGeneration !== maintenanceGeneration
        || value.journalRevision !== journalRevision || value.phase !== "complete" || value.nextOperation !== 0
        || !DIGEST.test(value.planDigest ?? "")) {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid protected maintenance state", {
        status: 502, retryable: true,
      });
    }
    return Object.freeze(structuredClone(value));
  }

  async executeProtectedSetTransition({ transactionId, setId, desiredStateRevision, workerIds,
    allowedOperations, operationOrder, maintenanceGeneration, issuedAt, expiresAt, journalRevision,
    migrationPlanId, migrationPlanDigest, qualificationId, qualificationDigest,
    faultInjection, targets, authority: input, correlationId }) {
    const at = instant(this.#clock(), "clock");
    const issued = instant(issuedAt, "issuedAt");
    const expires = instant(expiresAt, "expiresAt");
    if (!UUID.test(transactionId ?? "") || input?.leaseId !== transactionId || input?.fencingToken !== journalRevision
        || !TARGET_KEY.test(setId ?? "") || !Number.isSafeInteger(desiredStateRevision) || desiredStateRevision < 1
        || !Number.isSafeInteger(maintenanceGeneration) || maintenanceGeneration < 1
        || !Number.isSafeInteger(journalRevision) || journalRevision < 1
        || !Array.isArray(workerIds) || workerIds.length < 1 || workerIds.length > 32
        || !Array.isArray(targets) || targets.length !== workerIds.length
        || !Array.isArray(allowedOperations) || allowedOperations.length !== 1
        || allowedOperations[0] !== "protected-set.transition"
        || !Array.isArray(operationOrder) || operationOrder.length !== PROTECTED_TRANSITION_OPERATIONS.length
        || operationOrder.some((value, index) => value !== PROTECTED_TRANSITION_OPERATIONS[index])
        || issued.getTime() > at.getTime() + 1_000 || expires.getTime() <= at.getTime()
        || expires.getTime() <= issued.getTime()
        || expires.getTime() - issued.getTime() > PROTECTED_MAINTENANCE_MAXIMUM_TTL_MILLISECONDS) {
      throw new TypeError("protected set transition is invalid");
    }
    const migrationBound = migrationPlanId !== undefined || migrationPlanDigest !== undefined;
    if (migrationBound && (!TARGET_KEY.test(migrationPlanId ?? "") || !DIGEST.test(migrationPlanDigest ?? ""))) {
      throw new TypeError("protected set migration binding is invalid");
    }
    const qualificationBound = qualificationId !== undefined || qualificationDigest !== undefined;
    if (qualificationBound && (!TARGET_KEY.test(qualificationId ?? "") || !DIGEST.test(qualificationDigest ?? ""))) {
      throw new TypeError("protected set qualification binding is invalid");
    }
    if (migrationBound && qualificationBound) throw new TypeError("protected set transition authority is ambiguous");
    const normalizedFaultInjection = transitionFaultInjection(faultInjection);
    if (normalizedFaultInjection != null && !migrationBound && !qualificationBound) {
      throw new TypeError("protected set fault injection requires a local policy binding");
    }
    if (qualificationBound && normalizedFaultInjection == null) {
      throw new TypeError("protected set qualification binding requires its exact fault");
    }
    const normalizedTargets = [];
    for (let index = 0; index < targets.length; index += 1) {
      const value = targets[index];
      const desiredTarget = maintenanceTarget(value?.desiredTarget, index, maintenanceGeneration);
      const previousTarget = value?.previousTarget == null ? null
        : maintenanceTarget(value.previousTarget, index, value.previousTarget.maintenanceGeneration);
      const legacyPreviousTarget = value?.legacyPreviousTarget == null ? null
        : legacyTransitionTarget(value.legacyPreviousTarget, `targets[${index}].legacyPreviousTarget`);
      const desiredCompanions = (value?.desiredCompanions ?? []).map((item, companionIndex) =>
        transitionCompanion(item, `targets[${index}].desiredCompanions[${companionIndex}]`, desiredTarget.workerId));
      if (!value?.desiredWorker || value.desiredWorker.workerId !== desiredTarget.workerId
          || value.desiredWorker.modelProfileId !== desiredTarget.modelProfileId
          || value.desiredWorker.placementClass !== "protected-resident"
          || value.desiredWorker.maintenanceGeneration !== maintenanceGeneration
          || value.desiredWorker.configDigest !== desiredTarget.requiredConfigDigest
          || value.desiredWorker.image !== desiredTarget.requiredImageDigest
          || (migrationBound && !DIGEST.test(desiredTarget.requiredStartSpecDigest ?? ""))
          || (previousTarget != null && legacyPreviousTarget != null)
          || (previousTarget != null && (previousTarget.workerId !== desiredTarget.workerId
            || previousTarget.containerName !== desiredTarget.containerName
            || previousTarget.stageOrder !== desiredTarget.stageOrder
            || !sameStringArrays(previousTarget.dependsOnWorkerIds, desiredTarget.dependsOnWorkerIds)))
          || (legacyPreviousTarget == null && desiredCompanions.length !== 0
            && (desiredCompanions.length !== desiredTarget.dependentContainers.length
              || desiredCompanions.some((spec, index) => {
                const dependent = desiredTarget.dependentContainers[index];
                return !DIGEST.test(dependent.requiredStartSpecDigest ?? "")
                  || dependent.containerName !== spec.containerName || dependent.requiredImageId !== spec.requiredImageId
                  || dependent.requiredImageDigest !== spec.image || dependent.requiredConfigDigest !== spec.configDigest
                  || !isDeepStrictEqual(dependent.requiredLabels, spec.requiredLabels);
              })))
          || (migrationBound !== (legacyPreviousTarget != null))
          || (qualificationBound && (previousTarget == null
            || !isDeepStrictEqual(previousTarget, desiredTarget)))) {
        throw new TypeError(`transition target ${index} is invalid`);
      }
      const desiredWorker = await this.#specs.buildStartPayload({ worker: structuredClone(value.desiredWorker) });
      normalizedTargets.push(Object.freeze({
        desiredWorker, desiredTarget, previousTarget, legacyPreviousTarget,
        // Migration plans intentionally omit an empty companion contract. Preserve
        // that canonical representation so the Node Agent does not receive []
        // where the immutable plan binds nil/null.
        ...(!migrationBound || desiredCompanions.length !== 0
          ? { desiredCompanions: Object.freeze(desiredCompanions) }
          : {}),
      }));
    }
    if (new Set(workerIds).size !== workerIds.length
        || workerIds.some((workerId, index) => workerId !== normalizedTargets[index].desiredTarget.workerId)
        || normalizedTargets.some((value, index) => index > 0
          && normalizedTargets[index - 1].desiredTarget.stageOrder >= value.desiredTarget.stageOrder)
        || normalizedTargets.some((value) => value.desiredTarget.dependsOnWorkerIds.some((dependencyWorkerId) => {
          const dependency = normalizedTargets.find((candidate) => candidate.desiredTarget.workerId === dependencyWorkerId);
          return dependency == null || dependency.desiredTarget.stageOrder >= value.desiredTarget.stageOrder;
        })) || (qualificationBound && normalizedFaultInjection != null
          && normalizedTargets.filter((value) => value.desiredTarget.stageOrder === normalizedFaultInjection.stageOrder
            && value.desiredTarget.targetKey === normalizedFaultInjection.targetKey).length !== 1)) {
      throw new TypeError("protected set transition target order is invalid");
    }
    const payload = Object.freeze({
      transactionId, setId, desiredStateRevision, workerIds: Object.freeze([...workerIds]),
      allowedOperations: Object.freeze([...allowedOperations]), operationOrder: Object.freeze([...operationOrder]),
      maintenanceGeneration, issuedAt: issued.toISOString(), expiresAt: expires.toISOString(), journalRevision,
      ...(migrationBound ? { migrationPlanId, migrationPlanDigest } : {}),
      ...(qualificationBound ? { qualificationId, qualificationDigest } : {}),
      ...(normalizedFaultInjection == null ? {} : { faultInjection: normalizedFaultInjection }),
      targets: Object.freeze(normalizedTargets),
    });
    const value = await this.#send({
      type: "protected-set.transaction.execute", payload, authority: input, correlationId,
      issuedAt: issued, deadlineAt: expires, commandId: transactionId,
      // expiresAt bounds when this exact signed command may be accepted. Once
      // accepted, its synchronous execution remains bounded independently by
      // the six immutable create-time health contracts and companion count.
      timeoutMilliseconds: protectedTransitionTimeoutMilliseconds(normalizedTargets),
    });
    if (!value || value.transactionId !== transactionId || value.setId !== setId
        || value.desiredStateRevision !== desiredStateRevision || value.maintenanceGeneration !== maintenanceGeneration
        || value.journalRevision !== journalRevision || value.phase !== "complete" || value.nextOperation !== 0
        || !DIGEST.test(value.planDigest ?? "")) {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid protected set transition state", {
        status: 502, retryable: true,
      });
    }
    return Object.freeze(structuredClone(value));
  }

  async inspectProtectedSetTransition({ transactionId, migrationPlanId, migrationPlanDigest,
    qualificationId, qualificationDigest, protectedTargetPolicyDigest,
    mode, faultInjection = null, correlationId }) {
    const migrationBound = migrationPlanId !== undefined || migrationPlanDigest !== undefined;
    const qualificationBound = qualificationId !== undefined || qualificationDigest !== undefined;
    if (!UUID.test(transactionId ?? "") || migrationBound === qualificationBound
        || (migrationBound && (!TARGET_KEY.test(migrationPlanId ?? "") || !DIGEST.test(migrationPlanDigest ?? "")))
        || (qualificationBound && (!TARGET_KEY.test(qualificationId ?? "") || !DIGEST.test(qualificationDigest ?? "")
          || !DIGEST.test(protectedTargetPolicyDigest ?? "") || mode !== "fault"))
        || !new Set(["fault", "success"]).has(mode)) {
      throw new TypeError("protected set transition inspection binding is invalid");
    }
    const inspectionId = this.#id();
    const value = await this.#send({
      type: "protected-set.transaction.inspect",
      payload: { inspectionId, transactionId,
        ...(migrationBound ? { migrationPlanId, migrationPlanDigest } : { qualificationId, qualificationDigest }), mode },
      authority: { leaseId: inspectionId, fencingToken: 1, nodeGeneration: this.#generation },
      correlationId, commandId: inspectionId, timeoutMilliseconds: 60_000,
    });
    return protectedTransitionInspectionResult(value, {
      nodeId: this.#nodeId, nodeGeneration: this.#generation,
      transactionId, migrationPlanId, migrationPlanDigest, qualificationId, qualificationDigest,
      protectedTargetPolicyDigest, mode,
      faultInjection: mode === "fault" ? transitionFaultInjection(faultInjection ?? {
        stageOrder: 4, targetKey: "office.translation-lmt4", injectionPoint: "after-stage-health",
        failureCode: "protected_set_transition_stage_failed", oneShot: true,
      }) : null,
    });
  }

  async listConflictingWorkers({ exclusiveJobId, authority: input, correlationId }) {
    if (!UUID.test(exclusiveJobId ?? "")) throw new TypeError("exclusive job identity is invalid");
    const value = await this.#send({ type: "worker.conflicts.list", payload: { exclusiveJobId }, authority: input, correlationId });
    if (!Array.isArray(value?.workers) || value.workers.some((worker) => !TARGET_KEY.test(worker?.workerId ?? "")
        || typeof worker.containerName !== "string" || worker.containerName.length < 1 || worker.containerName.length > 128
        || worker.state !== "running" || worker.wasRunning !== true)) {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid conflict workers", { status: 502, retryable: true });
    }
    return value.workers.map((worker) => Object.freeze(structuredClone(worker)));
  }

  async drainConflictingWorker({ exclusiveJobId, targetKey, authority: input, correlationId }) {
    if (!UUID.test(exclusiveJobId ?? "") || !TARGET_KEY.test(targetKey ?? "")) throw new TypeError("exclusive drain identity is invalid");
    const value = await this.#send({ type: "worker.conflict.drain", payload: { exclusiveJobId, targetKey }, authority: input, correlationId,
      timeoutMilliseconds: 50_000 });
    if (value?.workerId !== targetKey || value.state === "running" || value.leasesReleased !== true) {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid drain state", { status: 502, retryable: true });
    }
    return Object.freeze(structuredClone(value));
  }

  async restoreConflictingWorker({ exclusiveJobId, targetKey, authority: input, correlationId }) {
    if (!UUID.test(exclusiveJobId ?? "") || !TARGET_KEY.test(targetKey ?? "")) throw new TypeError("exclusive restore identity is invalid");
    const value = await this.#send({ type: "worker.conflict.restore", payload: { exclusiveJobId, targetKey }, authority: input, correlationId,
      timeoutMilliseconds: 50_000 });
    if (value?.workerId !== targetKey || value.state !== "running") {
      throw new PlatformError("node_agent_protocol_mismatch", "Node Agent returned invalid restore state", { status: 502, retryable: true });
    }
    return Object.freeze(structuredClone(value));
  }

  close() {
    this.#signer.close?.();
    this.#transport.close?.();
  }
}
