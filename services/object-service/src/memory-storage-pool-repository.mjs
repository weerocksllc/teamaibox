import { randomUUID } from "node:crypto";

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function allocationKey(blobKey, poolId) {
  return `${blobKey}\u0000${poolId}`;
}

export class StoragePoolRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoragePoolRepositoryError";
    this.code = code;
  }
}

export class MemoryStoragePoolRepository {
  #pools = new Map();
  #reservations = new Map();
  #allocations = new Map();
  #migrations = new Map();

  async createPool(record) {
    if (this.#pools.has(record.poolId)) {
      throw new StoragePoolRepositoryError("storage_pool_exists", "Storage pool already exists");
    }
    this.#pools.set(record.poolId, clone(record));
    return clone(record);
  }

  async pool(poolId) {
    return clone(this.#pools.get(poolId) ?? null);
  }

  async listPools() {
    return [...this.#pools.values()]
      .sort((left, right) => left.poolId.localeCompare(right.poolId))
      .map(clone);
  }

  async updatePool(poolId, expectedLifecycleStates, changes) {
    const pool = this.#pools.get(poolId);
    if (!pool) throw new StoragePoolRepositoryError("storage_pool_not_found", "Storage pool was not found");
    if (expectedLifecycleStates && !expectedLifecycleStates.includes(pool.lifecycleState)) {
      throw new StoragePoolRepositoryError(
        "storage_pool_state_conflict",
        `Storage pool is ${pool.lifecycleState}`,
      );
    }
    Object.assign(pool, clone(changes));
    return clone(pool);
  }

  async createReservation(record) {
    if (this.#reservations.has(record.reservationId)) {
      throw new StoragePoolRepositoryError(
        "storage_reservation_exists",
        "Storage reservation already exists",
      );
    }
    this.#reservations.set(record.reservationId, clone(record));
    return clone(record);
  }

  async reservation(reservationId) {
    return clone(this.#reservations.get(reservationId) ?? null);
  }

  async abortReservation(reservationId, abortedAt) {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) {
      throw new StoragePoolRepositoryError(
        "storage_reservation_not_found",
        "Storage reservation was not found",
      );
    }
    if (reservation.state === "committed") {
      throw new StoragePoolRepositoryError(
        "storage_reservation_committed",
        "Committed storage reservation cannot be aborted",
      );
    }
    if (reservation.state === "reserved") {
      reservation.state = "aborted";
      reservation.updatedAt = new Date(abortedAt);
    }
    return clone(reservation);
  }

  async commitReservation(reservationId, verifiedCopies, committedAt) {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) {
      throw new StoragePoolRepositoryError(
        "storage_reservation_not_found",
        "Storage reservation was not found",
      );
    }
    if (reservation.state !== "reserved") {
      throw new StoragePoolRepositoryError(
        "storage_reservation_state_conflict",
        `Storage reservation is ${reservation.state}`,
      );
    }
    const candidates = reservation.targets.map((target) => ({
      target,
      verified: verifiedCopies.find((candidate) => candidate.poolId === target.poolId),
      existing: this.#allocations.get(allocationKey(reservation.blobKey, target.poolId)),
    }));
    if (candidates.some(({ verified }) => !verified)) {
      throw new StoragePoolRepositoryError(
        "storage_verification_mismatch",
        "A reserved storage target was not verified",
      );
    }
    for (const { existing } of candidates) {
      if (existing && (existing.size !== reservation.size || existing.sha256 !== reservation.sha256)) {
        throw new StoragePoolRepositoryError(
          "storage_allocation_conflict",
          "Storage allocation integrity conflicts with the reservation",
        );
      }
    }
    for (const { target, verified, existing } of candidates) {
      const key = allocationKey(reservation.blobKey, target.poolId);
      if (!existing) {
        this.#allocations.set(key, {
          allocationId: randomUUID(),
          blobKey: reservation.blobKey,
          poolId: target.poolId,
          dataClass: reservation.dataClass,
          size: reservation.size,
          sha256: reservation.sha256,
          allocationKind: target.allocationKind,
          verifiedAt: new Date(verified.verifiedAt),
          createdAt: new Date(committedAt),
        });
      }
    }
    reservation.state = "committed";
    reservation.updatedAt = new Date(committedAt);
    reservation.committedAt = new Date(committedAt);
    return clone(reservation);
  }

  async activeReservationsForPool(poolId, now) {
    return [...this.#reservations.values()]
      .filter((reservation) => reservation.state === "reserved"
        && reservation.expiresAt > now
        && reservation.targets.some((target) => target.poolId === poolId))
      .map(clone);
  }

  async expireReservations(now) {
    let expired = 0;
    for (const reservation of this.#reservations.values()) {
      if (reservation.state === "reserved" && reservation.expiresAt <= now) {
        reservation.state = "expired";
        reservation.updatedAt = new Date(now);
        expired += 1;
      }
    }
    return expired;
  }

  async placementReservedBytes(poolId, now) {
    const reservations = await this.activeReservationsForPool(poolId, now);
    return reservations.reduce((total, reservation) => total + reservation.size, 0);
  }

  async allocation(poolId, blobKey) {
    return clone(this.#allocations.get(allocationKey(blobKey, poolId)) ?? null);
  }

  async allocations({ poolId = null, blobKey = null } = {}) {
    return [...this.#allocations.values()]
      .filter((allocation) => (poolId === null || allocation.poolId === poolId)
        && (blobKey === null || allocation.blobKey === blobKey))
      .sort((left, right) => left.allocationId.localeCompare(right.allocationId))
      .map(clone);
  }

  async allocatedBytes(poolId) {
    return [...this.#allocations.values()]
      .filter((allocation) => allocation.poolId === poolId)
      .reduce((total, allocation) => total + allocation.size, 0);
  }

  async addAllocation(record) {
    const key = allocationKey(record.blobKey, record.poolId);
    const existing = this.#allocations.get(key);
    if (existing) {
      if (existing.size !== record.size || existing.sha256 !== record.sha256) {
        throw new StoragePoolRepositoryError(
          "storage_allocation_conflict",
          "Storage allocation integrity conflicts with the existing copy",
        );
      }
      return clone(existing);
    }
    const allocation = { allocationId: record.allocationId ?? randomUUID(), ...clone(record) };
    this.#allocations.set(key, allocation);
    return clone(allocation);
  }

  async deleteAllocation(poolId, blobKey) {
    return this.#allocations.delete(allocationKey(blobKey, poolId));
  }

  async createMigration(record) {
    const migration = { migrationId: record.migrationId ?? randomUUID(), ...clone(record) };
    this.#migrations.set(migration.migrationId, migration);
    return clone(migration);
  }

  async updateMigration(migrationId, changes) {
    const migration = this.#migrations.get(migrationId);
    if (!migration) {
      throw new StoragePoolRepositoryError(
        "storage_migration_not_found",
        "Storage migration was not found",
      );
    }
    Object.assign(migration, clone(changes));
    return clone(migration);
  }

  async migrations({ poolId = null, sourcePoolId = null, blobKey = null } = {}) {
    return [...this.#migrations.values()]
      .filter((migration) => (poolId === null
        || migration.sourcePoolId === poolId || migration.targetPoolId === poolId)
        && (sourcePoolId === null || migration.sourcePoolId === sourcePoolId)
        && (blobKey === null || migration.blobKey === blobKey))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone);
  }

  async incompleteMigrationsForPool(poolId) {
    const incomplete = new Set(["copying", "cleanup_pending", "failed"]);
    return [...this.#migrations.values()]
      .filter((migration) => incomplete.has(migration.state)
        && (migration.sourcePoolId === poolId || migration.targetPoolId === poolId))
      .map(clone);
  }

  async migrationReservedBytes(poolId) {
    return [...this.#migrations.values()]
      .filter((migration) => migration.targetPoolId === poolId && migration.state === "copying")
      .reduce((total, migration) => total + migration.size, 0);
  }

  async resolveFailedMigrations(sourcePoolId, blobKey, resolvedAt) {
    for (const migration of this.#migrations.values()) {
      if (migration.sourcePoolId === sourcePoolId && migration.blobKey === blobKey
        && migration.state === "failed") {
        migration.state = "superseded";
        migration.updatedAt = new Date(resolvedAt);
        migration.completedAt = new Date(resolvedAt);
      }
    }
  }
}
