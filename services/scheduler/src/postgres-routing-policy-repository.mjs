function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid"); return result.rows; }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function mapped(row) {
  if (!row) return null;
  return {
    policyId: row.id, policyKey: row.policy_key, displayName: row.display_name,
    selector: json(row.selector), priority: Number(row.priority),
    routing: {
      mode: row.mode, allowExternal: row.mode !== "internal_only",
      externalProcessingApproved: row.external_processing_approved === true,
      pinnedTargetId: row.pinned_target_id, pinnedProfileId: row.pinned_profile_id,
      targetWeights: json(row.target_weights),
    },
    enabled: row.enabled === true, revision: Number(row.revision), createdBy: row.created_by,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

export class PostgresRoutingPolicyRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required"); this.#database = database; }
  async list() { return rows(await this.#database.query(`SELECT * FROM compute.routing_policies ORDER BY policy_key`)).map(mapped); }
  async findById(id) { return mapped(rows(await this.#database.query(`SELECT * FROM compute.routing_policies WHERE id=$1`, [id]))[0]); }
  async findByKey(key) { return mapped(rows(await this.#database.query(`SELECT * FROM compute.routing_policies WHERE policy_key=$1`, [key]))[0]); }
  async create(value) {
    return this.#database.transaction(async (transaction) => {
      const duplicate = rows(await transaction.query(`SELECT id FROM compute.routing_policies WHERE policy_key=$1 FOR UPDATE`, [value.policyKey]))[0];
      if (duplicate) conflict("routing_policy_key_conflict", "Routing policy key already exists");
      const inserted = rows(await transaction.query(`
        INSERT INTO compute.routing_policies (
          id, policy_key, display_name, selector, priority, mode,
          external_processing_approved, pinned_target_id, pinned_profile_id,
          target_weights, enabled, revision, created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11,1,$12,$13,$13)
        RETURNING *`, [
        value.policyId, value.policyKey, value.displayName, JSON.stringify(value.selector), value.priority,
        value.routing.mode, value.routing.externalProcessingApproved, value.routing.pinnedTargetId,
        value.routing.pinnedProfileId, JSON.stringify(value.routing.targetWeights), value.enabled,
        value.createdBy, value.createdAt,
      ]))[0];
      return mapped(inserted);
    });
  }
  async update(id, revision, value) {
    return this.#database.transaction(async (transaction) => {
      const current = rows(await transaction.query(`SELECT * FROM compute.routing_policies WHERE id=$1 FOR UPDATE`, [id]))[0];
      if (!current) return null;
      if (Number(current.revision) !== revision) conflict("routing_policy_revision_conflict", "Routing policy revision changed");
      const duplicate = rows(await transaction.query(`SELECT id FROM compute.routing_policies WHERE policy_key=$1 AND id<>$2 FOR UPDATE`, [value.policyKey, id]))[0];
      if (duplicate) conflict("routing_policy_key_conflict", "Routing policy key already exists");
      const updated = rows(await transaction.query(`
        UPDATE compute.routing_policies
        SET policy_key=$2, display_name=$3, selector=$4::jsonb, priority=$5,
            mode=$6, external_processing_approved=$7, pinned_target_id=$8,
            pinned_profile_id=$9, target_weights=$10::jsonb, enabled=$11,
            revision=revision+1, updated_at=$12
        WHERE id=$1 RETURNING *`, [
        id, value.policyKey, value.displayName, JSON.stringify(value.selector), value.priority,
        value.routing.mode, value.routing.externalProcessingApproved, value.routing.pinnedTargetId,
        value.routing.pinnedProfileId, JSON.stringify(value.routing.targetWeights), value.enabled,
        value.updatedAt,
      ]))[0];
      return mapped(updated);
    });
  }
}
