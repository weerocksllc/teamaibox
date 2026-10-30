import { PlatformError } from "../../../packages/observability/src/index.mjs";

const TERMINAL_JOBS = new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]);
const ACTIVE_ATTEMPTS = new Set(["pending", "dispatched", "accepted", "running"]);
const ACTIVE_REALTIME = new Set(["admitted", "connected"]);

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function conflict(code, message) {
  return new PlatformError(code, message, { status: 409, retryable: true });
}

export class MemoryLeaseRepository {
  #nodes = new Map();
  #jobs = new Map();
  #attempts = new Map();
  #leaseSets = new Map();
  #byAcquisition = new Map();
  #byToken = new Map();
  #fences = new Map();
  #exclusiveIntents = new Map();
  #realtimeSessions = new Map();
  #realtimeByAdmission = new Map();
  #tail = Promise.resolve();

  constructor({ nodes = [], jobs = [] } = {}) {
    for (const node of nodes) this.#nodes.set(node.nodeId, copy(node));
    for (const job of jobs) this.#jobs.set(job.jobId, copy(job));
  }

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

  #leaseForToken(leaseToken) {
    const id = this.#byToken.get(leaseToken);
    return id ? this.#leaseSets.get(id) : null;
  }

  #assertFence(lease, fencingToken) {
    if (!lease || lease.fencingToken !== fencingToken) {
      throw conflict("stale_lease_fence", "Lease fencing token is stale or unknown");
    }
  }

  #activeForJob(jobId) {
    return [...this.#leaseSets.values()].find((lease) => lease.jobId === jobId && lease.state === "active");
  }

  async findActiveByJob(jobId) {
    return copy(this.#activeForJob(jobId) ?? null);
  }

  #activeForNode(nodeId, at) {
    return [...this.#leaseSets.values()].filter((lease) =>
      lease.nodeId === nodeId
      && lease.state === "active"
      && lease.expiresAt > at,
    );
  }

  #closeRealtime(session, state, reason, at) {
    if (!ACTIVE_REALTIME.has(session.state)) return;
    session.state = state;
    session.releaseReason = reason;
    session.releasedAt = new Date(at);
    session.updatedAt = new Date(at);
  }

  #expireRealtime(at) {
    for (const session of this.#realtimeSessions.values()) {
      if (!ACTIVE_REALTIME.has(session.state)) continue;
      if (session.expiresAt <= at) {
        this.#closeRealtime(session, "expired", "session_expired", at);
      } else if (session.state === "admitted" && session.connectionDeadlineAt <= at) {
        this.#closeRealtime(session, "expired", "connection_timeout", at);
      }
    }
  }

  #activeRealtimeForNode(nodeId, at) {
    this.#expireRealtime(at);
    return [...this.#realtimeSessions.values()].filter((session) =>
      session.nodeId === nodeId && ACTIVE_REALTIME.has(session.state) && session.expiresAt > at,
    );
  }

  #ownedRealtime(ownerIdentityId, sessionId) {
    const session = this.#realtimeSessions.get(sessionId);
    if (!session || session.ownerIdentityId !== ownerIdentityId) {
      throw new PlatformError("realtime_session_not_found", "Realtime session was not found", { status: 404 });
    }
    return session;
  }

  #activeExclusiveIntent(nodeId, at) {
    for (const intent of this.#exclusiveIntents.values()) {
      if (intent.state === "pending" && intent.deadlineAt <= at) {
        intent.state = "expired";
        intent.finishedAt = new Date(at);
        intent.finishReason = "intent_expired";
      }
    }
    return [...this.#exclusiveIntents.values()].find((intent) =>
      intent.nodeId === nodeId && ["pending", "acquired"].includes(intent.state),
    );
  }

  #closeLease(lease, state, reason, at) {
    if (lease.state !== "active") return;
    lease.state = state;
    lease.releaseReason = reason;
    lease.releasedAt = new Date(at);
    lease.reconciliationCount += 1;
    lease.lastReconciledAt = new Date(at);

    if (lease.nodeExclusive) {
      const intent = [...this.#exclusiveIntents.values()].find((item) =>
        item.leaseSetId === lease.leaseSetId && item.state === "acquired",
      );
      if (intent) {
        intent.state = "completed";
        intent.finishedAt = new Date(at);
        intent.finishReason = reason;
      }
    }

    const attempt = this.#attempts.get(lease.attemptId);
    const job = this.#jobs.get(lease.jobId);
    const jobIsTerminal = TERMINAL_JOBS.has(job?.status);
    if (attempt && ACTIVE_ATTEMPTS.has(attempt.status) && !jobIsTerminal) {
      attempt.status = attempt.acceptanceState === "not_accepted" ? "lost" : "incomplete";
      attempt.retryable = attempt.acceptanceState === "not_accepted";
      attempt.errorCode = reason;
      attempt.finishedAt = new Date(at);
    }
    if (job?.currentAttemptId === lease.attemptId) job.currentAttemptId = null;
    if (job && !jobIsTerminal) {
      if (attempt?.acceptanceState === "not_accepted") {
        job.status = "queued";
        job.waitingReason = reason;
      } else {
        job.status = "incomplete";
        job.waitingReason = null;
        job.retryClassification = "manual_reconcile";
        job.terminalAt = new Date(at);
      }
      job.updatedAt = new Date(at);
    }
  }

  async acquireLeaseSet(input) {
    return this.#exclusive(async () => {
      const previousId = this.#byAcquisition.get(input.acquisitionKey);
      if (previousId) {
        const previous = this.#leaseSets.get(previousId);
        if (previous.jobId !== input.jobId
            || previous.nodeId !== input.nodeId
            || previous.modelProfileId !== input.modelProfileId
            || previous.nodeExclusive !== input.nodeExclusive
            || JSON.stringify(previous.reservation) !== JSON.stringify(input.reservation)) {
          throw conflict("acquisition_key_conflict", "Lease acquisition key was reused with different facts");
        }
        return copy(previous);
      }

      const job = this.#jobs.get(input.jobId);
      if (!job) throw new PlatformError("job_not_found", "Compute job does not exist", { status: 404 });
      if (TERMINAL_JOBS.has(job.status) || job.cancelRequestedAt) {
        throw conflict("job_not_leasable", "Compute job is terminal or cancelled");
      }
      if (this.#activeForJob(input.jobId)) {
        throw conflict("active_job_lease_exists", "Compute job already has an active lease set");
      }

      const node = this.#nodes.get(input.nodeId);
      if (!node) throw new PlatformError("node_not_found", "Compute node does not exist", { status: 404 });
      if (node.lifecycleState !== "ready") {
        throw conflict("node_not_ready", "Compute node is not ready");
      }
      if (node.generation !== input.nodeGeneration) {
        throw conflict("stale_node_generation", "Compute node generation changed");
      }

      for (const due of this.#activeForNode(input.nodeId, new Date(0))) {
        if (due.expiresAt <= input.acquiredAt) {
          this.#closeLease(due, "expired", "lease_expired", input.acquiredAt);
        }
      }

      const exclusiveIntent = this.#activeExclusiveIntent(input.nodeId, input.acquiredAt);
      const activeOnNode = this.#activeForNode(input.nodeId, input.acquiredAt);
      const activeRealtime = this.#activeRealtimeForNode(input.nodeId, input.acquiredAt);
      if (input.nodeExclusive) {
        if (!exclusiveIntent || exclusiveIntent.jobId !== input.jobId || exclusiveIntent.state !== "pending") {
          throw conflict("exclusive_intent_required", "Node-exclusive acquisition requires its active preparation intent");
        }
        if (activeOnNode.length || activeRealtime.length) {
          throw conflict("exclusive_conflicting_leases", "Conflicting AI leases must drain before node-exclusive acquisition");
        }
      } else {
        if (exclusiveIntent) {
          throw conflict("node_exclusive_pending", "Node is reserved for pending or active exclusive work");
        }
        if (activeOnNode.some((lease) => lease.nodeExclusive)) {
          throw conflict("node_exclusive_active", "Node has an active exclusive lease");
        }
      }

      const fencingToken = (this.#fences.get(input.nodeId) ?? 0) + 1;
      this.#fences.set(input.nodeId, fencingToken);
      const attemptNumber = [...this.#attempts.values()]
        .filter((attempt) => attempt.jobId === input.jobId).length + 1;
      const attempt = {
        attemptId: input.attemptId,
        jobId: input.jobId,
        attemptNumber,
        nodeId: input.nodeId,
        modelProfileId: input.modelProfileId,
        dispatchFence: fencingToken,
        status: "pending",
        acceptanceState: "not_accepted",
        retryable: null,
        errorCode: null,
        dispatchedAt: null,
        acceptedAt: null,
        finishedAt: null,
        createdAt: new Date(input.acquiredAt),
      };
      const lease = {
        leaseSetId: input.attemptId,
        acquisitionKey: input.acquisitionKey,
        nodeId: input.nodeId,
        nodeGeneration: input.nodeGeneration,
        jobId: input.jobId,
        attemptId: input.attemptId,
        modelProfileId: input.modelProfileId,
        leaseToken: input.leaseToken,
        fencingToken,
        state: "active",
        dispatchState: "pending",
        dispatchId: null,
        reservation: copy(input.reservation),
        acquiredAt: new Date(input.acquiredAt),
        heartbeatAt: new Date(input.acquiredAt),
        expiresAt: new Date(input.expiresAt),
        dispatchedAt: null,
        acceptedAt: null,
        releasedAt: null,
        releaseReason: null,
        reconciliationCount: 0,
        lastReconciledAt: null,
        nodeExclusive: input.nodeExclusive,
      };

      this.#attempts.set(attempt.attemptId, attempt);
      this.#leaseSets.set(lease.leaseSetId, lease);
      this.#byAcquisition.set(lease.acquisitionKey, lease.leaseSetId);
      this.#byToken.set(lease.leaseToken, lease.leaseSetId);
      job.status = "admitted";
      job.route = node.labels?.localAppliance === true ? "local" : "managed_node";
      job.currentAttemptId = attempt.attemptId;
      job.waitingReason = null;
      job.updatedAt = new Date(input.acquiredAt);
      if (input.nodeExclusive) {
        exclusiveIntent.state = "acquired";
        exclusiveIntent.leaseSetId = lease.leaseSetId;
      }
      return copy(lease);
    });
  }

  async beginExclusiveIntent(input) {
    return this.#exclusive(async () => {
      const previous = this.#exclusiveIntents.get(input.intentId);
      if (previous) {
        if (previous.jobId !== input.jobId || previous.nodeId !== input.nodeId) {
          throw conflict("exclusive_intent_identity_conflict", "Exclusive intent ID was reused with different facts");
        }
        return copy(previous);
      }
      const job = this.#jobs.get(input.jobId);
      const node = this.#nodes.get(input.nodeId);
      if (!job || TERMINAL_JOBS.has(job.status) || job.cancelRequestedAt) {
        throw conflict("job_not_exclusive_eligible", "Job cannot begin exclusive preparation");
      }
      if (!node || node.lifecycleState !== "ready") throw conflict("node_not_ready", "Compute node is not ready");
      const active = this.#activeExclusiveIntent(input.nodeId, input.requestedAt);
      if (active) throw conflict("exclusive_intent_conflict", "Node already has active exclusive preparation");
      if (input.deadlineAt <= input.requestedAt) throw new TypeError("exclusive intent deadline must follow request time");
      const intent = {
        intentId: input.intentId, nodeId: input.nodeId, jobId: input.jobId,
        state: "pending", leaseSetId: null,
        requestedAt: new Date(input.requestedAt), deadlineAt: new Date(input.deadlineAt),
        finishedAt: null, finishReason: null,
      };
      this.#exclusiveIntents.set(intent.intentId, intent);
      return copy(intent);
    });
  }

  async cancelExclusiveIntent({ intentId, jobId, reason, cancelledAt }) {
    return this.#exclusive(async () => {
      const intent = this.#exclusiveIntents.get(intentId);
      if (!intent || intent.jobId !== jobId) throw conflict("exclusive_intent_not_found", "Exclusive intent was not found for the job");
      if (intent.state === "acquired") throw conflict("exclusive_lease_active", "Acquired exclusive intent must be released through its lease");
      if (intent.state !== "pending") return copy(intent);
      intent.state = "cancelled";
      intent.finishedAt = new Date(cancelledAt);
      intent.finishReason = reason;
      return copy(intent);
    });
  }

  async heartbeatLeaseSet({ leaseToken, fencingToken, heartbeatAt, expiresAt }) {
    return this.#exclusive(async () => {
      const lease = this.#leaseForToken(leaseToken);
      this.#assertFence(lease, fencingToken);
      if (lease.state !== "active" || lease.expiresAt <= heartbeatAt) {
        if (lease.state === "active") this.#closeLease(lease, "expired", "lease_expired", heartbeatAt);
        throw conflict("lease_expired", "Lease is no longer active");
      }
      const node = this.#nodes.get(lease.nodeId);
      if (!node || node.lifecycleState !== "ready" || node.generation !== lease.nodeGeneration) {
        this.#closeLease(lease, "revoked", "node_fence_changed", heartbeatAt);
        throw conflict("stale_node_generation", "Node fence changed while heartbeating");
      }
      lease.heartbeatAt = new Date(heartbeatAt);
      lease.expiresAt = new Date(expiresAt);
      return copy(lease);
    });
  }

  async claimDispatch({ leaseToken, fencingToken, dispatchId, dispatchedAt }) {
    return this.#exclusive(async () => {
      const lease = this.#leaseForToken(leaseToken);
      this.#assertFence(lease, fencingToken);
      if (lease.state !== "active" || lease.expiresAt <= dispatchedAt) {
        if (lease?.state === "active") this.#closeLease(lease, "expired", "lease_expired", dispatchedAt);
        throw conflict("lease_expired", "Dispatch requires an active lease");
      }
      const node = this.#nodes.get(lease.nodeId);
      if (!node || node.lifecycleState !== "ready" || node.generation !== lease.nodeGeneration) {
        this.#closeLease(lease, "revoked", "node_fence_changed", dispatchedAt);
        throw conflict("stale_node_generation", "Node fence changed before dispatch");
      }
      if (lease.dispatchState !== "pending") {
        if (lease.dispatchId === dispatchId) return copy(lease);
        throw conflict("duplicate_dispatch", "Lease has already been claimed by another dispatch");
      }
      if ([...this.#leaseSets.values()].some((item) => item.dispatchId === dispatchId)) {
        throw conflict("duplicate_dispatch", "Dispatch identity has already been used");
      }
      lease.dispatchState = "claimed";
      lease.dispatchId = dispatchId;
      lease.dispatchedAt = new Date(dispatchedAt);
      const attempt = this.#attempts.get(lease.attemptId);
      attempt.status = "dispatched";
      attempt.dispatchedAt = new Date(dispatchedAt);
      const job = this.#jobs.get(lease.jobId);
      job.status = "preparing";
      job.updatedAt = new Date(dispatchedAt);
      return copy(lease);
    });
  }

  async acknowledgeDispatch({ leaseToken, fencingToken, dispatchId, acceptedAt }) {
    return this.#exclusive(async () => {
      const lease = this.#leaseForToken(leaseToken);
      this.#assertFence(lease, fencingToken);
      if (lease.state !== "active" || lease.expiresAt <= acceptedAt) {
        if (lease?.state === "active") this.#closeLease(lease, "expired", "lease_expired", acceptedAt);
        throw conflict("lease_expired", "Dispatch acknowledgement requires an active lease");
      }
      if (lease.dispatchId !== dispatchId || !["claimed", "accepted"].includes(lease.dispatchState)) {
        throw conflict("dispatch_identity_mismatch", "Dispatch acknowledgement does not match the lease claim");
      }
      if (lease.dispatchState === "accepted") return copy(lease);
      lease.dispatchState = "accepted";
      lease.acceptedAt = new Date(acceptedAt);
      const attempt = this.#attempts.get(lease.attemptId);
      attempt.status = "accepted";
      attempt.acceptanceState = "accepted_no_output";
      attempt.acceptedAt = new Date(acceptedAt);
      return copy(lease);
    });
  }

  async releaseLeaseSet({ leaseToken, fencingToken, reason, releasedAt }) {
    return this.#exclusive(async () => {
      const lease = this.#leaseForToken(leaseToken);
      this.#assertFence(lease, fencingToken);
      if (lease.state !== "active") return copy(lease);
      this.#closeLease(lease, "released", reason, releasedAt);
      return copy(lease);
    });
  }

  async acquireRealtimeReservation(input) {
    return this.#exclusive(async () => {
      const previousId = this.#realtimeByAdmission.get(input.admissionKey);
      if (previousId) {
        const previous = this.#realtimeSessions.get(previousId);
        if (previous.ownerIdentityId !== input.ownerIdentityId
            || previous.capability !== input.capability
            || previous.requestedModel !== input.requestedModel) {
          throw conflict("realtime_admission_key_conflict", "Realtime admission key was reused with different facts");
        }
        return copy(previous);
      }
      const node = this.#nodes.get(input.nodeId);
      if (!node || node.lifecycleState !== "ready") throw conflict("node_not_ready", "Compute node is not ready");
      if (node.generation !== input.nodeGeneration) {
        throw conflict("stale_node_generation", "Compute node generation changed");
      }
      const exclusiveIntent = this.#activeExclusiveIntent(input.nodeId, input.admittedAt);
      if (exclusiveIntent) throw conflict("node_exclusive_pending", "Node is reserved for exclusive work");
      const activeLeases = this.#activeForNode(input.nodeId, input.admittedAt);
      if (activeLeases.some((lease) => lease.nodeExclusive)) {
        throw conflict("node_exclusive_active", "Node has an active exclusive lease");
      }
      const fencingToken = (this.#fences.get(input.nodeId) ?? 0) + 1;
      this.#fences.set(input.nodeId, fencingToken);
      const session = {
        sessionId: input.sessionId,
        admissionKey: input.admissionKey,
        ownerIdentityId: input.ownerIdentityId,
        correlationId: input.correlationId,
        capability: input.capability,
        requestedModel: input.requestedModel,
        modelProfileId: input.modelProfileId,
        nodeId: input.nodeId,
        nodeGeneration: input.nodeGeneration,
        route: input.route,
        state: "admitted",
        priorityClass: "latency",
        schedulerPriority: 100,
        latencyBudgetMilliseconds: input.latencyBudgetMilliseconds,
        resources: copy(input.resources),
        codecDirections: copy(input.codecDirections),
        leaseToken: input.leaseToken,
        fencingToken,
        connectionId: null,
        admittedAt: new Date(input.admittedAt),
        connectionDeadlineAt: new Date(input.connectionDeadlineAt),
        expiresAt: new Date(input.expiresAt),
        connectedAt: null,
        heartbeatAt: new Date(input.admittedAt),
        releasedAt: null,
        releaseReason: null,
        updatedAt: new Date(input.admittedAt),
      };
      this.#realtimeSessions.set(session.sessionId, session);
      this.#realtimeByAdmission.set(session.admissionKey, session.sessionId);
      return copy(session);
    });
  }

  async connectRealtimeSession({ ownerIdentityId, sessionId, connectionId, connectedAt }) {
    return this.#exclusive(async () => {
      this.#expireRealtime(connectedAt);
      const session = this.#ownedRealtime(ownerIdentityId, sessionId);
      if (!ACTIVE_REALTIME.has(session.state)) {
        throw conflict("realtime_session_expired", "Realtime session is no longer active");
      }
      if (session.state === "connected") {
        if (session.connectionId !== connectionId) {
          throw conflict("realtime_session_already_connected", "Realtime session already has an active connection");
        }
        return copy(session);
      }
      if (connectedAt >= session.connectionDeadlineAt || connectedAt >= session.expiresAt) {
        this.#closeRealtime(session, "expired", "connection_timeout", connectedAt);
        throw conflict("realtime_session_expired", "Realtime connection deadline has expired");
      }
      const node = this.#nodes.get(session.nodeId);
      if (!node || node.lifecycleState !== "ready" || node.generation !== session.nodeGeneration) {
        this.#closeRealtime(session, "revoked", "node_fence_changed", connectedAt);
        throw conflict("stale_node_generation", "Node fence changed before realtime connection");
      }
      session.state = "connected";
      session.connectionId = connectionId;
      session.connectedAt = new Date(connectedAt);
      session.heartbeatAt = new Date(connectedAt);
      session.updatedAt = new Date(connectedAt);
      return copy(session);
    });
  }

  async heartbeatRealtimeSession({ ownerIdentityId, sessionId, connectionId, heartbeatAt }) {
    return this.#exclusive(async () => {
      this.#expireRealtime(heartbeatAt);
      const session = this.#ownedRealtime(ownerIdentityId, sessionId);
      if (session.state !== "connected" || session.connectionId !== connectionId) {
        throw conflict("realtime_connection_stale", "Realtime connection no longer owns the reservation");
      }
      const node = this.#nodes.get(session.nodeId);
      if (!node || node.lifecycleState !== "ready" || node.generation !== session.nodeGeneration) {
        this.#closeRealtime(session, "revoked", "node_fence_changed", heartbeatAt);
        throw conflict("stale_node_generation", "Node fence changed during realtime session");
      }
      session.heartbeatAt = new Date(heartbeatAt);
      session.updatedAt = new Date(heartbeatAt);
      return copy(session);
    });
  }

  async releaseRealtimeSession({ ownerIdentityId, sessionId, connectionId, reason, releasedAt }) {
    return this.#exclusive(async () => {
      const session = this.#ownedRealtime(ownerIdentityId, sessionId);
      if (!ACTIVE_REALTIME.has(session.state)) return copy(session);
      if (session.connectionId !== null && session.connectionId !== connectionId) {
        throw conflict("realtime_connection_stale", "Realtime connection no longer owns the reservation");
      }
      this.#closeRealtime(session, "released", reason, releasedAt);
      return copy(session);
    });
  }

  async reconcileRealtimeSessions({ reconciledAt }) {
    return this.#exclusive(async () => {
      const before = new Map([...this.#realtimeSessions.values()].map((session) => [session.sessionId, session.state]));
      this.#expireRealtime(reconciledAt);
      const outcomes = [];
      for (const session of this.#realtimeSessions.values()) {
        if (ACTIVE_REALTIME.has(session.state)) {
          const node = this.#nodes.get(session.nodeId);
          if (!node || node.lifecycleState !== "ready" || node.generation !== session.nodeGeneration) {
            this.#closeRealtime(session, "revoked", "node_fence_changed", reconciledAt);
          }
        }
        if (before.get(session.sessionId) !== session.state) {
          outcomes.push({
            sessionId: session.sessionId, state: session.state, reason: session.releaseReason,
          });
        }
      }
      return copy(outcomes);
    });
  }

  async listActiveRealtimeSessions({ observedAt }) {
    return this.#exclusive(async () => {
      this.#expireRealtime(observedAt);
      return copy([...this.#realtimeSessions.values()].filter((session) => ACTIVE_REALTIME.has(session.state)));
    });
  }

  async reconcileLeaseSets({ reconciledAt }) {
    return this.#exclusive(async () => {
      const outcomes = [];
      for (const lease of this.#leaseSets.values()) {
        if (lease.state !== "active") continue;
        const job = this.#jobs.get(lease.jobId);
        const node = this.#nodes.get(lease.nodeId);
        let state = null;
        let reason = null;
        if (TERMINAL_JOBS.has(job?.status)) {
          state = "released";
          reason = "job_terminal";
        } else if (lease.expiresAt <= reconciledAt) {
          state = "expired";
          reason = "lease_expired";
        } else if (!node || node.lifecycleState !== "ready" || node.generation !== lease.nodeGeneration) {
          state = "revoked";
          reason = "node_fence_changed";
        }
        if (state) {
          this.#closeLease(lease, state, reason, reconciledAt);
          outcomes.push({ leaseSetId: lease.leaseSetId, state, reason, jobStatus: job?.status ?? null });
        } else {
          lease.reconciliationCount += 1;
          lease.lastReconciledAt = new Date(reconciledAt);
        }
      }

      for (const attempt of this.#attempts.values()) {
        if (!ACTIVE_ATTEMPTS.has(attempt.status)) continue;
        const activeLease = [...this.#leaseSets.values()].find((lease) =>
          lease.attemptId === attempt.attemptId && lease.state === "active",
        );
        if (activeLease) continue;
        const job = this.#jobs.get(attempt.jobId);
        if (!job || TERMINAL_JOBS.has(job.status)) continue;
        attempt.status = attempt.acceptanceState === "not_accepted" ? "lost" : "incomplete";
        attempt.finishedAt = new Date(reconciledAt);
        job.currentAttemptId = null;
        if (attempt.acceptanceState === "not_accepted") {
          job.status = "queued";
          job.waitingReason = "lease_missing";
        } else {
          job.status = "incomplete";
          job.retryClassification = "manual_reconcile";
          job.terminalAt = new Date(reconciledAt);
        }
        job.updatedAt = new Date(reconciledAt);
        outcomes.push({ attemptId: attempt.attemptId, state: "orphaned", reason: "lease_missing", jobStatus: job.status });
      }
      return outcomes;
    });
  }

  async snapshot() {
    return copy({
      nodes: [...this.#nodes.values()],
      jobs: [...this.#jobs.values()],
      attempts: [...this.#attempts.values()],
      leaseSets: [...this.#leaseSets.values()],
      exclusiveIntents: [...this.#exclusiveIntents.values()],
      realtimeSessions: [...this.#realtimeSessions.values()],
    });
  }

  async listAttempts(jobId) {
    return copy([...this.#attempts.values()]
      .filter((attempt) => attempt.jobId === jobId)
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
      .map((attempt) => ({
        ...attempt,
        nodeGeneration: this.#leaseSets.get(attempt.attemptId)?.nodeGeneration ?? null,
      })));
  }

  async updateNode(nodeId, patch) {
    return this.#exclusive(async () => {
      const node = this.#nodes.get(nodeId);
      if (!node) return null;
      Object.assign(node, copy(patch));
      return copy(node);
    });
  }
}
