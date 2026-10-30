import { isDeepStrictEqual } from "node:util";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { authorizeProtectedResidentOperation } from "./protected-resident-guard.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const IMAGE_REFERENCE = /^(?:[a-z0-9][a-z0-9._:/-]*@)?(sha256:[a-f0-9]{64})$/;
const MAXIMUM_TTL_MILLISECONDS = 15 * 60_000;
const UNLOADED = new Set(["absent", "removed", "stopped", "unloaded"]);
const OPERATIONS = Object.freeze(["protected.stop", "protected.restore", "protected.verify"]);
const TRANSITION_OPERATIONS = Object.freeze(["protected.inspect", "protected.stage", "protected.verify", "protected.commit"]);

function qualificationFault(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "faultInjection,protectedTargetPolicyDigest,qualificationDigest,qualificationId"
      || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.qualificationId ?? "")
      || !SHA256.test(value.qualificationDigest ?? "")
      || !SHA256.test(value.protectedTargetPolicyDigest ?? "")
      || !value.faultInjection
      || Object.keys(value.faultInjection).sort().join(",") !== "failureCode,injectionPoint,oneShot,stageOrder,targetKey"
      || !Number.isSafeInteger(value.faultInjection.stageOrder)
      || value.faultInjection.stageOrder < 1 || value.faultInjection.stageOrder > 32
      || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.faultInjection.targetKey ?? "")
      || value.faultInjection.injectionPoint !== "after-stage-health"
      || value.faultInjection.failureCode !== "protected_set_transition_stage_failed"
      || value.faultInjection.oneShot !== true) {
    throw new TypeError("protected set qualification fault is invalid");
  }
  return Object.freeze(copy(value));
}

function copy(value) {
  return value == null ? null : structuredClone(value);
}

function canonicalTarget(value) {
  if (value == null) return value;
  // Optional empty collections are omitted by older persisted targets and by
  // the Agent's omitempty encoding. Normalize only absence, never actual drift.
  return { ...value,
    dependsOnWorkerIds: value.dependsOnWorkerIds === undefined ? [] : value.dependsOnWorkerIds,
    dependentContainers: value.dependentContainers === undefined ? [] : value.dependentContainers,
  };
}

function fail(code, message, { retryable = false, details = null } = {}) {
  throw new PlatformError(code, message, { status: 409, retryable, details });
}

function instant(value, name) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${name} is invalid`);
  return result;
}

function profile(value, name = "profile") {
  if (!value || !UUID.test(value.workerId ?? "") || !UUID.test(value.modelProfileId ?? "")
      || !SHA256.test(value.imageDigest ?? "") || !SHA256.test(value.configurationDigest ?? "")
      || value.placementClass !== "protected-resident"
      || !Number.isSafeInteger(value.maintenanceGeneration) || value.maintenanceGeneration < 1
      || !Number.isSafeInteger(value.declaredResidentBytes) || value.declaredResidentBytes < 1
      || !Number.isSafeInteger(value.stageOrder) || value.stageOrder < 0
      || !Array.isArray(value.dependsOnWorkerIds) || new Set(value.dependsOnWorkerIds).size !== value.dependsOnWorkerIds.length
      || value.dependsOnWorkerIds.some((workerId) => !UUID.test(workerId ?? "") || workerId === value.workerId)) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({
    workerId: value.workerId,
    modelProfileId: value.modelProfileId,
    imageDigest: value.imageDigest,
    configurationDigest: value.configurationDigest,
    placementClass: "protected-resident",
    maintenanceGeneration: value.maintenanceGeneration,
    declaredResidentBytes: value.declaredResidentBytes,
    dependsOnWorkerIds: Object.freeze([...value.dependsOnWorkerIds]),
    stageOrder: value.stageOrder,
  });
}

function loaded(identity) {
  return identity != null && !UNLOADED.has(identity.state);
}

function desiredIdentity(identity, expected) {
  return identity?.workerId === expected.workerId
    && identity.modelProfileId === expected.modelProfileId
    && identity.imageDigest === expected.imageDigest
    && identity.configurationDigest === expected.configurationDigest
    && identity.placementClass === "protected-resident"
    && identity.maintenanceGeneration === expected.maintenanceGeneration;
}

function binding(value, expected, nodeId, nodeGeneration, { requireExpectedIdentity = true } = {}) {
  const imageMatch = IMAGE_REFERENCE.exec(value?.worker?.image ?? "");
  if (!value || !value.worker || value.worker.workerId !== expected.workerId
      || !UUID.test(value.worker.modelProfileId ?? "") || imageMatch == null
      || value.worker.placementClass !== "protected-resident"
      || !Number.isSafeInteger(value.worker.maintenanceGeneration) || value.worker.maintenanceGeneration < 1
      || !SHA256.test(value.worker.configDigest ?? "")
      || value.worker.nodeId !== nodeId || value.worker.nodeGeneration !== nodeGeneration
      || !UUID.test(value.worker.attemptId ?? "")
      || !UUID.test(value.authority?.leaseId ?? "") || !Number.isSafeInteger(value.authority?.fencingToken)
      || value.authority.fencingToken < 1 || value.authority.nodeGeneration !== nodeGeneration
      || !Number.isSafeInteger(value.residentBytes) || value.residentBytes < 1
      || typeof value.correlationId !== "string" || value.correlationId.length < 8 || value.correlationId.length > 127) {
    throw new TypeError("protected profile Node Agent binding is invalid");
  }
  if (requireExpectedIdentity && (value.worker.modelProfileId !== expected.modelProfileId
      || imageMatch[1] !== expected.imageDigest
      || value.worker.maintenanceGeneration !== expected.maintenanceGeneration
      || value.worker.configDigest !== expected.configurationDigest)) {
    fail("protected_set_runtime_binding_drift", "Node Agent binding does not match the required protected profile identity", {
      details: { workerId: expected.workerId },
    });
  }
  return Object.freeze({
    worker: Object.freeze(copy(value.worker)), authority: Object.freeze(copy(value.authority)),
    ...(value.desiredCompanions == null ? {} : { desiredCompanions: Object.freeze(copy(value.desiredCompanions)) }),
    residentBytes: value.residentBytes, correlationId: value.correlationId,
  });
}

function identityFromState(state, expected, value, { requireExpectedIdentity = true } = {}) {
  const stateImage = IMAGE_REFERENCE.exec(state?.image ?? "");
  const boundImage = IMAGE_REFERENCE.exec(value.worker.image);
  const startedAt = new Date(state?.startedAt);
  const observed = {
    workerId: value.worker.workerId,
    modelProfileId: value.worker.modelProfileId,
    imageDigest: boundImage?.[1],
    configurationDigest: value.worker.configDigest,
    placementClass: value.worker.placementClass,
    maintenanceGeneration: value.worker.maintenanceGeneration,
  };
  if (!state || state.workerId !== observed.workerId || state.modelProfileId !== observed.modelProfileId
      || stateImage?.[1] !== observed.imageDigest
      || state.placementClass !== observed.placementClass
      || state.maintenanceGeneration !== observed.maintenanceGeneration
      || state.configDigest !== observed.configurationDigest
      || !CONTAINER_ID.test(state.containerId ?? "")
      || !Number.isFinite(startedAt.getTime())
      || typeof state.status !== "string" || state.status.length < 1
      || typeof state.health !== "string" || state.health.length < 1
      || (requireExpectedIdentity && !desiredIdentity(observed, expected))) {
    fail("protected_set_runtime_identity_drift", "Node Agent reported a different protected profile identity", {
      details: { workerId: expected.workerId },
    });
  }
  return Object.freeze({
    ...observed,
    containerId: state.containerId,
    startedAt: startedAt.toISOString(),
    state: state.status,
    healthy: state.status === "running" && state.health === "healthy",
    residentBytes: value.residentBytes,
  });
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameProfileIdentity(left, right) {
  return left.workerId === right.workerId
    && left.modelProfileId === right.modelProfileId
    && left.imageDigest === right.imageDigest
    && left.configurationDigest === right.configurationDigest
    && left.placementClass === right.placementClass
    && left.maintenanceGeneration === right.maintenanceGeneration
    && left.declaredResidentBytes === right.declaredResidentBytes
    && left.stageOrder === right.stageOrder
    && sameStrings(left.dependsOnWorkerIds, right.dependsOnWorkerIds);
}

/**
 * Narrow Scheduler-to-Agent boundary for task 21.2.
 *
 * Cold boot and successor reconciliation use one dependency-ordered,
 * Node-Agent-journaled full-set transition. A loaded successor is never
 * replaced through ordinary Worker lifecycle authority: the transition keeps
 * every exact prior image/config identity until the complete desired set is
 * healthy, while the separate maintenance transaction remains a bounded
 * stop/restore/probe operation over the current complete set.
 */
export class ProtectedOfficeSetNodeAgentRuntime {
  #router;
  #nodeId;
  #nodeGeneration;
  #bindings;
  #targets;
  #protectedSet;
  #maintenanceAuthorizer;
  #clock;

  constructor({ nodeAgentRouter, nodeId, nodeGeneration, bindingFactory,
    maintenanceTargetFactory, protectedSetProvider, maintenanceAuthorizer = null, clock = () => new Date() }) {
    if (!nodeAgentRouter || ["startWorker", "workerHealth", "executeProtectedMaintenanceTransaction", "executeProtectedSetTransition"]
      .some((method) => typeof nodeAgentRouter[method] !== "function")
      || !UUID.test(nodeId ?? "") || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1
      || typeof bindingFactory !== "function" || typeof maintenanceTargetFactory !== "function"
      || typeof protectedSetProvider !== "function"
      || (maintenanceAuthorizer != null && typeof maintenanceAuthorizer !== "function")
      || typeof clock !== "function") {
      throw new TypeError("protected office-set Node Agent runtime dependencies are incomplete");
    }
    this.#router = nodeAgentRouter;
    this.#nodeId = nodeId;
    this.#nodeGeneration = nodeGeneration;
    this.#bindings = bindingFactory;
    this.#targets = maintenanceTargetFactory;
    this.#protectedSet = protectedSetProvider;
    this.#maintenanceAuthorizer = maintenanceAuthorizer;
    this.#clock = clock;
  }

  async #binding(expected, previousIdentity = null, { purpose, requireExpectedIdentity = true }) {
    const value = await this.#bindings({
      profile: copy(expected), previousIdentity: copy(previousIdentity), purpose,
    });
    return binding(value, previousIdentity ?? expected, this.#nodeId, this.#nodeGeneration, {
      requireExpectedIdentity,
    });
  }

  async #inspect(expected, previousIdentity = null, { purpose, requireExpectedIdentity = true }) {
    const value = await this.#binding(expected, previousIdentity, { purpose, requireExpectedIdentity });
    let state;
    try {
      state = await this.#router.workerHealth({
        workerId: value.worker.workerId, nodeId: this.#nodeId, authority: value.authority,
        correlationId: value.correlationId,
      });
    } catch (error) {
      if (error?.code !== "managed_worker_not_found") throw error;
      return Object.freeze({
        workerId: (previousIdentity ?? expected).workerId,
        modelProfileId: (previousIdentity ?? expected).modelProfileId,
        imageDigest: (previousIdentity ?? expected).imageDigest,
        configurationDigest: (previousIdentity ?? expected).configurationDigest,
        placementClass: "protected-resident",
        maintenanceGeneration: (previousIdentity ?? expected).maintenanceGeneration,
        state: "absent", healthy: false, residentBytes: 0,
      });
    }
    return identityFromState(state, previousIdentity ?? expected, value, { requireExpectedIdentity });
  }

  async inspectProtectedProfile({ profile: input }) {
    // Inspection must report the actually bound identity, including an older
    // healthy revision. Requiring the desired identity here would turn a
    // legitimate maintenance decision into an opaque protocol error and
    // prevent the coordinator from invoking its complete-set authorization.
    return this.#inspect(profile(input), null, { purpose: "inspect", requireExpectedIdentity: false });
  }

  async stageProtectedProfile({ transactionId, maintenanceGeneration, profile: input, previousIdentity = null }) {
    const expected = profile(input);
    if (maintenanceGeneration !== expected.maintenanceGeneration || !UUID.test(transactionId ?? "")) {
      throw new TypeError("protected profile stage transaction is invalid");
    }
    if (loaded(previousIdentity)) {
      if (!desiredIdentity(previousIdentity, expected)) {
        fail("protected_successor_requires_declarative_cutover",
          "A loaded protected successor cannot be staged through an ordinary Worker start or the prior-identity maintenance transaction",
          { details: { workerId: expected.workerId, transactionId } });
      }
      return Object.freeze(copy(previousIdentity));
    }
    const value = await this.#binding(expected, null, { purpose: "stage", requireExpectedIdentity: true });
    const state = await this.#router.startWorker({
      worker: value.worker, authority: value.authority, correlationId: value.correlationId,
    });
    return identityFromState(state, expected, value, { requireExpectedIdentity: true });
  }

  async probeProtectedProfile({ transactionId, maintenanceGeneration, profile: input }) {
    const expected = profile(input);
    if (maintenanceGeneration !== expected.maintenanceGeneration || !UUID.test(transactionId ?? "")) {
      throw new TypeError("protected profile probe transaction is invalid");
    }
    return this.#inspect(expected, null, { purpose: "probe", requireExpectedIdentity: true });
  }

  async restoreProtectedProfile({ transactionId, maintenanceGeneration, profile: input, previousIdentity = null }) {
    const expected = profile(input);
    if (maintenanceGeneration !== expected.maintenanceGeneration || !UUID.test(transactionId ?? "")) {
      throw new TypeError("protected profile restore transaction is invalid");
    }
    if (!loaded(previousIdentity)) {
      const current = await this.#inspect(expected, null, { purpose: "rollback-verify", requireExpectedIdentity: false });
      if (loaded(current)) {
        fail("protected_set_atomic_rollback_required",
          "The Node Agent protected-set transaction did not clean a partially started cold-boot identity",
          { details: { workerId: expected.workerId, transactionId } });
      }
      return current;
    }
    // No mutation is attempted here. This proves that a rejected successor
    // left the exact previous identity intact; actual stop/restore authority is
    // available only through executeProtectedSetMaintenance below.
    return this.#inspect(expected, previousIdentity, { purpose: "restore", requireExpectedIdentity: true });
  }

  async #target(expected, previousIdentity, purpose) {
    const source = previousIdentity == null ? expected : {
      ...expected,
      modelProfileId: previousIdentity.modelProfileId,
      imageDigest: previousIdentity.imageDigest,
      configurationDigest: previousIdentity.configurationDigest,
      maintenanceGeneration: previousIdentity.maintenanceGeneration,
    };
    const value = copy(await this.#targets({
      profile: copy(source), previousIdentity: copy(previousIdentity), purpose,
    }));
    const imageMatch = IMAGE_REFERENCE.exec(value?.requiredImageDigest ?? "");
    if (!value || value.workerId !== source.workerId || value.modelProfileId !== source.modelProfileId
        || value.placementClass !== "protected-resident" || value.maintenanceGeneration !== source.maintenanceGeneration
        || value.requiredConfigDigest !== source.configurationDigest || imageMatch?.[1] !== source.imageDigest
        || value.stageOrder !== expected.stageOrder
        || !sameStrings(value.dependsOnWorkerIds ?? [], expected.dependsOnWorkerIds)) {
      fail("protected_transition_target_drift", "Node Agent transition target does not match the declared identity", {
        details: { workerId: expected.workerId, purpose },
      });
    }
    return value;
  }

  // Performs one Node Agent-journaled transition for the entire dependency-
  // ordered set. Per-profile stage/restore methods remain read/compatibility
  // boundaries only; the coordinator never uses them to mutate production.
  async transitionProtectedSet({ transactionId, setId, desiredStateRevision, maintenanceGeneration,
    profiles: inputProfiles, previousIdentities, maintenanceContext = null, journalRevision,
    qualificationFault: inputQualificationFault = null }) {
    if (!UUID.test(transactionId ?? "") || typeof setId !== "string" || setId.length < 3
        || !Number.isSafeInteger(desiredStateRevision) || desiredStateRevision < 1
        || (journalRevision != null && (!Number.isSafeInteger(journalRevision) || journalRevision < 1))
        || !Array.isArray(inputProfiles) || inputProfiles.length < 1 || inputProfiles.length > 32) {
      throw new TypeError("protected set transition is invalid");
    }
    const profiles = inputProfiles.map((value, index) => profile(value, `profiles[${index}]`));
    const qualification = qualificationFault(inputQualificationFault);
    if (profiles.some((value) => value.maintenanceGeneration !== maintenanceGeneration)) {
      throw new TypeError("protected set transition generation is invalid");
    }
    const authoritative = await this.#protectedSet({ nodeId: this.#nodeId });
    const authoritativeProfiles = Array.isArray(authoritative?.profiles)
      ? authoritative.profiles.map((value, index) => profile(value, `protectedSet.profiles[${index}]`)) : [];
    const authoritativeByWorker = new Map(authoritativeProfiles.map((value) => [value.workerId, value]));
    if (authoritative?.maintenanceGeneration !== maintenanceGeneration
        || authoritativeProfiles.length !== profiles.length || authoritativeByWorker.size !== profiles.length
        || profiles.some((value) => !sameProfileIdentity(value, authoritativeByWorker.get(value.workerId) ?? {}))) {
      fail("protected_transition_set_drift", "Protected transition must bind the complete authoritative set");
    }
    const now = instant(this.#clock(), "clock");
    const issuedAt = maintenanceContext == null ? now : instant(maintenanceContext.issuedAt, "maintenanceContext.issuedAt");
    const expiresAt = maintenanceContext == null
      ? new Date(now.getTime() + MAXIMUM_TTL_MILLISECONDS)
      : instant(maintenanceContext.expiresAt, "maintenanceContext.expiresAt");
    if (issuedAt.getTime() > now.getTime() + 1_000 || expiresAt.getTime() <= now.getTime()
        || expiresAt.getTime() <= issuedAt.getTime() || expiresAt.getTime() - issuedAt.getTime() > MAXIMUM_TTL_MILLISECONDS) {
      fail("protected_resident_maintenance_scope_mismatch", "Protected transition window is invalid");
    }
    const changedLoaded = profiles.filter((expected) => loaded(previousIdentities?.[expected.workerId])
      && !desiredIdentity(previousIdentities[expected.workerId], expected));
    if (qualification != null && profiles.some((expected) => {
      const previous = previousIdentities?.[expected.workerId];
      return !loaded(previous) || previous.healthy !== true || !desiredIdentity(previous, expected);
    })) {
      fail("protected_set_qualification_baseline_drift",
        "Protected-set qualification requires every exact healthy canonical previous identity");
    }
    if (changedLoaded.length > 0 || qualification != null) {
      await authorizeProtectedResidentOperation({
        workers: profiles.map((value) => ({ workerId: value.workerId, placementClass: value.placementClass,
          maintenanceGeneration: value.maintenanceGeneration })),
        operation: "protected-set.maintenance", maintenanceContext,
        maintenanceAuthorizer: this.#maintenanceAuthorizer, now,
        maximumTtlMilliseconds: MAXIMUM_TTL_MILLISECONDS,
      });
    }
    const targets = [];
    const fencingTokens = [];
    for (const expected of profiles) {
      const previousIdentity = previousIdentities?.[expected.workerId] ?? null;
      const desiredBinding = await this.#binding(expected, null, { purpose: "transition", requireExpectedIdentity: true });
      fencingTokens.push(desiredBinding.authority.fencingToken);
      const desiredTarget = await this.#target(expected, null, "desired");
      const previousTarget = loaded(previousIdentity)
        ? await this.#target(expected, previousIdentity, "previous") : null;
      if (qualification != null && !isDeepStrictEqual(canonicalTarget(previousTarget), canonicalTarget(desiredTarget))) {
        fail("protected_set_qualification_baseline_drift",
          "Protected-set qualification previous target differs from the canonical desired target");
      }
      targets.push({ desiredWorker: desiredBinding.worker, desiredTarget, previousTarget,
        ...(desiredBinding.desiredCompanions == null ? {} : { desiredCompanions: desiredBinding.desiredCompanions }) });
    }
    const resolvedJournalRevision = journalRevision ?? Math.max(...fencingTokens);
    targets.sort((left, right) => left.desiredTarget.stageOrder - right.desiredTarget.stageOrder
      || left.desiredTarget.targetKey.localeCompare(right.desiredTarget.targetKey));
    const response = await this.#router.executeProtectedSetTransition({
      nodeId: this.#nodeId, nodeGeneration: this.#nodeGeneration, transactionId, setId, desiredStateRevision,
      workerIds: targets.map((value) => value.desiredTarget.workerId),
      allowedOperations: ["protected-set.transition"], operationOrder: [...TRANSITION_OPERATIONS],
      maintenanceGeneration, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(),
      journalRevision: resolvedJournalRevision,
      ...(qualification == null ? {} : {
        qualificationId: qualification.qualificationId,
        qualificationDigest: qualification.qualificationDigest,
        faultInjection: qualification.faultInjection,
      }),
      targets, correlationId: `protected-transition:${transactionId}`,
    });
    this.#bindings.recordTransition?.({
      transactionId,
      journalRevision: response.journalRevision,
      profiles: copy(profiles),
      previousIdentities: copy(previousIdentities),
    });
    return response;
  }

  async inspectProtectedSetQualificationFault({ transactionId, qualificationId, qualificationDigest,
    protectedTargetPolicyDigest, faultInjection }) {
    if (typeof this.#router.inspectProtectedSetTransition !== "function") {
      throw new TypeError("managed Node Agent router lacks protected set qualification inspection");
    }
    const qualification = qualificationFault({ qualificationId, qualificationDigest,
      protectedTargetPolicyDigest, faultInjection });
    return this.#router.inspectProtectedSetTransition({
      nodeId: this.#nodeId, nodeGeneration: this.#nodeGeneration, transactionId,
      qualificationId: qualification.qualificationId,
      qualificationDigest: qualification.qualificationDigest,
      protectedTargetPolicyDigest: qualification.protectedTargetPolicyDigest,
      mode: "fault", faultInjection: qualification.faultInjection,
      correlationId: `protected-transition-inspect:${transactionId}`,
    });
  }

  async executeProtectedSetMaintenance({ profiles: inputProfiles, maintenanceContext, journalRevision }) {
    if (!Array.isArray(inputProfiles) || inputProfiles.length < 1 || inputProfiles.length > 32) {
      throw new TypeError("protected maintenance profile set is invalid");
    }
    const profiles = inputProfiles.map((value, index) => profile(value, `profiles[${index}]`));
    const generations = [...new Set(profiles.map((value) => value.maintenanceGeneration))];
    const completeWorkerIds = profiles.map((value) => value.workerId).sort();
    const authoritative = await this.#protectedSet({ nodeId: this.#nodeId });
    const authoritativeProfiles = Array.isArray(authoritative?.profiles)
      ? authoritative.profiles.map((value, index) => profile(value, `protectedSet.profiles[${index}]`)) : [];
    const authoritativeByWorker = new Map(authoritativeProfiles.map((value) => [value.workerId, value]));
    const issuedAt = instant(maintenanceContext?.issuedAt, "maintenanceContext.issuedAt");
    const expiresAt = instant(maintenanceContext?.expiresAt, "maintenanceContext.expiresAt");
    const now = instant(this.#clock(), "clock");
    if (generations.length !== 1 || authoritativeProfiles.length < 1
        || authoritativeByWorker.size !== authoritativeProfiles.length
        || new Set(authoritativeProfiles.map((value) => value.modelProfileId)).size !== authoritativeProfiles.length
        || authoritativeProfiles.length !== profiles.length
        || authoritative?.maintenanceGeneration !== generations[0]
        || profiles.some((value) => !sameProfileIdentity(value, authoritativeByWorker.get(value.workerId) ?? {}))
        || !maintenanceContext || !UUID.test(maintenanceContext.transactionId ?? "")
        || !Array.isArray(maintenanceContext.workerIds) || new Set(maintenanceContext.workerIds).size !== maintenanceContext.workerIds.length
        || !sameStrings([...maintenanceContext.workerIds].sort(), completeWorkerIds)
        || !Array.isArray(maintenanceContext.allowedOperations) || maintenanceContext.allowedOperations.length !== 1
        || maintenanceContext.allowedOperations[0] !== "protected-set.maintenance"
        || maintenanceContext.maintenanceGeneration !== generations[0]
        || issuedAt.getTime() > now.getTime() + 1_000 || expiresAt.getTime() <= now.getTime()
        || expiresAt.getTime() <= issuedAt.getTime() || expiresAt.getTime() - issuedAt.getTime() > MAXIMUM_TTL_MILLISECONDS
        || !Number.isSafeInteger(journalRevision) || journalRevision < 1) {
      fail("protected_resident_maintenance_scope_mismatch",
        "Protected maintenance must bind the exact complete protected office set and bounded generation");
    }
    // This verifies the administrator/control-plane signature over the exact
    // full set. The Node Agent client subsequently HMAC-signs the same bounded
    // facts for the mTLS command hop; neither proof substitutes for the other.
    await authorizeProtectedResidentOperation({
      workers: profiles.map((value) => ({
        workerId: value.workerId,
        placementClass: value.placementClass,
        maintenanceGeneration: value.maintenanceGeneration,
      })),
      operation: "protected-set.maintenance",
      maintenanceContext,
      maintenanceAuthorizer: this.#maintenanceAuthorizer,
      now,
      maximumTtlMilliseconds: MAXIMUM_TTL_MILLISECONDS,
    });
    const targets = [];
    for (const expected of profiles) {
      const value = copy(await this.#targets({ profile: copy(expected), purpose: "maintenance" }));
      const imageMatch = IMAGE_REFERENCE.exec(value?.requiredImageDigest ?? "");
      if (!value || value.workerId !== expected.workerId || value.modelProfileId !== expected.modelProfileId
          || value.placementClass !== "protected-resident" || value.maintenanceGeneration !== expected.maintenanceGeneration
          || value.requiredConfigDigest !== expected.configurationDigest || imageMatch?.[1] !== expected.imageDigest
          || value.stageOrder !== expected.stageOrder
          || !sameStrings(value.dependsOnWorkerIds ?? [], expected.dependsOnWorkerIds)) {
        fail("protected_maintenance_target_drift", "Node Agent maintenance target does not match the protected manifest", {
          details: { workerId: expected.workerId },
        });
      }
      targets.push(value);
    }
    targets.sort((left, right) => right.stageOrder - left.stageOrder || left.targetKey.localeCompare(right.targetKey));
    return this.#router.executeProtectedMaintenanceTransaction({
      nodeId: this.#nodeId,
      nodeGeneration: this.#nodeGeneration,
      transactionId: maintenanceContext.transactionId,
      workerIds: targets.map((value) => value.workerId),
      allowedOperations: ["protected-set.maintenance"],
      operationOrder: [...OPERATIONS],
      maintenanceGeneration: generations[0],
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      journalRevision,
      targets,
      correlationId: `protected-maintenance:${maintenanceContext.transactionId}`,
    });
  }
}
