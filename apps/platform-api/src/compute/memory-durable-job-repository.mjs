import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]);
const PRE_DISPATCH = new Set(["queued", "admitted", "preparing"]);

function copy(value) {
  return value === null ? null : structuredClone(value);
}

function publicState(status) {
  if (["admitted", "preparing"].includes(status)) return "preparing";
  if (status === "succeeded") return "completed";
  if (["expired", "incomplete"].includes(status)) return "failed";
  return status;
}

export class MemoryDurableJobRepository {
  #jobs = new Map();
  #byResponse = new Map();
  #byIdempotency = new Map();
  #events = new Map();
  #sequence = 0;
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #idempotencyKey(ownerIdentityId, scope, key) {
    return key ? `${ownerIdentityId}\u0000${scope}\u0000${key}` : null;
  }

  #event(job, kind, fields = {}) {
    const event = {
      sequence: ++this.#sequence,
      eventId: fields.eventId,
      jobId: job.jobId,
      eventKind: kind,
      state: job.status,
      publicState: publicState(job.status),
      progress: job.progress.value,
      progressRevision: job.progress.revision,
      progressSequence: job.progress.sequence,
      messageKey: fields.messageKey ?? job.progress.messageKey,
      payload: copy(fields.payload ?? {}),
      error: copy(fields.error ?? null),
      createdAt: new Date(fields.createdAt ?? job.updatedAt),
    };
    const events = this.#events.get(job.jobId) ?? [];
    events.push(event);
    this.#events.set(job.jobId, events);
  }

  async findIdempotent({ ownerIdentityId, scope, key }) {
    const compound = this.#idempotencyKey(ownerIdentityId, scope, key);
    return copy(compound ? this.#jobs.get(this.#byIdempotency.get(compound)) ?? null : null);
  }

  async recordReplay({ jobId, ownerIdentityId }) {
    return this.#exclusive(async () => {
      const job = this.#jobs.get(jobId);
      if (!job || job.ownerIdentityId !== ownerIdentityId) return null;
      job.replayCount = (job.replayCount ?? 0) + 1;
      return copy(job);
    });
  }

  async insertJob(job, { quota }) {
    return this.#exclusive(async () => {
      const compound = this.#idempotencyKey(
        job.ownerIdentityId,
        job.idempotency?.scope,
        job.idempotency?.key,
      );
      const existing = compound ? this.#jobs.get(this.#byIdempotency.get(compound)) : null;
      if (existing) {
        existing.replayCount = (existing.replayCount ?? 0) + 1;
        return { inserted: false, job: copy(existing) };
      }

      const records = [...this.#jobs.values()];
      const ownerOpen = records.filter((candidate) => candidate.ownerIdentityId === job.ownerIdentityId
        && !TERMINAL.has(candidate.status));
      const ownerActive = ownerOpen.filter((candidate) => !PRE_DISPATCH.has(candidate.status));
      const capabilityOpen = records.filter((candidate) => candidate.capabilityKey === job.capabilityKey
        && !TERMINAL.has(candidate.status));
      const since = new Date(job.createdAt.getTime() - 24 * 60 * 60 * 1000);
      const ownerDaily = records.filter((candidate) => candidate.ownerIdentityId === job.ownerIdentityId
        && candidate.createdAt >= since);
      if (ownerOpen.length >= quota.maxQueuedPerOwner
        || ownerActive.length >= quota.maxActivePerOwner
        || capabilityOpen.length >= quota.maxQueuedPerCapability
        || ownerDaily.length >= quota.maxDailySubmissionsPerOwner) {
        throw new PlatformError("compute_quota_exceeded", "Compute submission quota is exhausted", {
          status: 429,
          retryable: true,
        });
      }
      const stored = copy(job);
      delete stored.initialEventId;
      this.#jobs.set(stored.jobId, stored);
      if (stored.responseId) this.#byResponse.set(stored.responseId, stored.jobId);
      if (compound) this.#byIdempotency.set(compound, stored.jobId);
      this.#event(stored, "state", {
        eventId: job.initialEventId,
        messageKey: "tasks.state.queued",
        createdAt: stored.createdAt,
      });
      return { inserted: true, job: copy(stored) };
    });
  }

  async findJob(jobId) {
    return copy(this.#jobs.get(jobId) ?? null);
  }

  async findOwnedJob({ ownerIdentityId, jobId = null, responseId = null }) {
    const resolvedId = jobId ?? this.#byResponse.get(responseId);
    const job = this.#jobs.get(resolvedId);
    return copy(job?.ownerIdentityId === ownerIdentityId ? job : null);
  }

  async listOwnedJobs({ ownerIdentityId, limit = 100 }) {
    return [...this.#jobs.values()]
      .filter((job) => job.ownerIdentityId === ownerIdentityId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(copy);
  }

  async listDispatchableJobs({ limit = 32 }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new TypeError("Dispatchable job limit is invalid");
    const now = new Date();
    return [...this.#jobs.values()]
      .filter((job) => ["queued", "admitted", "preparing"].includes(job.status)
        && !job.cancelRequestedAt && (!job.deadlineAt || job.deadlineAt > now))
      .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt || left.jobId.localeCompare(right.jobId))
      .slice(0, limit)
      .map(copy);
  }

  async listManagedNodeRecoverableJobs({ limit = 32 }) {
    const now = new Date();
    return [...this.#jobs.values()]
      .filter((job) => job.status === "running" && job.route === "managed_node"
        && job.currentAttemptId && !job.cancelRequestedAt && (!job.deadlineAt || job.deadlineAt > now))
      .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt || left.jobId.localeCompare(right.jobId))
      .slice(0, limit)
      .map(copy);
  }

  async transition({ jobId, allowedFrom, status, now, messageKey, waitingReason = null, route = null }) {
    return this.#exclusive(async () => {
      const job = this.#jobs.get(jobId);
      if (!job) return null;
      if (!allowedFrom.includes(job.status)) {
        throw new PlatformError("invalid_job_transition", "Compute job state transition is invalid", { status: 409 });
      }
      job.status = status;
      job.waitingReason = waitingReason;
      if (route !== null) job.route = route;
      job.updatedAt = new Date(now);
      if (TERMINAL.has(status)) job.terminalAt = new Date(now);
      this.#event(job, "state", { messageKey, createdAt: now });
      return copy(job);
    });
  }

  async setWaiting({ jobId, waitingReason, now, eventId }) {
    return this.#exclusive(async () => {
      const job = this.#jobs.get(jobId);
      if (!job) return null;
      if (TERMINAL.has(job.status) || job.cancelRequestedAt) {
        return { changed: false, job: copy(job) };
      }
      if (job.status === "preparing") return { changed: false, job: copy(job) };
      if (!PRE_DISPATCH.has(job.status) || job.currentAttemptId) {
        throw new PlatformError("invalid_job_transition", "Compute job cannot wait after dispatch", { status: 409 });
      }
      if (job.status === "queued" && job.waitingReason === waitingReason) {
        return { changed: false, job: copy(job) };
      }
      job.status = "queued";
      job.waitingReason = waitingReason;
      job.route = "unassigned";
      job.progress.sequence += 1;
      job.progress.messageKey = "tasks.compute.waiting";
      job.updatedAt = new Date(now);
      this.#event(job, "waiting", {
        eventId,
        messageKey: "tasks.compute.waiting",
        payload: { waitingReason },
        createdAt: now,
      });
      return { changed: true, job: copy(job) };
    });
  }

  async reportProgress({ jobId, progress, messageKey, payload, now, eventId }) {
    return this.#exclusive(async () => {
      const job = this.#jobs.get(jobId);
      if (!job) return null;
      if (!["preparing", "running"].includes(job.status)) {
        throw new PlatformError("job_not_running", "Compute progress is not accepted in this state", { status: 409 });
      }
      if (progress < job.progress.value) {
        throw new PlatformError("invalid_job_progress", "Compute progress must be monotonic", { status: 409 });
      }
      job.progress.value = progress;
      job.progress.sequence += 1;
      job.progress.messageKey = messageKey;
      job.updatedAt = new Date(now);
      this.#event(job, "progress", { eventId, messageKey, payload, createdAt: now });
      return copy(job);
    });
  }

  async requestCancellation({ ownerIdentityId, jobId, responseId, now, eventId }) {
    return this.#exclusive(async () => {
      const resolvedId = jobId ?? this.#byResponse.get(responseId);
      const job = this.#jobs.get(resolvedId);
      if (!job || job.ownerIdentityId !== ownerIdentityId) return null;
      if (TERMINAL.has(job.status)) return copy(job);
      if (!job.cancelRequestedAt) {
        job.cancelRequestedAt = new Date(now);
        job.updatedAt = new Date(now);
        if (PRE_DISPATCH.has(job.status)) {
          job.status = "cancelled";
          job.terminalAt = new Date(now);
        }
        this.#event(job, "cancellation_requested", {
          eventId,
          messageKey: "tasks.cancellation.requested",
          createdAt: now,
        });
      }
      return copy(job);
    });
  }

  async complete({ jobId, resultArtifact, resultSchema, now, eventId }) {
    return this.#exclusive(async () => {
      const job = this.#jobs.get(jobId);
      if (!job) return null;
      if (job.status !== "running") {
        throw new PlatformError("invalid_job_transition", "Only a running job can complete", { status: 409 });
      }
      job.status = "succeeded";
      job.progress = { ...job.progress, value: 1, sequence: job.progress.sequence + 1 };
      job.resultArtifact = copy(resultArtifact);
      job.resultSchema = resultSchema;
      job.retryClassification = "terminal";
      job.updatedAt = new Date(now);
      job.terminalAt = new Date(now);
      this.#event(job, "result", { eventId, messageKey: "tasks.state.completed", createdAt: now });
      return copy(job);
    });
  }

  async fail({ jobId, error, retryClassification, status, now, eventId }) {
    return this.#exclusive(async () => {
      const job = this.#jobs.get(jobId);
      if (!job) return null;
      if (TERMINAL.has(job.status)) return copy(job);
      job.status = status;
      job.error = copy(error);
      job.retryClassification = retryClassification;
      job.updatedAt = new Date(now);
      job.terminalAt = new Date(now);
      this.#event(job, "retry_guidance", {
        eventId,
        messageKey: error.guidanceKey,
        error,
        createdAt: now,
      });
      return copy(job);
    });
  }

  async expireDeadlines({ now }) {
    return this.#exclusive(async () => {
      const expired = [];
      for (const job of this.#jobs.values()) {
        if (TERMINAL.has(job.status) || !job.deadlineAt || job.deadlineAt > now) continue;
        job.cancelRequestedAt = job.cancelRequestedAt ?? new Date(now);
        job.status = job.status === "running" ? "incomplete" : "expired";
        job.retryClassification = job.status === "incomplete" ? "manual_reconcile" : "terminal";
        job.error = {
          code: "deadline_exceeded",
          message: "Compute job deadline expired",
          retryable: false,
          guidanceKey: "tasks.compute.deadline_exceeded",
          retryAction: null,
        };
        job.updatedAt = new Date(now);
        job.terminalAt = new Date(now);
        this.#event(job, "state", { messageKey: job.error.guidanceKey, createdAt: now });
        expired.push(copy(job));
      }
      return expired;
    });
  }

  async listEvents({ ownerIdentityId, jobId, afterSequence = 0 }) {
    const job = this.#jobs.get(jobId);
    if (!job || job.ownerIdentityId !== ownerIdentityId) return null;
    return copy((this.#events.get(jobId) ?? []).filter((event) => event.sequence > afterSequence));
  }

  async snapshot() {
    return copy([...this.#jobs.values()]);
  }
}

export const durableJobTerminalStates = TERMINAL;
