import { MemoryTaskCenterRepository } from "./memory-repository.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL task-center query result is invalid");
  return result.rows;
}

function value(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerIdentityId: row.owner_identity_id,
    agentSessionKey: row.agent_session_key,
    operationKind: row.operation_kind,
    titleKey: row.title_key,
    scope: typeof row.operation_scope === "string" ? JSON.parse(row.operation_scope) : structuredClone(row.operation_scope),
    status: row.status,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    decidedBy: row.decided_by_identity_id,
  };
}

export class PostgresAgentTaskCenterRepository {
  #database;
  #tasks;

  constructor({ database, taskRepository = new MemoryTaskCenterRepository() }) {
    if (!database?.query || !taskRepository) throw new TypeError("PostgreSQL Agent task-center dependencies are incomplete");
    this.#database = database;
    this.#tasks = taskRepository;
  }

  insertTask(input) { return this.#tasks.insertTask(input); }
  findTask(id) { return this.#tasks.findTask(id); }
  updateTask(input) { return this.#tasks.updateTask(input); }
  listTasksByOwner(ownerIdentityId) { return this.#tasks.listTasksByOwner(ownerIdentityId); }
  appendTaskEvent(taskId, event) { return this.#tasks.appendTaskEvent(taskId, event); }
  listTaskEvents(taskId, afterSequence) { return this.#tasks.listTaskEvents(taskId, afterSequence); }

  async insertAgentConfirmation(input) {
    const result = await this.#database.query(`
      INSERT INTO platform.agent_operation_confirmations (
        id, owner_identity_id, agent_session_key, operation_kind, title_key,
        operation_scope, status, created_at, expires_at, bridge_schema_version
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$8,0)
      RETURNING *`, [
      input.id, input.ownerIdentityId, input.agentSessionKey, input.operationKind,
      input.titleKey, JSON.stringify(input.scope), input.createdAt, input.expiresAt,
    ]);
    return value(rows(result)[0]);
  }

  async findAgentConfirmation(confirmationId) {
    return value(rows(await this.#database.query(`
      SELECT * FROM platform.agent_operation_confirmations
      WHERE id = $1 AND bridge_schema_version = 0`, [confirmationId]))[0]);
  }

  async updateAgentConfirmation(input) {
    const result = await this.#database.query(`
      UPDATE platform.agent_operation_confirmations
      SET status = $2, decided_at = $3, decided_by_identity_id = $4,
          updated_at = $5
      WHERE id = $1 AND bridge_schema_version = 0
      RETURNING *`, [
      input.id, input.status, input.decidedAt, input.decidedBy, new Date(),
    ]);
    return value(rows(result)[0]);
  }

  async listAgentConfirmationsByOwner(ownerIdentityId) {
    const result = await this.#database.query(`
      SELECT * FROM platform.agent_operation_confirmations
      WHERE owner_identity_id = $1 AND bridge_schema_version = 0
      ORDER BY created_at DESC, id DESC`, [ownerIdentityId]);
    return rows(result).map(value);
  }

  async expireAgentConfirmations(now) {
    await this.#database.query(`
      UPDATE platform.agent_operation_confirmations
      SET status = 'expired', decided_at = $1, decided_by_identity_id = NULL,
          updated_at = $1
      WHERE bridge_schema_version = 0 AND status = 'pending' AND expires_at <= $1`, [now]);
  }
}
