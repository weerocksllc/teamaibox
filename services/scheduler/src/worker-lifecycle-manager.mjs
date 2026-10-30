import { randomUUID } from "node:crypto";
import { PlatformError } from "../../../packages/observability/src/index.mjs";
import {
  assertOrdinaryOperationExcludesProtectedResidents,
  isProtectedResidentWorker,
} from "./protected-resident-guard.mjs";
import { assertWorkerControlResponse, createWorkerControlEnvelope } from "./worker-control-protocol.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARCHITECTURES = new Set(["linux/arm64/v8", "linux/amd64"]);
const TERMINAL_EXECUTE = new Set(["worker.execute.succeeded", "worker.execute.failed", "worker.execute.cancelled"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_POLICY = Object.freeze({
  idleTimeoutMilliseconds: 5 * 60_000,
  prepareTimeoutMilliseconds: 10 * 60_000,
  dockerHealthTimeoutMilliseconds: 30_000,
  dockerHealthPollMilliseconds: 200,
  executeTimeoutMilliseconds: 24 * 60 * 60_000,
  cancelTimeoutMilliseconds: 30_000,
  unloadTimeoutMilliseconds: 2 * 60_000,
  crashWindowMilliseconds: 10 * 60_000,
  crashThreshold: 3,
  backoffBaseMilliseconds: 2_000,
  backoffMaximumMilliseconds: 2 * 60_000,
  circuitOpenMilliseconds: 15 * 60_000,
});

function requiredUuid(value, name) {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a UUID`);
  return value;
}

function validDate(value, name) {
  const date = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return date;
}

function policy(input = {}) {
  const result = { ...DEFAULT_POLICY, ...input };
  for (const name of [
    "idleTimeoutMilliseconds", "prepareTimeoutMilliseconds", "executeTimeoutMilliseconds",
    "cancelTimeoutMilliseconds", "unloadTimeoutMilliseconds", "crashWindowMilliseconds",
    "dockerHealthTimeoutMilliseconds", "dockerHealthPollMilliseconds",
    "backoffBaseMilliseconds", "backoffMaximumMilliseconds", "circuitOpenMilliseconds",
  ]) {
    if (!Number.isSafeInteger(result[name]) || result[name] < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(result.crashThreshold) || result.crashThreshold < 1 || result.crashThreshold > 100) {
    throw new TypeError("crashThreshold must be between 1 and 100");
  }
  if (result.backoffBaseMilliseconds > result.backoffMaximumMilliseconds) {
    throw new TypeError("backoff base cannot exceed the maximum");
  }
  return Object.freeze(result);
}

function conflict(code, message, retryable = true) {
  return new PlatformError(code, message, { status: 409, retryable });
}

function health(state, generation, observedAt, reasonCode = null) {
  return { state, generation, observedAt: new Date(observedAt), reasonCode };
}

function stableFailureCode(error) {
  for (const value of [error?.code, error?.cause?.code, error?.message]) {
    if (typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value)) return value;
  }
  return "worker_prepare_failed";
}

function commandAuthority(worker) {
  return { leaseId: worker.controlLeaseId, fencingToken: worker.controlFencingToken, nodeGeneration: worker.nodeGeneration };
}

function validateResources(resources) {
  const keys = ["cpuMillis", "unifiedMemoryBytes", "storageBytes", "networkBitsPerSecond", "acceleratorUnits", "codecSessions"];
  const result = {};
  for (const key of keys) {
    if (!Number.isSafeInteger(resources?.[key]) || resources[key] < 0) throw new TypeError(`resources.${key} must be a non-negative safe integer`);
    result[key] = resources[key];
  }
  return result;
}

function resultArtifactRefs(result) {
  const values = [];
  if (typeof result?.artifactRef === "string") values.push(result.artifactRef);
  if (Array.isArray(result?.artifactRefs)) {
    values.push(...result.artifactRefs.filter((value) => typeof value === "string"));
  }
  return [...new Set(values)];
}

function attemptBinding(worker, attemptId) {
  return worker.attemptBindings?.[attemptId] ?? null;
}

function assertAttemptAuthority(worker, attemptId, leaseId, fencingToken) {
  const binding = attemptBinding(worker, attemptId);
  if (!binding || binding.leaseId !== leaseId || binding.fencingToken !== fencingToken) {
    throw conflict("stale_worker_attempt_fence", "Worker attempt authority no longer matches durable state");
  }
  return binding;
}

export class WorkerLifecycleManager {
  #repository;
  #nodeAgent;
  #workerControl;
  #events;
  #capabilityRegistrar;
  #capabilityDescriptorResolver;
  #clock;
  #policy;
  #starts = new Map();
  #sequence = 0;

  constructor({ repository, nodeAgent, workerControl, eventSink, capabilityRegistrar = null,
    capabilityDescriptorResolver = null, clock = () => new Date(), lifecyclePolicy = {},
    maintenanceAuthorizer = null }) {
    if (!repository || !nodeAgent || !workerControl || !eventSink) {
      throw new TypeError("repository, nodeAgent, workerControl, and eventSink are required");
    }
    if ((capabilityRegistrar === null) !== (capabilityDescriptorResolver === null)
      || (capabilityRegistrar !== null && typeof capabilityRegistrar.registerReadyWorker !== "function")
      || (capabilityDescriptorResolver !== null && typeof capabilityDescriptorResolver.resolve !== "function")) {
      throw new TypeError("plugin capability registrar and descriptor resolver must be configured together");
    }
    if (maintenanceAuthorizer !== null && typeof maintenanceAuthorizer !== "function") {
      throw new TypeError("maintenanceAuthorizer must be a function when configured");
    }
    this.#repository = repository;
    this.#nodeAgent = nodeAgent;
    this.#workerControl = workerControl;
    this.#events = eventSink;
    this.#capabilityRegistrar = capabilityRegistrar;
    this.#capabilityDescriptorResolver = capabilityDescriptorResolver;
    this.#clock = clock;
    this.#policy = policy(lifecyclePolicy);
  }

  async #waitForDockerHealth({ workerId, nodeId, authority, correlationId }) {
    const attempts = Math.max(1, Math.ceil(this.#policy.dockerHealthTimeoutMilliseconds / this.#policy.dockerHealthPollMilliseconds));
    let observed = null;
    for (let index = 0; index < attempts; index += 1) {
      observed = await this.#nodeAgent.workerHealth({ workerId, nodeId, authority, correlationId });
      if (observed?.status === "running" && observed?.health === "healthy") return observed;
      if (observed?.status !== "running" || new Set(["unhealthy", "stopped", "exited", "dead"]).has(observed?.health)) break;
      await new Promise((resolve) => setTimeout(resolve, this.#policy.dockerHealthPollMilliseconds));
    }
    throw new PlatformError("worker_docker_health_not_ready", "Docker did not report the prepared worker healthy", { status: 503, retryable: true });
  }

  async #registerCapabilities(worker) {
    if (!this.#capabilityRegistrar) return null;
    const descriptor = await this.#capabilityDescriptorResolver.resolve({
      computePluginId: worker.computePluginId,
      modelProfileId: worker.modelProfileId,
    });
    if (!descriptor || typeof descriptor.pluginId !== "string" || !Array.isArray(descriptor.operations)
      || descriptor.operations.length < 1) throw new TypeError("scheduler plugin capability descriptor is unavailable");
    return this.#capabilityRegistrar.registerReadyWorker({ pluginId: descriptor.pluginId, worker,
      operations: descriptor.operations });
  }

  async #emit(type, worker, payload = {}, correlationId = null) {
    this.#sequence += 1;
    try {
      await this.#events.publish({
        protocolVersion: 1,
        eventId: randomUUID(),
        sequence: this.#sequence,
        type,
        workerId: worker.workerId,
        nodeId: worker.nodeId,
        modelProfileId: worker.modelProfileId,
        generation: worker.generation,
        occurredAt: validDate(this.#clock(), "clock"),
        correlationId,
        payload: structuredClone(payload),
      });
    } catch (error) {
      throw new PlatformError("worker_event_persist_failed", "Worker lifecycle event could not be persisted", { cause: error, status: 503, retryable: true });
    }
  }

  async provision({
    workerId = randomUUID(), nodeId, nodeGeneration, computePluginId, modelProfileId, attemptId, image,
    architecture, resources, maxConcurrentAttempts = 1, reservationIds = [],
    controlLeaseId, controlFencingToken, placementClass = "warm-optional", maintenanceGeneration = 1, now,
  }) {
    for (const [value, name] of [[workerId, "workerId"], [nodeId, "nodeId"], [computePluginId, "computePluginId"], [modelProfileId, "modelProfileId"], [attemptId, "attemptId"], [controlLeaseId, "controlLeaseId"]]) {
      requiredUuid(value, name);
    }
    if (!Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1) throw new TypeError("nodeGeneration must be positive");
    if (!/^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(image)) throw new TypeError("image must be a digest-pinned OCI reference or full local content ID");
    if (!ARCHITECTURES.has(architecture)) throw new TypeError("architecture is unsupported");
    if (!Number.isSafeInteger(maxConcurrentAttempts) || maxConcurrentAttempts < 1 || maxConcurrentAttempts > 1024) {
      throw new TypeError("maxConcurrentAttempts must be between 1 and 1024");
    }
    if (!Number.isSafeInteger(controlFencingToken) || controlFencingToken < 1) throw new TypeError("controlFencingToken must be positive");
    if (!new Set(["protected-resident", "warm-optional", "exclusive-batch"]).has(placementClass)) {
      throw new TypeError("placementClass is invalid");
    }
    if (!Number.isSafeInteger(maintenanceGeneration) || maintenanceGeneration < 1) {
      throw new TypeError("maintenanceGeneration must be positive");
    }
    for (const reservationId of reservationIds) requiredUuid(reservationId, "reservationId");
    const at = validDate(now ?? this.#clock(), "now");
    return this.#repository.create({
      workerId, nodeId, nodeGeneration, computePluginId, modelProfileId, attemptId, image, architecture,
      resources: validateResources(resources), maxConcurrentAttempts,
      reservationIds: [...new Set(reservationIds)], activeAttemptIds: [],
      attemptStates: {}, attemptBindings: {}, bindingRevision: 0,
      generation: 1, lifecycleState: "stopped",
      placementClass, maintenanceGeneration,
      health: health("unknown", 1, at), loadedAt: null, lastHeartbeatAt: null,
      idleSince: null, crashTimestamps: [], crashCount: 0, nextRetryAt: null,
      circuitOpenUntil: null, lastFailureCode: null,
      controlLeaseId, controlFencingToken, createdAt: at, updatedAt: at,
    });
  }

  async bindAttempt({ workerId, attemptId, leaseId, fencingToken, correlationId, now }) {
    for (const [value, name] of [[workerId, "workerId"], [attemptId, "attemptId"], [leaseId, "leaseId"]]) requiredUuid(value, name);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new TypeError("fencingToken must be positive");
    const at = validDate(now ?? this.#clock(), "now");
    let created = false;
    let binding;
    const worker = await this.#repository.mutate(workerId, (current) => {
      current.attemptBindings ??= {};
      current.bindingRevision ??= 0;
      for (const staleAttemptId of Object.keys(current.attemptStates ?? {})) {
        if (!current.activeAttemptIds.includes(staleAttemptId)) delete current.attemptStates[staleAttemptId];
      }
      const existing = current.attemptBindings[attemptId];
      if (existing) {
        if (existing.leaseId !== leaseId || existing.fencingToken !== fencingToken) {
          throw conflict("stale_worker_attempt_fence", "Attempt is already bound with different authority");
        }
        binding = structuredClone(existing);
        return current;
      }
      if (["starting", "preparing", "draining", "stopping"].includes(current.lifecycleState)) {
        throw conflict("worker_transition_in_progress", "Worker cannot bind an attempt during a lifecycle transition");
      }
      if (Object.keys(current.attemptBindings).length >= current.maxConcurrentAttempts) {
        throw conflict("worker_concurrency_exhausted", "Worker attempt binding capacity is exhausted");
      }
      current.bindingRevision += 1;
      binding = { leaseId, fencingToken, revision: current.bindingRevision, boundAt: at.toISOString() };
      current.attemptBindings[attemptId] = binding;
      current.updatedAt = at;
      created = true;
      return current;
    });
    if (created) await this.#emit("worker.attempt_bound", worker, {
      attemptId, fencingToken, bindingRevision: binding.revision,
    }, correlationId);
    return Object.freeze({ worker, binding: Object.freeze(structuredClone(binding)), created });
  }

  async releaseAttempt({ workerId, attemptId, leaseId, fencingToken, correlationId, reason = "attempt_finished", now }) {
    for (const [value, name] of [[workerId, "workerId"], [attemptId, "attemptId"], [leaseId, "leaseId"]]) requiredUuid(value, name);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new TypeError("fencingToken must be positive");
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(reason)) throw new TypeError("reason must be a stable snake_case code");
    const at = validDate(now ?? this.#clock(), "now");
    let released = false;
    let bindingRevision = null;
    const worker = await this.#repository.mutate(workerId, (current) => {
      current.attemptBindings ??= {};
      current.bindingRevision ??= 0;
      const binding = current.attemptBindings[attemptId];
      if (!binding) return current;
      assertAttemptAuthority(current, attemptId, leaseId, fencingToken);
      if (current.activeAttemptIds.includes(attemptId)) {
        throw conflict("worker_attempt_active", "Active attempt authority cannot be released");
      }
      delete current.attemptBindings[attemptId];
      current.bindingRevision += 1;
      bindingRevision = current.bindingRevision;
      current.updatedAt = at;
      released = true;
      return current;
    });
    if (released) await this.#emit("worker.attempt_released", worker, {
      attemptId, fencingToken, bindingRevision, reason,
    }, correlationId);
    return Object.freeze({ worker, released, bindingRevision });
  }

  async ensureReady({ workerId, correlationId, now }) {
    requiredUuid(workerId, "workerId");
    if (this.#starts.has(workerId)) return this.#starts.get(workerId);
    const operation = this.#startAndPrepare({ workerId, correlationId, now })
      .finally(() => this.#starts.delete(workerId));
    this.#starts.set(workerId, operation);
    return operation;
  }

  async #startAndPrepare({ workerId, correlationId, now }) {
    const at = validDate(now ?? this.#clock(), "now");
    let warm = false;
    let resuming = false;
    let worker = await this.#repository.mutate(workerId, (current) => {
      if (["ready", "busy"].includes(current.lifecycleState) && current.health.state === "healthy") {
        warm = true;
        return current;
      }
      if (isProtectedResidentWorker(current)) {
        throw conflict("protected_set_recovery_required",
          "Protected-resident Workers must be started or recovered through the complete protected-set transaction", false);
      }
      if (["starting", "preparing"].includes(current.lifecycleState)) {
        resuming = true;
        return current;
      }
      if (["draining", "stopping"].includes(current.lifecycleState)) {
        throw conflict("worker_transition_in_progress", "Worker lifecycle transition is already in progress");
      }
      if (current.lifecycleState === "circuit_open" && current.circuitOpenUntil > at) {
        throw conflict("worker_circuit_open", "Worker crash circuit is open");
      }
      if (current.nextRetryAt && current.nextRetryAt > at) {
        throw conflict("worker_backoff_active", "Worker restart backoff has not elapsed");
      }
      current.generation += 1;
      current.lifecycleState = "starting";
      current.health = health("starting", current.generation, at);
      current.idleSince = null;
      current.circuitOpenUntil = null;
      current.nextRetryAt = null;
      current.updatedAt = at;
      return current;
    });
    if (warm) {
      await this.#registerCapabilities(worker);
      await this.#emit("worker.warm_reused", worker, {}, correlationId);
      return { worker, warmReuse: true };
    }

    const startedAt = at;
    let failureStage = "worker_start";
    try {
      await this.#nodeAgent.startWorker({ worker: structuredClone(worker), authority: commandAuthority(worker), correlationId });
      failureStage = "worker_health";
      const nodeHealth = await this.#nodeAgent.workerHealth({ workerId, nodeId: worker.nodeId, authority: commandAuthority(worker), correlationId });
      if (!nodeHealth || nodeHealth.status !== "running") throw new Error("node_agent_worker_not_running");
      failureStage = "worker_state_preparing";
      worker = await this.#repository.mutate(workerId, (current) => {
        if (current.generation !== worker.generation || !["starting", "preparing"].includes(current.lifecycleState)) throw conflict("worker_generation_changed", "Worker generation changed during start");
        current.lifecycleState = "preparing";
        current.updatedAt = validDate(this.#clock(), "clock");
        return current;
      });
      failureStage = "worker_prepare";
      const request = createWorkerControlEnvelope({
        workerId, type: "worker.prepare.request", correlationId,
        leaseId: worker.controlLeaseId, fencingToken: worker.controlFencingToken,
        payload: { generation: worker.generation, modelProfileId: worker.modelProfileId },
        sentAt: this.#clock(),
      });
      const response = assertWorkerControlResponse(
        request,
        await this.#workerControl.send(request, { timeoutMilliseconds: this.#policy.prepareTimeoutMilliseconds }),
        ["worker.prepare.ready"],
      );
      if (response.payload.generation !== worker.generation || response.payload.modelProfileId !== worker.modelProfileId) {
        throw new Error("worker_prepare_generation_mismatch");
      }
      failureStage = "worker_docker_health";
      await this.#waitForDockerHealth({ workerId, nodeId: worker.nodeId, authority: commandAuthority(worker), correlationId });
      const readyAt = validDate(this.#clock(), "clock");
      failureStage = "worker_state_ready";
      worker = await this.#repository.mutate(workerId, (current) => {
        if (current.generation !== worker.generation || current.lifecycleState !== "preparing") throw conflict("worker_generation_changed", "Worker generation changed during prepare");
        current.lifecycleState = "ready";
        current.health = health("healthy", current.generation, readyAt);
        current.loadedAt = readyAt;
        current.lastHeartbeatAt = readyAt;
        current.idleSince = readyAt;
        current.crashTimestamps = [];
        current.crashCount = 0;
        current.nextRetryAt = null;
        current.circuitOpenUntil = null;
        current.lastFailureCode = null;
        current.updatedAt = readyAt;
        return current;
      });
      failureStage = "worker_capability_registration";
      await this.#registerCapabilities(worker);
    } catch (error) {
      await this.#emit("worker.prepare_failed", worker, {
        stage: failureStage,
        causeCode: stableFailureCode(error),
      }, correlationId).catch(() => {});
      await this.recordCrash({ workerId, reasonCode: "worker_prepare_failed", correlationId, now: this.#clock() });
      throw new PlatformError("worker_prepare_failed", "Compute worker failed to start or prepare", { cause: error, status: 503, retryable: true });
    }
    if (resuming) await this.#emit("worker.start_resumed", worker, {}, correlationId);
    await this.#emit("worker.ready", worker, { coldStartMilliseconds: Math.max(0, worker.loadedAt - startedAt) }, correlationId);
    return { worker, warmReuse: false };
  }

  async #sendAttemptObjectControl({ workerId, jobId, attemptId, leaseId, fencingToken,
    correlationId, type, payload, allowedTypes, timeoutMilliseconds = 120_000, now }) {
    for (const [value, name] of [[workerId, "workerId"], [jobId, "jobId"], [attemptId, "attemptId"], [leaseId, "leaseId"]]) {
      requiredUuid(value, name);
    }
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new TypeError("fencingToken must be positive");
    let worker = await this.#repository.get(workerId);
    assertAttemptAuthority(worker, attemptId, leaseId, fencingToken);
    if (!["ready", "busy"].includes(worker.lifecycleState) || worker.health.state !== "healthy") {
      throw conflict("worker_not_ready", "Worker must be healthy before object transfer");
    }
    const generation = worker.generation;
    const request = createWorkerControlEnvelope({ workerId, type, correlationId, jobId, attemptId,
      leaseId, fencingToken, payload: { generation, ...structuredClone(payload) }, sentAt: now ?? this.#clock() });
    const response = assertWorkerControlResponse(request,
      await this.#workerControl.send(request, { timeoutMilliseconds }), allowedTypes);
    if (response.payload.generation !== generation) {
      throw conflict("worker_generation_changed", "Object transfer response belongs to a stale worker generation");
    }
    if (response.type.endsWith(".failed")) {
      throw new PlatformError(response.payload.code ?? "worker_object_transfer_failed",
        "Worker rejected an attempt-scoped object transfer", { status: 502, retryable: false });
    }
    worker = await this.#repository.get(workerId);
    assertAttemptAuthority(worker, attemptId, leaseId, fencingToken);
    if (worker.generation !== generation) {
      throw conflict("worker_generation_changed", "Worker generation changed during object transfer");
    }
    return Object.freeze({ worker, payload: Object.freeze(structuredClone(response.payload)) });
  }

  async beginObjectTransfer({ workerId, jobId, attemptId, leaseId, fencingToken, correlationId,
    transferId, referenceId, role, size, mediaType, integrity, now }) {
    requiredUuid(transferId, "transferId"); requiredUuid(referenceId, "referenceId");
    if (typeof role !== "string" || !/^[^\u0000-\u001f\u007f]{1,512}$/u.test(role)
        || !Number.isSafeInteger(size) || size < 1
        || typeof mediaType !== "string" || mediaType.length < 1 || mediaType.length > 255
        || !SHA256.test(integrity?.digest ?? "")) {
      throw new TypeError("worker object transfer metadata is invalid");
    }
    const result = await this.#sendAttemptObjectControl({ workerId, jobId, attemptId, leaseId,
      fencingToken, correlationId, type: "worker.object.begin.request", now,
      payload: { transferId, referenceId, role, size, mediaType,
        integrity: { algorithm: "sha256", digest: integrity.digest } },
      allowedTypes: ["worker.object.begin.accepted", "worker.object.begin.failed"] });
    if (result.payload.transferId !== transferId || result.payload.receivedBytes !== 0) {
      throw new PlatformError("worker_protocol_mismatch", "Worker returned invalid object-transfer state", { status: 502, retryable: true });
    }
    await this.#emit("worker.object_transfer_started", result.worker,
      { jobId, attemptId, transferId, referenceId, role, size }, correlationId);
    return result.payload;
  }

  async writeObjectTransferChunk({ workerId, jobId, attemptId, leaseId, fencingToken, correlationId,
    transferId, offset, bytesBase64, chunkSha256, now }) {
    requiredUuid(transferId, "transferId");
    if (!Number.isSafeInteger(offset) || offset < 0 || typeof bytesBase64 !== "string"
        || bytesBase64.length < 1 || bytesBase64.length > 384 * 1024
        || !SHA256.test(chunkSha256 ?? "")) throw new TypeError("worker object-transfer chunk is invalid");
    const byteLength = Buffer.from(bytesBase64, "base64").byteLength;
    if (byteLength < 1 || byteLength > 256 * 1024) throw new TypeError("worker object-transfer chunk size is invalid");
    const result = await this.#sendAttemptObjectControl({ workerId, jobId, attemptId, leaseId,
      fencingToken, correlationId, type: "worker.object.chunk.request", now,
      payload: { transferId, offset, bytesBase64, chunkSha256 },
      allowedTypes: ["worker.object.chunk.accepted", "worker.object.chunk.failed"] });
    if (result.payload.transferId !== transferId || result.payload.receivedBytes !== offset + byteLength) {
      throw new PlatformError("worker_protocol_mismatch", "Worker returned an invalid object-transfer offset", { status: 502, retryable: true });
    }
    return result.payload;
  }

  async commitObjectTransfer({ workerId, jobId, attemptId, leaseId, fencingToken, correlationId,
    transferId, now }) {
    requiredUuid(transferId, "transferId");
    const result = await this.#sendAttemptObjectControl({ workerId, jobId, attemptId, leaseId,
      fencingToken, correlationId, type: "worker.object.commit.request", now,
      payload: { transferId }, allowedTypes: ["worker.object.commit.succeeded", "worker.object.commit.failed"] });
    if (result.payload.transferId !== transferId || !Number.isSafeInteger(result.payload.verifiedBytes)
        || !SHA256.test(result.payload.integrity?.digest ?? "")) {
      throw new PlatformError("worker_protocol_mismatch", "Worker returned invalid object verification facts", { status: 502, retryable: true });
    }
    await this.#emit("worker.object_transfer_verified", result.worker,
      { jobId, attemptId, transferId, verifiedBytes: result.payload.verifiedBytes,
        integrity: structuredClone(result.payload.integrity) }, correlationId);
    return result.payload;
  }

  async discardObjectTransfers({ workerId, jobId, attemptId, leaseId, fencingToken, correlationId,
    transferIds, now }) {
    if (!Array.isArray(transferIds) || transferIds.length < 1) {
      throw new TypeError("worker object transfer discard set is invalid");
    }
    const unique = [...new Set(transferIds)];
    unique.forEach((value) => requiredUuid(value, "transferId"));
    const discardedTransferIds = [];
    // Older Worker-Control v1 implementations accept 32 IDs per message.
    // Batch that wire format without imposing a limit on the task's files.
    for (let offset = 0; offset < unique.length; offset += 32) {
      const batch = unique.slice(offset, offset + 32);
      const result = await this.#sendAttemptObjectControl({ workerId, jobId, attemptId, leaseId,
        fencingToken, correlationId, type: "worker.object.discard.request", now,
        payload: { transferIds: batch },
        allowedTypes: ["worker.object.discard.succeeded", "worker.object.discard.failed"] });
      if (!Array.isArray(result.payload.discardedTransferIds)
          || result.payload.discardedTransferIds.some((value) => !batch.includes(value))) {
        throw new PlatformError("worker_protocol_mismatch", "Worker returned invalid object-discard facts", { status: 502, retryable: true });
      }
      discardedTransferIds.push(...result.payload.discardedTransferIds);
    }
    return { discardedTransferIds: [...new Set(discardedTransferIds)] };
  }

  async execute({ workerId, jobId, attemptId, leaseId, fencingToken, correlationId, input, now }) {
    for (const [value, name] of [[workerId, "workerId"], [jobId, "jobId"], [attemptId, "attemptId"], [leaseId, "leaseId"]]) requiredUuid(value, name);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new TypeError("fencingToken must be positive");
    const at = validDate(now ?? this.#clock(), "now");
    let generation;
    let worker = await this.#repository.mutate(workerId, (current) => {
      assertAttemptAuthority(current, attemptId, leaseId, fencingToken);
      if (!["ready", "busy"].includes(current.lifecycleState) || current.health.state !== "healthy") {
        throw conflict("worker_not_ready", "Worker must be healthy and ready before execute");
      }
      if (current.attemptStates[attemptId]) throw conflict("attempt_already_dispatched", "Attempt is already known to this worker", false);
      if (current.activeAttemptIds.length >= current.maxConcurrentAttempts) throw conflict("worker_concurrency_exhausted", "Worker concurrency is exhausted");
      current.activeAttemptIds.push(attemptId);
      current.attemptStates[attemptId] = "running";
      current.lifecycleState = "busy";
      current.idleSince = null;
      current.updatedAt = at;
      generation = current.generation;
      return current;
    });
    try {
      await this.#emit("worker.execution_started", worker, { jobId, attemptId }, correlationId);
    } catch (error) {
      await this.#repository.mutate(workerId, (current) => {
        delete current.attemptStates[attemptId];
        current.activeAttemptIds = current.activeAttemptIds.filter((id) => id !== attemptId);
        current.lifecycleState = current.activeAttemptIds.length ? "busy" : "ready";
        current.idleSince = current.activeAttemptIds.length ? null : validDate(this.#clock(), "clock");
        current.updatedAt = validDate(this.#clock(), "clock");
        return current;
      });
      await this.releaseAttempt({ workerId, attemptId, leaseId, fencingToken, correlationId,
        reason: "dispatch_event_failed", now: this.#clock() });
      throw error;
    }
    const request = createWorkerControlEnvelope({
      workerId, type: "worker.execute.request", correlationId, jobId, attemptId,
      leaseId, fencingToken, payload: { generation, input: structuredClone(input ?? {}) }, sentAt: at,
    });
    try {
      const response = assertWorkerControlResponse(
        request,
        await this.#workerControl.send(request, { timeoutMilliseconds: this.#policy.executeTimeoutMilliseconds }),
        [...TERMINAL_EXECUTE],
      );
      if (response.payload.generation !== generation) throw new Error("worker_execute_generation_mismatch");
      const finishedAt = validDate(this.#clock(), "clock");
      let alreadyCancelled = false;
      worker = await this.#repository.mutate(workerId, (current) => {
        if (current.generation !== generation) throw conflict("worker_generation_changed", "Execution belongs to a stale worker generation");
        if (!current.attemptStates[attemptId]) {
          if (response.type === "worker.execute.cancelled") {
            alreadyCancelled = true;
            return current;
          }
          throw conflict("worker_terminal_race", "Worker returned a terminal result after attempt ownership ended", false);
        }
        delete current.attemptStates[attemptId];
        current.activeAttemptIds = current.activeAttemptIds.filter((id) => id !== attemptId);
        current.lifecycleState = current.activeAttemptIds.length ? "busy" : "ready";
        current.idleSince = current.activeAttemptIds.length ? null : finishedAt;
        current.updatedAt = finishedAt;
        return current;
      });
      const outcome = response.type.slice("worker.execute.".length);
      const result = response.payload.result ?? null;
      if (!alreadyCancelled) {
        await this.#emit(`worker.execution_${outcome}`, worker, {
          jobId, attemptId, resultArtifactRefs: resultArtifactRefs(result),
        }, correlationId);
      }
      return { outcome, result, worker };
    } catch (error) {
      if (error?.code === "worker_event_persist_failed") throw error;
      const fatal = error?.fatalWorker === true || error?.code === "worker_transport_lost";
      if (fatal) {
        await this.recordCrash({ workerId, reasonCode: "worker_execute_crash", correlationId, now: this.#clock() });
      } else {
        worker = await this.#repository.mutate(workerId, (current) => {
          delete current.attemptStates[attemptId];
          current.activeAttemptIds = current.activeAttemptIds.filter((id) => id !== attemptId);
          current.lifecycleState = current.activeAttemptIds.length ? "busy" : "ready";
          current.idleSince = current.activeAttemptIds.length ? null : validDate(this.#clock(), "clock");
          current.updatedAt = validDate(this.#clock(), "clock");
          return current;
        });
        await this.#emit("worker.execution_failed", worker, { jobId, attemptId, reasonCode: "worker_execution_failed" }, correlationId);
      }
      throw error;
    } finally {
      await this.releaseAttempt({ workerId, attemptId, leaseId, fencingToken, correlationId,
        reason: "attempt_finished", now: this.#clock() });
    }
  }

  async cancel({ workerId, jobId, attemptId, leaseId, fencingToken, correlationId, now }) {
    let worker = await this.#repository.get(requiredUuid(workerId, "workerId"));
    for (const [value, name] of [[jobId, "jobId"], [attemptId, "attemptId"], [leaseId, "leaseId"]]) requiredUuid(value, name);
    assertAttemptAuthority(worker, attemptId, leaseId, fencingToken);
    if (!worker.attemptStates[attemptId]) return { status: "not_found", worker };
    const request = createWorkerControlEnvelope({
      workerId, type: "worker.cancel.request", correlationId, jobId, attemptId,
      leaseId, fencingToken, payload: { generation: worker.generation, mode: "cooperative" },
      sentAt: now ?? this.#clock(),
    });
    worker = await this.#repository.mutate(workerId, (current) => {
      assertAttemptAuthority(current, attemptId, leaseId, fencingToken);
      if (current.attemptStates[attemptId]) {
        current.attemptStates[attemptId] = "cancel_requested";
        current.updatedAt = validDate(this.#clock(), "clock");
      }
      return current;
    });
    await this.#emit("worker.cancel_requested", worker, { jobId, attemptId }, correlationId);
    const response = assertWorkerControlResponse(
      request,
      await this.#workerControl.send(request, { timeoutMilliseconds: this.#policy.cancelTimeoutMilliseconds }),
      ["worker.cancel.accepted", "worker.cancel.cancelled", "worker.cancel.not_found"],
    );
    if (response.payload.generation !== worker.generation) throw conflict("worker_generation_changed", "Cancellation response belongs to a stale worker generation");
    if (response.type === "worker.cancel.cancelled" || response.type === "worker.cancel.not_found") {
      const cancelledAt = validDate(this.#clock(), "clock");
      let alreadyFinished = false;
      const updated = await this.#repository.mutate(workerId, (current) => {
        if (!current.attemptStates[attemptId]) {
          alreadyFinished = true;
          return current;
        }
        delete current.attemptStates[attemptId];
        current.activeAttemptIds = current.activeAttemptIds.filter((id) => id !== attemptId);
        current.lifecycleState = current.activeAttemptIds.length ? "busy" : "ready";
        current.idleSince = current.activeAttemptIds.length ? null : cancelledAt;
        current.updatedAt = cancelledAt;
        return current;
      });
      if (!alreadyFinished) await this.#emit("worker.execution_cancelled", updated, { jobId, attemptId }, correlationId);
      await this.releaseAttempt({ workerId, attemptId, leaseId, fencingToken, correlationId,
        reason: "attempt_cancelled", now: this.#clock() });
      return { status: "cancelled", worker: updated };
    }
    const updated = await this.#repository.get(workerId);
    return { status: updated.attemptStates[attemptId] ? "pending" : "cancelled", worker: updated };
  }

  async unload({ workerId, correlationId, reason = "scheduler_unload", now }) {
    requiredUuid(workerId, "workerId");
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(reason)) throw new TypeError("reason must be a stable snake_case code");
    const at = validDate(now ?? this.#clock(), "now");
    const snapshot = await this.#repository.get(workerId);
    if (snapshot.lifecycleState === "stopped") return snapshot;
    assertOrdinaryOperationExcludesProtectedResidents({
      workers: [snapshot],
      operation: "worker.unload",
    });
    let worker = await this.#repository.mutate(workerId, (current) => {
      assertOrdinaryOperationExcludesProtectedResidents({
        workers: [current], operation: "worker.unload",
      });
      if (current.lifecycleState === "stopped") return current;
      if (current.activeAttemptIds.length || Object.keys(current.attemptBindings ?? {}).length) {
        throw conflict("worker_busy", "Worker cannot unload with active or bound attempts");
      }
      if (!["ready", "failed", "circuit_open"].includes(current.lifecycleState)) throw conflict("worker_transition_in_progress", "Worker cannot unload in its current state");
      current.lifecycleState = "draining";
      current.circuitOpenUntil = null;
      current.updatedAt = at;
      return current;
    });
    if (worker.lifecycleState === "stopped") return worker;
    if (worker.health.state === "healthy") {
      const request = createWorkerControlEnvelope({
        workerId, type: "worker.unload.request", correlationId,
        leaseId: worker.controlLeaseId, fencingToken: worker.controlFencingToken,
        payload: { generation: worker.generation, reason }, sentAt: this.#clock(),
      });
      assertWorkerControlResponse(
        request,
        await this.#workerControl.send(request, { timeoutMilliseconds: this.#policy.unloadTimeoutMilliseconds }),
        ["worker.unload.succeeded"],
      );
    }
    worker = await this.#repository.mutate(workerId, (current) => {
      current.lifecycleState = "stopping";
      current.updatedAt = validDate(this.#clock(), "clock");
      return current;
    });
    await this.#nodeAgent.stopWorker({ workerId, nodeId: worker.nodeId, authority: commandAuthority(worker), gracePeriodSeconds: 30, correlationId });
    const stoppedAt = validDate(this.#clock(), "clock");
    worker = await this.#repository.mutate(workerId, (current) => {
      current.lifecycleState = "stopped";
      current.health = health("unknown", current.generation || 1, stoppedAt);
      current.loadedAt = null;
      current.idleSince = null;
      current.lastHeartbeatAt = null;
      current.nextRetryAt = null;
      current.circuitOpenUntil = null;
      current.updatedAt = stoppedAt;
      return current;
    });
    await this.#emit("worker.stopped", worker, { reason }, correlationId);
    return worker;
  }

  async stopIdle({ now, correlationId = "scheduler.idle-sweep" } = {}) {
    const at = validDate(now ?? this.#clock(), "now");
    const workers = await this.#repository.list({ states: ["ready"] });
    const due = workers.filter((worker) => !isProtectedResidentWorker(worker)
      && worker.idleSince && at - new Date(worker.idleSince) >= this.#policy.idleTimeoutMilliseconds);
    const stopped = [];
    for (const worker of due) {
      stopped.push(await this.unload({ workerId: worker.workerId, correlationId, reason: "idle_timeout", now: at }));
    }
    return stopped;
  }

  async recordCrash({ workerId, reasonCode, correlationId, now }) {
    requiredUuid(workerId, "workerId");
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(reasonCode)) throw new TypeError("reasonCode must be stable snake_case");
    const at = validDate(now ?? this.#clock(), "now");
    let affectedAttempts;
    let worker = await this.#repository.mutate(workerId, (current) => {
      const floor = at.getTime() - this.#policy.crashWindowMilliseconds;
      current.crashTimestamps = current.crashTimestamps.filter((value) => new Date(value).getTime() >= floor);
      current.crashTimestamps.push(at);
      current.crashCount = current.crashTimestamps.length;
      current.lastFailureCode = reasonCode;
      affectedAttempts = [...new Set([
        ...current.activeAttemptIds,
        ...Object.keys(current.attemptBindings ?? {}),
      ])];
      current.activeAttemptIds = [];
      current.attemptStates = {};
      current.attemptBindings = {};
      if (affectedAttempts.length) current.bindingRevision = (current.bindingRevision ?? 0) + 1;
      current.loadedAt = null;
      current.idleSince = null;
      current.health = health("unhealthy", Math.max(1, current.generation), at, reasonCode);
      if (current.crashCount >= this.#policy.crashThreshold) {
        current.lifecycleState = "circuit_open";
        current.circuitOpenUntil = new Date(at.getTime() + this.#policy.circuitOpenMilliseconds);
        current.nextRetryAt = current.circuitOpenUntil;
      } else {
        const delay = Math.min(this.#policy.backoffMaximumMilliseconds, this.#policy.backoffBaseMilliseconds * (2 ** (current.crashCount - 1)));
        current.lifecycleState = "failed";
        current.nextRetryAt = new Date(at.getTime() + delay);
        current.circuitOpenUntil = null;
      }
      current.updatedAt = at;
      return current;
    });
    if (isProtectedResidentWorker(worker)) {
      await this.#emit("worker.protected_recovery_required", worker, {
        reasonCode, affectedAttemptIds: affectedAttempts, containerRemoved: false,
      }, correlationId);
      return { worker, affectedAttemptIds: affectedAttempts };
    }
    try {
      await this.#nodeAgent.stopWorker({ workerId, nodeId: worker.nodeId,
        authority: commandAuthority(worker), gracePeriodSeconds: 0, correlationId });
    } catch (error) {
      worker = await this.#repository.mutate(workerId, (current) => {
        current.lifecycleState = "circuit_open";
        current.circuitOpenUntil = new Date(at.getTime() + this.#policy.circuitOpenMilliseconds);
        current.nextRetryAt = current.circuitOpenUntil;
        current.lastFailureCode = "worker_crash_cleanup_failed";
        current.updatedAt = at;
        return current;
      });
      await this.#emit("worker.crash_cleanup_failed", worker, {
        reasonCode: "worker_crash_cleanup_failed", affectedAttemptIds: affectedAttempts,
      }, correlationId);
      const failure = new PlatformError("worker_transport_lost", "Crashed Worker could not be removed safely", {
        cause: error, status: 502, retryable: true,
      });
      failure.fatalWorker = true;
      throw failure;
    }
    await this.#emit(worker.lifecycleState === "circuit_open" ? "worker.circuit_opened" : "worker.crashed", worker, {
      reasonCode, crashCount: worker.crashCount, nextRetryAt: worker.nextRetryAt,
      affectedAttemptIds: affectedAttempts, containerRemoved: true,
    }, correlationId);
    return { worker, affectedAttemptIds: affectedAttempts };
  }

  async recoverCircuits({ now, correlationId = "scheduler.circuit-sweep" } = {}) {
    const at = validDate(now ?? this.#clock(), "now");
    const open = await this.#repository.list({ states: ["circuit_open"] });
    const recovered = [];
    for (const candidate of open.filter((worker) => worker.circuitOpenUntil <= at)) {
      const worker = await this.#repository.mutate(candidate.workerId, (current) => {
        if (current.lifecycleState !== "circuit_open" || current.circuitOpenUntil > at) return current;
        current.lifecycleState = "failed";
        current.nextRetryAt = at;
        current.circuitOpenUntil = null;
        current.updatedAt = at;
        return current;
      });
      await this.#emit("worker.circuit_half_open", worker, {}, correlationId);
      recovered.push(worker);
    }
    return recovered;
  }
}

export const defaultWorkerLifecyclePolicy = DEFAULT_POLICY;
