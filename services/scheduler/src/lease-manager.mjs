import { randomUUID } from "node:crypto";

const RESOURCE_KEYS = Object.freeze([
  "cpuMillis",
  "unifiedMemoryBytes",
  "acceleratorUnits",
  "codecSessions",
  "storageBytes",
  "networkBitsPerSecond",
]);

const DEFAULT_TTL_MILLISECONDS = 30_000;
const MINIMUM_TTL_MILLISECONDS = 1_000;
const MAXIMUM_TTL_MILLISECONDS = 10 * 60_000;
const DEFAULT_EXCLUSIVE_INTENT_TTL_MILLISECONDS = 15 * 60_000;
const MAXIMUM_EXCLUSIVE_INTENT_TTL_MILLISECONDS = 2 * 60 * 60_000;

function instant(value, name) {
  const date = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return date;
}

function ttl(value) {
  const resolved = value ?? DEFAULT_TTL_MILLISECONDS;
  if (!Number.isInteger(resolved)
      || resolved < MINIMUM_TTL_MILLISECONDS
      || resolved > MAXIMUM_TTL_MILLISECONDS) {
    throw new TypeError(`ttlMilliseconds must be between ${MINIMUM_TTL_MILLISECONDS} and ${MAXIMUM_TTL_MILLISECONDS}`);
  }
  return resolved;
}

export function validateReservation(reservation) {
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    throw new TypeError("reservation must be an object");
  }

  const normalized = {};
  for (const key of RESOURCE_KEYS) {
    const value = reservation[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`reservation.${key} must be a non-negative safe integer`);
    }
    normalized[key] = value;
  }
  if (!Object.values(normalized).some((value) => value > 0)) {
    throw new TypeError("reservation must request at least one resource");
  }
  return Object.freeze(normalized);
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

/**
 * Scheduler-side lease workflow. The repository owns the transaction and is
 * responsible for locking the job and target node before checking capacity.
 */
export class LeaseManager {
  #repository;
  #memoryGuard;
  #memorySnapshotProvider;

  constructor({ repository, memoryGuard = null, memorySnapshotProvider = null }) {
    if (!repository) throw new TypeError("repository is required");
    if ((memoryGuard === null) !== (memorySnapshotProvider === null)
        || (memoryGuard && (!memoryGuard.evaluate || !memorySnapshotProvider?.snapshot))) {
      throw new TypeError("memory guard and snapshot provider must be configured together");
    }
    this.#repository = repository;
    this.#memoryGuard = memoryGuard;
    this.#memorySnapshotProvider = memorySnapshotProvider;
  }

  async acquire({
    acquisitionKey,
    jobId,
    nodeId,
    nodeGeneration,
    modelProfileId,
    reservation,
    ttlMilliseconds,
    now,
    attemptId = randomUUID(),
    leaseToken = randomUUID(),
    nodeExclusive = false,
  }) {
    required(acquisitionKey, "acquisitionKey");
    required(jobId, "jobId");
    required(nodeId, "nodeId");
    required(modelProfileId, "modelProfileId");
    required(attemptId, "attemptId");
    required(leaseToken, "leaseToken");
    if (!Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1) {
      throw new TypeError("nodeGeneration must be a positive safe integer");
    }
    if (typeof nodeExclusive !== "boolean") throw new TypeError("nodeExclusive must be boolean");
    const acquiredAt = instant(now, "now");
    const duration = ttl(ttlMilliseconds);

    const normalizedReservation = validateReservation(reservation);
    if (this.#memoryGuard) {
      const snapshot = await this.#memorySnapshotProvider.snapshot({
        nodeId, jobId, modelProfileId, nodeExclusive, observedAt: acquiredAt,
      });
      this.#memoryGuard.evaluate({
        ...snapshot,
        workload: {
          ...(snapshot.workload ?? {}),
          class: nodeExclusive ? "exclusive" : "batch",
          requestedBytes: normalizedReservation.unifiedMemoryBytes,
          coldLoad: snapshot.workload?.coldLoad !== false,
        },
      });
    }
    return this.#repository.acquireLeaseSet({
      acquisitionKey,
      jobId,
      nodeId,
      nodeGeneration,
      modelProfileId,
      reservation: normalizedReservation,
      attemptId,
      leaseToken,
      acquiredAt,
      expiresAt: new Date(acquiredAt.getTime() + duration),
      nodeExclusive,
    });
  }

  async beginExclusiveIntent({
    intentId = randomUUID(), jobId, nodeId, ttlMilliseconds = DEFAULT_EXCLUSIVE_INTENT_TTL_MILLISECONDS, now,
  }) {
    required(intentId, "intentId");
    required(jobId, "jobId");
    required(nodeId, "nodeId");
    if (!Number.isSafeInteger(ttlMilliseconds)
        || ttlMilliseconds < MINIMUM_TTL_MILLISECONDS
        || ttlMilliseconds > MAXIMUM_EXCLUSIVE_INTENT_TTL_MILLISECONDS) {
      throw new TypeError(`exclusive intent TTL must be between ${MINIMUM_TTL_MILLISECONDS} and ${MAXIMUM_EXCLUSIVE_INTENT_TTL_MILLISECONDS}`);
    }
    const requestedAt = instant(now, "now");
    return this.#repository.beginExclusiveIntent({
      intentId, jobId, nodeId, requestedAt,
      deadlineAt: new Date(requestedAt.getTime() + ttlMilliseconds),
    });
  }

  async cancelExclusiveIntent({ intentId, jobId, reason = "exclusive_preparation_failed", now }) {
    required(intentId, "intentId");
    required(jobId, "jobId");
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(reason)) throw new TypeError("reason must be a stable snake_case code");
    return this.#repository.cancelExclusiveIntent({
      intentId, jobId, reason, cancelledAt: instant(now, "now"),
    });
  }

  async heartbeat({ leaseToken, fencingToken, ttlMilliseconds, now }) {
    required(leaseToken, "leaseToken");
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      throw new TypeError("fencingToken must be a positive safe integer");
    }
    const heartbeatAt = instant(now, "now");
    const duration = ttl(ttlMilliseconds);
    return this.#repository.heartbeatLeaseSet({
      leaseToken,
      fencingToken,
      heartbeatAt,
      expiresAt: new Date(heartbeatAt.getTime() + duration),
    });
  }

  async claimDispatch({ leaseToken, fencingToken, dispatchId = randomUUID(), now }) {
    required(leaseToken, "leaseToken");
    required(dispatchId, "dispatchId");
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      throw new TypeError("fencingToken must be a positive safe integer");
    }
    return this.#repository.claimDispatch({
      leaseToken,
      fencingToken,
      dispatchId,
      dispatchedAt: instant(now, "now"),
    });
  }

  async acknowledgeDispatch({ leaseToken, fencingToken, dispatchId, now }) {
    required(leaseToken, "leaseToken");
    required(dispatchId, "dispatchId");
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      throw new TypeError("fencingToken must be a positive safe integer");
    }
    return this.#repository.acknowledgeDispatch({
      leaseToken,
      fencingToken,
      dispatchId,
      acceptedAt: instant(now, "now"),
    });
  }

  async release({ leaseToken, fencingToken, reason = "scheduler_release", now }) {
    required(leaseToken, "leaseToken");
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(reason)) {
      throw new TypeError("reason must be a stable snake_case code");
    }
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      throw new TypeError("fencingToken must be a positive safe integer");
    }
    return this.#repository.releaseLeaseSet({
      leaseToken,
      fencingToken,
      reason,
      releasedAt: instant(now, "now"),
    });
  }

  async reconcile({ now }) {
    return this.#repository.reconcileLeaseSets({ reconciledAt: instant(now, "now") });
  }

  async activeForJob({ jobId }) {
    required(jobId, "jobId");
    if (typeof this.#repository.findActiveByJob !== "function") {
      throw new TypeError("lease repository does not expose active job leases");
    }
    return this.#repository.findActiveByJob(jobId);
  }

  async attemptHistory({ jobId }) {
    required(jobId, "jobId");
    if (typeof this.#repository.listAttempts !== "function") {
      throw new TypeError("lease repository does not expose attempt history");
    }
    return Object.freeze(await this.#repository.listAttempts(jobId));
  }
}

export const leaseResourceKeys = RESOURCE_KEYS;
export const leaseTtlBounds = Object.freeze({
  defaultMilliseconds: DEFAULT_TTL_MILLISECONDS,
  minimumMilliseconds: MINIMUM_TTL_MILLISECONDS,
  maximumMilliseconds: MAXIMUM_TTL_MILLISECONDS,
  exclusiveIntentDefaultMilliseconds: DEFAULT_EXCLUSIVE_INTENT_TTL_MILLISECONDS,
  exclusiveIntentMaximumMilliseconds: MAXIMUM_EXCLUSIVE_INTENT_TTL_MILLISECONDS,
});
