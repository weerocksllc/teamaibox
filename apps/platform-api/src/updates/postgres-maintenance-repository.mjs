const DIGEST = /^sha256:([a-f0-9]{64})$/;
function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL maintenance result is invalid"); return result.rows; }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function encoded(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function decoded(value) { const match = DIGEST.exec(value ?? ""); if (!match) throw new TypeError("maintenance evidence digest is invalid"); return Buffer.from(match[1], "hex"); }
function nodeEvidence(row) { return { nodeId: row.node_id, drainDigest: encoded(row.drain_digest), applyDigest: encoded(row.apply_digest), postCheckDigest: encoded(row.post_check_digest) }; }
function mapped(row, evidenceRows = []) {
  if (!row) return null;
  const evidence = evidenceRows.filter((item) => item.evidence_state === "completed").sort((a, b) => Number(a.node_position) - Number(b.node_position));
  return { planId: row.id, operationKey: row.operation_key, kind: row.maintenance_kind, candidate: json(row.candidate), targetNodes: json(row.target_nodes), strategy: row.strategy,
    state: row.plan_state, blockers: json(row.blockers), warnings: json(row.warnings), preflight: json(row.preflight_evidence),
    compatibility: json(row.compatibility_evidence), revalidationDecision: row.revalidation_decision, recoveryInstructions: json(row.recovery_instructions), rollbackInstructions: json(row.rollback_instructions),
    currentNodeId: row.current_node_id, completedNodeIds: evidence.map((item) => item.node_id), nodeEvidence: evidence.map(nodeEvidence), postCheck: row.post_check == null ? null : json(row.post_check),
    failureCode: row.failure_code, revision: Number(row.revision), requestedBy: row.requested_by, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at };
}

export class PostgresMaintenanceRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL maintenance storage requires query and transaction"); this.#database = database; }
  async #evidence(planId, database = this.#database) { return rows(await database.query("SELECT * FROM platform.maintenance_node_evidence WHERE plan_id=$1 ORDER BY node_position", [planId])); }
  async #map(row, database = this.#database) { return row ? mapped(row, await this.#evidence(row.id, database)) : null; }
  async findByOperationKey(operationKey) { return this.#map(rows(await this.#database.query("SELECT * FROM platform.maintenance_plans WHERE operation_key=$1", [operationKey]))[0]); }
  async create(value) {
    const row = rows(await this.#database.query(`INSERT INTO platform.maintenance_plans
      (id,operation_key,maintenance_kind,candidate,target_nodes,strategy,plan_state,blockers,warnings,backup_evidence,preflight_evidence,compatibility_evidence,
       revalidation_decision,recovery_instructions,rollback_instructions,requested_by,created_at,updated_at)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15::jsonb,$16,$17,$17)
      ON CONFLICT (operation_key) DO NOTHING RETURNING *`, [value.planId, value.operationKey, value.kind, JSON.stringify(value.candidate), JSON.stringify(value.targetNodes), value.strategy,
      value.state, JSON.stringify(value.blockers), JSON.stringify(value.warnings), JSON.stringify({}), JSON.stringify(value.preflight), JSON.stringify(value.compatibility),
      value.revalidationDecision, JSON.stringify(value.recoveryInstructions), JSON.stringify(value.rollbackInstructions), value.requestedBy, value.createdAt]))[0];
    return row ? mapped(row) : this.findByOperationKey(value.operationKey);
  }
  async get(planId) { return this.#map(rows(await this.#database.query("SELECT * FROM platform.maintenance_plans WHERE id=$1", [planId]))[0]); }
  async list({ limit = 100 } = {}) { const values = rows(await this.#database.query("SELECT * FROM platform.maintenance_plans ORDER BY created_at DESC,id DESC LIMIT $1", [limit])); return Promise.all(values.map((row) => this.#map(row))); }
  async beginExecution(planId, { expectedRevision, updatedAt }) {
    return this.#map(rows(await this.#database.query(`UPDATE platform.maintenance_plans SET plan_state='executing',revision=revision+1,updated_at=$3
      WHERE id=$1 AND plan_state='ready' AND revision=$2 RETURNING *`, [planId, expectedRevision, updatedAt]))[0]);
  }
  async beginNode(planId, { expectedRevision, nodeId, updatedAt }) {
    return this.#database.transaction(async (database) => {
      const plan = rows(await database.query("SELECT * FROM platform.maintenance_plans WHERE id=$1 FOR UPDATE", [planId]))[0];
      if (!plan || plan.plan_state !== "executing" || Number(plan.revision) !== expectedRevision || plan.current_node_id !== null) return null;
      const targets = json(plan.target_nodes), position = targets.findIndex((item) => item.nodeId === nodeId); if (position < 0) return null;
      const inserted = rows(await database.query(`INSERT INTO platform.maintenance_node_evidence (plan_id,node_id,node_position,evidence_state,started_at)
        VALUES ($1,$2,$3,'executing',$4) ON CONFLICT (plan_id,node_id) DO NOTHING RETURNING plan_id`, [planId, nodeId, position, updatedAt]))[0]; if (!inserted) return null;
      const row = rows(await database.query("UPDATE platform.maintenance_plans SET current_node_id=$2,revision=revision+1,updated_at=$3 WHERE id=$1 RETURNING *", [planId, nodeId, updatedAt]))[0];
      return this.#map(row, database);
    });
  }
  async completeNode(planId, { expectedRevision, nodeId, evidence, updatedAt }) {
    return this.#database.transaction(async (database) => {
      const plan = rows(await database.query("SELECT * FROM platform.maintenance_plans WHERE id=$1 FOR UPDATE", [planId]))[0];
      if (!plan || plan.plan_state !== "executing" || Number(plan.revision) !== expectedRevision || plan.current_node_id !== nodeId) return null;
      const completed = rows(await database.query(`UPDATE platform.maintenance_node_evidence SET evidence_state='completed',drain_digest=$3,apply_digest=$4,post_check_digest=$5,completed_at=$6
        WHERE plan_id=$1 AND node_id=$2 AND evidence_state='executing' RETURNING plan_id`, [planId, nodeId, decoded(evidence.drainDigest), decoded(evidence.applyDigest), decoded(evidence.postCheckDigest), updatedAt]))[0]; if (!completed) return null;
      const row = rows(await database.query("UPDATE platform.maintenance_plans SET current_node_id=NULL,revision=revision+1,updated_at=$2 WHERE id=$1 RETURNING *", [planId, updatedAt]))[0];
      return this.#map(row, database);
    });
  }
  async complete(planId, { expectedRevision, postCheck, completedAt }) {
    const row = rows(await this.#database.query(`UPDATE platform.maintenance_plans SET plan_state='completed',post_check=$3::jsonb,revision=revision+1,updated_at=$4,completed_at=$4
      WHERE id=$1 AND plan_state='executing' AND revision=$2 AND current_node_id IS NULL
      AND (SELECT count(*) FROM platform.maintenance_node_evidence WHERE plan_id=$1 AND evidence_state='completed')=jsonb_array_length(target_nodes) RETURNING *`,
    [planId, expectedRevision, JSON.stringify(postCheck), completedAt]))[0]; return this.#map(row);
  }
  async finishFailure(planId, { rollbackPassed, failureCode, postCheck, completedAt }) {
    return this.#database.transaction(async (database) => {
      await database.query(`UPDATE platform.maintenance_node_evidence SET evidence_state='failed',failure_code=$2,completed_at=$3
        WHERE plan_id=$1 AND evidence_state='executing'`, [planId, failureCode, completedAt]);
      const row = rows(await database.query(`UPDATE platform.maintenance_plans SET plan_state=$2,current_node_id=NULL,post_check=$3::jsonb,failure_code=$4,
        revision=revision+1,updated_at=$5,completed_at=$5 WHERE id=$1 AND plan_state IN ('executing','ready') RETURNING *`,
      [planId, rollbackPassed ? "rolled_back" : "manual_recovery_required", postCheck == null ? null : JSON.stringify(postCheck), failureCode, completedAt]))[0]; return this.#map(row, database);
    });
  }
}
