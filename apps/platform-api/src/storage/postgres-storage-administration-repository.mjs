function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function count(value) { return Number(value ?? 0); }
function pool(row) {
  if (!row) return null;
  return Object.freeze({
    poolId: row.pool_id,
    displayName: row.display_name,
    backendKind: row.backend_kind,
    nodeId: row.node_id,
    failureDomain: row.failure_domain,
    lifecycleState: row.lifecycle_state,
    healthState: row.health_state,
    totalBytes: row.total_bytes == null ? null : Number(row.total_bytes),
    availableBytes: row.available_bytes == null ? null : Number(row.available_bytes),
    safetyReserveBytes: Number(row.safety_reserve_bytes),
    encryptionMode: row.encryption_mode,
    encryptionStatus: row.encryption_status,
    compatibilityStatus: row.compatibility_status,
    dataClasses: Object.freeze([...(row.data_classes ?? [])]),
    allocationCount: count(row.allocation_count),
    allocatedBytes: count(row.allocated_bytes),
    liveReservationCount: count(row.live_reservation_count),
    liveReservationBytes: count(row.live_reservation_bytes),
    incompleteMigrationCount: count(row.incomplete_migration_count),
    observedAt: iso(row.observed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    removedAt: iso(row.removed_at),
  });
}

const POOL_FACTS = `
  SELECT storage_pool.*,
    COALESCE((SELECT array_agg(data_class ORDER BY data_class)
      FROM objects.storage_pool_data_classes class WHERE class.pool_id=storage_pool.pool_id), ARRAY[]::text[]) AS data_classes,
    (SELECT count(*) FROM objects.storage_allocations allocation WHERE allocation.pool_id=storage_pool.pool_id)::bigint AS allocation_count,
    COALESCE((SELECT sum(size) FROM objects.storage_allocations allocation WHERE allocation.pool_id=storage_pool.pool_id),0)::bigint AS allocated_bytes,
    (SELECT count(*) FROM objects.storage_placement_targets target
      JOIN objects.storage_placement_reservations reservation ON reservation.reservation_id=target.reservation_id
      WHERE target.pool_id=storage_pool.pool_id AND reservation.state='reserved' AND reservation.expires_at>clock_timestamp())::bigint AS live_reservation_count,
    COALESCE((SELECT sum(reservation.size) FROM objects.storage_placement_targets target
      JOIN objects.storage_placement_reservations reservation ON reservation.reservation_id=target.reservation_id
      WHERE target.pool_id=storage_pool.pool_id AND reservation.state='reserved' AND reservation.expires_at>clock_timestamp()),0)::bigint AS live_reservation_bytes,
    (SELECT count(*) FROM objects.storage_migrations migration
      WHERE (migration.source_pool_id=storage_pool.pool_id OR migration.target_pool_id=storage_pool.pool_id)
        AND migration.state IN ('copying','verifying','cleanup_pending','failed'))::bigint AS incomplete_migration_count
  FROM objects.storage_pools storage_pool`;

export class PostgresStorageAdministrationRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    this.#database = database;
  }

  async list() {
    return Object.freeze(rows(await this.#database.query(`${POOL_FACTS} ORDER BY storage_pool.created_at,storage_pool.pool_id`)).map(pool));
  }

  async find(poolId, { lock = false, executor = this.#database } = {}) {
    const result = rows(await executor.query(`SELECT * FROM objects.storage_pools WHERE pool_id=$1${lock ? " FOR UPDATE" : ""}`, [poolId]))[0];
    if (!result) return null;
    const classes = rows(await executor.query(`SELECT data_class FROM objects.storage_pool_data_classes WHERE pool_id=$1 ORDER BY data_class`, [poolId]));
    return pool({ ...result, data_classes: classes.map((item) => item.data_class) });
  }

  async create(input) {
    return this.#database.transaction(async (transaction) => {
      const created = rows(await transaction.query(`
        INSERT INTO objects.storage_pools
          (pool_id,display_name,backend_kind,node_id,failure_domain,lifecycle_state,health_state,total_bytes,available_bytes,
           safety_reserve_bytes,encryption_mode,encryption_status,encryption_verified_at,compatibility_status,compatibility_verified_at,observed_at)
        VALUES ($1,$2,$3,$4,$5,'active','healthy',$6,$7,$8,$9,'verified',$10,'verified',$10,$10)
        RETURNING *`, [input.poolId, input.displayName, input.backendKind, input.nodeId, input.failureDomain,
        input.totalBytes, input.availableBytes, input.safetyReserveBytes, input.encryptionMode, input.observedAt]))[0];
      for (const dataClass of input.dataClasses) {
        await transaction.query(`INSERT INTO objects.storage_pool_data_classes (pool_id,data_class) VALUES ($1,$2)`, [input.poolId, dataClass]);
      }
      return pool({ ...created, data_classes: input.dataClasses });
    });
  }

  async replaceDataClasses({ poolId, expectedUpdatedAt, dataClasses }) {
    return this.#database.transaction(async (transaction) => {
      const current = await this.find(poolId, { lock: true, executor: transaction });
      if (!current || current.updatedAt !== expectedUpdatedAt) return null;
      await transaction.query(`DELETE FROM objects.storage_pool_data_classes WHERE pool_id=$1`, [poolId]);
      for (const dataClass of dataClasses) {
        await transaction.query(`INSERT INTO objects.storage_pool_data_classes (pool_id,data_class) VALUES ($1,$2)`, [poolId, dataClass]);
      }
      const updated = rows(await transaction.query(`UPDATE objects.storage_pools SET updated_at=clock_timestamp() WHERE pool_id=$1 RETURNING *`, [poolId]))[0];
      return pool({ ...updated, data_classes: dataClasses });
    });
  }

  async transition({ poolId, expectedUpdatedAt, fromState, toState }) {
    const result = rows(await this.#database.query(`
      UPDATE objects.storage_pools
      SET lifecycle_state=$4, removed_at=CASE WHEN $4='removed' THEN clock_timestamp() ELSE removed_at END,
          updated_at=clock_timestamp()
      WHERE pool_id=$1 AND lifecycle_state=$2 AND updated_at=$3
      RETURNING *`, [poolId, fromState, expectedUpdatedAt, toState]))[0];
    if (!result) return null;
    const classes = rows(await this.#database.query(`SELECT data_class FROM objects.storage_pool_data_classes WHERE pool_id=$1 ORDER BY data_class`, [poolId]));
    return pool({ ...result, data_classes: classes.map((item) => item.data_class) });
  }
}
