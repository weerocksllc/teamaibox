import { PlatformError } from "../../../packages/observability/src/index.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL protected-set result is invalid");
  return result.rows;
}

function copy(value) {
  return value == null ? null : structuredClone(value);
}

function json(value) {
  if (value == null) return null;
  return typeof value === "string" ? JSON.parse(value) : copy(value);
}

function date(value) {
  return value == null ? null : new Date(value);
}

function revision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function conflict(code, message) {
  throw new PlatformError(code, message, { status: 409, retryable: true });
}

function translate(error) {
  if (error instanceof PlatformError) throw error;
  if (error?.code === "23505" && error?.constraint === "protected_office_set_transactions_one_active_idx") {
    conflict("protected_set_transaction_active", "Another protected-set transaction requires completion or recovery");
  }
  if (error?.code === "23505" && error?.constraint === "protected_office_sets_pkey") {
    conflict("protected_set_state_revision_conflict", "Protected-set state changed");
  }
  if (error?.code === "23505") {
    throw new PlatformError("protected_set_transaction_conflict", "Protected-set transaction already exists", { status: 409 });
  }
  if (error?.code === "23514" && /terminal protected office transaction/.test(error.message ?? "")) {
    throw new PlatformError("protected_set_transaction_terminal", "Terminal protected-set transaction cannot change", { status: 409 });
  }
  if (error?.code === "23514" && /transaction revision is stale/.test(error.message ?? "")) {
    conflict("protected_set_transaction_revision_conflict", "Protected-set transaction journal changed");
  }
  if (error?.code === "23514" && /set state revision or identity is stale/.test(error.message ?? "")) {
    conflict("protected_set_state_revision_conflict", "Protected-set state changed");
  }
  if (error?.code === "23514" || error?.code === "23503" || error?.code === "22P02"
      || error?.code === "22007" || error?.code === "22008") {
    throw new PlatformError("protected_set_persistence_invalid", "Protected-set persistence violates its fail-closed envelope", { status: 409 });
  }
  throw error;
}

function transaction(row) {
  if (!row) return null;
  return {
    transactionId: row.id,
    setId: row.set_id,
    nodeId: row.node_id,
    revision: Number(row.revision),
    desiredStateRevision: Number(row.desired_state_revision),
    maintenanceGeneration: Number(row.maintenance_generation),
    state: row.transaction_state,
    manifest: json(row.manifest),
    previousIdentities: json(row.previous_identities),
    maintenanceAuthorization: json(row.maintenance_authorization),
    admission: json(row.admission),
    steps: json(row.steps),
    recoverySteps: json(row.recovery_steps),
    observedIdentities: json(row.observed_identities),
    failureCode: row.failure_code,
    recoveryFailures: json(row.recovery_failures),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    completedAt: date(row.completed_at),
  };
}

function setState(row) {
  if (!row) return null;
  return {
    setId: row.set_id,
    nodeId: row.node_id,
    revision: Number(row.revision),
    desiredStateRevision: Number(row.desired_state_revision),
    observedStateRevision: Number(row.observed_state_revision),
    maintenanceGeneration: Number(row.maintenance_generation),
    recoveryState: row.recovery_state,
    recoveryReasonCode: row.recovery_reason_code,
    healthyIdentities: json(row.healthy_identities),
    aggregateResidentBytes: Number(row.aggregate_resident_bytes),
    lastTransactionId: row.last_transaction_id,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

async function lockTransaction(database, transactionId) {
  return transaction(rows(await database.query(
    "SELECT * FROM compute.protected_office_set_transactions WHERE id=$1 FOR UPDATE",
    [transactionId],
  ))[0]);
}

async function lockSetState(database, setId) {
  return setState(rows(await database.query(
    "SELECT * FROM compute.protected_office_sets WHERE set_id=$1 FOR UPDATE",
    [setId],
  ))[0]);
}

async function updateTransactionRow(database, current, patch) {
  const next = { ...current, ...copy(patch) };
  return transaction(rows(await database.query(`
    UPDATE compute.protected_office_set_transactions
    SET transaction_state=$3, revision=revision+1,
        steps=$4::jsonb, recovery_steps=$5::jsonb,
        observed_identities=$6::jsonb, failure_code=$7,
        recovery_failures=$8::jsonb, updated_at=$9, completed_at=$10
    WHERE id=$1 AND revision=$2
    RETURNING *`, [
    current.transactionId, current.revision, next.state,
    JSON.stringify(next.steps ?? []), JSON.stringify(next.recoverySteps ?? []),
    next.observedIdentities == null ? null : JSON.stringify(next.observedIdentities),
    next.failureCode ?? null, JSON.stringify(next.recoveryFailures ?? []),
    next.updatedAt, next.completedAt ?? null,
  ]))[0]) ?? conflict("protected_set_transaction_revision_conflict", "Protected-set transaction journal changed");
}

async function writeSetStateRow(database, current, setId, value) {
  const next = { ...copy(current ?? {}), ...copy(value), setId };
  if (!current) {
    return setState(rows(await database.query(`
      INSERT INTO compute.protected_office_sets (
        set_id, node_id, revision, desired_state_revision,
        observed_state_revision, maintenance_generation,
        recovery_state, recovery_reason_code, healthy_identities,
        aggregate_resident_bytes, last_transaction_id, created_at, updated_at
      ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
      RETURNING *`, [
      setId, next.nodeId, next.desiredStateRevision,
      next.observedStateRevision ?? 0, next.maintenanceGeneration,
      next.recoveryState, next.recoveryReasonCode ?? null,
      JSON.stringify(next.healthyIdentities ?? []), next.aggregateResidentBytes ?? 0,
      next.lastTransactionId, next.createdAt, next.updatedAt,
    ]))[0]);
  }
  return setState(rows(await database.query(`
    UPDATE compute.protected_office_sets
    SET revision=revision+1, desired_state_revision=$3,
        observed_state_revision=$4, maintenance_generation=$5,
        recovery_state=$6, recovery_reason_code=$7,
        healthy_identities=$8::jsonb, aggregate_resident_bytes=$9,
        last_transaction_id=$10, updated_at=$11
    WHERE set_id=$1 AND revision=$2
    RETURNING *`, [
    setId, current.revision, next.desiredStateRevision,
    next.observedStateRevision, next.maintenanceGeneration,
    next.recoveryState, next.recoveryReasonCode ?? null,
    JSON.stringify(next.healthyIdentities ?? []), next.aggregateResidentBytes ?? 0,
    next.lastTransactionId, next.updatedAt,
  ]))[0]) ?? conflict("protected_set_state_revision_conflict", "Protected-set state changed");
}

export class PostgresProtectedOfficeSetRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL protected office set repository requires a transactional adapter");
    }
    this.#database = database;
  }

  async beginTransaction(value) {
    if (!value || typeof value.transactionId !== "string" || value.transactionId.length < 8) {
      throw new TypeError("protected-set transaction identity is invalid");
    }
    try {
      return transaction(rows(await this.#database.query(`
        INSERT INTO compute.protected_office_set_transactions (
          id, set_id, node_id, revision, desired_state_revision,
          maintenance_generation, transaction_state, manifest,
          previous_identities, maintenance_authorization, admission,
          steps, recovery_steps, observed_identities, failure_code,
          recovery_failures, created_at, updated_at, completed_at
        ) VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,
                  $10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb,
                  $16,$17,$18)
        RETURNING *`, [
        value.transactionId, value.setId, value.nodeId,
        value.desiredStateRevision, value.maintenanceGeneration,
        value.state, JSON.stringify(value.manifest), JSON.stringify(value.previousIdentities),
        value.maintenanceAuthorization == null ? null : JSON.stringify(value.maintenanceAuthorization),
        JSON.stringify(value.admission), JSON.stringify(value.steps ?? []),
        JSON.stringify(value.recoverySteps ?? []),
        value.observedIdentities == null ? null : JSON.stringify(value.observedIdentities),
        value.failureCode ?? null, JSON.stringify(value.recoveryFailures ?? []),
        value.createdAt, value.updatedAt, value.completedAt ?? null,
      ]))[0]);
    } catch (error) {
      translate(error);
    }
  }

  async getTransaction(transactionId) {
    return transaction(rows(await this.#database.query(
      "SELECT * FROM compute.protected_office_set_transactions WHERE id=$1",
      [transactionId],
    ))[0]);
  }

  async updateTransaction(transactionId, expectedRevision, patch) {
    revision(expectedRevision, "expectedRevision");
    try {
      return await this.#database.transaction(async (database) => {
        const current = await lockTransaction(database, transactionId);
        if (!current) return null;
        if (current.revision !== expectedRevision) {
          conflict("protected_set_transaction_revision_conflict", "Protected-set transaction journal changed");
        }
        const nextPatch = typeof patch === "function" ? await patch(copy(current)) : patch;
        if (!nextPatch || typeof nextPatch !== "object" || Array.isArray(nextPatch)) {
          throw new TypeError("protected-set transaction patch is invalid");
        }
        return updateTransactionRow(database, current, nextPatch);
      });
    } catch (error) {
      translate(error);
    }
  }

  async listIncompleteTransactions({ setId = null } = {}) {
    const result = setId == null
      ? await this.#database.query(`
          SELECT * FROM compute.protected_office_set_transactions
          WHERE transaction_state NOT IN ('succeeded','rolled-back')
          ORDER BY created_at,id`, [])
      : await this.#database.query(`
          SELECT * FROM compute.protected_office_set_transactions
          WHERE set_id=$1 AND transaction_state NOT IN ('succeeded','rolled-back')
          ORDER BY created_at,id`, [setId]);
    return rows(result).map(transaction);
  }

  async getSetState(setId) {
    return setState(rows(await this.#database.query(
      "SELECT * FROM compute.protected_office_sets WHERE set_id=$1",
      [setId],
    ))[0]);
  }

  async putSetState(setId, expectedRevision, value) {
    revision(expectedRevision, "expectedRevision");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("protected-set state is invalid");
    }
    try {
      return await this.#database.transaction(async (database) => {
        const current = await lockSetState(database, setId);
        if ((current?.revision ?? 0) !== expectedRevision) {
          conflict("protected_set_state_revision_conflict", "Protected-set state changed");
        }
        return writeSetStateRow(database, current, setId, value);
      });
    } catch (error) {
      translate(error);
    }
  }

  async commitTransactionAndSetState({
    transactionId,
    expectedTransactionRevision,
    transactionPatch,
    setId,
    expectedSetRevision,
    setState: value,
  }) {
    revision(expectedTransactionRevision, "expectedTransactionRevision");
    revision(expectedSetRevision, "expectedSetRevision");
    try {
      return await this.#database.transaction(async (database) => {
        const currentTransaction = await lockTransaction(database, transactionId);
        const currentSet = await lockSetState(database, setId);
        if (!currentTransaction) return null;
        if (currentTransaction.revision !== expectedTransactionRevision) {
          conflict("protected_set_transaction_revision_conflict", "Protected-set transaction journal changed");
        }
        if ((currentSet?.revision ?? 0) !== expectedSetRevision) {
          conflict("protected_set_state_revision_conflict", "Protected-set state changed");
        }
        if (!transactionPatch || typeof transactionPatch !== "object" || Array.isArray(transactionPatch)
            || !value || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("protected-set atomic commit is invalid");
        }
        const savedTransaction = await updateTransactionRow(database, currentTransaction, transactionPatch);
        const savedSet = await writeSetStateRow(database, currentSet, setId, value);
        return { transaction: savedTransaction, setState: savedSet };
      });
    } catch (error) {
      translate(error);
    }
  }
}
