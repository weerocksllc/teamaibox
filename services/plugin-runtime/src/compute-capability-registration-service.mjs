import { createHash, randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const OPERATION = /^[a-z][a-z0-9_.-]{2,127}$/;
const HEALTHY_WORKER_STATES = new Set(["ready", "busy"]);
const DEFAULT_TTL_SECONDS = 90;

export class ComputeCapabilityRegistrationError extends Error {
  constructor(code, message, { status = 409, retryable = false } = {}) {
    super(message);
    this.name = "ComputeCapabilityRegistrationError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function fail(code, message, options) {
  throw new ComputeCapabilityRegistrationError(code, message, options);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date;
}

function normalizedClaims(claims) {
  if (!Array.isArray(claims) || claims.length < 1 || claims.length > 64) {
    fail("compute_registration_claim_invalid", "At least one bounded capability claim is required", { status: 400 });
  }
  const profiles = new Set();
  return Object.freeze(claims.map((claim) => {
    if (!claim || Object.keys(claim).some((key) => !new Set(["modelProfileId", "operations"]).has(key))
      || !UUID.test(claim.modelProfileId ?? "") || profiles.has(claim.modelProfileId)
      || !Array.isArray(claim.operations) || claim.operations.length < 1
      || !claim.operations.every((operation) => typeof operation === "string" && OPERATION.test(operation))
      || new Set(claim.operations).size !== claim.operations.length
      || !claim.operations.every((operation, index) => index === 0 || claim.operations[index - 1] < operation)) {
      fail("compute_registration_claim_invalid", "Capability claims must be unique, sorted, and bounded", { status: 400 });
    }
    profiles.add(claim.modelProfileId);
    return Object.freeze({ modelProfileId: claim.modelProfileId, operations: Object.freeze([...claim.operations]) });
  }));
}

function publicRegistration(record) {
  return Object.freeze({
    registrationId: record.registrationId,
    pluginId: record.pluginId,
    pluginVersion: record.pluginVersion,
    pluginGeneration: record.pluginGeneration,
    workerId: record.workerId,
    workerGeneration: record.workerGeneration,
    nodeId: record.nodeId,
    modelProfileId: record.modelProfileId,
    capabilityId: record.capabilityId,
    capabilityKey: record.capabilityKey,
    modality: record.modality,
    operations: Object.freeze([...record.operations]),
    resourceEnvelope: Object.freeze(structuredClone(record.resourceEnvelope)),
    expiresAt: validDate(record.expiresAt, "expiresAt").toISOString(),
  });
}

export class ComputeCapabilityRegistrationService {
  #repository;
  #schedulerAuthority;
  #audit;
  #clock;
  #ttlSeconds;

  constructor({ repository, schedulerAuthority, auditSink, clock = () => new Date(), ttlSeconds = DEFAULT_TTL_SECONDS }) {
    if (!repository?.getActivePlugin || !repository?.getWorker || !repository?.getProfiles
      || !repository?.putCapabilityRegistration || !repository?.listCapabilityRegistrations
      || !repository?.retireWorkerRegistrations || !schedulerAuthority?.verify || !auditSink?.record) {
      throw new TypeError("compute capability registration dependencies are required");
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 300) {
      throw new TypeError("compute capability registration TTL is invalid");
    }
    this.#repository = repository;
    this.#schedulerAuthority = schedulerAuthority;
    this.#audit = auditSink;
    this.#clock = clock;
    this.#ttlSeconds = ttlSeconds;
  }

  async #emit(action, facts) {
    await this.#audit.record(Object.freeze({
      schemaVersion: 1,
      action,
      occurredAt: validDate(this.#clock(), "clock").toISOString(),
      ...structuredClone(facts),
    }));
  }

  async #verifyScheduler(authority, request) {
    try {
      return await this.#schedulerAuthority.verify(authority, request);
    } catch {
      fail("compute_registration_scheduler_required", "Verified scheduler authority is required", { status: 401 });
    }
  }

  async register({ authority, pluginId, claims }) {
    if (!PLUGIN_ID.test(pluginId ?? "")) fail("compute_registration_plugin_invalid", "Compute plugin identity is invalid", { status: 400 });
    const verified = await this.#verifyScheduler(authority, { operation: "register-compute-capabilities", pluginId });
    if (!verified || !UUID.test(verified.workerId ?? "") || !UUID.test(verified.nodeId ?? "")
      || !UUID.test(verified.leaseId ?? "") || !Number.isSafeInteger(verified.fencingToken)
      || verified.fencingToken < 1 || !Number.isSafeInteger(verified.workerGeneration) || verified.workerGeneration < 1) {
      fail("compute_registration_scheduler_required", "Verified scheduler authority is required", { status: 401 });
    }
    const normalized = normalizedClaims(claims);
    const [plugin, worker] = await Promise.all([
      this.#repository.getActivePlugin(pluginId),
      this.#repository.getWorker(verified.workerId),
    ]);
    if (!plugin || plugin.pluginType !== "ComputePlugin" || plugin.lifecycleState !== "enabled") {
      fail("compute_registration_plugin_unavailable", "Compute plugin is not active");
    }
    if (!worker || worker.pluginId !== pluginId || worker.nodeId !== verified.nodeId
      || worker.generation !== verified.workerGeneration || worker.controlLeaseId !== verified.leaseId
      || worker.controlFencingToken !== verified.fencingToken || worker.healthState !== "healthy"
      || !HEALTHY_WORKER_STATES.has(worker.lifecycleState)) {
      fail("compute_registration_worker_fenced", "Worker registration authority is stale", { status: 401 });
    }
    if (normalized.length !== 1 || normalized[0].modelProfileId !== worker.modelProfileId) {
      fail("compute_registration_profile_denied", "Worker can register only its scheduler-assigned profile");
    }
    const profiles = await this.#repository.getProfiles(normalized.map(({ modelProfileId }) => modelProfileId));
    const now = validDate(this.#clock(), "clock");
    const records = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const claim = normalized[index];
      const profile = profiles[index];
      const experimentalAllowed = profile?.certificationState === "experimental"
        && new Set(["development", "validation"]).has(verified.routingEnvironment)
        && Array.isArray(verified.experimentalProfileIds)
        && verified.experimentalProfileIds.includes(profile.modelProfileId);
      if (!profile || profile.modelProfileId !== claim.modelProfileId
        || (profile.certificationState !== "certified" && !experimentalAllowed)
        || !Array.isArray(profile.operations) || claim.operations.some((operation) => !profile.operations.includes(operation))) {
        fail("compute_registration_profile_uncertified", "Only Certified profiles or explicitly enabled non-production Experimental profiles can be registered");
      }
      const identity = {
        pluginId,
        pluginVersion: plugin.currentVersion,
        pluginGeneration: plugin.generation,
        workerId: worker.workerId,
        workerGeneration: worker.generation,
        nodeId: worker.nodeId,
        leaseId: worker.controlLeaseId,
        fencingToken: worker.controlFencingToken,
        modelProfileId: profile.modelProfileId,
        capabilityId: profile.capabilityId,
        operations: claim.operations,
      };
      const record = {
        registrationId: randomUUID(),
        ...identity,
        capabilityKey: profile.capabilityKey,
        modality: profile.modality,
        resourceEnvelope: structuredClone(profile.resourceEnvelope),
        registrationDigest: digest(identity),
        state: "available",
        observedAt: now,
        expiresAt: new Date(now.getTime() + this.#ttlSeconds * 1000),
        retiredAt: null,
        retireReason: null,
      };
      records.push(await this.#repository.putCapabilityRegistration(record));
    }
    await this.#emit("plugin.compute_capabilities.registered", {
      pluginId,
      workerId: worker.workerId,
      workerGeneration: worker.generation,
      registrationIds: records.map(({ registrationId }) => registrationId),
    });
    return Object.freeze(records.map(publicRegistration));
  }

  async listForScheduler({ authority }) {
    await this.#verifyScheduler(authority, { operation: "list-compute-capabilities" });
    const records = await this.#repository.listCapabilityRegistrations(validDate(this.#clock(), "clock"));
    return Object.freeze(records.map(publicRegistration));
  }

  async retireWorker({ authority, workerId, workerGeneration, reason = "worker_unavailable" }) {
    const verified = await this.#verifyScheduler(authority, { operation: "retire-compute-capabilities", workerId });
    if (!verified || verified.workerId !== workerId || verified.workerGeneration !== workerGeneration) {
      fail("compute_registration_scheduler_required", "Verified scheduler authority is required", { status: 401 });
    }
    const now = validDate(this.#clock(), "clock");
    const count = await this.#repository.retireWorkerRegistrations(workerId, workerGeneration, now, reason);
    await this.#emit("plugin.compute_capabilities.retired", { workerId, workerGeneration, reason, count });
    return Object.freeze({ count });
  }
}
