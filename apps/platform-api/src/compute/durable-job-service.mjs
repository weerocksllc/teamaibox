import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const DATA_CLASSES = new Set(["public", "internal", "confidential", "restricted"]);
const RETRY_CLASSIFICATIONS = new Set(["retryable", "terminal", "manual_reconcile"]);
const JOB_ROUTES = new Set(["local", "managed_node", "external_provider"]);
const DEFAULT_POLICY = Object.freeze({
  minimumPriority: 0,
  maximumPriority: 100,
  maxQueuedPerOwner: 64,
  maxActivePerOwner: 4,
  maxQueuedPerCapability: 256,
  maxDailySubmissionsPerOwner: 1000,
  maxRequestBytes: 1024 * 1024,
  maxDeadlineMs: 7 * 24 * 60 * 60 * 1000,
});

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

// A queued chat may finish through the background dispatcher's buffered path.
// Reconnecting clients must receive that saved answer, not execute it again.
async function* replayCompletedChat(job, work) {
  const result = job.result;
  if (work.operation !== "chat.completions" || result?.object !== "chat.completion"
    || !Array.isArray(result.choices) || !result.choices.length
    || !result.choices.every(choice => record(choice.message) && Number.isInteger(choice.index)
      && typeof choice.finish_reason === "string"
      && (choice.message.tool_calls === undefined || Array.isArray(choice.message.tool_calls)))) {
    throw new PlatformError("compute_stream_replay_unavailable", "The saved result cannot be replayed as a chat stream", { status: 409 });
  }
  const { choices, usage, ...metadata } = structuredClone(result);
  const base = { ...metadata, object: "chat.completion.chunk" };
  yield { data: { ...base, choices: choices.map(({ message, ...choice }) => ({
    ...choice, finish_reason: null, delta: { ...message,
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}),
    },
  })) } };
  yield { data: { ...base, choices: choices.map(choice => ({ index: choice.index, delta: {}, finish_reason: choice.finish_reason })) } };
  if (work.request?.stream_options?.include_usage === true && usage) {
    yield { data: { ...base, choices: [], usage } };
  }
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PlatformError("invalid_compute_request", "Request contains a non-finite number", { status: 400 });
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw new PlatformError("invalid_compute_request", "Request contains an unsupported value", { status: 400 });
}

function requestFacts(request) {
  const serialized = canonical(request);
  return {
    bytes: Buffer.byteLength(serialized, "utf8"),
    digest: `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`,
  };
}

function requiredUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new PlatformError("invalid_compute_request", `${label} is invalid`, { status: 400 });
  }
  return value;
}

function requiredKey(value, label) {
  if (typeof value !== "string" || !KEY.test(value)) {
    throw new PlatformError("invalid_compute_request", `${label} is invalid`, { status: 400 });
  }
  return value;
}

function safeModel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\s\u0000-\u001f]/u.test(value)) {
    throw new PlatformError("invalid_compute_request", "Requested model is invalid", { status: 400 });
  }
  return value;
}

function safeDeadline(value, now, maximumMs) {
  if (value === null || value === undefined) return null;
  const deadline = new Date(value);
  if (!Number.isFinite(deadline.getTime()) || deadline <= now || deadline.getTime() - now.getTime() > maximumMs) {
    throw new PlatformError("invalid_compute_deadline", "Compute deadline is outside the allowed window", { status: 400 });
  }
  return deadline;
}

function publicJob(job, result = null) {
  return Object.freeze({
    schemaVersion: 1,
    jobId: job.jobId,
    responseId: job.responseId,
    ownerIdentityId: job.ownerIdentityId,
    capabilityId: job.capabilityId,
    capabilityKey: job.capabilityKey,
    operation: job.operation,
    status: job.status,
    priority: job.priority,
    route: job.route,
    model: job.requestedModel,
    profileId: job.requestedModelProfileId,
    attemptId: job.currentAttemptId,
    requestDigest: job.requestDigest,
    dataClass: job.dataClass,
    progress: Object.freeze(structuredClone(job.progress)),
    waitingReason: job.waitingReason,
    retryClassification: job.retryClassification,
    error: job.error ? Object.freeze(structuredClone(job.error)) : null,
    resultSchema: job.resultSchema,
    result: result === null ? null : Object.freeze(structuredClone(result)),
    output: Array.isArray(result?.output) ? Object.freeze(structuredClone(result.output)) : Object.freeze([]),
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    terminalAt: job.terminalAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  });
}

function publicTaskResults(job) {
  if (!job.resultArtifact || job.status !== "succeeded" || !UUID.test(job.jobId)) return Object.freeze([]);
  return Object.freeze([Object.freeze({ label: "tasks.result.output", artifactRef: job.jobId })]);
}

function dispatchJob(job) {
  return Object.freeze({ ...publicJob(job), correlationId: job.correlationId });
}

function missingJob() {
  throw new PlatformError("job_not_found", "Compute job was not found", { status: 404 });
}

export class DurableJobService {
  #repository;
  #payloads;
  #resolveCapability;
  #clock;
  #policy;
  #policySource;
  #audit;
  #artifactHandoff;

  constructor({
    repository,
    payloadStore,
    resolveCapability,
    clock = () => new Date(),
    policy = {},
    policySource = null,
    audit = async () => {},
    artifactHandoff = null,
  }) {
    const repositoryMethods = [
      "findIdempotent", "recordReplay", "insertJob", "findOwnedJob", "findJob", "transition",
      "setWaiting", "reportProgress", "requestCancellation", "complete", "fail", "expireDeadlines",
      "listEvents",
    ];
    if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function")) {
      throw new TypeError("durable job repository is incomplete");
    }
    if (!payloadStore?.persist || !payloadStore?.read || !payloadStore?.discard) {
      throw new TypeError("protected job payload store is incomplete");
    }
    if (typeof resolveCapability !== "function") throw new TypeError("capability resolver is required");
    if (artifactHandoff !== null && (!artifactHandoff?.resolveInputs || !artifactHandoff?.registerResults)) {
      throw new TypeError("compute artifact handoff is incomplete");
    }
    if (policySource !== null && typeof policySource?.submissionPolicy !== "function") {
      throw new TypeError("compute policy source is incomplete");
    }
    const merged = { ...DEFAULT_POLICY, ...policy };
    this.#validatePolicy(merged);
    this.#repository = repository;
    this.#payloads = payloadStore;
    this.#resolveCapability = resolveCapability;
    this.#clock = clock;
    this.#policy = Object.freeze(merged);
    this.#policySource = policySource;
    this.#audit = audit;
    this.#artifactHandoff = artifactHandoff;
  }

  async #emit(action, fields) {
    await this.#audit({ action, occurredAt: this.#clock().toISOString(), ...fields });
  }

  #validatePolicy(value) {
    for (const [key, item] of Object.entries(value)) {
      const minimum = key === "minimumPriority" ? 0 : 1;
      if (!Number.isSafeInteger(item) || item < minimum) throw new TypeError(`compute policy ${key} is invalid`);
    }
    if (value.minimumPriority > 100 || value.maximumPriority > 100 || value.minimumPriority > value.maximumPriority) {
      throw new TypeError("compute priority policy is invalid");
    }
    return value;
  }

  async #effectivePolicy() {
    if (!this.#policySource) return this.#policy;
    const dynamic = await this.#policySource.submissionPolicy();
    if (!record(dynamic)) throw new PlatformError("compute_policy_unavailable", "Queue admission policy is unavailable", { status: 503, retryable: true });
    try { return Object.freeze(this.#validatePolicy({ ...this.#policy, ...dynamic })); }
    catch { throw new PlatformError("compute_policy_invalid", "Queue admission policy is invalid", { status: 503 }); }
  }

  async submit(work) {
    if (!record(work) || !record(work.request)) {
      throw new PlatformError("invalid_compute_request", "Compute submission is invalid", { status: 400 });
    }
    const now = this.#clock();
    const effectivePolicy = await this.#effectivePolicy();
    const ownerIdentityId = requiredUuid(work.ownerIdentityId, "Owner identity");
    const capabilityKey = requiredKey(work.capabilityKey, "Capability");
    const operation = requiredKey(work.operation, "Operation");
    const capability = await this.#resolveCapability(capabilityKey);
    if (!record(capability) || !UUID.test(capability.capabilityId) || capability.enabled !== true
      || (Array.isArray(capability.operations) && !capability.operations.includes(operation))) {
      throw new PlatformError("capability_unavailable", "Requested capability is unavailable", { status: 409, retryable: true });
    }
    const priority = work.priority ?? 50;
    if (!Number.isInteger(priority) || priority < effectivePolicy.minimumPriority || priority > effectivePolicy.maximumPriority) {
      throw new PlatformError("invalid_compute_priority", "Compute priority is invalid", { status: 400 });
    }
    if (!DATA_CLASSES.has(work.dataClass)) {
      throw new PlatformError("invalid_compute_request", "Compute data class is invalid", { status: 400 });
    }
    if (typeof work.correlationId !== "string" || !CORRELATION.test(work.correlationId)) {
      throw new PlatformError("invalid_compute_request", "Compute correlation identifier is invalid", { status: 400 });
    }
    const idempotencyKey = work.idempotencyKey ?? null;
    if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || !IDEMPOTENCY.test(idempotencyKey))) {
      throw new PlatformError("invalid_compute_request", "Idempotency key is invalid", { status: 400 });
    }
    const requestedModelProfileId = work.requestedModelProfileId === null || work.requestedModelProfileId === undefined
      ? null
      : requiredUuid(work.requestedModelProfileId, "Model profile");
    const requestedModel = safeModel(work.requestedModel);
    const deadlineAt = safeDeadline(work.deadlineAt, now, effectivePolicy.maxDeadlineMs);
    const payloadFacts = requestFacts(work.request);
    if (payloadFacts.bytes > effectivePolicy.maxRequestBytes) {
      throw new PlatformError("compute_request_too_large", "Compute request exceeds its quota", { status: 413 });
    }
    const facts = requestFacts({
      capabilityKey,
      operation,
      requestedModel,
      requestedModelProfileId,
      dataClass: work.dataClass,
      priority,
      deadlineAt: deadlineAt?.toISOString() ?? null,
      request: work.request,
    });
    const idempotency = idempotencyKey ? { scope: `${capabilityKey}:${operation}`, key: idempotencyKey } : null;
    if (idempotency) {
      const existing = await this.#repository.findIdempotent({ ownerIdentityId, ...idempotency });
      if (existing) {
        if (existing.requestDigest !== facts.digest) {
          throw new PlatformError("idempotency_conflict", "Idempotency key was used with different request facts", { status: 409 });
        }
        const replayed = await this.#repository.recordReplay({ jobId: existing.jobId, ownerIdentityId });
        if (!replayed) missingJob();
        await this.#emit("compute.job_replayed", { jobId: replayed.jobId, ownerIdentityId, operation });
        return publicJob(replayed);
      }
    }

    const jobId = randomUUID();
    const inputArtifacts = this.#artifactHandoff
      ? await this.#artifactHandoff.resolveInputs({
        ownerIdentityId, jobId, capabilityKey, operation, request: work.request,
      })
      : [];
    const requestArtifact = await this.#payloads.persist({
      ownerIdentityId,
      jobId,
      relationship: "input",
      dataClass: work.dataClass,
      payload: work.request,
      inputArtifacts,
    });
    const job = {
      jobId,
      responseId: operation === "responses" ? `resp_${randomUUID().replaceAll("-", "")}` : null,
      ownerIdentityId,
      capabilityId: capability.capabilityId,
      capabilityKey,
      operation,
      requestedModel,
      requestedModelProfileId,
      status: "queued",
      priority,
      route: "unassigned",
      idempotency,
      requestDigest: facts.digest,
      requestSizeBytes: payloadFacts.bytes,
      requestArtifact,
      inputArtifacts,
      resultArtifact: null,
      resultSchema: null,
      dataClass: work.dataClass,
      progress: { revision: 1, sequence: 0, value: 0, messageKey: "tasks.state.queued" },
      waitingReason: null,
      currentAttemptId: null,
      retryClassification: null,
      error: null,
      correlationId: work.correlationId,
      deadlineAt,
      cancelRequestedAt: null,
      terminalAt: null,
      initialEventId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      replayCount: 0,
    };
    try {
      const result = await this.#repository.insertJob(job, { quota: effectivePolicy });
      if (!result.inserted) {
        await this.#payloads.discard({ ownerIdentityId, artifact: requestArtifact });
        if (result.job.requestDigest !== facts.digest) {
          throw new PlatformError("idempotency_conflict", "Idempotency key was used with different request facts", { status: 409 });
        }
        await this.#emit("compute.job_replayed", { jobId: result.job.jobId, ownerIdentityId, operation });
        return publicJob(result.job);
      }
      await this.#emit("compute.job_submitted", {
        jobId,
        ownerIdentityId,
        capabilityKey,
        operation,
        priority,
        dataClass: work.dataClass,
      });
      return publicJob(result.job);
    } catch (error) {
      const persisted = await this.#repository.findOwnedJob({ ownerIdentityId, jobId });
      if (!persisted) await this.#payloads.discard({ ownerIdentityId, artifact: requestArtifact }).catch(() => {});
      throw error;
    }
  }

  async get({ ownerIdentityId, jobId = null, responseId = null, includeResult = true }) {
    const job = await this.#repository.findOwnedJob({ ownerIdentityId, jobId, responseId });
    if (!job) missingJob();
    let result = includeResult && job.resultArtifact
      ? await this.#payloads.read({ ownerIdentityId, artifact: job.resultArtifact })
      : null;
    if (result && typeof this.#payloads.refreshResultReferences === "function") {
      result = await this.#payloads.refreshResultReferences({ ownerIdentityId, result, expiresInSeconds: 900 });
    }
    return publicJob(job, result);
  }

  async executionInput({ jobId, ownerIdentityId }) {
    requiredUuid(jobId, "Job");
    requiredUuid(ownerIdentityId, "Owner identity");
    const job = await this.#repository.findOwnedJob({ ownerIdentityId, jobId });
    if (!job) missingJob();
    if (!new Set(["queued", "admitted", "preparing", "running"]).has(job.status)) {
      throw new PlatformError("job_not_dispatchable", "Compute job cannot be dispatched in its current state", { status: 409 });
    }
    const request = await this.#payloads.read({ ownerIdentityId, artifact: job.requestArtifact });
    return Object.freeze({ job: publicJob(job), request: Object.freeze(structuredClone(request)),
      requestArtifact: Object.freeze(structuredClone(job.requestArtifact)),
      inputArtifacts: Object.freeze(structuredClone(job.inputArtifacts
        ?? job.requestArtifact?.extensions?.inputArtifacts ?? [])) });
  }

  async listOwn({ ownerIdentityId, limit = 100 }) {
    requiredUuid(ownerIdentityId, "Owner identity");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PlatformError("invalid_compute_request", "Own-task limit is invalid", { status: 400 });
    }
    if (typeof this.#repository.listOwnedJobs !== "function") {
      throw new PlatformError("task_listing_unavailable", "Own-task listing is unavailable", { status: 503, retryable: true });
    }
    return Object.freeze((await this.#repository.listOwnedJobs({ ownerIdentityId, limit })).map((job) => Object.freeze({
      ...publicJob(job),
      results: publicTaskResults(job),
    })));
  }

  async resultReference({ ownerIdentityId, jobId, expiresInSeconds = 300 }) {
    requiredUuid(ownerIdentityId, "Owner identity");
    requiredUuid(jobId, "Job");
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) {
      throw new PlatformError("invalid_compute_request", "Result reference lifetime is invalid", { status: 400 });
    }
    const job = await this.#repository.findOwnedJob({ ownerIdentityId, jobId });
    if (!job || job.status !== "succeeded" || !job.resultArtifact) {
      throw new PlatformError("task_result_not_found", "Task result was not found", { status: 404 });
    }
    if (typeof this.#payloads.refreshReference !== "function") {
      throw new PlatformError("task_result_unavailable", "Task result is unavailable", { status: 503, retryable: true });
    }
    const artifact = await this.#payloads.refreshReference({
      ownerIdentityId,
      artifact: job.resultArtifact,
      audience: "compute.user-result",
      expiresInSeconds,
    });
    const referenceId = artifact?.object?.referenceId;
    if (!UUID.test(referenceId ?? "")) {
      throw new PlatformError("task_result_unavailable", "Task result is unavailable", { status: 503, retryable: true });
    }
    return Object.freeze({
      taskId: job.jobId,
      label: "tasks.result.output",
      referenceId,
      expiresAt: artifact.extensions?.referenceExpiresAt ?? null,
    });
  }

  async listDispatchable({ limit = 32 } = {}) {
    if (typeof this.#repository.listDispatchableJobs !== "function") {
      throw new PlatformError("compute_reconciliation_unavailable", "Compute reconciliation is unavailable", { status: 503, retryable: true });
    }
    return Object.freeze((await this.#repository.listDispatchableJobs({ limit })).map((job) => dispatchJob(job)));
  }

  async listManagedNodeRecoverable({ limit = 32 } = {}) {
    if (typeof this.#repository.listManagedNodeRecoverableJobs !== "function") return Object.freeze([]);
    return Object.freeze((await this.#repository.listManagedNodeRecoverableJobs({ limit })).map((job) => dispatchJob(job)));
  }

  async cancel({ ownerIdentityId, jobId = null, responseId = null }) {
    const job = await this.#repository.requestCancellation({
      ownerIdentityId,
      jobId,
      responseId,
      now: this.#clock(),
      eventId: randomUUID(),
    });
    if (!job) missingJob();
    await this.#emit("compute.job_cancellation_requested", { jobId: job.jobId, ownerIdentityId, state: job.status });
    return publicJob(job);
  }

  async markPreparing(jobId, waitingReason = "worker_preparing", route = "local") {
    requiredUuid(jobId, "Job");
    if (!JOB_ROUTES.has(route)) throw new PlatformError("invalid_compute_route", "Compute route is invalid", { status: 400 });
    const job = await this.#repository.transition({
      jobId,
      allowedFrom: ["queued", "admitted"],
      status: "preparing",
      waitingReason: requiredKey(waitingReason, "Waiting reason"),
      route,
      now: this.#clock(),
      messageKey: "tasks.state.preparing",
    });
    if (!job) missingJob();
    return publicJob(job);
  }

  async markWaiting(jobId, waitingReason) {
    requiredUuid(jobId, "Job");
    const reason = requiredKey(waitingReason, "Waiting reason");
    const result = await this.#repository.setWaiting({
      jobId,
      waitingReason: reason,
      now: this.#clock(),
      eventId: randomUUID(),
    });
    if (!result) missingJob();
    if (result.changed) {
      await this.#emit("compute.job_waiting", {
        jobId,
        ownerIdentityId: result.job.ownerIdentityId,
        waitingReason: reason,
      });
    }
    return publicJob(result.job);
  }

  async markRunning(jobId) {
    requiredUuid(jobId, "Job");
    const job = await this.#repository.transition({
      jobId,
      allowedFrom: ["queued", "admitted", "preparing"],
      status: "running",
      now: this.#clock(),
      messageKey: "tasks.state.running",
    });
    if (!job) missingJob();
    return publicJob(job);
  }

  async reportProgress(jobId, { value, messageKey = "tasks.progress.updated", payload = {} }) {
    requiredUuid(jobId, "Job");
    if (!Number.isFinite(value) || value < 0 || value >= 1 || !record(payload)) {
      throw new PlatformError("invalid_job_progress", "Compute progress is invalid", { status: 400 });
    }
    requiredKey(messageKey, "Progress message key");
    const job = await this.#repository.reportProgress({
      jobId,
      progress: value,
      messageKey,
      payload,
      now: this.#clock(),
      eventId: randomUUID(),
    });
    if (!job) missingJob();
    return publicJob(job);
  }

  async acknowledgeCancellation(jobId) {
    requiredUuid(jobId, "Job");
    const current = await this.#repository.findJob(jobId);
    if (!current) missingJob();
    if (!current.cancelRequestedAt) {
      throw new PlatformError("cancellation_not_requested", "Compute cancellation was not requested", { status: 409 });
    }
    if (current.status === "cancelled") return publicJob(current);
    const job = await this.#repository.transition({
      jobId,
      allowedFrom: ["preparing", "running"],
      status: "cancelled",
      now: this.#clock(),
      messageKey: "tasks.state.cancelled",
    });
    if (!job) missingJob();
    await this.#emit("compute.job_cancelled", { jobId, ownerIdentityId: job.ownerIdentityId });
    return publicJob(job);
  }

  async complete(jobId, { result, resultSchema = null }) {
    requiredUuid(jobId, "Job");
    if (!record(result) || (resultSchema !== null && (typeof resultSchema !== "string" || resultSchema.length > 256))) {
      throw new PlatformError("invalid_compute_result", "Compute result is invalid", { status: 400 });
    }
    const current = await this.#repository.findJob(jobId);
    if (!current) missingJob();
    const registeredArtifacts = this.#artifactHandoff
      ? await this.#artifactHandoff.registerResults({
        ownerIdentityId: current.ownerIdentityId, jobId, capabilityKey: current.capabilityKey,
        operation: current.operation, result,
        inputArtifacts: current.inputArtifacts ?? current.requestArtifact?.extensions?.inputArtifacts ?? [],
      })
      : [];
    const artifact = await this.#payloads.persist({
      ownerIdentityId: current.ownerIdentityId,
      jobId,
      relationship: "output",
      dataClass: current.dataClass,
      payload: result,
      inputArtifacts: current.inputArtifacts ?? current.requestArtifact?.extensions?.inputArtifacts ?? [],
      registeredArtifacts,
    });
    try {
      const job = await this.#repository.complete({
        jobId,
        resultArtifact: artifact,
        resultSchema,
        now: this.#clock(),
        eventId: randomUUID(),
      });
      if (!job) missingJob();
      await this.#emit("compute.job_completed", { jobId, ownerIdentityId: current.ownerIdentityId, resultSchema });
      return publicJob(job, result);
    } catch (error) {
      await this.#payloads.discard({ ownerIdentityId: current.ownerIdentityId, artifact }).catch(() => {});
      throw error;
    }
  }

  async fail(jobId, { code, message, retryClassification, guidanceKey, retryAction = null }) {
    requiredUuid(jobId, "Job");
    requiredKey(code, "Error code");
    requiredKey(guidanceKey, "Guidance key");
    if (!RETRY_CLASSIFICATIONS.has(retryClassification)
      || typeof message !== "string" || message.length < 1 || message.length > 1024
      || (retryAction !== null && !KEY.test(retryAction))) {
      throw new PlatformError("invalid_compute_error", "Compute error classification is invalid", { status: 400 });
    }
    const error = {
      code,
      message,
      retryable: retryClassification === "retryable",
      guidanceKey,
      retryAction,
    };
    const job = await this.#repository.fail({
      jobId,
      error,
      retryClassification,
      status: retryClassification === "manual_reconcile" ? "incomplete" : "failed",
      now: this.#clock(),
      eventId: randomUUID(),
    });
    if (!job) missingJob();
    await this.#emit("compute.job_failed", { jobId, ownerIdentityId: job.ownerIdentityId, code, retryClassification });
    return publicJob(job);
  }

  async expireDeadlines() {
    const jobs = await this.#repository.expireDeadlines({ now: this.#clock() });
    for (const job of jobs) {
      await this.#emit("compute.job_deadline_expired", {
        jobId: job.jobId,
        ownerIdentityId: job.ownerIdentityId,
        state: job.status,
      });
    }
    return Object.freeze(jobs.map((job) => publicJob(job)));
  }

  async events({ ownerIdentityId, jobId, afterSequence = 0 }) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new PlatformError("invalid_event_cursor", "Job event cursor is invalid", { status: 400 });
    }
    const events = await this.#repository.listEvents({ ownerIdentityId, jobId, afterSequence });
    if (events === null) missingJob();
    return Object.freeze(events.map((event) => Object.freeze({
      ...structuredClone(event),
      createdAt: event.createdAt.toISOString(),
    })));
  }
}

export const durableJobPolicyDefaults = DEFAULT_POLICY;

export class DurableComputeBackend {
  #jobs;
  #execution;
  #realtime;
  #reconcileTimer = null;
  #reconciling = false;

  constructor({ jobService, execution, realtimeAdmission }) {
    if (!jobService?.submit || !jobService?.get || !jobService?.cancel) {
      throw new TypeError("durable job service is required");
    }
    if (!execution?.awaitResult || !execution?.streamResult) {
      throw new TypeError("compute execution bridge is required");
    }
    const realtimeMethods = ["admit", "connect", "heartbeat", "disconnect"];
    if (!realtimeAdmission || realtimeMethods.some((method) => typeof realtimeAdmission[method] !== "function")) {
      throw new TypeError("realtime admission service is incomplete");
    }
    this.#jobs = jobService;
    this.#execution = execution;
    this.#realtime = realtimeAdmission;
  }

  async submit(work) {
    const accepted = await this.#jobs.submit(work);
    if (accepted.status !== "succeeded" && work?.deferDispatch !== true
        && this.#execution.canDispatch?.(work) === true) {
      queueMicrotask(() => { void this.#execution.dispatch({
        jobId: accepted.jobId,
        ownerIdentityId: accepted.ownerIdentityId,
      }); });
    }
    return accepted;
  }

  async reconcile({ limit = 32 } = {}) {
    if (this.#reconciling || typeof this.#jobs.listDispatchable !== "function") return Object.freeze({ inspected: 0, dispatched: 0 });
    this.#reconciling = true;
    try {
      const jobs = await this.#jobs.listDispatchable({ limit });
      let dispatched = 0;
      for (const job of jobs) {
        const work = { operation: job.operation, requestedModel: job.model,
          requestedModelProfileId: job.profileId };
        if (this.#execution.canDispatch?.(work) !== true) continue;
        dispatched += 1;
        void this.#execution.dispatch({ jobId: job.jobId, ownerIdentityId: job.ownerIdentityId });
      }
      return Object.freeze({ inspected: jobs.length, dispatched });
    } finally {
      this.#reconciling = false;
    }
  }

  startReconciler({ intervalMilliseconds = 5_000, limit = 32 } = {}) {
    if (this.#reconcileTimer) return false;
    if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1_000 || intervalMilliseconds > 60_000) {
      throw new TypeError("Compute reconciliation interval is invalid");
    }
    const tick = () => { void this.reconcile({ limit }).catch(() => {}); };
    this.#reconcileTimer = setInterval(tick, intervalMilliseconds);
    this.#reconcileTimer.unref?.();
    queueMicrotask(tick);
    return true;
  }

  stopReconciler() {
    if (!this.#reconcileTimer) return false;
    clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = null;
    return true;
  }

  async invoke(work) {
    const accepted = await this.#jobs.submit(work);
    const completed = accepted.status === "succeeded"
      ? await this.#jobs.get({ ownerIdentityId: accepted.ownerIdentityId, jobId: accepted.jobId })
      : await this.#execution.awaitResult({ jobId: accepted.jobId, ownerIdentityId: accepted.ownerIdentityId });
    if (completed.status !== "succeeded" || !record(completed.result)) {
      throw new PlatformError("compute_not_completed", "Compute job did not complete successfully", { status: 502 });
    }
    return { job: completed, body: completed.result };
  }

  async stream(work) {
    const accepted = await this.#jobs.submit(work);
    const input = { jobId: accepted.jobId, ownerIdentityId: accepted.ownerIdentityId };
    if (accepted.status === "succeeded") {
      return replayCompletedChat(await this.#jobs.get(input), work);
    }
    const jobs = this.#jobs, execution = this.#execution;
    return (async function* () {
      let emitted = false;
      try {
        for await (const item of await execution.streamResult(input)) {
          emitted = true;
          yield item;
        }
      } catch (error) {
        // Completion can race stream preparation. Never append a whole answer
        // after delivering part of a stream, or disguise an unfinished job.
        if (!emitted && ["job_not_dispatchable", "job_execution_in_progress", "compute_local_worker_busy"].includes(error.code)) {
          const completed = await jobs.get(input);
          if (completed.status === "succeeded") {
            yield* replayCompletedChat(completed, work);
            return;
          }
        }
        throw error;
      }
    }());
  }

  async getJob(input) {
    return this.#jobs.get(input);
  }

  async cancelJob(input) {
    const job = await this.#jobs.cancel(input);
    if (job.cancelRequestedAt && !new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]).has(job.status)) {
      await this.#execution.cancel?.(job.jobId);
      return this.#jobs.get({ ownerIdentityId: job.ownerIdentityId, jobId: job.jobId });
    }
    return job;
  }

  async admitRealtime(input) {
    return this.#realtime.admit(input);
  }

  async connectRealtime(input) {
    return this.#realtime.connect(input);
  }

  async heartbeatRealtime(input) {
    return this.#realtime.heartbeat(input);
  }

  async disconnectRealtime(input) {
    return this.#realtime.disconnect(input);
  }
}
