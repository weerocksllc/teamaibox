function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function json(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function iso(value) {
  return value?.toISOString?.() ?? value ?? null;
}

function pluginType(value) {
  if (value === "application") return "ApplicationPlugin";
  if (value === "compute") return "ComputePlugin";
  throw new TypeError("PostgreSQL plugin type is invalid");
}

function delegation(row) {
  if (!row) return null;
  return {
    delegationId: row.id,
    pluginId: row.plugin_key,
    pluginVersion: row.plugin_version,
    pluginGeneration: Number(row.plugin_generation),
    audience: row.audience,
    identityId: row.identity_id,
    sessionId: row.session_id,
    tokenHash: Buffer.from(row.token_hash).toString("hex"),
    grants: json(row.grants),
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    revokeReason: row.revoke_reason,
  };
}

function registration(row) {
  if (!row) return null;
  return {
    registrationId: row.id,
    pluginId: row.plugin_key,
    pluginVersion: row.plugin_version,
    pluginGeneration: Number(row.plugin_generation),
    workerId: row.worker_instance_id,
    workerGeneration: Number(row.worker_generation),
    nodeId: row.node_id,
    leaseId: row.control_lease_id,
    fencingToken: Number(row.control_fencing_token),
    modelProfileId: row.model_profile_id,
    capabilityId: row.capability_id,
    capabilityKey: row.capability_key,
    modality: row.modality,
    operations: json(row.operations),
    resourceEnvelope: json(row.resource_envelope),
    registrationDigest: `sha256:${Buffer.from(row.registration_digest).toString("hex")}`,
    state: row.registration_state,
    observedAt: iso(row.observed_at),
    expiresAt: iso(row.expires_at),
    retiredAt: iso(row.retired_at),
    retireReason: row.retire_reason,
  };
}

function digestBytes(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("SHA-256 value is invalid");
  return Buffer.from(value.slice(7), "hex");
}

export class PostgresPluginAccessRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database is required");
    this.#database = database;
  }

  async getActivePlugin(pluginId) {
    const row = rows(await this.#database.query(`
      SELECT plugins.plugin_key, plugins.plugin_type, plugins.lifecycle_state,
             plugins.generation, versions.version AS current_version,
             versions.manifest
      FROM plugins.plugins
      JOIN plugins.plugin_versions versions ON versions.id = plugins.current_version_id
      WHERE plugins.plugin_key = $1`, [pluginId]))[0];
    if (!row) return null;
    return {
      pluginId: row.plugin_key,
      pluginType: pluginType(row.plugin_type),
      lifecycleState: row.lifecycle_state,
      currentVersion: row.current_version,
      generation: Number(row.generation),
      manifest: json(row.manifest),
    };
  }

  async insertDelegation(record) {
    try {
      const result = await this.#database.query(`
        INSERT INTO plugins.delegated_user_tokens (
          id, plugin_id, plugin_version_id, plugin_generation, audience,
          identity_id, session_id, token_hash, grants, issued_at, expires_at
        )
        SELECT $1, plugins.id, versions.id, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
        FROM plugins.plugins
        JOIN plugins.plugin_versions versions
          ON versions.plugin_id = plugins.id AND versions.version = $3
        WHERE plugins.plugin_key = $2 AND plugins.plugin_type = 'application'
          AND plugins.lifecycle_state = 'enabled'
          AND plugins.current_version_id = versions.id
          AND plugins.generation = $4
        RETURNING id`, [
        record.delegationId, record.pluginId, record.pluginVersion,
        record.pluginGeneration, record.audience, record.identityId,
        record.sessionId, Buffer.from(record.tokenHash, "hex"),
        JSON.stringify(record.grants), record.issuedAt, record.expiresAt,
      ]);
      if (!rows(result)[0]) throw new Error("active ApplicationPlugin changed before delegation persistence");
      return structuredClone(record);
    } catch (error) {
      if (error?.code === "23505") error.code = "delegated_token_collision";
      throw error;
    }
  }

  async getDelegation(delegationId) {
    return delegation(rows(await this.#database.query(`
      SELECT tokens.*, plugins.plugin_key, versions.version AS plugin_version
      FROM plugins.delegated_user_tokens tokens
      JOIN plugins.plugins ON plugins.id = tokens.plugin_id
      JOIN plugins.plugin_versions versions ON versions.id = tokens.plugin_version_id
      WHERE tokens.id = $1`, [delegationId]))[0]);
  }

  async findDelegationByTokenHash(tokenHash) {
    return delegation(rows(await this.#database.query(`
      SELECT tokens.*, plugins.plugin_key, versions.version AS plugin_version
      FROM plugins.delegated_user_tokens tokens
      JOIN plugins.plugins ON plugins.id = tokens.plugin_id
      JOIN plugins.plugin_versions versions ON versions.id = tokens.plugin_version_id
      WHERE tokens.token_hash = $1`, [Buffer.from(tokenHash, "hex")]))[0]);
  }

  async touchDelegation(delegationId, now) {
    return rows(await this.#database.query(`
      UPDATE plugins.delegated_user_tokens
      SET last_used_at = $2
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2
      RETURNING id`, [delegationId, now])).length === 1;
  }

  async revokeDelegation(delegationId, now, reason) {
    return rows(await this.#database.query(`
      UPDATE plugins.delegated_user_tokens
      SET revoked_at = $2, revoke_reason = $3
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`, [delegationId, now, reason])).length === 1;
  }

  async revokeForSession(identityId, sessionId, now, reason) {
    return Number(rows(await this.#database.query(`
      WITH revoked AS (
        UPDATE plugins.delegated_user_tokens
        SET revoked_at = $3, revoke_reason = $4
        WHERE identity_id = $1 AND session_id = $2 AND revoked_at IS NULL
        RETURNING 1
      ) SELECT count(*)::bigint AS count FROM revoked`, [identityId, sessionId, now, reason]))[0]?.count ?? 0);
  }

  async revokeForPlugin(pluginId, now, reason) {
    return Number(rows(await this.#database.query(`
      WITH revoked AS (
        UPDATE plugins.delegated_user_tokens tokens
        SET revoked_at = $2, revoke_reason = $3
        FROM plugins.plugins
        WHERE tokens.plugin_id = plugins.id AND plugins.plugin_key = $1
          AND tokens.revoked_at IS NULL
        RETURNING 1
      ) SELECT count(*)::bigint AS count FROM revoked`, [pluginId, now, reason]))[0]?.count ?? 0);
  }

  async getWorker(workerId) {
    const row = rows(await this.#database.query(`
      SELECT workers.id AS worker_id, plugins.plugin_key, workers.node_id,
             workers.model_profile_id, workers.generation,
             workers.control_lease_id, workers.control_fencing_token,
             workers.lifecycle_state, workers.health_state
      FROM compute.worker_instances workers
      JOIN plugins.plugins ON plugins.id = workers.compute_plugin_id
      WHERE workers.id = $1`, [workerId]))[0];
    return row ? {
      workerId: row.worker_id,
      pluginId: row.plugin_key,
      nodeId: row.node_id,
      modelProfileId: row.model_profile_id,
      generation: Number(row.generation),
      controlLeaseId: row.control_lease_id,
      controlFencingToken: Number(row.control_fencing_token),
      lifecycleState: row.lifecycle_state,
      healthState: row.health_state,
    } : null;
  }

  async getProfiles(profileIds) {
    const result = rows(await this.#database.query(`
      SELECT profiles.id AS model_profile_id, profiles.certification_state,
             capabilities.id AS capability_id, capabilities.capability_key,
             capabilities.modality, capabilities.api_operations,
             COALESCE(profiles.measured_envelope, profiles.declared_resources) AS resource_envelope
      FROM compute.model_profiles profiles
      JOIN compute.capabilities capabilities ON capabilities.id = profiles.capability_id
      WHERE profiles.id = ANY($1::uuid[])`, [profileIds]));
    const mapped = new Map(result.map((row) => [row.model_profile_id, {
      modelProfileId: row.model_profile_id,
      certificationState: row.certification_state,
      capabilityId: row.capability_id,
      capabilityKey: row.capability_key,
      modality: row.modality,
      operations: json(row.api_operations),
      resourceEnvelope: json(row.resource_envelope),
    }]));
    return profileIds.map((id) => structuredClone(mapped.get(id) ?? null));
  }

  async putCapabilityRegistration(record) {
    const inserted = rows(await this.#database.query(`
      INSERT INTO plugins.compute_capability_registrations (
        id, plugin_id, plugin_version_id, plugin_generation,
        worker_instance_id, worker_generation, node_id, model_profile_id,
        capability_id, control_lease_id, control_fencing_token, operations,
        resource_envelope, registration_digest, registration_state,
        observed_at, expires_at
      )
      SELECT $1, plugins.id, versions.id, $4, workers.id, $6, workers.node_id,
             profiles.id, profiles.capability_id, $10, $11, $12::jsonb,
             COALESCE(profiles.measured_envelope, profiles.declared_resources),
             $13, 'available', $14, $15
      FROM plugins.plugins
      JOIN plugins.plugin_versions versions
        ON versions.plugin_id = plugins.id AND versions.version = $3
      JOIN compute.worker_instances workers
        ON workers.compute_plugin_id = plugins.id AND workers.id = $5
      JOIN compute.model_profiles profiles ON profiles.id = $8
      JOIN compute.capabilities capabilities ON capabilities.id = profiles.capability_id
      WHERE plugins.plugin_key = $2 AND plugins.plugin_type = 'compute'
        AND plugins.lifecycle_state = 'enabled' AND plugins.current_version_id = versions.id
        AND plugins.generation = $4 AND workers.generation = $6
        AND workers.node_id = $7 AND workers.model_profile_id = profiles.id
        AND profiles.capability_id = $9::uuid
        AND workers.control_lease_id = $10 AND workers.control_fencing_token = $11
        AND workers.lifecycle_state IN ('ready','busy') AND workers.health_state = 'healthy'
        AND profiles.certification_state = 'certified'
        AND capabilities.api_operations @> $12::jsonb
      ON CONFLICT (worker_instance_id, worker_generation, model_profile_id) DO UPDATE
      SET observed_at = EXCLUDED.observed_at,
          expires_at = EXCLUDED.expires_at
      WHERE compute_capability_registrations.registration_digest = EXCLUDED.registration_digest
        AND compute_capability_registrations.registration_state = 'available'
      RETURNING *`, [
      record.registrationId, record.pluginId, record.pluginVersion,
      record.pluginGeneration, record.workerId, record.workerGeneration,
      record.nodeId, record.modelProfileId, record.capabilityId, record.leaseId,
      record.fencingToken, JSON.stringify(record.operations),
      digestBytes(record.registrationDigest), record.observedAt, record.expiresAt,
    ]));
    if (inserted[0]) return this.#registrationById(inserted[0].id);
    const existing = rows(await this.#database.query(`
      SELECT registration_digest
      FROM plugins.compute_capability_registrations
      WHERE worker_instance_id = $1 AND worker_generation = $2 AND model_profile_id = $3`, [
      record.workerId, record.workerGeneration, record.modelProfileId,
    ]))[0];
    if (!existing) {
      const error = new Error("compute registration facts changed before persistence");
      error.code = "compute_registration_facts_changed";
      throw error;
    }
    if (`sha256:${Buffer.from(existing.registration_digest).toString("hex")}` !== record.registrationDigest) {
      const error = new Error("compute capability registration changed within one worker generation");
      error.code = "compute_registration_conflict";
      throw error;
    }
    return this.#registrationByWorker(record.workerId, record.workerGeneration, record.modelProfileId);
  }

  async #registrationById(id) {
    return registration(rows(await this.#database.query(this.#registrationSelect("registrations.id = $1"), [id]))[0]);
  }

  async #registrationByWorker(workerId, generation, profileId) {
    return registration(rows(await this.#database.query(this.#registrationSelect(
      "registrations.worker_instance_id = $1 AND registrations.worker_generation = $2 AND registrations.model_profile_id = $3",
    ), [workerId, generation, profileId]))[0]);
  }

  #registrationSelect(predicate) {
    return `
      SELECT registrations.*, plugins.plugin_key, versions.version AS plugin_version,
             capabilities.capability_key, capabilities.modality
      FROM plugins.compute_capability_registrations registrations
      JOIN plugins.plugins ON plugins.id = registrations.plugin_id
      JOIN plugins.plugin_versions versions ON versions.id = registrations.plugin_version_id
      JOIN compute.capabilities capabilities ON capabilities.id = registrations.capability_id
      WHERE ${predicate}`;
  }

  async listCapabilityRegistrations(now) {
    return rows(await this.#database.query(`
      SELECT registrations.*, plugins.plugin_key, versions.version AS plugin_version,
             capabilities.capability_key, capabilities.modality
      FROM plugins.compute_capability_registrations registrations
      JOIN plugins.plugins ON plugins.id = registrations.plugin_id
      JOIN plugins.plugin_versions versions ON versions.id = registrations.plugin_version_id
      JOIN compute.worker_instances workers ON workers.id = registrations.worker_instance_id
      JOIN compute.capabilities capabilities ON capabilities.id = registrations.capability_id
      WHERE registrations.registration_state = 'available'
        AND registrations.expires_at > $1
        AND plugins.lifecycle_state = 'enabled'
        AND plugins.current_version_id = registrations.plugin_version_id
        AND plugins.generation = registrations.plugin_generation
        AND workers.generation = registrations.worker_generation
        AND workers.control_lease_id = registrations.control_lease_id
        AND workers.control_fencing_token = registrations.control_fencing_token
        AND workers.lifecycle_state IN ('ready','busy') AND workers.health_state = 'healthy'
      ORDER BY capabilities.capability_key, versions.version, registrations.worker_instance_id`, [now])).map(registration);
  }

  async retireWorkerRegistrations(workerId, workerGeneration, now, reason) {
    return Number(rows(await this.#database.query(`
      WITH retired AS (
        UPDATE plugins.compute_capability_registrations
        SET registration_state = 'retired', retired_at = $3, retire_reason = $4
        WHERE worker_instance_id = $1 AND worker_generation = $2
          AND registration_state = 'available'
        RETURNING 1
      ) SELECT count(*)::bigint AS count FROM retired`, [workerId, workerGeneration, now, reason]))[0]?.count ?? 0);
  }
}
