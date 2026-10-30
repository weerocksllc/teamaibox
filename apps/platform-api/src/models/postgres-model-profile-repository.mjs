function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function digestBytes(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("model profile fingerprint is invalid");
  return Buffer.from(value.slice(7), "hex");
}
function mapped(row) {
  if (!row) return null;
  return {
    profile: json(row.profile_document),
    fingerprint: `sha256:${Buffer.from(row.profile_fingerprint).toString("hex")}`,
  };
}

export class PostgresModelProfileRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL transactional adapter is required");
    this.#database = database;
  }

  async registerImmutable({ profile, fingerprint, registeredBy, operationKey }) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query(`
        SELECT pg_advisory_xact_lock(hashtextextended($1, 0)),
               pg_advisory_xact_lock(hashtextextended($2, 0))`, [profile.profileKey, fingerprint]);
      const previous = mapped(rows(await transaction.query(`
        SELECT profile_document, profile_fingerprint
        FROM compute.model_profile_registrations
        WHERE profile_key = $1 OR profile_fingerprint = $2
        FOR SHARE`, [profile.profileKey, digestBytes(fingerprint)]))[0]);
      if (previous) {
        if (previous.profile.profileKey !== profile.profileKey || previous.fingerprint !== fingerprint) {
          const error = new Error("model profile identity is immutable");
          error.code = "model_profile_conflict";
          throw error;
        }
        return { profile: previous.profile, created: false };
      }
      await transaction.query(`
        INSERT INTO compute.model_profiles (
          id, profile_key, capability_id, source_model, source_revision,
          engine, engine_version, precision, artifact_digest,
          quantization_recipe, compatibility, declared_resources,
          measured_envelope, certification_state, exclusive, created_by,
          created_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
          NULL,'experimental',$13,$14,$15
        )`, [
        profile.profileId, profile.profileKey, profile.capabilityId,
        profile.source.model, profile.source.revision,
        profile.engine.name, profile.engine.version, profile.precision,
        profile.artifactDigest, JSON.stringify(profile.quantizationRecipe ?? {}),
        JSON.stringify(profile.compatibility), JSON.stringify(profile.resourceEnvelope),
        profile.exclusive, registeredBy, profile.createdAt,
      ]);
      const inserted = mapped(rows(await transaction.query(`
        INSERT INTO compute.model_profile_registrations (
          profile_id, profile_key, profile_fingerprint, profile_document,
          registered_by, operation_key, created_at
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
        RETURNING profile_document, profile_fingerprint`, [
        profile.profileId, profile.profileKey, digestBytes(fingerprint),
        JSON.stringify(profile), registeredBy, operationKey, profile.createdAt,
      ]))[0]);
      return { profile: inserted.profile, created: true };
    });
  }

  async getByKey(profileKey) {
    return mapped(rows(await this.#database.query(`
      SELECT profile_document, profile_fingerprint
      FROM compute.model_profile_registrations
      WHERE profile_key = $1`, [profileKey]))[0]);
  }
}
