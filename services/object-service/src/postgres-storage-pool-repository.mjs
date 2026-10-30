import { randomUUID } from "node:crypto";

import { StoragePoolRepositoryError } from "./memory-storage-pool-repository.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL storage-pool result is invalid");
  return result.rows;
}

function date(value) { return value == null ? null : new Date(value); }
function digest(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("storage-pool digest is corrupt");
  return Buffer.from(value).toString("hex");
}
function encodedDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("storage-pool digest is invalid");
  return Buffer.from(value, "hex");
}

function poolRecord(row, dataClasses = []) {
  if (!row) return null;
  return {
    poolId: row.pool_id, displayName: row.display_name, backendKind: row.backend_kind,
    nodeId: row.node_id, failureDomain: row.failure_domain, lifecycleState: row.lifecycle_state,
    healthState: row.health_state, totalBytes: row.total_bytes == null ? null : Number(row.total_bytes),
    availableBytes: row.available_bytes == null ? null : Number(row.available_bytes),
    safetyReserveBytes: Number(row.safety_reserve_bytes), dataClasses: [...dataClasses],
    encryptionMode: row.encryption_mode, encryptionStatus: row.encryption_status,
    encryptionVerifiedAt: date(row.encryption_verified_at), compatibilityStatus: row.compatibility_status,
    compatibilityVerifiedAt: date(row.compatibility_verified_at), observedAt: date(row.observed_at),
    removedAt: date(row.removed_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

function reservationRecord(row, targets = []) {
  if (!row) return null;
  return {
    reservationId: row.reservation_id, blobKey: row.blob_key, dataClass: row.data_class,
    size: Number(row.size), sha256: digest(row.sha256), state: row.state,
    targets: targets.map((target) => ({ poolId: target.pool_id, failureDomain: target.failure_domain,
      allocationKind: target.allocation_kind })), expiresAt: date(row.expires_at), committedAt: date(row.committed_at),
    createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

function allocationRecord(row) {
  if (!row) return null;
  return {
    allocationId: row.allocation_id, blobKey: row.blob_key, poolId: row.pool_id,
    dataClass: row.data_class, size: Number(row.size), sha256: digest(row.sha256),
    allocationKind: row.allocation_kind, verifiedAt: date(row.verified_at), createdAt: date(row.created_at),
  };
}

function migrationRecord(row) {
  if (!row) return null;
  return {
    migrationId: row.migration_id, blobKey: row.blob_key, dataClass: row.data_class,
    size: Number(row.size), sha256: digest(row.sha256), sourcePoolId: row.source_pool_id,
    targetPoolId: row.target_pool_id, state: row.state, reusedExistingCopy: row.reused_existing_copy,
    candidateCleanupPending: row.candidate_cleanup_pending, failureCode: row.failure_code,
    verifiedAt: date(row.verified_at), completedAt: date(row.completed_at),
    createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

function repositoryFailure(error) {
  if (error instanceof StoragePoolRepositoryError) return error;
  if (error?.code === "23505") return new StoragePoolRepositoryError("storage_conflict", "Storage record already exists");
  if (error?.code === "23514") return new StoragePoolRepositoryError("storage_state_conflict", "Storage safety boundary rejected the operation");
  return error;
}

export class PostgresStoragePoolRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL storage-pool repository requires query and transactions");
    this.#database = database;
  }

  async #classes(poolId, executor = this.#database) {
    return rows(await executor.query(
      "SELECT data_class FROM objects.storage_pool_data_classes WHERE pool_id=$1 ORDER BY data_class", [poolId],
    )).map((row) => row.data_class);
  }

  async createPool(record) {
    try {
      return await this.#database.transaction(async (tx) => {
        const created = rows(await tx.query(`INSERT INTO objects.storage_pools
          (pool_id,display_name,backend_kind,node_id,failure_domain,lifecycle_state,health_state,total_bytes,available_bytes,
           safety_reserve_bytes,encryption_mode,encryption_status,encryption_verified_at,compatibility_status,
           compatibility_verified_at,observed_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [record.poolId, record.displayName, record.backendKind, record.nodeId, record.failureDomain,
          record.lifecycleState, record.healthState, record.totalBytes, record.availableBytes,
          record.safetyReserveBytes, record.encryptionMode, record.encryptionStatus, record.encryptionVerifiedAt,
          record.compatibilityStatus, record.compatibilityVerifiedAt, record.observedAt, record.createdAt, record.updatedAt]))[0];
        for (const value of record.dataClasses) {
          await tx.query("INSERT INTO objects.storage_pool_data_classes (pool_id,data_class) VALUES ($1,$2)", [record.poolId, value]);
        }
        return poolRecord(created, record.dataClasses);
      });
    } catch (error) { throw repositoryFailure(error); }
  }

  async pool(poolId) {
    const row = rows(await this.#database.query("SELECT * FROM objects.storage_pools WHERE pool_id=$1", [poolId]))[0];
    return row ? poolRecord(row, await this.#classes(poolId)) : null;
  }

  async listPools() {
    const values = rows(await this.#database.query("SELECT * FROM objects.storage_pools ORDER BY pool_id"));
    return Promise.all(values.map(async (row) => poolRecord(row, await this.#classes(row.pool_id))));
  }

  async updatePool(poolId, expectedLifecycleStates, changes) {
    try {
      return await this.#database.transaction(async (tx) => {
        const current = rows(await tx.query("SELECT * FROM objects.storage_pools WHERE pool_id=$1 FOR UPDATE", [poolId]))[0];
        if (!current) throw new StoragePoolRepositoryError("storage_pool_not_found", "Storage pool was not found");
        if (expectedLifecycleStates && !expectedLifecycleStates.includes(current.lifecycle_state)) {
          throw new StoragePoolRepositoryError("storage_pool_state_conflict", `Storage pool is ${current.lifecycle_state}`);
        }
        const dataClasses = Object.hasOwn(changes, "dataClasses") ? [...changes.dataClasses] : await this.#classes(poolId, tx);
        if (Object.hasOwn(changes, "dataClasses")) {
          await tx.query("DELETE FROM objects.storage_pool_data_classes WHERE pool_id=$1", [poolId]);
          for (const value of dataClasses) await tx.query(
            "INSERT INTO objects.storage_pool_data_classes (pool_id,data_class) VALUES ($1,$2)", [poolId, value],
          );
        }
        const next = {
          displayName: changes.displayName ?? current.display_name,
          lifecycleState: changes.lifecycleState ?? current.lifecycle_state,
          healthState: changes.healthState ?? current.health_state,
          totalBytes: Object.hasOwn(changes, "totalBytes") ? changes.totalBytes : current.total_bytes,
          availableBytes: Object.hasOwn(changes, "availableBytes") ? changes.availableBytes : current.available_bytes,
          safetyReserveBytes: changes.safetyReserveBytes ?? current.safety_reserve_bytes,
          encryptionMode: changes.encryptionMode ?? current.encryption_mode,
          encryptionStatus: changes.encryptionStatus ?? current.encryption_status,
          encryptionVerifiedAt: Object.hasOwn(changes, "encryptionVerifiedAt") ? changes.encryptionVerifiedAt : current.encryption_verified_at,
          compatibilityStatus: changes.compatibilityStatus ?? current.compatibility_status,
          compatibilityVerifiedAt: Object.hasOwn(changes, "compatibilityVerifiedAt") ? changes.compatibilityVerifiedAt : current.compatibility_verified_at,
          observedAt: Object.hasOwn(changes, "observedAt") ? changes.observedAt : current.observed_at,
          removedAt: Object.hasOwn(changes, "removedAt") ? changes.removedAt : current.removed_at,
          updatedAt: changes.updatedAt ?? new Date(),
        };
        const updated = rows(await tx.query(`UPDATE objects.storage_pools SET display_name=$2,lifecycle_state=$3,
          health_state=$4,total_bytes=$5,available_bytes=$6,safety_reserve_bytes=$7,encryption_mode=$8,
          encryption_status=$9,encryption_verified_at=$10,compatibility_status=$11,compatibility_verified_at=$12,
          observed_at=$13,removed_at=$14,updated_at=$15 WHERE pool_id=$1 RETURNING *`,
        [poolId, next.displayName, next.lifecycleState, next.healthState, next.totalBytes, next.availableBytes,
          next.safetyReserveBytes, next.encryptionMode, next.encryptionStatus, next.encryptionVerifiedAt,
          next.compatibilityStatus, next.compatibilityVerifiedAt, next.observedAt, next.removedAt, next.updatedAt]))[0];
        return poolRecord(updated, dataClasses);
      });
    } catch (error) { throw repositoryFailure(error); }
  }

  async createReservation(record) {
    try {
      return await this.#database.transaction(async (tx) => {
        const created = rows(await tx.query(`INSERT INTO objects.storage_placement_reservations
          (reservation_id,blob_key,data_class,size,sha256,state,requested_copies,expires_at,committed_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [record.reservationId, record.blobKey, record.dataClass, record.size, encodedDigest(record.sha256), record.state,
          record.targets.length, record.expiresAt, record.committedAt, record.createdAt, record.updatedAt]))[0];
        for (const target of record.targets) await tx.query(
          "INSERT INTO objects.storage_placement_targets (reservation_id,pool_id,allocation_kind) VALUES ($1,$2,$3)",
          [record.reservationId, target.poolId, target.allocationKind],
        );
        return reservationRecord(created, record.targets.map((target) => ({
          pool_id: target.poolId, failure_domain: target.failureDomain, allocation_kind: target.allocationKind,
        })));
      });
    } catch (error) { throw repositoryFailure(error); }
  }

  async #reservation(reservationId, executor = this.#database, lock = false) {
    const record = rows(await executor.query(
      `SELECT * FROM objects.storage_placement_reservations WHERE reservation_id=$1${lock ? " FOR UPDATE" : ""}`, [reservationId],
    ))[0];
    if (!record) return null;
    const targets = rows(await executor.query(`SELECT target.*,pool.failure_domain FROM objects.storage_placement_targets target
      JOIN objects.storage_pools pool ON pool.pool_id=target.pool_id WHERE reservation_id=$1 ORDER BY allocation_kind DESC,pool_id`, [reservationId]));
    return reservationRecord(record, targets);
  }

  reservation(reservationId) { return this.#reservation(reservationId); }

  async abortReservation(reservationId, abortedAt) {
    try {
      const row = rows(await this.#database.query(`UPDATE objects.storage_placement_reservations
        SET state=CASE WHEN state='reserved' THEN 'aborted' ELSE state END,updated_at=$2
        WHERE reservation_id=$1 AND state<>'committed' RETURNING *`, [reservationId, abortedAt]))[0];
      if (!row) throw new StoragePoolRepositoryError("storage_reservation_not_found", "Storage reservation was not found or is committed");
      return this.#reservation(reservationId);
    } catch (error) { throw repositoryFailure(error); }
  }

  async commitReservation(reservationId, verifiedCopies, committedAt) {
    try {
      return await this.#database.transaction(async (tx) => {
        const reservation = await this.#reservation(reservationId, tx, true);
        if (!reservation) throw new StoragePoolRepositoryError("storage_reservation_not_found", "Storage reservation was not found");
        if (reservation.state !== "reserved") throw new StoragePoolRepositoryError("storage_reservation_state_conflict", `Storage reservation is ${reservation.state}`);
        for (const target of reservation.targets) {
          const verified = verifiedCopies.find((value) => value.poolId === target.poolId);
          if (!verified || verified.size !== reservation.size || verified.sha256 !== reservation.sha256) {
            throw new StoragePoolRepositoryError("storage_verification_mismatch", "Storage verification does not match reservation");
          }
          await tx.query(`INSERT INTO objects.storage_allocations
            (allocation_id,blob_key,pool_id,data_class,size,sha256,allocation_kind,verified_at,created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (blob_key,pool_id) DO NOTHING`,
          [randomUUID(), reservation.blobKey, target.poolId, reservation.dataClass, reservation.size,
            encodedDigest(reservation.sha256), target.allocationKind, verified.verifiedAt, committedAt]);
        }
        await tx.query(`UPDATE objects.storage_placement_reservations SET state='committed',committed_at=$2,updated_at=$2
          WHERE reservation_id=$1`, [reservationId, committedAt]);
        return this.#reservation(reservationId, tx);
      });
    } catch (error) { throw repositoryFailure(error); }
  }

  async activeReservationsForPool(poolId, now) {
    const values = rows(await this.#database.query(`SELECT reservation.* FROM objects.storage_placement_reservations reservation
      JOIN objects.storage_placement_targets target ON target.reservation_id=reservation.reservation_id
      WHERE target.pool_id=$1 AND reservation.state='reserved' AND reservation.expires_at>$2 ORDER BY reservation.created_at`, [poolId, now]));
    return Promise.all(values.map((row) => this.#reservation(row.reservation_id)));
  }

  async expireReservations(now) {
    const result = await this.#database.query(`UPDATE objects.storage_placement_reservations SET state='expired',updated_at=$1
      WHERE state='reserved' AND expires_at<=$1`, [now]);
    return result.rowCount;
  }

  async placementReservedBytes(poolId, now) {
    const row = rows(await this.#database.query(`SELECT COALESCE(sum(reservation.size),0)::bigint AS bytes
      FROM objects.storage_placement_reservations reservation JOIN objects.storage_placement_targets target
      ON target.reservation_id=reservation.reservation_id WHERE target.pool_id=$1 AND reservation.state='reserved' AND reservation.expires_at>$2`, [poolId, now]))[0];
    return Number(row.bytes);
  }

  async allocation(poolId, blobKey) {
    return allocationRecord(rows(await this.#database.query(
      "SELECT * FROM objects.storage_allocations WHERE pool_id=$1 AND blob_key=$2", [poolId, blobKey],
    ))[0]);
  }

  async allocations({ poolId = null, blobKey = null } = {}) {
    return rows(await this.#database.query(`SELECT * FROM objects.storage_allocations
      WHERE ($1::text IS NULL OR pool_id=$1) AND ($2::text IS NULL OR blob_key=$2) ORDER BY allocation_id`, [poolId, blobKey])).map(allocationRecord);
  }

  async allocatedBytes(poolId) {
    return Number(rows(await this.#database.query(
      "SELECT COALESCE(sum(size),0)::bigint AS bytes FROM objects.storage_allocations WHERE pool_id=$1", [poolId],
    ))[0].bytes);
  }

  async addAllocation(record) {
    try {
      const row = rows(await this.#database.query(`INSERT INTO objects.storage_allocations
        (allocation_id,blob_key,pool_id,data_class,size,sha256,allocation_kind,verified_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (blob_key,pool_id) DO UPDATE SET verified_at=EXCLUDED.verified_at RETURNING *`,
      [record.allocationId ?? randomUUID(), record.blobKey, record.poolId, record.dataClass, record.size,
        encodedDigest(record.sha256), record.allocationKind, record.verifiedAt, record.createdAt]))[0];
      return allocationRecord(row);
    } catch (error) { throw repositoryFailure(error); }
  }

  async deleteAllocation(poolId, blobKey) {
    const result = await this.#database.query("DELETE FROM objects.storage_allocations WHERE pool_id=$1 AND blob_key=$2", [poolId, blobKey]);
    return result.rowCount === 1;
  }

  async createMigration(record) {
    try {
      return migrationRecord(rows(await this.#database.query(`INSERT INTO objects.storage_migrations
        (migration_id,blob_key,data_class,size,sha256,source_pool_id,target_pool_id,state,reused_existing_copy,
         candidate_cleanup_pending,failure_code,verified_at,completed_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [record.migrationId ?? randomUUID(), record.blobKey, record.dataClass, record.size, encodedDigest(record.sha256),
        record.sourcePoolId, record.targetPoolId, record.state, record.reusedExistingCopy, record.candidateCleanupPending,
        record.failureCode, record.verifiedAt ?? null, record.completedAt, record.createdAt, record.updatedAt]))[0]);
    } catch (error) { throw repositoryFailure(error); }
  }

  async updateMigration(migrationId, changes) {
    try {
      return await this.#database.transaction(async (tx) => {
        const current = rows(await tx.query("SELECT * FROM objects.storage_migrations WHERE migration_id=$1 FOR UPDATE", [migrationId]))[0];
        if (!current) throw new StoragePoolRepositoryError("storage_migration_not_found", "Storage migration was not found");
        const updated = rows(await tx.query(`UPDATE objects.storage_migrations SET state=$2,candidate_cleanup_pending=$3,
          failure_code=$4,verified_at=$5,completed_at=$6,updated_at=$7 WHERE migration_id=$1 RETURNING *`,
        [migrationId, changes.state ?? current.state,
          Object.hasOwn(changes, "candidateCleanupPending") ? changes.candidateCleanupPending : current.candidate_cleanup_pending,
          Object.hasOwn(changes, "failureCode") ? changes.failureCode : current.failure_code,
          Object.hasOwn(changes, "verifiedAt") ? changes.verifiedAt : current.verified_at,
          Object.hasOwn(changes, "completedAt") ? changes.completedAt : current.completed_at,
          changes.updatedAt ?? new Date()]))[0];
        return migrationRecord(updated);
      });
    } catch (error) { throw repositoryFailure(error); }
  }

  async migrations({ poolId = null, sourcePoolId = null, blobKey = null } = {}) {
    return rows(await this.#database.query(`SELECT * FROM objects.storage_migrations WHERE
      ($1::text IS NULL OR source_pool_id=$1 OR target_pool_id=$1) AND ($2::text IS NULL OR source_pool_id=$2)
      AND ($3::text IS NULL OR blob_key=$3) ORDER BY created_at,migration_id`, [poolId, sourcePoolId, blobKey])).map(migrationRecord);
  }

  async incompleteMigrationsForPool(poolId) {
    return rows(await this.#database.query(`SELECT * FROM objects.storage_migrations WHERE
      (source_pool_id=$1 OR target_pool_id=$1) AND state IN ('copying','verifying','cleanup_pending','failed') ORDER BY created_at`, [poolId])).map(migrationRecord);
  }

  async migrationReservedBytes(poolId) {
    return Number(rows(await this.#database.query(`SELECT COALESCE(sum(size),0)::bigint AS bytes FROM objects.storage_migrations
      WHERE target_pool_id=$1 AND state='copying'`, [poolId]))[0].bytes);
  }

  async resolveFailedMigrations(sourcePoolId, blobKey, resolvedAt) {
    await this.#database.query(`UPDATE objects.storage_migrations SET state='superseded',updated_at=$3,completed_at=$3
      WHERE source_pool_id=$1 AND blob_key=$2 AND state='failed'`, [sourcePoolId, blobKey, resolvedAt]);
  }
}
