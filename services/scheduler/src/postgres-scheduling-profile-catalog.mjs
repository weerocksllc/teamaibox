function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL scheduling profile result is invalid");
  return result.rows;
}

function json(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

export class PostgresSchedulingProfileCatalog {
  #database;
  constructor({ database }) {
    if (typeof database?.query !== "function") throw new TypeError("PostgreSQL scheduling profile catalog requires a query adapter");
    this.#database = database;
  }

  async findByIds(profileIds) {
    if (!Array.isArray(profileIds) || profileIds.length > 1024
        || profileIds.some((value) => typeof value !== "string")) {
      throw new TypeError("profileIds must be a bounded string array");
    }
    if (profileIds.length === 0) return [];
    return rows(await this.#database.query(`
      SELECT registration.profile_document, registration.profile_fingerprint,
             profile.certification_state, profile.lifecycle_evidence_refs,
             profile.placement_class,
             profile.desired_state_revision, profile.observed_state_revision,
             profile.maintenance_generation, profile.recovery_state,
             profile.recovery_reason_code
      FROM compute.model_profile_registrations registration
      JOIN compute.model_profiles profile ON profile.id = registration.profile_id
      WHERE registration.profile_id = ANY($1::uuid[])
      ORDER BY registration.profile_key`, [profileIds])).map((row) => {
      const profile = json(row.profile_document);
      profile.certification = {
        state: row.certification_state,
        evidenceRefs: json(row.lifecycle_evidence_refs ?? []),
      };
      profile.placement = {
        placementClass: row.placement_class ?? "warm-optional",
        desiredStateRevision: Number(row.desired_state_revision ?? 1),
        observedStateRevision: Number(row.observed_state_revision ?? 0),
        maintenanceGeneration: Number(row.maintenance_generation ?? 1),
        recoveryState: row.recovery_state ?? "healthy",
        recoveryReasonCode: row.recovery_reason_code ?? null,
      };
      return Object.freeze({
        profile: Object.freeze(profile),
        fingerprint: `sha256:${Buffer.from(row.profile_fingerprint).toString("hex")}`,
      });
    });
  }
}
