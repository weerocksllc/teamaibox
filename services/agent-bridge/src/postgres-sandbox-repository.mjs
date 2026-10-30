import { Buffer } from "node:buffer";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}

function sandbox(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerIdentityId: row.owner_identity_id,
    workerId: row.worker_id,
    sandboxKey: row.sandbox_key,
    workspaceKey: row.workspace_key,
    workspaceVolume: row.workspace_volume,
    workspaceQuotaBytes: Number(row.workspace_quota_bytes),
    image: row.image_reference,
    runtimeFingerprint: `sha256:${Buffer.from(row.runtime_fingerprint).toString("hex")}`,
    state: row.state,
    generation: Number(row.generation),
    activeOperations: Number(row.active_operations),
    nodeId: row.node_id,
    containerId: row.container_id,
    lastErrorCode: row.last_error_code,
    lastActivityAt: date(row.last_activity_at),
    idleDeadlineAt: date(row.idle_deadline_at),
    revision: Number(row.revision),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function operation(row) {
  if (!row) return null;
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    state: row.state,
    createdAt: date(row.created_at),
    releasedAt: date(row.released_at),
  };
}

async function selectSandbox(executor, clause, values, lock = false) {
  const result = await executor.query(`SELECT * FROM platform.agent_sandboxes WHERE ${clause}${lock ? " FOR UPDATE" : ""}`, values);
  return sandbox(rows(result)[0]);
}

async function writeSandbox(executor, value, expectedRevision) {
  const result = await executor.query(`
    UPDATE platform.agent_sandboxes
    SET workspace_quota_bytes = $3,
        image_reference = $4,
        runtime_fingerprint = $5,
        state = $6,
        generation = $7,
        active_operations = $8,
        node_id = $9,
        container_id = $10,
        last_error_code = $11,
        last_activity_at = $12,
        idle_deadline_at = $13,
        revision = $14,
        updated_at = $15
    WHERE id = $1 AND revision = $2
    RETURNING *`, [
    value.id,
    expectedRevision,
    value.workspaceQuotaBytes,
    value.image,
    Buffer.from(value.runtimeFingerprint.slice(7), "hex"),
    value.state,
    value.generation,
    value.activeOperations,
    value.nodeId,
    value.containerId,
    value.lastErrorCode,
    value.lastActivityAt,
    value.idleDeadlineAt,
    value.revision,
    value.updatedAt,
  ]);
  return sandbox(rows(result)[0]);
}

export class PostgresAgentSandboxRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL sandbox database with transactions is required");
    this.#database = database;
  }

  async ensureSandbox(value) {
    return this.#database.transaction(async (transaction) => {
      const inserted = rows(await transaction.query(`
        INSERT INTO platform.agent_sandboxes (
          id, owner_identity_id, worker_id, sandbox_key, workspace_key,
          workspace_volume, workspace_quota_bytes, image_reference,
          runtime_fingerprint, state, generation, active_operations, node_id,
          container_id, last_error_code, last_activity_at, idle_deadline_at,
          revision, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
        ) ON CONFLICT (owner_identity_id) DO NOTHING RETURNING id`, [
        value.id,
        value.ownerIdentityId,
        value.workerId,
        value.sandboxKey,
        value.workspaceKey,
        value.workspaceVolume,
        value.workspaceQuotaBytes,
        value.image,
        Buffer.from(value.runtimeFingerprint.slice(7), "hex"),
        value.state,
        value.generation,
        value.activeOperations,
        value.nodeId,
        value.containerId,
        value.lastErrorCode,
        value.lastActivityAt,
        value.idleDeadlineAt,
        value.revision,
        value.createdAt,
        value.updatedAt,
      ])).length > 0;
      const current = await selectSandbox(transaction, "owner_identity_id = $1", [value.ownerIdentityId], true);
      return { inserted, sandbox: current };
    });
  }

  async findByOwner(ownerIdentityId) {
    return selectSandbox(this.#database, "owner_identity_id = $1", [ownerIdentityId]);
  }

  async findSandbox(sandboxId) {
    return selectSandbox(this.#database, "id = $1", [sandboxId]);
  }

  async updateSandbox(value, expectedRevision) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectSandbox(transaction, "id = $1", [value.id], true);
      if (!current) return null;
      if (current.revision !== expectedRevision) {
        throw new PlatformError("agent_sandbox_revision_conflict", "Agent sandbox changed concurrently", { status: 409, retryable: true });
      }
      const updated = await writeSandbox(transaction, value, expectedRevision);
      if (!updated) throw new PlatformError("agent_sandbox_revision_conflict", "Agent sandbox changed concurrently", { status: 409, retryable: true });
      return updated;
    });
  }

  async acquireOperation({ operationId, sandboxId, now }) {
    return this.#database.transaction(async (transaction) => {
      const existing = operation(rows(await transaction.query(
        "SELECT * FROM platform.agent_sandbox_operations WHERE id = $1 FOR UPDATE",
        [operationId],
      ))[0]);
      if (existing) return { inserted: false, operation: existing, sandbox: await selectSandbox(transaction, "id = $1", [existing.sandboxId], true) };
      const current = await selectSandbox(transaction, "id = $1", [sandboxId], true);
      if (!current) return null;
      if (current.state !== "running") throw new PlatformError("agent_sandbox_unavailable", "Agent sandbox is not running", { status: 409, retryable: true });
      const created = operation(rows(await transaction.query(`
        INSERT INTO platform.agent_sandbox_operations (id, sandbox_id, state, created_at)
        VALUES ($1,$2,'active',$3) RETURNING *`, [operationId, sandboxId, now]))[0]);
      const updated = await writeSandbox(transaction, {
        ...current,
        activeOperations: current.activeOperations + 1,
        lastActivityAt: now,
        idleDeadlineAt: null,
        revision: current.revision + 1,
        updatedAt: now,
      }, current.revision);
      return { inserted: true, operation: created, sandbox: updated };
    });
  }

  async releaseOperation({ operationId, now, idleDeadlineAt }) {
    return this.#database.transaction(async (transaction) => {
      const currentOperation = operation(rows(await transaction.query(
        "SELECT * FROM platform.agent_sandbox_operations WHERE id = $1 FOR UPDATE",
        [operationId],
      ))[0]);
      if (!currentOperation) return null;
      const current = await selectSandbox(transaction, "id = $1", [currentOperation.sandboxId], true);
      if (currentOperation.state === "released") return { released: false, operation: currentOperation, sandbox: current };
      if (!current || current.activeOperations < 1) throw new PlatformError("agent_sandbox_operation_invariant", "Agent sandbox operation count is inconsistent", { status: 500 });
      const released = operation(rows(await transaction.query(`
        UPDATE platform.agent_sandbox_operations
        SET state = 'released', released_at = $2 WHERE id = $1 RETURNING *`, [operationId, now]))[0]);
      const remaining = current.activeOperations - 1;
      const updated = await writeSandbox(transaction, {
        ...current,
        activeOperations: remaining,
        lastActivityAt: now,
        idleDeadlineAt: remaining === 0 ? idleDeadlineAt : null,
        revision: current.revision + 1,
        updatedAt: now,
      }, current.revision);
      return { released: true, operation: released, sandbox: updated };
    });
  }

  async claimIdle({ now, limit }) {
    return this.#database.transaction(async (transaction) => {
      const candidates = rows(await transaction.query(`
        SELECT * FROM platform.agent_sandboxes
        WHERE state = 'running' AND active_operations = 0
          AND idle_deadline_at IS NOT NULL AND idle_deadline_at <= $1
        ORDER BY idle_deadline_at, id
        LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit])).map(sandbox);
      const claimed = [];
      for (const current of candidates) {
        const updated = await writeSandbox(transaction, {
          ...current,
          state: "stopping",
          revision: current.revision + 1,
          updatedAt: now,
        }, current.revision);
        if (updated) claimed.push(updated);
      }
      return claimed;
    });
  }
}
