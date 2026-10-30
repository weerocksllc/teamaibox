import { randomUUID } from "node:crypto";
import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { assertOrdinaryOperationExcludesProtectedResidents } from "./protected-resident-guard.mjs";

const REQUIRED_DOMAINS = Object.freeze([
  "identity", "administration", "files", "messaging", "database", "object", "queue",
]);
const DEFAULT_CAPACITY_REFRESH_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_CAPACITY_REFRESH_POLL_MILLISECONDS = 2_000;
const RETRYABLE_CAPACITY_CODES = new Set([
  "lease_capacity_exhausted", "node_capacity_metrics_stale", "unified_memory_pressure",
]);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function abortableWait(milliseconds, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function stableCorrelation(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new TypeError("correlationId is invalid");
  }
  return value;
}

export class ExclusiveJobCoordinator {
  #leases;
  #drainer;
  #survival;
  #events;
  #clock;
  #capacityRefreshTimeoutMilliseconds;
  #capacityRefreshPollMilliseconds;
  #wait;

  constructor({
    leaseManager, workerDrainer, survivalProbe, eventSink, resourcePolicy,
    clock = () => new Date(),
    capacityRefreshTimeoutMilliseconds = DEFAULT_CAPACITY_REFRESH_TIMEOUT_MILLISECONDS,
    capacityRefreshPollMilliseconds = DEFAULT_CAPACITY_REFRESH_POLL_MILLISECONDS,
    wait = abortableWait,
    maintenanceAuthorizer = null,
  }) {
    if (!leaseManager || !workerDrainer || !survivalProbe || !eventSink) {
      throw new TypeError("leaseManager, workerDrainer, survivalProbe, eventSink are required");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof wait !== "function") throw new TypeError("wait must be a function");
    if (maintenanceAuthorizer !== null && typeof maintenanceAuthorizer !== "function") {
      throw new TypeError("maintenanceAuthorizer must be a function when configured");
    }
    this.#leases = leaseManager;
    this.#drainer = workerDrainer;
    this.#survival = survivalProbe;
    this.#events = eventSink;
    this.#clock = clock;
    this.#capacityRefreshTimeoutMilliseconds = positiveInteger(
      capacityRefreshTimeoutMilliseconds, "capacityRefreshTimeoutMilliseconds",
    );
    this.#capacityRefreshPollMilliseconds = positiveInteger(
      capacityRefreshPollMilliseconds, "capacityRefreshPollMilliseconds",
    );
    this.#wait = wait;
  }

  async #assertSurvival(phase, correlationId) {
    const status = await this.#survival.check({ domains: REQUIRED_DOMAINS, phase, correlationId });
    const failed = REQUIRED_DOMAINS.filter((domain) => status?.[domain]?.healthy !== true);
    if (failed.length) {
      throw new PlatformError("core_service_survival_failed", "Core service objectives failed during exclusive preparation", {
        status: 503, retryable: true, details: { phase, failedDomains: failed },
      });
    }
    return status;
  }

  async #acquireAfterDrain(input, { intent, signal }) {
    const maximumWaits = Math.ceil(
      this.#capacityRefreshTimeoutMilliseconds / this.#capacityRefreshPollMilliseconds,
    );
    let waits = 0;
    while (true) {
      signal?.throwIfAborted();
      try {
        return await this.#leases.acquire({ ...input, now: this.#clock() });
      } catch (error) {
        if (!RETRYABLE_CAPACITY_CODES.has(error?.code) || waits >= maximumWaits) throw error;
        const current = new Date(this.#clock());
        const intentDeadline = new Date(intent.deadlineAt);
        const remainingIntentMilliseconds = intentDeadline.getTime() - current.getTime();
        const remainingRefreshMilliseconds = this.#capacityRefreshTimeoutMilliseconds
          - (waits * this.#capacityRefreshPollMilliseconds);
        const delay = Math.min(
          this.#capacityRefreshPollMilliseconds,
          remainingIntentMilliseconds,
          remainingRefreshMilliseconds,
        );
        if (!Number.isFinite(delay) || delay < 1) throw error;
        waits += 1;
        await this.#wait(delay, signal);
      }
    }
  }

  async prepare({
    intentId = randomUUID(), acquisitionKey = randomUUID(),
    jobId, nodeId, nodeGeneration, modelProfileId,
    reservation, controlPlaneDemand, nodeCapacity, administratorFloor = {},
    leaseTtlMilliseconds, intentTtlMilliseconds,
    attemptId, leaseToken, correlationId, now, signal = null,
  }) {
    stableCorrelation(correlationId);
    if (signal !== null && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
    signal?.throwIfAborted();
    const startedAt = now ?? this.#clock();
    signal?.throwIfAborted();
    const intent = await this.#leases.beginExclusiveIntent({
      intentId, jobId, nodeId, ttlMilliseconds: intentTtlMilliseconds, now: startedAt,
    });
    let lease = null;
    let drained = [];
    try {
      signal?.throwIfAborted();
      await this.#assertSurvival("before_drain", correlationId);
      signal?.throwIfAborted();
      const conflicts = await this.#drainer.listConflictingWorkers({ nodeId, nodeGeneration, exclusiveJobId: jobId,
        intentId: intent.intentId, correlationId });
      if (!Array.isArray(conflicts)) throw new TypeError("worker drainer must return an array");
      assertOrdinaryOperationExcludesProtectedResidents({ workers: conflicts, operation: "exclusive.drain" });
      for (const worker of conflicts) {
        signal?.throwIfAborted();
        const result = await this.#drainer.drainWorker({
          workerId: worker.workerId,
          nodeId, nodeGeneration, intentId: intent.intentId,
          exclusiveJobId: jobId,
          deadlineAt: intent.deadlineAt,
          reason: "node_exclusive_pending",
          correlationId,
        });
        if (result?.state !== "stopped" || result?.leasesReleased !== true) {
          throw new PlatformError("exclusive_worker_drain_incomplete", "Conflicting worker did not stop and release leases", { status: 409, retryable: true });
        }
        drained.push(result);
        signal?.throwIfAborted();
      }
      await this.#assertSurvival("after_drain", correlationId);
      signal?.throwIfAborted();
      lease = await this.#acquireAfterDrain({
        acquisitionKey, jobId, nodeId, nodeGeneration, modelProfileId,
        reservation, ttlMilliseconds: leaseTtlMilliseconds,
        attemptId, leaseToken, nodeExclusive: true,
      }, { intent, signal });
      if (lease.state !== "active" || lease.nodeExclusive !== true) {
        throw new PlatformError("exclusive_lease_invalid", "Node-exclusive lease was not active after acquisition", { status: 503, retryable: true });
      }
      signal?.throwIfAborted();
      await this.#assertSurvival("after_exclusive_lease", correlationId);
      signal?.throwIfAborted();
      await this.#events.publish({
        protocolVersion: 1, eventId: randomUUID(), type: "scheduler.node_exclusive_ready",
        occurredAt: new Date(this.#clock()), correlationId, jobId, nodeId,
        payload: {
          intentId: intent.intentId,
          leaseSetId: lease.leaseSetId,
          fencingToken: lease.fencingToken,
          drainedWorkerIds: drained.map((worker) => worker.workerId).sort(),
        },
      });
      return { intent, lease, drained };
    } catch (error) {
      for (const worker of [...drained].reverse()) {
        await this.#drainer.restoreWorker({ workerId: worker.workerId, nodeId, nodeGeneration,
          exclusiveJobId: jobId, lease, intentId: intent.intentId, correlationId }).catch(() => {});
      }
      if (lease) {
        await this.#leases.release({
          leaseToken: lease.leaseToken,
          fencingToken: lease.fencingToken,
          reason: "exclusive_preparation_failed",
          now: this.#clock(),
        }).catch(() => {});
      } else {
        await this.#leases.cancelExclusiveIntent({
          intentId: intent.intentId,
          jobId,
          reason: "exclusive_preparation_failed",
          now: this.#clock(),
        }).catch(() => {});
      }
      throw error;
    }
  }

  async restore({ jobId, nodeId, nodeGeneration, correlationId, lease = null, intentId = null, drained }) {
    stableCorrelation(correlationId);
    if (!Array.isArray(drained) || drained.some((worker) => typeof worker?.workerId !== "string")) {
      throw new TypeError("exclusive drained worker list is invalid");
    }
    const restored = [];
    for (const worker of [...drained].reverse()) {
      const value = await this.#drainer.restoreWorker({ workerId: worker.workerId, nodeId, nodeGeneration,
        exclusiveJobId: jobId, lease, intentId, correlationId });
      if (value?.state !== "running") {
        throw new PlatformError("exclusive_worker_restore_incomplete", "Conflicting worker did not restart", { status: 503, retryable: true });
      }
      restored.push(value);
    }
    await this.#events.publish({ protocolVersion: 1, eventId: randomUUID(), type: "scheduler.node_exclusive_restored",
      occurredAt: new Date(this.#clock()), correlationId, jobId, nodeId,
      payload: { restoredWorkerIds: restored.map((worker) => worker.workerId).sort() } });
    return Object.freeze(restored);
  }
}

export const requiredCoreSurvivalDomains = REQUIRED_DOMAINS;
