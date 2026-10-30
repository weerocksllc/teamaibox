import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { authorizeProtectedResidentOperation } from "./protected-resident-guard.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/;
const TERMINAL_TRANSACTION_STATES = new Set(["succeeded", "rolled-back"]);
const UNLOADED_STATES = new Set(["absent", "stopped", "unloaded"]);
const MAXIMUM_MEMORY_EVIDENCE_AGE_MILLISECONDS = 15_000;
function copy(value) {
  return value == null ? null : structuredClone(value);
}

function fail(code, message, { status = 409, retryable = false, details = null, cause } = {}) {
  throw new PlatformError(code, message, { status, retryable, details, cause });
}

function instant(value, name) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return result;
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function stable(value, name) {
  if (typeof value !== "string" || !STABLE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function exactIdentity(value) {
  if (value == null) return null;
  return Object.freeze({
    workerId: value.workerId ?? value.worker_id,
    modelProfileId: value.modelProfileId ?? value.model_profile_id,
    imageDigest: value.imageDigest ?? value.image_digest ?? value.image,
    configurationDigest: value.configurationDigest ?? value.configuration_digest,
    placementClass: value.placementClass ?? value.placement_class ?? "protected-resident",
    maintenanceGeneration: value.maintenanceGeneration ?? value.maintenance_generation,
    state: value.state ?? value.lifecycleState ?? value.lifecycle_state ?? "unknown",
    healthy: value.healthy === true,
    residentBytes: value.residentBytes ?? value.resident_bytes ?? 0,
  });
}

function matchesDesired(identity, profile) {
  return identity?.workerId === profile.workerId
    && identity.modelProfileId === profile.modelProfileId
    && identity.imageDigest === profile.imageDigest
    && identity.configurationDigest === profile.configurationDigest
    && identity.placementClass === "protected-resident"
    && identity.maintenanceGeneration === profile.maintenanceGeneration
    && identity.healthy === true
    && !UNLOADED_STATES.has(identity.state);
}

function normalizeProfile(value, index, generation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`profiles[${index}] is invalid`);
  const placementClass = value.placementClass ?? value.placement_class;
  const maintenanceGeneration = value.maintenanceGeneration ?? value.maintenance_generation;
  const dependsOnWorkerIds = value.dependsOnWorkerIds ?? value.depends_on_worker_ids ?? [];
  const imageDigest = value.imageDigest ?? value.image_digest ?? value.image;
  const configurationDigest = value.configurationDigest ?? value.configuration_digest;
  const declaredResidentBytes = value.declaredResidentBytes ?? value.declared_resident_bytes
    ?? value.resourceEnvelope?.residentBytes ?? value.resource_envelope?.resident_bytes;
  if (placementClass !== "protected-resident") throw new TypeError(`profiles[${index}].placementClass must be protected-resident`);
  if (maintenanceGeneration !== generation) throw new TypeError(`profiles[${index}].maintenanceGeneration is stale`);
  if (!SHA256.test(imageDigest ?? "") || !SHA256.test(configurationDigest ?? "")) {
    throw new TypeError(`profiles[${index}] must pin image and configuration digests`);
  }
  if (!Array.isArray(dependsOnWorkerIds) || new Set(dependsOnWorkerIds).size !== dependsOnWorkerIds.length
      || dependsOnWorkerIds.some((item) => !STABLE_ID.test(item ?? ""))) {
    throw new TypeError(`profiles[${index}].dependsOnWorkerIds is invalid`);
  }
  const stageOrder = value.stageOrder ?? value.stage_order ?? index;
  if (!Number.isSafeInteger(stageOrder) || stageOrder < 0) {
    throw new TypeError(`profiles[${index}].stageOrder is invalid`);
  }
  return Object.freeze({
    modelProfileId: stable(value.modelProfileId ?? value.model_profile_id, `profiles[${index}].modelProfileId`),
    workerId: stable(value.workerId ?? value.worker_id, `profiles[${index}].workerId`),
    imageDigest,
    configurationDigest,
    placementClass,
    maintenanceGeneration,
    declaredResidentBytes: positive(declaredResidentBytes, `profiles[${index}].declaredResidentBytes`),
    dependsOnWorkerIds: Object.freeze([...dependsOnWorkerIds]),
    stageOrder,
  });
}

function dependencyOrder(profiles) {
  const byWorker = new Map(profiles.map((profile) => [profile.workerId, profile]));
  for (const profile of profiles) {
    if (profile.dependsOnWorkerIds.includes(profile.workerId)
        || profile.dependsOnWorkerIds.some((workerId) => !byWorker.has(workerId))) {
      fail("protected_set_dependency_invalid", "Protected office set has an invalid dependency", {
        details: { workerId: profile.workerId },
      });
    }
  }
  const pending = new Set(profiles.map((profile) => profile.workerId));
  const complete = new Set();
  const ordered = [];
  while (pending.size > 0) {
    const ready = profiles.filter((profile) => pending.has(profile.workerId)
      && profile.dependsOnWorkerIds.every((workerId) => complete.has(workerId)))
      .sort((left, right) => left.stageOrder - right.stageOrder || left.workerId.localeCompare(right.workerId));
    if (ready.length === 0) fail("protected_set_dependency_cycle", "Protected office set dependency graph is cyclic");
    for (const profile of ready) {
      pending.delete(profile.workerId);
      complete.add(profile.workerId);
      ordered.push(profile);
    }
  }
  return Object.freeze(ordered);
}

function normalizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("protected office set manifest is invalid");
  const maintenanceGeneration = positive(
    value.maintenanceGeneration ?? value.maintenance_generation,
    "maintenanceGeneration",
  );
  const profiles = (value.profiles ?? []).map((profile, index) => normalizeProfile(profile, index, maintenanceGeneration));
  if (profiles.length < 1 || new Set(profiles.map((profile) => profile.workerId)).size !== profiles.length
      || new Set(profiles.map((profile) => profile.modelProfileId)).size !== profiles.length) {
    throw new TypeError("protected office set profiles must be non-empty and unique");
  }
  const required = value.requiredModelProfileIds ?? value.required_model_profile_ids;
  if (!Array.isArray(required) || required.length !== profiles.length || new Set(required).size !== required.length
      || [...required].sort().some((profileId, index) => profileId !== profiles.map((profile) => profile.modelProfileId).sort()[index])) {
    fail("protected_set_incomplete", "Protected office set manifest does not contain the complete required profile set");
  }
  const declaredResidentBytes = profiles.reduce((total, profile) => total + profile.declaredResidentBytes, 0);
  if (!Number.isSafeInteger(declaredResidentBytes)) throw new TypeError("Model memory description exceeds numeric bounds");
  return Object.freeze({
    setId: stable(value.setId ?? value.set_id, "setId"),
    nodeId: stable(value.nodeId ?? value.node_id, "nodeId"),
    desiredStateRevision: positive(value.desiredStateRevision ?? value.desired_state_revision, "desiredStateRevision"),
    maintenanceGeneration,
    profiles: dependencyOrder(profiles),
    requiredModelProfileIds: Object.freeze([...required].sort()),
    declaredResidentBytes,
  });
}

function observedHost(snapshot, now) {
  const host = snapshot?.host ?? snapshot;
  const totalBytes = host?.totalBytes ?? host?.total_bytes;
  const availableBytes = host?.availableBytes ?? host?.available_bytes;
  positive(totalBytes, "memorySnapshot.host.totalBytes");
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 || availableBytes > totalBytes) {
    throw new TypeError("memorySnapshot.host.availableBytes is invalid");
  }
  let observedAt;
  let hostObservedAt;
  try {
    observedAt = instant(snapshot?.observedAt ?? snapshot?.observed_at, "memorySnapshot.observedAt");
    hostObservedAt = instant(host?.observedAt ?? host?.observed_at, "memorySnapshot.host.observedAt");
  } catch (error) {
    fail("protected_set_memory_evidence_stale", "Protected-set memory evidence is missing or stale", {
      retryable: true, cause: error,
    });
  }
  if (now - observedAt > MAXIMUM_MEMORY_EVIDENCE_AGE_MILLISECONDS
      || now - hostObservedAt > MAXIMUM_MEMORY_EVIDENCE_AGE_MILLISECONDS
      || observedAt - now > 1_000 || hostObservedAt - now > 1_000) {
    fail("protected_set_memory_evidence_stale", "Protected-set memory evidence is missing or stale", { retryable: true });
  }
  return { totalBytes, availableBytes };
}

function runtimeIsLoaded(identity) {
  return identity != null && !UNLOADED_STATES.has(identity.state);
}

function residentBytes(identities) {
  return identities.reduce((total, identity) => total + (identity?.residentBytes ?? 0), 0);
}

/**
 * Orchestrates the Scheduler half of a protected office-set transaction.
 * `runtime` is deliberately a narrow boundary: a deployment adapter maps the
 * four exact-identity operations to signed Node Agent transaction commands.
 */
export class ProtectedOfficeSetCoordinator {
  #repository;
  #runtime;
  #memorySnapshots;
  #memoryGuard;
  #placementRepository;
  #maintenanceAuthorizer;
  #coreServiceProbe;
  #clock;
  #idFactory;

  constructor({
    repository,
    runtime,
    memorySnapshotProvider,
    memoryGuard = null,
    placementRepository = null,
    maintenanceAuthorizer = null,
    coreServiceProbe = async () => ({ healthy: true }),
    clock = () => new Date(),
    idFactory = randomUUID,
  }) {
    const repositoryMethods = ["beginTransaction", "getTransaction", "updateTransaction", "commitTransactionAndSetState",
      "listIncompleteTransactions", "getSetState", "putSetState"];
    const runtimeMethods = ["inspectProtectedProfile", "transitionProtectedSet", "probeProtectedProfile", "restoreProtectedProfile"];
    if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function")
        || !runtime || runtimeMethods.some((method) => typeof runtime[method] !== "function")
        || typeof memorySnapshotProvider?.snapshot !== "function"
        || (memoryGuard != null && typeof memoryGuard.evaluate !== "function")
        || (placementRepository != null && typeof placementRepository.getModelProfilePlacement !== "function")
        || (maintenanceAuthorizer != null && typeof maintenanceAuthorizer !== "function")
        || typeof coreServiceProbe !== "function" || typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("protected office set coordinator dependencies are incomplete");
    }
    this.#repository = repository;
    this.#runtime = runtime;
    this.#memorySnapshots = memorySnapshotProvider;
    this.#memoryGuard = memoryGuard;
    this.#placementRepository = placementRepository;
    this.#maintenanceAuthorizer = maintenanceAuthorizer;
    this.#coreServiceProbe = coreServiceProbe;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  async #update(transaction, patch) {
    const next = await this.#repository.updateTransaction(transaction.transactionId, transaction.revision, {
      ...copy(patch), updatedAt: instant(this.#clock(), "clock").toISOString(),
    });
    if (!next) fail("protected_set_transaction_missing", "Protected-set transaction journal disappeared", { status: 503, retryable: false });
    return next;
  }

  async #writeSetState(manifest, current, value) {
    return this.#repository.putSetState(manifest.setId, current?.revision ?? 0, {
      nodeId: manifest.nodeId,
      desiredStateRevision: manifest.desiredStateRevision,
      maintenanceGeneration: manifest.maintenanceGeneration,
      ...copy(value),
      updatedAt: instant(this.#clock(), "clock").toISOString(),
      createdAt: current?.createdAt ?? instant(this.#clock(), "clock").toISOString(),
    });
  }

  async #assertPlacements(manifest) {
    if (!this.#placementRepository) return;
    for (const profile of manifest.profiles) {
      const placement = await this.#placementRepository.getModelProfilePlacement(profile.modelProfileId);
      if (!placement || placement.profile?.placementClass !== "protected-resident"
          || placement.profile.maintenanceGeneration !== manifest.maintenanceGeneration
          || placement.currentRevision?.configurationDigest !== profile.configurationDigest
          || placement.currentRevision?.maintenanceGeneration !== manifest.maintenanceGeneration) {
        fail("protected_set_placement_stale", "Protected office set placement is missing or stale", {
          details: { modelProfileId: profile.modelProfileId },
        });
      }
    }
  }

  async #assertCoreHealthy(manifest, phase) {
    let probe;
    try {
      probe = await this.#coreServiceProbe({ nodeId: manifest.nodeId, setId: manifest.setId, phase });
    } catch (error) {
      fail("protected_set_core_probe_failed", "Core-service health probe failed", { status: 503, retryable: true, cause: error });
    }
    if (probe?.healthy !== true) {
      fail("protected_set_core_unhealthy", "Core services are not healthy during protected-set staging", {
        status: 503, retryable: true, details: { phase },
      });
    }
    return copy(probe);
  }

  async #observeHost(manifest) {
    const snapshot = await this.#memorySnapshots.snapshot({nodeId:manifest.nodeId});
    const host = observedHost(snapshot, instant(this.#clock(), "clock"));
    // Observe real memory/health only. Model estimates do not book capacity or
    // prevent a healthy independent application from starting.
    if (this.#memoryGuard) this.#memoryGuard.evaluate({...copy(snapshot),nodeId:manifest.nodeId});
    return Object.freeze({snapshot:copy(snapshot),host});
  }

  async #rollback(transaction, manifest, previousIdentities, reasonCode) {
    transaction = await this.#update(transaction, { state: "rolling-back", failureCode: reasonCode });
    const failures = [];
    for (const profile of [...manifest.profiles].reverse()) {
      const attempt = 1 + (transaction.recoverySteps ?? [])
        .filter((step) => step.workerId === profile.workerId).length;
      try {
        await this.#runtime.restoreProtectedProfile({
          transactionId: transaction.transactionId,
          maintenanceGeneration: manifest.maintenanceGeneration,
          profile: copy(profile),
          previousIdentity: copy(previousIdentities[profile.workerId] ?? null),
        });
        transaction = await this.#update(transaction, {
          recoverySteps: [...(transaction.recoverySteps ?? []), {
            workerId: profile.workerId, attempt, state: "restored",
          }],
        });
      } catch (error) {
        failures.push({ workerId: profile.workerId, errorCode: error?.code ?? "protected_set_restore_failed" });
        transaction = await this.#update(transaction, {
          recoverySteps: [...(transaction.recoverySteps ?? []), {
            workerId: profile.workerId, attempt, state: "failed",
            errorCode: error?.code ?? "protected_set_restore_failed",
          }],
        });
      }
    }
    const priorState = await this.#repository.getSetState(manifest.setId);
    if (failures.length > 0) {
      const preserved = copy(priorState?.healthyIdentities ?? []);
      transaction = await this.#update(transaction, { state: "recovery-required", recoveryFailures: failures });
      await this.#writeSetState(manifest, priorState, {
        observedStateRevision: priorState?.observedStateRevision ?? 0,
        recoveryState: "manual-recovery",
        recoveryReasonCode: "protected_set_rollback_incomplete",
        healthyIdentities: preserved,
        aggregateResidentBytes: residentBytes(preserved),
        lastTransactionId: transaction.transactionId,
      });
      fail("protected_set_rollback_incomplete", "Protected office set rollback requires recovery", {
        status: 503, retryable: false, details: { transactionId: transaction.transactionId, failures },
      });
    }
    const committedAt = instant(this.#clock(), "clock").toISOString();
    const restored = copy(priorState?.healthyIdentities
      ?? Object.values(previousIdentities).filter((identity) => identity?.healthy === true));
    const committed = await this.#repository.commitTransactionAndSetState({
      transactionId: transaction.transactionId,
      expectedTransactionRevision: transaction.revision,
      transactionPatch: { state: "rolled-back", completedAt: committedAt, updatedAt: committedAt },
      setId: manifest.setId,
      expectedSetRevision: priorState?.revision ?? 0,
      setState: {
        nodeId: manifest.nodeId,
        desiredStateRevision: manifest.desiredStateRevision,
        maintenanceGeneration: manifest.maintenanceGeneration,
        observedStateRevision: priorState?.observedStateRevision ?? 0,
        recoveryState: "degraded",
        recoveryReasonCode: reasonCode,
        healthyIdentities: restored,
        aggregateResidentBytes: residentBytes(restored),
        lastTransactionId: transaction.transactionId,
        updatedAt: committedAt,
        createdAt: priorState?.createdAt ?? committedAt,
      },
    });
    return committed.transaction;
  }

  async boot({ manifest: input, maintenanceContext = null, qualificationFault = null }) {
    const manifest = normalizeManifest(input);
    await this.#assertPlacements(manifest);
    const priorState = await this.#repository.getSetState(manifest.setId);
    const previousIdentities = {};
    for (const profile of manifest.profiles) {
      previousIdentities[profile.workerId] = exactIdentity(await this.#runtime.inspectProtectedProfile({ profile: copy(profile) }));
    }
    const exact = manifest.profiles.every((profile) => matchesDesired(previousIdentities[profile.workerId], profile));
    if (qualificationFault != null && !exact) {
      fail("protected_set_qualification_baseline_drift",
        "Protected-set qualification requires the exact healthy canonical set");
    }
    await this.#assertCoreHealthy(manifest, "pre-admission");
    const admission = await this.#observeHost(manifest);
    if (qualificationFault == null && exact && priorState?.observedStateRevision === manifest.desiredStateRevision
        && priorState.recoveryState === "healthy") {
      return Object.freeze({ state: "healthy", reused: true, setState: priorState, admission });
    }
    const changedLoaded = manifest.profiles.filter((profile) => runtimeIsLoaded(previousIdentities[profile.workerId])
      && !matchesDesired(previousIdentities[profile.workerId], profile));
    if (changedLoaded.length > 0 || qualificationFault != null) {
      await authorizeProtectedResidentOperation({
        // One loaded identity change is maintenance of the protected office
        // set, never authority over a convenient subset. The signed context
        // therefore binds every member even when only one desired identity
        // changed.
        workers: manifest.profiles.map((profile) => ({
          workerId: profile.workerId,
          placementClass: "protected-resident",
          maintenanceGeneration: manifest.maintenanceGeneration,
        })),
        operation: "protected-set.maintenance",
        maintenanceContext,
        maintenanceAuthorizer: this.#maintenanceAuthorizer,
        now: instant(this.#clock(), "clock"),
      });
    }
    // A replacement is part of the already signed maintenance transaction;
    // using a second local identity would break recovery fencing at the Agent.
    const transactionId = stable(
      changedLoaded.length > 0 || qualificationFault != null ? maintenanceContext.transactionId : this.#idFactory(),
      "transactionId",
    );
    let transaction = await this.#repository.beginTransaction({
      transactionId,
      setId: manifest.setId,
      nodeId: manifest.nodeId,
      desiredStateRevision: manifest.desiredStateRevision,
      maintenanceGeneration: manifest.maintenanceGeneration,
      state: "admitting",
      manifest: copy(manifest),
      previousIdentities: copy(previousIdentities),
      maintenanceAuthorization: changedLoaded.length > 0 || qualificationFault != null ? {
        transactionId,
        workerIds: manifest.profiles.map((profile) => profile.workerId).sort(),
        allowedOperations: ["protected-set.maintenance"],
        maintenanceGeneration: manifest.maintenanceGeneration,
        issuedAt: maintenanceContext.issuedAt,
        expiresAt: maintenanceContext.expiresAt,
      } : null,
      admission: copy(admission),
      steps: [],
      recoverySteps: [],
      createdAt: instant(this.#clock(), "clock").toISOString(),
      updatedAt: instant(this.#clock(), "clock").toISOString(),
    });
    await this.#writeSetState(manifest, priorState, {
      observedStateRevision: priorState?.observedStateRevision ?? 0,
      recoveryState: "recovering",
      recoveryReasonCode: "protected_set_staging",
      healthyIdentities: copy(priorState?.healthyIdentities ?? []),
      lastTransactionId: transactionId,
    });
    try {
      transaction = await this.#update(transaction, {
        state: "staging",
        // PostgreSQL deliberately permits only the durable lifecycle states
        // staging/staged/healthy.  "planned" was a UI vocabulary value and
        // made the first real journal update violate the deployed CHECK.
        steps: manifest.profiles.map((profile) => ({ workerId: profile.workerId, state: "staging" })),
      });
      const transition = await this.#runtime.transitionProtectedSet({
        transactionId,
        setId: manifest.setId,
        desiredStateRevision: manifest.desiredStateRevision,
        maintenanceGeneration: manifest.maintenanceGeneration,
        profiles: copy(manifest.profiles),
        previousIdentities: copy(previousIdentities),
        maintenanceContext: copy(maintenanceContext),
        qualificationFault: copy(qualificationFault),
      });
      transaction = await this.#update(transaction, {
        state: "probing",
        transition: copy(transition),
        steps: transaction.steps.map((step) => ({ ...step, state: "staged" })),
      });
      const observed = [];
      for (const profile of manifest.profiles) {
        const probe = exactIdentity(await this.#runtime.probeProtectedProfile({
          transactionId,
          maintenanceGeneration: manifest.maintenanceGeneration,
          profile: copy(profile),
        }));
        if (!matchesDesired(probe, profile) || !Number.isSafeInteger(probe.residentBytes)
            || probe.residentBytes < 1 || probe.residentBytes > profile.declaredResidentBytes) {
          fail("protected_set_warm_probe_failed", "Protected profile warm probe did not match the desired exact identity or budget", {
            status: 503, retryable: true, details: { workerId: profile.workerId },
          });
        }
        observed.push(probe);
        transaction = await this.#update(transaction, {
          steps: transaction.steps.map((step) => step.workerId === profile.workerId ? { ...step, state: "healthy", identity: copy(probe) } : step),
          state: "probing",
        });
        await this.#assertCoreHealthy(manifest, `after:${profile.workerId}`);
      }
      const currentState = await this.#repository.getSetState(manifest.setId);
      const committedAt = instant(this.#clock(), "clock").toISOString();
      const committed = await this.#repository.commitTransactionAndSetState({
        transactionId,
        expectedTransactionRevision: transaction.revision,
        transactionPatch: {
          state: "succeeded", observedIdentities: observed,
          completedAt: committedAt, updatedAt: committedAt,
        },
        setId: manifest.setId,
        expectedSetRevision: currentState?.revision ?? 0,
        setState: {
          nodeId: manifest.nodeId,
          desiredStateRevision: manifest.desiredStateRevision,
          maintenanceGeneration: manifest.maintenanceGeneration,
          observedStateRevision: manifest.desiredStateRevision,
          recoveryState: "healthy",
          recoveryReasonCode: null,
          healthyIdentities: observed,
          aggregateResidentBytes: observed.reduce((total, identity) => total + identity.residentBytes, 0),
          lastTransactionId: transactionId,
          updatedAt: committedAt,
          createdAt: currentState?.createdAt ?? committedAt,
        },
      });
      transaction = committed.transaction;
      // Return the exact Node Agent response that performed the mutation.  A
      // caller that needs an audit checkpoint must consume this response
      // instead of resubmitting the same signed transaction: the latter is a
      // second mutation command and is correctly rejected by the Agent's
      // anti-replay boundary.
      return Object.freeze({
        state: "healthy",
        reused: false,
        transaction,
        setState: committed.setState,
        transition: Object.freeze(copy(transition)),
      });
    } catch (error) {
      const reasonCode = error?.code ?? "protected_set_stage_failed";
      await this.#rollback(transaction, manifest, previousIdentities, reasonCode);
      if (error instanceof PlatformError) throw error;
      fail("protected_set_stage_failed", "Protected office set staging failed and the previous identity was restored", {
        status: 503, retryable: true, cause: error,
      });
    }
  }

  async recover({ transactionId }) {
    stable(transactionId, "transactionId");
    let transaction = await this.#repository.getTransaction(transactionId);
    if (!transaction) fail("protected_set_transaction_missing", "Protected-set transaction was not found", { status: 404 });
    if (TERMINAL_TRANSACTION_STATES.has(transaction.state)) return Object.freeze({ state: transaction.state, transaction });
    const manifest = normalizeManifest(transaction.manifest);
    const previous = transaction.previousIdentities ?? {};
    // Inspect every member: a crash can occur after a runtime mutation and
    // before its journal step is acknowledged.
    for (const profile of manifest.profiles) await this.#runtime.inspectProtectedProfile({ profile: copy(profile) });
    try {
      transaction = await this.#rollback(transaction, manifest, previous, "protected_set_interrupted");
      return Object.freeze({ state: transaction.state, transaction });
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      fail("protected_set_recovery_failed", "Protected-set transaction recovery failed", { status: 503, retryable: false, cause: error });
    }
  }
}
