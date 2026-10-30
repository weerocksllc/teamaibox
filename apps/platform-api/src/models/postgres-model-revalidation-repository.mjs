function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid"); return result.rows; }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function digestBuffer(value) { return Buffer.from(value.slice(7), "hex"); }
function baseline(row) {
  if (!row) return null;
  return {
    id: row.id, profileId: row.model_profile_id, lifecycleRevision: Number(row.lifecycle_revision),
    validationRunId: row.validation_run_id, facts: json(row.facts),
    factsDigest: `sha256:${Buffer.from(row.facts_digest).toString("hex")}`,
    evidenceRefs: json(row.evidence_refs), recordedAt: new Date(row.recorded_at),
  };
}

export class PostgresModelRevalidationRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL transactional adapter is required");
    this.#database = database;
  }

  async putBaseline(record) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [record.profileId]);
      const previous = baseline(rows(await transaction.query(`
        SELECT * FROM compute.model_profile_certification_baselines
        WHERE model_profile_id = $1 AND (lifecycle_revision = $2 OR facts_digest = $3)
        FOR SHARE`, [record.profileId, record.lifecycleRevision, digestBuffer(record.factsDigest)]))[0]);
      if (previous) {
        if (previous.lifecycleRevision !== record.lifecycleRevision || previous.factsDigest !== record.factsDigest
          || previous.validationRunId !== record.validationRunId) {
          const error = new Error("certification baseline immutable facts changed");
          error.code = "model_revalidation_baseline_conflict";
          throw error;
        }
        return { baseline: previous, created: false };
      }
      const inserted = baseline(rows(await transaction.query(`
        INSERT INTO compute.model_profile_certification_baselines (
          model_profile_id, lifecycle_revision, validation_run_id, facts,
          facts_digest, evidence_refs, recorded_by, recorded_at
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)
        RETURNING *`, [
        record.profileId, record.lifecycleRevision, record.validationRunId,
        JSON.stringify(record.facts), digestBuffer(record.factsDigest),
        JSON.stringify(record.evidenceRefs), record.actorIdentityId, record.recordedAt,
      ]))[0]);
      return { baseline: inserted, created: true };
    });
  }

  async getLatestBaseline(profileId) {
    return baseline(rows(await this.#database.query(`
      SELECT * FROM compute.model_profile_certification_baselines
      WHERE model_profile_id = $1 ORDER BY lifecycle_revision DESC LIMIT 1`, [profileId]))[0]);
  }

  async recordCheck(record) {
    const row = rows(await this.#database.query(`
      INSERT INTO compute.model_profile_revalidation_checks (
        model_profile_id, baseline_id, observed_facts, observed_facts_digest,
        changed_dimensions, outcome, evidence_refs, worker_id, checked_at
      ) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7::jsonb,$8,$9)
      RETURNING id, observed_facts_digest, checked_at`, [
      record.profileId, record.baselineId, JSON.stringify(record.observedFacts),
      digestBuffer(record.observedFactsDigest), JSON.stringify(record.changedDimensions),
      record.outcome, JSON.stringify(record.evidenceRefs), record.workerId, record.checkedAt,
    ]))[0];
    return {
      id: row.id, observedFactsDigest: `sha256:${Buffer.from(row.observed_facts_digest).toString("hex")}`,
      checkedAt: new Date(row.checked_at),
    };
  }
}
