function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value ?? []); }
function profile(row) {
  if (!row) return null;
  return {
    profileId: row.profile_id, profileKey: row.profile_key,
    fingerprint: `sha256:${Buffer.from(row.profile_fingerprint).toString("hex")}`,
    state: row.certification_state, revision: Number(row.lifecycle_revision),
    reasonKey: row.lifecycle_reason_key, evidenceRefs: json(row.lifecycle_evidence_refs),
    validationRunId: row.lifecycle_validation_run_id, updatedAt: new Date(row.lifecycle_updated_at),
  };
}
function optIn(row) {
  if (!row) return null;
  return {
    policyKey: row.policy_key, environment: row.environment,
    profileId: row.model_profile_id, enabled: row.enabled,
    reasonKey: row.reason_key, revision: Number(row.revision),
    expiresAt: new Date(row.expires_at), updatedAt: new Date(row.updated_at),
  };
}

const PROFILE_SELECT = `
  SELECT profile.id AS profile_id, profile.profile_key,
         registration.profile_fingerprint, profile.certification_state,
         profile.lifecycle_revision, profile.lifecycle_reason_key,
         profile.lifecycle_evidence_refs, profile.lifecycle_validation_run_id,
         profile.lifecycle_updated_at
  FROM compute.model_profiles profile
  JOIN compute.capabilities capability ON capability.id = profile.capability_id
    AND capability.lifecycle_state <> 'retired'
  JOIN compute.model_profile_registrations registration ON registration.profile_id = profile.id`;

export class PostgresModelLifecycleRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL transactional adapter is required");
    this.#database = database;
  }

  async findProfile(profileId) {
    return profile(rows(await this.#database.query(`${PROFILE_SELECT} WHERE profile.id = $1`, [profileId]))[0]);
  }

  async listProfiles({ limit, afterProfileKey = null }) {
    return rows(await this.#database.query(`
      ${PROFILE_SELECT}
      WHERE ($1::text IS NULL OR profile.profile_key > $1)
      ORDER BY profile.profile_key
      LIMIT $2`, [afterProfileKey, limit])).map(profile);
  }

  async transitionLifecycle({ profileId, expectedRevision, expectedState, nextState, reasonKey, evidenceRefs, validationRunId, actorIdentityId, occurredAt }) {
    return this.#database.transaction(async (transaction) => {
      const current = rows(await transaction.query(`
        SELECT profile.certification_state, profile.lifecycle_revision
        FROM compute.model_profiles profile
        JOIN compute.capabilities capability ON capability.id = profile.capability_id
        WHERE profile.id = $1 AND capability.lifecycle_state <> 'retired'
        FOR UPDATE OF profile`, [profileId]))[0];
      if (!current) return null;
      if (current.certification_state !== expectedState || Number(current.lifecycle_revision) !== expectedRevision) {
        const error = new Error("profile lifecycle revision changed");
        error.code = "model_lifecycle_revision_conflict";
        throw error;
      }
      const updated = profile(rows(await transaction.query(`
        WITH changed AS (
          UPDATE compute.model_profiles
          SET certification_state = $2, lifecycle_revision = lifecycle_revision + 1,
              lifecycle_reason_key = $3, lifecycle_evidence_refs = $4::jsonb,
              lifecycle_validation_run_id = $5, lifecycle_updated_at = $6
          WHERE id = $1
          RETURNING *
        )
        SELECT changed.id AS profile_id, changed.profile_key,
               registration.profile_fingerprint, changed.certification_state,
               changed.lifecycle_revision, changed.lifecycle_reason_key,
               changed.lifecycle_evidence_refs, changed.lifecycle_validation_run_id,
               changed.lifecycle_updated_at
        FROM changed
        JOIN compute.model_profile_registrations registration ON registration.profile_id = changed.id`, [
        profileId, nextState, reasonKey, JSON.stringify(evidenceRefs), validationRunId, occurredAt,
      ]))[0]);
      await transaction.query(`
        INSERT INTO compute.model_profile_lifecycle_events (
          model_profile_id, profile_revision, from_state, to_state, reason_key,
          evidence_refs, validation_run_id, actor_identity_id, occurred_at
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [
        profileId, updated.revision, expectedState, nextState, reasonKey,
        JSON.stringify(evidenceRefs), validationRunId, actorIdentityId, occurredAt,
      ]);
      return updated;
    });
  }

  async upsertExperimentalOptIn({ policyKey, environment, profileId, enabled, reasonKey, expiresAt, actorIdentityId, occurredAt }) {
    return optIn(rows(await this.#database.query(`
      INSERT INTO compute.model_experimental_routing_opt_ins (
        policy_key, environment, model_profile_id, enabled, reason_key,
        expires_at, set_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      ON CONFLICT (policy_key, environment, model_profile_id) DO UPDATE
      SET enabled = EXCLUDED.enabled, reason_key = EXCLUDED.reason_key,
          expires_at = EXCLUDED.expires_at, set_by = EXCLUDED.set_by,
          revision = compute.model_experimental_routing_opt_ins.revision + 1,
          updated_at = EXCLUDED.updated_at
      RETURNING *`, [
      policyKey, environment, profileId, enabled, reasonKey,
      expiresAt, actorIdentityId, occurredAt,
    ]))[0]);
  }

  async listExperimentalOptIns({ policyKey, environment, now }) {
    return rows(await this.#database.query(`
      SELECT * FROM compute.model_experimental_routing_opt_ins
      WHERE policy_key = $1 AND environment = $2 AND enabled AND expires_at > $3
      ORDER BY model_profile_id`, [policyKey, environment, now])).map(optIn);
  }
}
