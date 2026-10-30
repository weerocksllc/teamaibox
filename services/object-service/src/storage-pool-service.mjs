import { randomUUID } from "node:crypto";

import { evaluateAuthorization } from "../../../packages/authorization/src/index.mjs";
import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { StoragePoolRepositoryError } from "./memory-storage-pool-repository.mjs";

const IDENTIFIER = /^[a-z][a-z0-9_.-]{2,127}$/;
const NODE_IDENTIFIER = /^(?:[a-z][a-z0-9_.-]{2,127}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const BACKEND_KINDS = new Set(["local-block", "local-filesystem", "s3-compatible"]);
const HEALTH_STATES = new Set(["unknown", "healthy", "degraded", "unavailable"]);
const ENCRYPTION_MODES = new Set(["none", "luks2", "provider-managed"]);
const VERIFICATION_STATES = new Set(["pending", "verified", "failed"]);
const LIFECYCLE_STATES = new Set(["active", "draining", "drained", "removed"]);
const INCOMPLETE_MIGRATIONS = new Set(["copying", "verifying", "cleanup_pending", "failed"]);

export const STORAGE_DATA_CLASSES = Object.freeze([
  "team-file",
  "message-attachment",
  "ai-artifact",
  "dataset",
  "checkpoint",
  "model-artifact",
  "agent-workspace",
  "plugin-data",
  "cache",
]);
const DATA_CLASSES = new Set(STORAGE_DATA_CLASSES);

function repositoryError(error) {
  if (!(error instanceof StoragePoolRepositoryError)) return error;
  const status = error.code.endsWith("_not_found") ? 404 : 409;
  return new PlatformError(error.code, error.message, { status });
}

function safeIdentifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new PlatformError("invalid_storage_pool", `${field} is invalid`, { status: 400 });
  }
  return value;
}

function safeNodeIdentifier(value) {
  if (typeof value !== "string" || !NODE_IDENTIFIER.test(value)) {
    throw new PlatformError("invalid_storage_pool", "Storage node identifier is invalid", { status: 400 });
  }
  return value;
}

function safeDisplayName(value) {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 128) {
    throw new PlatformError("invalid_storage_pool", "Storage pool display name is invalid", { status: 400 });
  }
  return value.trim();
}

function safeBytes(value, { positive = false, field = "byte count" } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new PlatformError("invalid_storage_capacity", `${field} is invalid`, { status: 400 });
  }
  return value;
}

function safeDate(value, field) {
  if (value === null || value === undefined || value === "") {
    throw new PlatformError("invalid_storage_observation", `${field} is invalid`, { status: 400 });
  }
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PlatformError("invalid_storage_observation", `${field} is invalid`, { status: 400 });
  }
  return date;
}

function safeDigest(value) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new PlatformError("invalid_storage_integrity", "Storage SHA-256 digest is invalid", { status: 400 });
  }
  return value;
}

function safeBlobKey(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || value.includes("\0")) {
    throw new PlatformError("invalid_storage_blob", "Storage blob key is invalid", { status: 400 });
  }
  return value;
}

function normalizedDataClasses(values) {
  if (!Array.isArray(values) || values.length < 1) {
    throw new PlatformError(
      "invalid_storage_data_class",
      "At least one storage data class is required",
      { status: 400 },
    );
  }
  const normalized = [...new Set(values)];
  if (normalized.some((value) => !DATA_CLASSES.has(value))) {
    throw new PlatformError("invalid_storage_data_class", "Storage data class is invalid", { status: 400 });
  }
  return normalized.sort();
}

function copyCount(value) {
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new PlatformError("invalid_storage_copies", "Storage copy count must be between 1 and 8", { status: 400 });
  }
  return value;
}

function preferredPools(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 8) {
    throw new PlatformError("invalid_storage_preference", "Storage pool preference is invalid", { status: 400 });
  }
  const normalized = values.map((value) => safeIdentifier(value, "Preferred storage pool identifier"));
  if (new Set(normalized).size !== normalized.length) {
    throw new PlatformError("invalid_storage_preference", "Storage pool preference is duplicated", { status: 400 });
  }
  return normalized;
}

function publicReservation(reservation) {
  return Object.freeze({
    reservationId: reservation.reservationId,
    blobKey: reservation.blobKey,
    dataClass: reservation.dataClass,
    size: reservation.size,
    integrity: Object.freeze({ algorithm: "sha256", digest: reservation.sha256 }),
    state: reservation.state,
    targets: Object.freeze(reservation.targets.map((target) => Object.freeze({ ...target }))),
    protection: Object.freeze({
      kind: "availability-copies",
      copyCount: reservation.targets.length,
    }),
    expiresAt: reservation.expiresAt.toISOString(),
  });
}

function verificationMatches(allocation, observation) {
  return observation
    && observation.size === allocation.size
    && observation.sha256 === allocation.sha256;
}

export class StoragePoolService {
  #repository;
  #dataPlane;
  #audit;
  #clock;
  #observationMaximumAgeMs;
  #reservationLifetimeMs;
  #healthSink;

  constructor({
    repository,
    dataPlane,
    audit = async () => {},
    clock = () => new Date(),
    observationMaximumAgeMs = 5 * 60 * 1000,
    reservationLifetimeMs = 5 * 60 * 1000,
    healthSink = null,
  }) {
    if (!repository?.createPool || !repository?.listPools || !repository?.createReservation
      || !repository?.allocations || !repository?.createMigration) {
      throw new TypeError("storage pool repository is incomplete");
    }
    if (!dataPlane?.copy || !dataPlane?.inspect || !dataPlane?.delete) {
      throw new TypeError("storage pool data plane is incomplete");
    }
    if (healthSink !== null && typeof healthSink.recordStoragePoolHealth !== "function") {
      throw new TypeError("storage health sink is incomplete");
    }
    if (!Number.isSafeInteger(observationMaximumAgeMs) || observationMaximumAgeMs < 1
      || !Number.isSafeInteger(reservationLifetimeMs) || reservationLifetimeMs < 1) {
      throw new TypeError("storage pool timing policy is invalid");
    }
    this.#repository = repository;
    this.#dataPlane = dataPlane;
    this.#audit = audit;
    this.#clock = clock;
    this.#observationMaximumAgeMs = observationMaximumAgeMs;
    this.#reservationLifetimeMs = reservationLifetimeMs;
    this.#healthSink = healthSink;
  }

  async #emit(action, fields = {}) {
    await this.#audit({ action, occurredAt: this.#clock().toISOString(), ...fields });
  }

  async #require(principal, permission) {
    const decision = evaluateAuthorization({ principal, permission, now: this.#clock() });
    if (!decision.allowed) {
      await this.#emit("storage.access_denied", {
        actorIdentityId: principal?.id ?? null,
        permission,
        reason: decision.reason,
        success: false,
      });
      throw new PlatformError("storage_access_denied", "Storage administration access denied", {
        status: 403,
      });
    }
  }

  async #requirePool(poolId) {
    const pool = await this.#repository.pool(safeIdentifier(poolId, "Storage pool identifier"));
    if (!pool) throw new PlatformError("storage_pool_not_found", "Storage pool was not found", { status: 404 });
    return pool;
  }

  #eligibilityReasons(pool, { dataClass = null, size = 0, now, availableToPlace }) {
    const reasons = [];
    if (pool.lifecycleState !== "active") reasons.push(`lifecycle_${pool.lifecycleState}`);
    if (pool.healthState !== "healthy") reasons.push(`health_${pool.healthState}`);
    if (!pool.observedAt) {
      reasons.push("observation_missing");
    } else if (now.getTime() - pool.observedAt.getTime() > this.#observationMaximumAgeMs) {
      reasons.push("observation_stale");
    } else if (pool.observedAt > now) {
      reasons.push("observation_from_future");
    }
    if (pool.compatibilityStatus !== "verified" || !pool.compatibilityVerifiedAt) {
      reasons.push(`compatibility_${pool.compatibilityStatus}`);
    }
    if (pool.encryptionStatus !== "verified" || !pool.encryptionVerifiedAt) {
      reasons.push(`encryption_${pool.encryptionStatus}`);
    }
    if (["local-block", "local-filesystem"].includes(pool.backendKind)
      && pool.encryptionMode !== "luks2") {
      reasons.push("local_pool_requires_luks2");
    }
    if (pool.backendKind === "s3-compatible" && pool.encryptionMode !== "provider-managed") {
      reasons.push("object_pool_requires_provider_encryption");
    }
    if (dataClass && !pool.dataClasses.includes(dataClass)) reasons.push("data_class_not_allowed");
    if (size > availableToPlace) reasons.push("capacity_insufficient");
    return [...new Set(reasons)];
  }

  async #inventory(pool, { dataClass = null, size = 0, now = this.#clock() } = {}) {
    const [allocatedBytes, placementReservedBytes, migrationReservedBytes, allocations] = await Promise.all([
      this.#repository.allocatedBytes(pool.poolId),
      this.#repository.placementReservedBytes(pool.poolId, now),
      this.#repository.migrationReservedBytes(pool.poolId),
      this.#repository.allocations({ poolId: pool.poolId }),
    ]);
    const reservedBytes = placementReservedBytes + migrationReservedBytes;
    const observedAvailable = pool.availableBytes ?? 0;
    const capacityAfterAllocations = Math.max(0, (pool.totalBytes ?? 0) - allocatedBytes);
    const availableToPlace = Math.max(
      0,
      Math.min(observedAvailable, capacityAfterAllocations) - pool.safetyReserveBytes - reservedBytes,
    );
    let uniqueCopyCount = 0;
    for (const allocation of allocations) {
      const copies = await this.#repository.allocations({ blobKey: allocation.blobKey });
      if (copies.length === 1) uniqueCopyCount += 1;
    }
    const reasons = this.#eligibilityReasons(pool, { dataClass, size, now, availableToPlace });
    return Object.freeze({
      poolId: pool.poolId,
      displayName: pool.displayName,
      backendKind: pool.backendKind,
      nodeId: pool.nodeId,
      failureDomain: pool.failureDomain,
      lifecycleState: pool.lifecycleState,
      healthState: pool.healthState,
      dataClasses: Object.freeze([...pool.dataClasses]),
      capacity: Object.freeze({
        totalBytes: pool.totalBytes,
        observedAvailableBytes: pool.availableBytes,
        allocatedBytes,
        reservedBytes,
        safetyReserveBytes: pool.safetyReserveBytes,
        availableToPlaceBytes: availableToPlace,
      }),
      encryption: Object.freeze({
        mode: pool.encryptionMode,
        status: pool.encryptionStatus,
        verifiedAt: pool.encryptionVerifiedAt?.toISOString() ?? null,
      }),
      compatibility: Object.freeze({
        status: pool.compatibilityStatus,
        verifiedAt: pool.compatibilityVerifiedAt?.toISOString() ?? null,
      }),
      observedAt: pool.observedAt?.toISOString() ?? null,
      createdAt: pool.createdAt?.toISOString() ?? null,
      updatedAt: pool.updatedAt?.toISOString() ?? null,
      removedAt: pool.removedAt?.toISOString() ?? null,
      eligibility: Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) }),
      allocations: Object.freeze({ count: allocations.length, uniqueCopyCount }),
      reservations: Object.freeze({ count: (await this.#repository.activeReservationsForPool(pool.poolId, now)).length,
        bytes: placementReservedBytes }),
      migrations: Object.freeze({ incompleteCount: (await this.#repository.incompleteMigrationsForPool(pool.poolId)).length }),
    });
  }

  async registerPool({
    principal,
    poolId,
    displayName,
    backendKind,
    nodeId = null,
    failureDomain,
    safetyReserveBytes = 0,
    dataClasses,
  }) {
    await this.#require(principal, "storage:manage");
    const id = safeIdentifier(poolId, "Storage pool identifier");
    if (!BACKEND_KINDS.has(backendKind)) {
      throw new PlatformError("invalid_storage_pool", "Storage backend kind is invalid", { status: 400 });
    }
    if (backendKind.startsWith("local-") && !nodeId) {
      throw new PlatformError("invalid_storage_pool", "Local storage pools require a node identifier", { status: 400 });
    }
    const now = this.#clock();
    const record = {
      poolId: id,
      displayName: safeDisplayName(displayName),
      backendKind,
      nodeId: nodeId === null ? null : safeNodeIdentifier(nodeId),
      failureDomain: safeIdentifier(failureDomain, "Storage failure domain"),
      lifecycleState: "active",
      healthState: "unknown",
      totalBytes: null,
      availableBytes: null,
      safetyReserveBytes: safeBytes(safetyReserveBytes, { field: "Storage safety reserve" }),
      dataClasses: normalizedDataClasses(dataClasses),
      encryptionMode: "none",
      encryptionStatus: "pending",
      encryptionVerifiedAt: null,
      compatibilityStatus: "pending",
      compatibilityVerifiedAt: null,
      observedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#repository.createPool(record);
    } catch (error) {
      throw repositoryError(error);
    }
    await this.#emit("storage.pool_registered", {
      actorIdentityId: principal.id,
      poolId: id,
      backendKind,
      success: true,
    });
    return this.#inventory(record);
  }

  async recordObservation({
    principal,
    poolId,
    healthState,
    totalBytes,
    availableBytes,
    encryptionMode,
    encryptionStatus,
    encryptionVerifiedAt = null,
    compatibilityStatus,
    compatibilityVerifiedAt = null,
    observedAt = this.#clock(),
  }) {
    await this.#require(principal, "storage:manage");
    const pool = await this.#requirePool(poolId);
    if (pool.lifecycleState === "removed") {
      throw new PlatformError("storage_pool_removed", "Removed storage pool cannot be observed", { status: 409 });
    }
    if (!HEALTH_STATES.has(healthState) || !ENCRYPTION_MODES.has(encryptionMode)
      || !VERIFICATION_STATES.has(encryptionStatus)
      || !VERIFICATION_STATES.has(compatibilityStatus)) {
      throw new PlatformError("invalid_storage_observation", "Storage observation state is invalid", { status: 400 });
    }
    const total = safeBytes(totalBytes, { positive: true, field: "Storage total capacity" });
    const available = safeBytes(availableBytes, { field: "Storage available capacity" });
    if (available > total) {
      throw new PlatformError(
        "invalid_storage_capacity",
        "Storage available capacity exceeds total capacity",
        { status: 400 },
      );
    }
    const allocated = await this.#repository.allocatedBytes(pool.poolId);
    if (allocated > total) {
      throw new PlatformError(
        "invalid_storage_capacity",
        "Observed capacity is below registered allocations",
        { status: 409 },
      );
    }
    const observed = safeDate(observedAt, "Storage observation timestamp");
    const encryptionVerified = encryptionStatus === "verified"
      ? safeDate(encryptionVerifiedAt, "Encryption verification timestamp") : null;
    const compatibilityVerified = compatibilityStatus === "verified"
      ? safeDate(compatibilityVerifiedAt, "Compatibility verification timestamp") : null;
    const changes = {
      healthState,
      totalBytes: total,
      availableBytes: available,
      encryptionMode,
      encryptionStatus,
      encryptionVerifiedAt: encryptionVerified,
      compatibilityStatus,
      compatibilityVerifiedAt: compatibilityVerified,
      observedAt: observed,
      updatedAt: this.#clock(),
    };
    let updated;
    try {
      updated = await this.#repository.updatePool(pool.poolId, ["active", "draining", "drained"], changes);
    } catch (error) {
      throw repositoryError(error);
    }
    await this.#emit("storage.pool_observed", {
      actorIdentityId: principal.id,
      poolId: pool.poolId,
      healthState,
      encryptionStatus,
      compatibilityStatus,
      success: true,
    });
    try { await this.#healthSink?.recordStoragePoolHealth(updated); }
    catch (error) { await this.#emit("storage.health_publish_failed", { actorIdentityId: principal.id, poolId: pool.poolId, errorCode: typeof error?.code === "string" ? error.code : "diagnostic_sink_failed", success: false }); }
    return this.#inventory(updated);
  }

  async setDataClasses({ principal, poolId, dataClasses }) {
    await this.#require(principal, "storage:manage");
    const pool = await this.#requirePool(poolId);
    if (pool.lifecycleState !== "active") {
      throw new PlatformError(
        "storage_pool_state_conflict",
        "Data classes can only change while a pool is active",
        { status: 409 },
      );
    }
    let updated;
    try {
      updated = await this.#repository.updatePool(pool.poolId, ["active"], {
        dataClasses: normalizedDataClasses(dataClasses),
        updatedAt: this.#clock(),
      });
    } catch (error) {
      throw repositoryError(error);
    }
    await this.#emit("storage.pool_data_classes_changed", {
      actorIdentityId: principal.id,
      poolId: pool.poolId,
      success: true,
    });
    return this.#inventory(updated);
  }

  async listPools({ principal }) {
    await this.#require(principal, "storage:view");
    const now = this.#clock();
    await this.#repository.expireReservations(now);
    return Promise.all((await this.#repository.listPools()).map((pool) => this.#inventory(pool, { now })));
  }

  async pool({ principal, poolId }) {
    await this.#require(principal, "storage:view");
    return this.#inventory(await this.#requirePool(poolId));
  }

  async reservePlacement({ principal, blobKey, dataClass, size, sha256, copies = 1, preferredPoolIds }) {
    await this.#require(principal, "storage:manage");
    const now = this.#clock();
    const normalizedBlobKey = safeBlobKey(blobKey);
    const normalizedSize = safeBytes(size, { positive: true, field: "Storage object size" });
    const normalizedDigest = safeDigest(sha256);
    if (!DATA_CLASSES.has(dataClass)) {
      throw new PlatformError("invalid_storage_data_class", "Storage data class is invalid", { status: 400 });
    }
    const desiredCopies = copyCount(copies);
    const preferred = preferredPools(preferredPoolIds);
    await this.#repository.expireReservations(now);
    const candidates = [];
    for (const pool of await this.#repository.listPools()) {
      const inventory = await this.#inventory(pool, {
        dataClass,
        size: normalizedSize,
        now,
      });
      if (inventory.eligibility.eligible) candidates.push(inventory);
    }
    const preference = new Map(preferred.map((poolId, index) => [poolId, index]));
    candidates.sort((left, right) => (preference.get(left.poolId) ?? preferred.length)
      - (preference.get(right.poolId) ?? preferred.length)
      || right.capacity.availableToPlaceBytes - left.capacity.availableToPlaceBytes
      || left.poolId.localeCompare(right.poolId));
    const selected = [];
    const failureDomains = new Set();
    for (const candidate of candidates) {
      if (failureDomains.has(candidate.failureDomain)) continue;
      selected.push(candidate);
      failureDomains.add(candidate.failureDomain);
      if (selected.length === desiredCopies) break;
    }
    if (selected.length !== desiredCopies) {
      throw new PlatformError(
        "storage_placement_unavailable",
        "No eligible storage placement satisfies capacity and failure-domain requirements",
        {
          status: 409,
          retryable: true,
          details: {
            requestedCopies: desiredCopies,
            eligiblePools: candidates.length,
            eligibleFailureDomains: new Set(candidates.map((pool) => pool.failureDomain)).size,
          },
        },
      );
    }
    const reservation = {
      reservationId: randomUUID(),
      blobKey: normalizedBlobKey,
      dataClass,
      size: normalizedSize,
      sha256: normalizedDigest,
      state: "reserved",
      targets: selected.map((pool, index) => ({
        poolId: pool.poolId,
        failureDomain: pool.failureDomain,
        allocationKind: index === 0 ? "primary" : "availability-copy",
      })),
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + this.#reservationLifetimeMs),
      committedAt: null,
    };
    try {
      await this.#repository.createReservation(reservation);
    } catch (error) {
      throw repositoryError(error);
    }
    await this.#emit("storage.placement_reserved", {
      actorIdentityId: principal.id,
      reservationId: reservation.reservationId,
      dataClass,
      size: normalizedSize,
      copyCount: desiredCopies,
      poolIds: reservation.targets.map((target) => target.poolId),
      success: true,
    });
    return publicReservation(reservation);
  }

  async commitPlacement({ principal, reservationId, verifiedCopies }) {
    await this.#require(principal, "storage:manage");
    const now = this.#clock();
    const reservation = await this.#repository.reservation(reservationId);
    if (!reservation) {
      throw new PlatformError("storage_reservation_not_found", "Storage reservation was not found", { status: 404 });
    }
    if (reservation.state !== "reserved" || reservation.expiresAt <= now) {
      if (reservation.state === "reserved") await this.#repository.expireReservations(now);
      throw new PlatformError(
        "storage_reservation_state_conflict",
        "Storage reservation is no longer commit-eligible",
        { status: 409 },
      );
    }
    if (!Array.isArray(verifiedCopies) || verifiedCopies.length !== reservation.targets.length) {
      throw new PlatformError(
        "storage_verification_mismatch",
        "Every reserved storage target must be verified",
        { status: 422 },
      );
    }
    const targetIds = new Set(reservation.targets.map((target) => target.poolId));
    const observedIds = new Set();
    const normalized = [];
    for (const observation of verifiedCopies) {
      if (!targetIds.has(observation?.poolId) || observedIds.has(observation.poolId)
        || observation.size !== reservation.size || observation.sha256 !== reservation.sha256) {
        throw new PlatformError(
          "storage_verification_mismatch",
          "Verified storage copy does not match the reservation",
          { status: 422 },
        );
      }
      const verifiedAt = safeDate(observation.verifiedAt, "Storage verification timestamp");
      if (verifiedAt > now) {
        throw new PlatformError(
          "storage_verification_mismatch",
          "Storage verification timestamp cannot be in the future",
          { status: 422 },
        );
      }
      const inventory = await this.#inventory(await this.#requirePool(observation.poolId), {
        dataClass: reservation.dataClass,
        now,
      });
      if (!inventory.eligibility.eligible) {
        throw new PlatformError(
          "storage_pool_ineligible",
          "A reserved storage target is no longer eligible",
          { status: 409, details: { poolId: observation.poolId, reasons: inventory.eligibility.reasons } },
        );
      }
      observedIds.add(observation.poolId);
      normalized.push({ ...observation, verifiedAt });
    }
    let committed;
    try {
      committed = await this.#repository.commitReservation(reservationId, normalized, now);
    } catch (error) {
      throw repositoryError(error);
    }
    await this.#emit("storage.placement_committed", {
      actorIdentityId: principal.id,
      reservationId,
      poolIds: committed.targets.map((target) => target.poolId),
      success: true,
    });
    return publicReservation(committed);
  }

  async abortPlacement({ principal, reservationId }) {
    await this.#require(principal, "storage:manage");
    let aborted;
    try {
      aborted = await this.#repository.abortReservation(reservationId, this.#clock());
    } catch (error) {
      throw repositoryError(error);
    }
    await this.#emit("storage.placement_aborted", {
      actorIdentityId: principal.id,
      reservationId,
      success: true,
    });
    return publicReservation(aborted);
  }

  async #eligibleMigrationTarget(allocation, sourcePoolId, excludedPoolIds = new Set()) {
    const now = this.#clock();
    const candidates = [];
    for (const pool of await this.#repository.listPools()) {
      if (pool.poolId === sourcePoolId || excludedPoolIds.has(pool.poolId)) continue;
      const inventory = await this.#inventory(pool, {
        dataClass: allocation.dataClass,
        size: allocation.size,
        now,
      });
      if (inventory.eligibility.eligible) candidates.push(inventory);
    }
    candidates.sort((left, right) => right.capacity.availableToPlaceBytes
      - left.capacity.availableToPlaceBytes || left.poolId.localeCompare(right.poolId));
    return candidates[0] ?? null;
  }

  async #finishSourceCleanup(migration, allocation) {
    try {
      await this.#dataPlane.delete({
        poolId: allocation.poolId,
        blobKey: allocation.blobKey,
      });
      await this.#repository.deleteAllocation(allocation.poolId, allocation.blobKey);
      const completedAt = this.#clock();
      await this.#repository.updateMigration(migration.migrationId, {
        state: "completed",
        updatedAt: completedAt,
        completedAt,
        failureCode: null,
        candidateCleanupPending: false,
      });
      await this.#repository.resolveFailedMigrations(allocation.poolId, allocation.blobKey, completedAt);
      return { state: "completed", migrationId: migration.migrationId };
    } catch {
      await this.#repository.updateMigration(migration.migrationId, {
        state: "cleanup_pending",
        updatedAt: this.#clock(),
        failureCode: "source_delete_failed",
      });
      return { state: "cleanup_pending", migrationId: migration.migrationId };
    }
  }

  async #migrateAllocation(allocation) {
    const existingCopies = await this.#repository.allocations({ blobKey: allocation.blobKey });
    for (const candidate of existingCopies) {
      if (candidate.poolId === allocation.poolId) continue;
      const inventory = await this.#inventory(await this.#requirePool(candidate.poolId), {
        dataClass: allocation.dataClass,
        now: this.#clock(),
      });
      if (!inventory.eligibility.eligible) continue;
      const migration = await this.#repository.createMigration({
        blobKey: allocation.blobKey,
        dataClass: allocation.dataClass,
        size: allocation.size,
        sha256: allocation.sha256,
        sourcePoolId: allocation.poolId,
        targetPoolId: candidate.poolId,
        state: "verifying",
        reusedExistingCopy: true,
        candidateCleanupPending: false,
        failureCode: null,
        createdAt: this.#clock(),
        updatedAt: this.#clock(),
        completedAt: null,
      });
      let observed;
      try {
        observed = await this.#dataPlane.inspect({
          poolId: candidate.poolId,
          blobKey: allocation.blobKey,
        });
      } catch {
        observed = null;
      }
      if (!verificationMatches(allocation, observed)) {
        await this.#repository.updateMigration(migration.migrationId, {
          state: "failed",
          updatedAt: this.#clock(),
          failureCode: "existing_copy_verification_mismatch",
        });
        continue;
      }
      await this.#repository.updateMigration(migration.migrationId, {
        state: "cleanup_pending",
        updatedAt: this.#clock(),
        verifiedAt: this.#clock(),
      });
      return this.#finishSourceCleanup(migration, allocation);
    }

    const failed = await this.#repository.migrations({
      sourcePoolId: allocation.poolId,
      blobKey: allocation.blobKey,
    });
    const excluded = new Set(failed
      .filter((migration) => migration.state === "failed" && migration.candidateCleanupPending)
      .map((migration) => migration.targetPoolId));
    const target = await this.#eligibleMigrationTarget(allocation, allocation.poolId, excluded);
    if (!target) {
      return { state: "blocked", blobKey: allocation.blobKey, reason: "no_eligible_target" };
    }
    const migration = await this.#repository.createMigration({
      blobKey: allocation.blobKey,
      dataClass: allocation.dataClass,
      size: allocation.size,
      sha256: allocation.sha256,
      sourcePoolId: allocation.poolId,
      targetPoolId: target.poolId,
      state: "copying",
      reusedExistingCopy: false,
      candidateCleanupPending: false,
      failureCode: null,
      createdAt: this.#clock(),
      updatedAt: this.#clock(),
      completedAt: null,
    });
    try {
      await this.#dataPlane.copy({
        sourcePoolId: allocation.poolId,
        targetPoolId: target.poolId,
        blobKey: allocation.blobKey,
      });
      const observed = await this.#dataPlane.inspect({
        poolId: target.poolId,
        blobKey: allocation.blobKey,
      });
      if (!verificationMatches(allocation, observed)) {
        throw new PlatformError(
          "storage_verification_mismatch",
          "Migrated storage copy failed integrity verification",
          { status: 422 },
        );
      }
      await this.#repository.addAllocation({
        blobKey: allocation.blobKey,
        poolId: target.poolId,
        dataClass: allocation.dataClass,
        size: allocation.size,
        sha256: allocation.sha256,
        allocationKind: "availability-copy",
        verifiedAt: this.#clock(),
        createdAt: this.#clock(),
      });
      await this.#repository.updateMigration(migration.migrationId, {
        state: "cleanup_pending",
        verifiedAt: this.#clock(),
        updatedAt: this.#clock(),
      });
      return this.#finishSourceCleanup(migration, allocation);
    } catch (error) {
      let candidateCleanupPending = true;
      try {
        await this.#dataPlane.delete({ poolId: target.poolId, blobKey: allocation.blobKey });
        candidateCleanupPending = false;
      } catch {
        // The failed candidate remains explicitly tracked and blocks safe removal.
      }
      await this.#repository.updateMigration(migration.migrationId, {
        state: "failed",
        updatedAt: this.#clock(),
        failureCode: error instanceof PlatformError
          ? error.code : "copy_or_verification_failed",
        candidateCleanupPending,
      });
      return {
        state: "failed",
        migrationId: migration.migrationId,
        reason: error instanceof PlatformError ? error.code : "copy_or_verification_failed",
      };
    }
  }

  async drainPool({ principal, poolId }) {
    await this.#require(principal, "storage:manage");
    let pool = await this.#requirePool(poolId);
    if (pool.lifecycleState === "removed") {
      throw new PlatformError("storage_pool_removed", "Removed storage pool cannot be drained", { status: 409 });
    }
    if (pool.lifecycleState === "active") {
      pool = await this.#repository.updatePool(pool.poolId, ["active"], {
        lifecycleState: "draining",
        updatedAt: this.#clock(),
      });
      await this.#emit("storage.pool_drain_started", {
        actorIdentityId: principal.id,
        poolId: pool.poolId,
        success: true,
      });
    }
    if (pool.lifecycleState === "drained") {
      return { poolId: pool.poolId, lifecycleState: "drained", migrations: [] };
    }

    const outcomes = [];
    const prior = await this.#repository.migrations({ sourcePoolId: pool.poolId });
    for (const migration of prior.filter((candidate) => candidate.state === "failed"
      && candidate.candidateCleanupPending)) {
      try {
        await this.#dataPlane.delete({
          poolId: migration.targetPoolId,
          blobKey: migration.blobKey,
        });
        await this.#repository.updateMigration(migration.migrationId, {
          candidateCleanupPending: false,
          updatedAt: this.#clock(),
        });
      } catch {
        // Keep the failed candidate tracked and avoid reusing its target.
      }
    }
    for (const migration of prior.filter((candidate) => candidate.state === "cleanup_pending")) {
      const allocation = await this.#repository.allocation(pool.poolId, migration.blobKey);
      if (allocation) outcomes.push(await this.#finishSourceCleanup(migration, allocation));
    }
    for (const allocation of await this.#repository.allocations({ poolId: pool.poolId })) {
      const cleanup = (await this.#repository.migrations({
        sourcePoolId: pool.poolId,
        blobKey: allocation.blobKey,
      })).some((migration) => migration.state === "cleanup_pending");
      if (!cleanup) outcomes.push(await this.#migrateAllocation(allocation));
    }

    const [allocations, reservations, incomplete] = await Promise.all([
      this.#repository.allocations({ poolId: pool.poolId }),
      this.#repository.activeReservationsForPool(pool.poolId, this.#clock()),
      this.#repository.incompleteMigrationsForPool(pool.poolId),
    ]);
    let lifecycleState = "draining";
    if (allocations.length === 0 && reservations.length === 0 && incomplete.length === 0) {
      await this.#repository.updatePool(pool.poolId, ["draining"], {
        lifecycleState: "drained",
        updatedAt: this.#clock(),
      });
      lifecycleState = "drained";
      await this.#emit("storage.pool_drained", {
        actorIdentityId: principal.id,
        poolId: pool.poolId,
        success: true,
      });
    }
    return Object.freeze({
      poolId: pool.poolId,
      lifecycleState,
      migrations: Object.freeze(outcomes.map((outcome) => Object.freeze(outcome))),
      blockers: Object.freeze({
        allocationCount: allocations.length,
        reservationCount: reservations.length,
        incompleteMigrationCount: incomplete.length,
      }),
    });
  }

  async removalReadiness({ principal, poolId }) {
    await this.#require(principal, "storage:view");
    const pool = await this.#requirePool(poolId);
    const [allocations, reservations, incomplete] = await Promise.all([
      this.#repository.allocations({ poolId: pool.poolId }),
      this.#repository.activeReservationsForPool(pool.poolId, this.#clock()),
      this.#repository.incompleteMigrationsForPool(pool.poolId),
    ]);
    const uniqueCopies = [];
    for (const allocation of allocations) {
      const copies = await this.#repository.allocations({ blobKey: allocation.blobKey });
      if (copies.length === 1) uniqueCopies.push(allocation.blobKey);
    }
    const blockers = {
      lifecycleState: pool.lifecycleState === "drained" ? null : pool.lifecycleState,
      liveAllocationCount: allocations.length,
      activeReservationCount: reservations.length,
      incompleteMigrationCount: incomplete.length,
      uniqueCopyBlobKeys: uniqueCopies.sort(),
    };
    const removable = pool.lifecycleState === "drained"
      && allocations.length === 0 && reservations.length === 0 && incomplete.length === 0;
    return Object.freeze({ poolId: pool.poolId, removable, blockers: Object.freeze(blockers) });
  }

  async removePool({ principal, poolId }) {
    await this.#require(principal, "storage:manage");
    const readiness = await this.removalReadiness({ principal, poolId });
    if (!readiness.removable) {
      throw new PlatformError(
        "storage_pool_not_removable",
        "Storage pool still has lifecycle or data-safety blockers",
        { status: 409, details: readiness.blockers },
      );
    }
    const removedAt = this.#clock();
    await this.#repository.updatePool(readiness.poolId, ["drained"], {
      lifecycleState: "removed",
      removedAt,
      updatedAt: removedAt,
    });
    await this.#emit("storage.pool_removed", {
      actorIdentityId: principal.id,
      poolId: readiness.poolId,
      success: true,
    });
    return Object.freeze({ poolId: readiness.poolId, lifecycleState: "removed", removedAt: removedAt.toISOString() });
  }
}

export function isStorageLifecycleState(value) {
  return LIFECYCLE_STATES.has(value);
}

export function isIncompleteStorageMigration(value) {
  return INCOMPLETE_MIGRATIONS.has(value);
}
