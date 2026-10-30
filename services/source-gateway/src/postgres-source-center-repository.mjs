function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL source result is invalid");
  return result.rows;
}

function json(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function date(value) { return value == null ? null : new Date(value); }

function source(row) {
  if (!row) return null;
  const declaration = json(row.declaration);
  return {
    ...declaration,
    sourceId: row.id,
    health: json(row.health),
    revision: Number(row.revision),
    createdBy: row.created_by,
    createdAt: date(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: date(row.updated_at),
  };
}

function policy(row) {
  if (!row) return null;
  const declaration = json(row.declaration);
  return {
    ...declaration,
    policyId: row.id,
    revision: Number(row.revision),
    createdBy: row.created_by,
    createdAt: date(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: date(row.updated_at),
  };
}

function declaration(value, omitted) {
  const result = structuredClone(value);
  for (const key of omitted) delete result[key];
  return result;
}

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function translate(error, kind) {
  if (error?.code === "23505") conflict(kind === "source" ? "source_key_conflict" : "source_policy_key_conflict", `${kind} key already exists`);
  throw error;
}

export class PostgresSourceCenterRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL Source Center repository requires transactions");
    this.#database = database;
  }

  async listSources({ ecosystem = null } = {}) {
    return rows(await this.#database.query(`SELECT * FROM source_center.sources
      WHERE ($1::text IS NULL OR ecosystem=$1)
      ORDER BY ecosystem,priority,source_key`, [ecosystem])).map(source);
  }

  async findSource(sourceId) { return source(rows(await this.#database.query("SELECT * FROM source_center.sources WHERE id=$1", [sourceId]))[0]); }
  async findSourceByKey(sourceKey) { return source(rows(await this.#database.query("SELECT * FROM source_center.sources WHERE source_key=$1", [sourceKey]))[0]); }

  async createSource(value) {
    try {
      return source(rows(await this.#database.query(`INSERT INTO source_center.sources (
        id,source_key,ecosystem,source_kind,priority,declaration,health,revision,created_by,created_at,updated_by,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,1,$8,$9,$8,$9) RETURNING *`, [
        value.sourceId, value.sourceKey, value.ecosystem, value.kind, value.priority,
        JSON.stringify(declaration(value, ["sourceId", "health", "revision", "createdBy", "createdAt", "updatedBy", "updatedAt"])),
        JSON.stringify(value.health), value.createdBy, value.createdAt,
      ]))[0]);
    } catch (error) { translate(error, "source"); }
  }

  async updateSource(sourceId, expectedRevision, patch) {
    try {
      const result = source(rows(await this.#database.query(`UPDATE source_center.sources SET
        source_key=$3,ecosystem=$4,source_kind=$5,priority=$6,declaration=$7::jsonb,health=$8::jsonb,
        revision=revision+1,updated_by=$9,updated_at=$10
        WHERE id=$1 AND revision=$2 RETURNING *`, [sourceId, expectedRevision, patch.sourceKey, patch.ecosystem,
        patch.kind, patch.priority, JSON.stringify(declaration(patch, ["sourceId", "health", "revision", "createdBy", "createdAt", "updatedBy", "updatedAt"])),
        JSON.stringify(patch.health), patch.updatedBy, patch.updatedAt]))[0]);
      if (!result && await this.findSource(sourceId)) conflict("source_revision_conflict", "source revision changed");
      return result;
    } catch (error) { if (error?.code?.startsWith?.("source_")) throw error; translate(error, "source"); }
  }

  async recordHealth(sourceId, expectedRevision, health, updatedAt) {
    return this.#database.transaction(async (transaction) => {
      const updated = source(rows(await transaction.query(`UPDATE source_center.sources SET
        health=$3::jsonb,revision=revision+1,updated_at=$4 WHERE id=$1 AND revision=$2 RETURNING *`,
      [sourceId, expectedRevision, JSON.stringify(health), updatedAt]))[0]);
      if (!updated) {
        const exists = rows(await transaction.query("SELECT id FROM source_center.sources WHERE id=$1", [sourceId]))[0];
        if (exists) conflict("source_revision_conflict", "source revision changed");
        return null;
      }
      await transaction.query(`INSERT INTO source_center.health_events
        (source_id,source_revision,state,latency_milliseconds,error_code,observed_at,recorded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [sourceId, updated.revision, health.state, health.latencyMilliseconds, health.errorCode, health.observedAt, updatedAt]);
      return updated;
    });
  }

  async listPolicies({ ecosystem = null } = {}) {
    return rows(await this.#database.query(`SELECT * FROM source_center.policies
      WHERE ($1::text IS NULL OR ecosystem=$1) ORDER BY ecosystem,policy_key`, [ecosystem])).map(policy);
  }

  async findPolicy(policyId) { return policy(rows(await this.#database.query("SELECT * FROM source_center.policies WHERE id=$1", [policyId]))[0]); }
  async findPolicyByKey(policyKey) { return policy(rows(await this.#database.query("SELECT * FROM source_center.policies WHERE policy_key=$1", [policyKey]))[0]); }

  async createPolicy(value) {
    try {
      return policy(rows(await this.#database.query(`INSERT INTO source_center.policies (
        id,policy_key,ecosystem,environment,declaration,revision,created_by,created_at,updated_by,updated_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,1,$6,$7,$6,$7) RETURNING *`, [value.policyId, value.policyKey,
        value.ecosystem, value.environment, JSON.stringify(declaration(value, ["policyId", "revision", "createdBy", "createdAt", "updatedBy", "updatedAt"])), value.createdBy, value.createdAt]))[0]);
    } catch (error) { translate(error, "policy"); }
  }

  async updatePolicy(policyId, expectedRevision, patch) {
    try {
      const result = policy(rows(await this.#database.query(`UPDATE source_center.policies SET
        policy_key=$3,ecosystem=$4,environment=$5,declaration=$6::jsonb,revision=revision+1,updated_by=$7,updated_at=$8
        WHERE id=$1 AND revision=$2 RETURNING *`, [policyId, expectedRevision, patch.policyKey, patch.ecosystem,
        patch.environment, JSON.stringify(declaration(patch, ["policyId", "revision", "createdBy", "createdAt", "updatedBy", "updatedAt"])), patch.updatedBy, patch.updatedAt]))[0]);
      if (!result && await this.findPolicy(policyId)) conflict("source_policy_revision_conflict", "source policy revision changed");
      return result;
    } catch (error) { if (error?.code?.startsWith?.("source_")) throw error; translate(error, "policy"); }
  }
}
