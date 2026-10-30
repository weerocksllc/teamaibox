import { PlatformError } from "../../../packages/observability/src/index.mjs";

const SELECT = `
SELECT *
FROM compute.worker_instances`;

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}

function json(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function dateArray(value) {
  return (value ?? []).map((entry) => new Date(entry));
}

function mapped(row) {
  if (!row) return null;
  return {
    workerId: row.id,
    nodeId: row.node_id,
    nodeGeneration: Number(row.node_generation),
    computePluginId: row.compute_plugin_id,
    modelProfileId: row.model_profile_id,
    attemptId: row.attempt_id,
    image: row.image_reference,
    architecture: row.architecture,
    generation: Number(row.generation),
    lifecycleState: row.lifecycle_state,
    health: {
      state: row.health_state,
      observedAt: date(row.health_observed_at),
      generation: Number(row.health_generation),
      reasonCode: row.health_reason_code,
    },
    resources: json(row.resources),
    maxConcurrentAttempts: Number(row.max_concurrent_attempts),
    activeAttemptIds: [...(row.active_attempt_ids ?? [])],
    attemptStates: json(row.attempt_states) ?? {},
    attemptBindings: json(row.attempt_bindings) ?? {},
    bindingRevision: Number(row.binding_revision ?? 0),
    reservationIds: [...(row.reservation_ids ?? [])],
    controlLeaseId: row.control_lease_id,
    controlFencingToken: Number(row.control_fencing_token),
    loadedAt: date(row.loaded_at),
    lastHeartbeatAt: date(row.last_heartbeat_at),
    idleSince: date(row.idle_since),
    crashTimestamps: dateArray(row.crash_timestamps),
    crashCount: Number(row.crash_count),
    nextRetryAt: date(row.next_retry_at),
    circuitOpenUntil: date(row.circuit_open_until),
    lastFailureCode: row.last_failure_code,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

async function select(executor, workerId, lock = false) {
  const result = await executor.query(`${SELECT} WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [workerId]);
  return mapped(rows(result)[0]);
}

function missing() {
  return new PlatformError("worker_not_found", "Compute worker does not exist", { status: 404 });
}

function immutableConflict() {
  return new PlatformError("worker_identity_conflict", "Worker ID was reused with different immutable facts", { status: 409 });
}

export class PostgresWorkerRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    }
    this.#database = database;
  }

  async create(worker) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query(`
        INSERT INTO compute.worker_instances (
          id, node_id, node_generation, compute_plugin_id, model_profile_id, attempt_id, image_reference,
          architecture, generation, lifecycle_state, health_state,
          health_observed_at, health_generation, health_reason_code,
          resources, max_concurrent_attempts, active_attempt_ids,
          attempt_states, attempt_bindings, binding_revision, reservation_ids, control_lease_id,
          control_fencing_token, loaded_at, last_heartbeat_at, idle_since,
          crash_timestamps, crash_count, next_retry_at, circuit_open_until,
          last_failure_code, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::uuid[],
          $18::jsonb,$19::jsonb,$20,$21::uuid[],$22,$23,$24,$25,$26,$27::timestamptz[],$28,
          $29,$30,$31,$32,$33
        ) ON CONFLICT (id) DO NOTHING`, [
        worker.workerId,
        worker.nodeId,
        worker.nodeGeneration,
        worker.computePluginId,
        worker.modelProfileId,
        worker.attemptId,
        worker.image,
        worker.architecture,
        worker.generation,
        worker.lifecycleState,
        worker.health.state,
        worker.health.observedAt,
        worker.health.generation,
        worker.health.reasonCode,
        JSON.stringify(worker.resources),
        worker.maxConcurrentAttempts,
        worker.activeAttemptIds,
        JSON.stringify(worker.attemptStates),
        JSON.stringify(worker.attemptBindings),
        worker.bindingRevision,
        worker.reservationIds,
        worker.controlLeaseId,
        worker.controlFencingToken,
        worker.loadedAt,
        worker.lastHeartbeatAt,
        worker.idleSince,
        worker.crashTimestamps,
        worker.crashCount,
        worker.nextRetryAt,
        worker.circuitOpenUntil,
        worker.lastFailureCode,
        worker.createdAt,
        worker.updatedAt,
      ]);
      const current = await select(transaction, worker.workerId, true);
      if (!current) throw missing();
      for (const key of [
        "nodeId", "nodeGeneration", "computePluginId", "modelProfileId",
        "image", "architecture", "controlLeaseId", "controlFencingToken",
      ]) {
        if (current[key] !== worker[key]) throw immutableConflict();
      }
      return current;
    });
  }

  async get(workerId) {
    const worker = await select(this.#database, workerId);
    if (!worker) throw missing();
    return worker;
  }

  async mutate(workerId, mutation) {
    return this.#database.transaction(async (transaction) => {
      const current = await select(transaction, workerId, true);
      if (!current) throw missing();
      const worker = await mutation(structuredClone(current));
      if (!worker || worker.workerId !== workerId) throw new TypeError("worker mutation must preserve identity");
      const result = await transaction.query(`
        UPDATE compute.worker_instances
        SET generation = $2,
            lifecycle_state = $3,
            health_state = $4,
            health_observed_at = $5,
            health_generation = $6,
            health_reason_code = $7,
            resources = $8::jsonb,
            max_concurrent_attempts = $9,
            active_attempt_ids = $10::uuid[],
            attempt_states = $11::jsonb,
            attempt_bindings = $12::jsonb,
            binding_revision = $13,
            reservation_ids = $14::uuid[],
            control_lease_id = $15,
            control_fencing_token = $16,
            loaded_at = $17,
            last_heartbeat_at = $18,
            idle_since = $19,
            crash_timestamps = $20::timestamptz[],
            crash_count = $21,
            next_retry_at = $22,
            circuit_open_until = $23,
            last_failure_code = $24,
            updated_at = $25
        WHERE id = $1
        RETURNING *`, [
        workerId,
        worker.generation,
        worker.lifecycleState,
        worker.health.state,
        worker.health.observedAt,
        worker.health.generation,
        worker.health.reasonCode,
        JSON.stringify(worker.resources),
        worker.maxConcurrentAttempts,
        worker.activeAttemptIds,
        JSON.stringify(worker.attemptStates),
        JSON.stringify(worker.attemptBindings),
        worker.bindingRevision,
        worker.reservationIds,
        worker.controlLeaseId,
        worker.controlFencingToken,
        worker.loadedAt,
        worker.lastHeartbeatAt,
        worker.idleSince,
        worker.crashTimestamps,
        worker.crashCount,
        worker.nextRetryAt,
        worker.circuitOpenUntil,
        worker.lastFailureCode,
        worker.updatedAt,
      ]);
      return mapped(rows(result)[0]);
    });
  }

  async list({ states } = {}) {
    if (states && (!Array.isArray(states) || states.some((state) => typeof state !== "string"))) {
      throw new TypeError("states must be an array of lifecycle state names");
    }
    const result = states
      ? await this.#database.query(`${SELECT} WHERE lifecycle_state = ANY($1::text[]) ORDER BY id`, [states])
      : await this.#database.query(`${SELECT} ORDER BY id`, []);
    return rows(result).map(mapped);
  }
}
