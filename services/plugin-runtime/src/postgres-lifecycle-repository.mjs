function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function json(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function typeFromDatabase(value) {
  if (value === "application") return "ApplicationPlugin";
  if (value === "compute") return "ComputePlugin";
  throw new TypeError("PostgreSQL plugin type is invalid");
}

function typeToDatabase(value) {
  if (value === "ApplicationPlugin") return "application";
  if (value === "ComputePlugin") return "compute";
  throw new TypeError("Plugin type is invalid");
}

function digestBytes(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("SHA-256 value is invalid");
  return Buffer.from(value.slice(7), "hex");
}

function digest(value) {
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function operation(row) {
  if (!row) return null;
  return {
    pluginId: row.plugin_key,
    operationKey: row.operation_key,
    kind: row.operation_kind,
    status: row.status,
    stage: row.stage,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    errorCode: row.error_code,
    result: json(row.result),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

export class PostgresPluginLifecycleRepository {
  #database;
  #lockManager;

  constructor({ database, lockManager }) {
    if (!database?.query || !database?.transaction || !lockManager?.runExclusive) {
      throw new TypeError("PostgreSQL database and lifecycle lock manager are required");
    }
    this.#database = database;
    this.#lockManager = lockManager;
  }

  runExclusive(pluginId, callback) {
    return this.#lockManager.runExclusive(`plugin-lifecycle:${pluginId}`, callback);
  }

  async resolveRuntimeGeneration({pluginId,version,slot,starting,legacyGeneration,currentGeneration}) {
    if (!Number.isSafeInteger(legacyGeneration) || legacyGeneration < 1
      || !Number.isSafeInteger(currentGeneration) || currentGeneration < legacyGeneration) {
      throw new TypeError('Plugin node generation is invalid');
    }
    // Bind a staged slot once before Docker start. Existing slots retain their
    // creation identity; reconnecting must not select a different container.
    return this.#database.transaction(async tx => {
      const row=rows(await tx.query(`SELECT s.health,s.slot_state FROM plugins.runtime_slots s
        JOIN plugins.plugins p ON p.id=s.plugin_id
        JOIN plugins.plugin_versions v ON v.id=s.plugin_version_id
        WHERE p.plugin_key=$1 AND v.version=$2 AND s.slot=$3 FOR UPDATE OF s`,[pluginId,version,slot]))[0];
      if (!row) { if(starting)throw new Error('Plugin runtime slot is missing');return legacyGeneration; }
      const health=json(row.health) ?? {};
      if (health.runtimeGeneration !== undefined) {
        if(!Number.isSafeInteger(health.runtimeGeneration)||health.runtimeGeneration<1||health.runtimeGeneration>currentGeneration)throw new Error('Plugin runtime binding is invalid');
        return health.runtimeGeneration;
      }
      const generation=starting&&row.slot_state==='staging' ? currentGeneration : legacyGeneration;
      if(starting) await tx.query(`UPDATE plugins.runtime_slots s SET health=coalesce(s.health,'{}'::jsonb)||jsonb_build_object('runtimeGeneration',$4::bigint)
        FROM plugins.plugins p,plugins.plugin_versions v
        WHERE s.plugin_id=p.id AND s.plugin_version_id=v.id AND p.plugin_key=$1 AND v.version=$2 AND s.slot=$3`,[pluginId,version,slot,generation]);
      return generation;
    });
  }

  async rebindRecoveredApplication({ pluginId, version, slot, previousGeneration, currentGeneration }) {
    if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 1
      || !Number.isSafeInteger(currentGeneration) || currentGeneration < previousGeneration) {
      throw new TypeError('Plugin recovery generation is invalid');
    }
    return this.#database.transaction(async tx => {
      const row = rows(await tx.query(`SELECT s.health,s.slot_state,p.lifecycle_state,p.active_slot,
          current.version AS current_version
        FROM plugins.runtime_slots s JOIN plugins.plugins p ON p.id=s.plugin_id
        JOIN plugins.plugin_versions v ON v.id=s.plugin_version_id
        LEFT JOIN plugins.plugin_versions current ON current.id=p.current_version_id
        WHERE p.plugin_key=$1 AND v.version=$2 AND s.slot=$3 FOR UPDATE OF p,s`,
      [pluginId,version,slot]))[0];
      if (!row || row.lifecycle_state !== 'enabled' || row.slot_state !== 'active'
        || row.active_slot !== slot || row.current_version !== version
        || (json(row.health)?.runtimeGeneration ?? previousGeneration) !== previousGeneration) {
        throw new Error('Plugin recovery binding changed');
      }
      // The caller has already received exact removal acknowledgement. Do
      // not keep a stale healthy/containerId claim for the replacement.
      await tx.query(`UPDATE plugins.runtime_slots s SET health=jsonb_build_object('runtimeGeneration',$4::bigint)
        FROM plugins.plugins p,plugins.plugin_versions v
        WHERE s.plugin_id=p.id AND s.plugin_version_id=v.id AND p.plugin_key=$1 AND v.version=$2 AND s.slot=$3`,
      [pluginId,version,slot,currentGeneration]);
      return currentGeneration;
    });
  }

  async recordRecoveredApplication({pluginId,version,slot,health,now}) {
    if (health?.healthy !== true || !Number.isSafeInteger(health.runtimeGeneration)
      || health.runtimeGeneration < 1 || typeof health.containerId !== 'string') {
      throw new TypeError('Recovered plugin health is invalid');
    }
    return this.#database.transaction(async tx => {
      const result = await tx.query(`UPDATE plugins.runtime_slots s SET health=$4::jsonb,updated_at=$5
        FROM plugins.plugins p,plugins.plugin_versions v
        WHERE s.plugin_id=p.id AND s.plugin_version_id=v.id AND p.plugin_key=$1 AND v.version=$2
          AND s.slot=$3 AND s.slot_state='active' AND p.active_slot=$3 AND p.lifecycle_state='enabled'
          AND p.current_version_id=v.id AND (s.health->>'runtimeGeneration')::bigint=$6
        RETURNING s.slot`,[pluginId,version,slot,JSON.stringify(health),now,health.runtimeGeneration]);
      if (rows(result).length !== 1) throw new Error('Recovered plugin binding changed');
      await tx.query(`UPDATE plugins.plugin_versions v SET health=$3::jsonb
        FROM plugins.plugins p WHERE v.plugin_id=p.id AND p.plugin_key=$1 AND v.version=$2`,
      [pluginId,version,JSON.stringify(health)]);
    });
  }

  async getPlugin(pluginId) {
    const pluginRow = rows(await this.#database.query(`
      SELECT p.*, current.version AS current_version
      FROM plugins.plugins p
      LEFT JOIN plugins.plugin_versions current ON current.id = p.current_version_id
      WHERE p.plugin_key = $1`, [pluginId]))[0];
    if (!pluginRow) return null;
    const [versionResult, slotResult, migrationResult] = await Promise.all([
      this.#database.query(`
        SELECT version, manifest, manifest_sha256, install_state, slot, health,
               staged_at, activated_at, retired_at, failed_at
        FROM plugins.plugin_versions
        WHERE plugin_id = $1
        ORDER BY version`, [pluginRow.id]),
      this.#database.query(`
        SELECT slots.slot, versions.version, slots.slot_state, slots.health,
               slots.updated_at
        FROM plugins.runtime_slots slots
        JOIN plugins.plugin_versions versions ON versions.id = slots.plugin_version_id
        WHERE slots.plugin_id = $1`, [pluginRow.id]),
      this.#database.query(`
        SELECT versions.version, runs.migration_id, runs.sequence,
               runs.migration_state, runs.transactional, runs.reversible,
               runs.error_code, runs.updated_at, operations.operation_key
        FROM plugins.migration_runs runs
        JOIN plugins.plugin_versions versions ON versions.id = runs.plugin_version_id
        JOIN plugins.lifecycle_operations operations ON operations.id = runs.lifecycle_operation_id
        WHERE runs.plugin_id = $1
        ORDER BY versions.version, runs.sequence`, [pluginRow.id]),
    ]);
    const versions = Object.fromEntries(rows(versionResult).map((value) => [value.version, {
      version: value.version,
      manifestPayloadDigest: digest(value.manifest_sha256),
      manifest: json(value.manifest),
      installState: value.install_state,
      slot: value.slot,
      health: json(value.health),
      stagedAt: value.staged_at?.toISOString?.() ?? value.staged_at ?? null,
      activatedAt: value.activated_at?.toISOString?.() ?? value.activated_at ?? null,
      retiredAt: value.retired_at?.toISOString?.() ?? value.retired_at ?? null,
      failedAt: value.failed_at?.toISOString?.() ?? value.failed_at ?? null,
    }]));
    const slots = Object.fromEntries(rows(slotResult).map((value) => [value.slot, {
      version: value.version,
      state: value.slot_state,
      health: json(value.health),
      updatedAt: value.updated_at?.toISOString?.() ?? value.updated_at,
    }]));
    const migrations = rows(migrationResult).map((value) => ({
      version: value.version,
      migrationId: value.migration_id,
      sequence: Number(value.sequence),
      status: value.migration_state,
      transactional: value.transactional,
      reversible: value.reversible,
      operationKey: value.operation_key,
      errorCode: value.error_code,
      updatedAt: value.updated_at?.toISOString?.() ?? value.updated_at,
    }));
    return {
      pluginId: pluginRow.plugin_key,
      pluginType: typeFromDatabase(pluginRow.plugin_type),
      publisherId: pluginRow.publisher,
      protectedOfficial: pluginRow.protected,
      lifecycleState: pluginRow.lifecycle_state,
      currentVersion: pluginRow.current_version,
      activeSlot: pluginRow.active_slot,
      generation: Number(pluginRow.generation),
      versions,
      slots,
      migrations,
      data: {
        namespace: pluginRow.data_namespace,
        retentionState: pluginRow.data_retention_state,
      },
      createdAt: pluginRow.created_at?.toISOString?.() ?? pluginRow.created_at,
      updatedAt: pluginRow.updated_at?.toISOString?.() ?? pluginRow.updated_at,
    };
  }

  async listPlugins() {
    const result = await this.#database.query(`
      SELECT plugin_key
      FROM plugins.plugins
      ORDER BY plugin_key`, []);
    return Promise.all(rows(result).map((row) => this.getPlugin(row.plugin_key)));
  }

  async listRuntimePlugins({ pluginKey = null } = {}) {
    if (pluginKey !== null && !/^[a-z][a-z0-9_.-]{1,127}$/.test(pluginKey)) throw new TypeError("Plugin runtime key is invalid");
    const result = await this.#database.query(`
      SELECT p.plugin_key,p.plugin_type,p.lifecycle_state,p.active_slot,p.generation,
             current.version AS current_version
      FROM plugins.plugins p
      LEFT JOIN plugins.plugin_versions current ON current.id=p.current_version_id
      WHERE ($1::text IS NULL OR p.plugin_key=$1)
      ORDER BY p.plugin_key`, [pluginKey]);
    return rows(result).map((row) => ({
      pluginId: row.plugin_key, pluginType: typeFromDatabase(row.plugin_type),
      lifecycleState: row.lifecycle_state, activeSlot: row.active_slot,
      generation: Number(row.generation), currentVersion: row.current_version,
    }));
  }

  async ensurePlugin({ pluginId, pluginType, publisherId, protectedOfficial }) {
    await this.#database.transaction(async (transaction) => {
      await transaction.query(`
        INSERT INTO plugins.plugins (
          plugin_key, plugin_type, publisher, protected, lifecycle_state,
          data_namespace
        ) VALUES ($1,$2,$3,$4,'discovered',$5)
        ON CONFLICT (plugin_key) DO NOTHING`, [
        pluginId, typeToDatabase(pluginType), publisherId, protectedOfficial,
        `plugin.${pluginId}`,
      ]);
      const row = rows(await transaction.query(`
        SELECT plugin_type, publisher
        FROM plugins.plugins
        WHERE plugin_key = $1
        FOR UPDATE`, [pluginId]))[0];
      if (!row || row.plugin_type !== typeToDatabase(pluginType) || row.publisher !== publisherId) {
        const error = new Error("plugin identity is immutable");
        error.code = "plugin_identity_conflict";
        throw error;
      }
    });
    return this.getPlugin(pluginId);
  }

  async getOperation(pluginId, operationKey) {
    return operation(rows(await this.#database.query(`
      SELECT operations.*, plugins.plugin_key
      FROM plugins.lifecycle_operations operations
      JOIN plugins.plugins ON plugins.id = operations.plugin_id
      WHERE plugins.plugin_key = $1 AND operations.operation_key = $2`, [pluginId, operationKey]))[0]);
  }

  async beginOperation(value) {
    const result = await this.#database.query(`
      INSERT INTO plugins.lifecycle_operations (
        plugin_id, operation_key, operation_kind, status, stage,
        from_version, to_version, created_at
      )
      SELECT id,$2,$3,'running','created',$4,$5,$6
      FROM plugins.plugins WHERE plugin_key = $1
      ON CONFLICT (plugin_id, operation_key) DO NOTHING
      RETURNING *`, [value.pluginId, value.operationKey, value.kind, value.fromVersion, value.toVersion, value.createdAt]);
    if (!rows(result)[0]) return this.getOperation(value.pluginId, value.operationKey);
    return { ...value, status: "running", stage: "created", errorCode: null };
  }

  async stageVersion(value) {
    await this.#database.transaction(async (transaction) => {
      const facts = rows(await transaction.query(`
        SELECT plugins.id AS plugin_id, imports.id AS import_id
        FROM plugins.plugins
        JOIN plugins.verified_imports imports ON imports.plugin_key = plugins.plugin_key
        WHERE plugins.plugin_key = $1 AND imports.version = $2
          AND imports.manifest_payload_sha256 = $3
          AND imports.bundle_payload_sha256 = $4
        FOR UPDATE OF plugins`, [
        value.pluginId, value.version, digestBytes(value.manifestPayloadDigest),
        digestBytes(value.bundlePayloadDigest),
      ]))[0];
      if (!facts) throw new Error("verified import disappeared before staging");
      await transaction.query(`
        INSERT INTO plugins.plugin_versions (
          plugin_id, version, manifest, manifest_sha256, supply_chain_state,
          install_state, verified_import_id, slot, staged_at
        ) VALUES ($1,$2,$3::jsonb,$4,'verified','staging',$5,$6,$7)
        ON CONFLICT (plugin_id, version) DO UPDATE
        SET install_state = 'staging', slot = EXCLUDED.slot,
            staged_at = EXCLUDED.staged_at, failed_at = NULL
        WHERE plugins.plugin_versions.manifest_sha256 = EXCLUDED.manifest_sha256
          AND plugins.plugin_versions.verified_import_id = EXCLUDED.verified_import_id`, [
        facts.plugin_id, value.version, JSON.stringify(value.manifest),
        digestBytes(value.manifestPayloadDigest), facts.import_id, value.slot, value.now,
      ]);
      await transaction.query(`
        INSERT INTO plugins.runtime_slots (
          plugin_id, slot, plugin_version_id, slot_state, generation
        )
        SELECT $1,$2,id,'staging',
               (SELECT generation + 1 FROM plugins.plugins WHERE id = $1)
        FROM plugins.plugin_versions
        WHERE plugin_id = $1 AND version = $3
        ON CONFLICT (plugin_id, slot) DO UPDATE
        SET plugin_version_id = EXCLUDED.plugin_version_id,
            slot_state = 'staging', health = NULL,
            generation = EXCLUDED.generation`, [facts.plugin_id, value.slot, value.version]);
      await transaction.query(`UPDATE plugins.plugins SET lifecycle_state = 'staged' WHERE id = $1`, [facts.plugin_id]);
      await transaction.query(`
        UPDATE plugins.lifecycle_operations SET stage = 'staged'
        WHERE plugin_id = $1 AND operation_key = $2`, [facts.plugin_id, value.operationKey]);
    });
  }

  async recordMigration(value) {
    const result = await this.#database.query(`
      INSERT INTO plugins.migration_runs (
        plugin_id, plugin_version_id, lifecycle_operation_id, migration_id,
        sequence, migration_state, transactional, reversible, error_code
      )
      SELECT plugins.id, versions.id, operations.id, $4,$5,$6,$7,$8,$9
      FROM plugins.plugins
      JOIN plugins.plugin_versions versions ON versions.plugin_id = plugins.id AND versions.version = $2
      JOIN plugins.lifecycle_operations operations ON operations.plugin_id = plugins.id AND operations.operation_key = $3
      WHERE plugins.plugin_key = $1
      ON CONFLICT (plugin_version_id, migration_id) DO UPDATE
      SET migration_state = EXCLUDED.migration_state,
          error_code = EXCLUDED.error_code
      RETURNING migration_id`, [
      value.pluginId, value.version, value.operationKey, value.migration.id,
      value.sequence, value.status, value.migration.transactional,
      value.migration.reversible, value.errorCode,
    ]);
    if (!rows(result)[0]) throw new Error("plugin migration could not be recorded");
  }

  async markSlotHealthy(value) {
    await this.#database.transaction(async (transaction) => {
      await transaction.query(`
        UPDATE plugins.plugin_versions versions
        SET health = $4::jsonb
        FROM plugins.plugins
        WHERE versions.plugin_id = plugins.id
          AND plugins.plugin_key = $1 AND versions.version = $2 AND versions.slot = $3`, [value.pluginId, value.version, value.slot, JSON.stringify(value.health)]);
      await transaction.query(`
        UPDATE plugins.runtime_slots slots
        SET slot_state = 'healthy', health = $3::jsonb
        FROM plugins.plugins
        WHERE slots.plugin_id = plugins.id AND plugins.plugin_key = $1 AND slots.slot = $2`, [value.pluginId, value.slot, JSON.stringify(value.health)]);
      await transaction.query(`
        UPDATE plugins.lifecycle_operations operations SET stage = 'healthy'
        FROM plugins.plugins
        WHERE operations.plugin_id = plugins.id AND plugins.plugin_key = $1
          AND operations.operation_key = $2`, [value.pluginId, value.operationKey]);
    });
  }

  async activateVersion(value) {
    return this.#database.transaction(async (transaction) => {
      const previous = rows(await transaction.query(`
        SELECT plugins.id, current.version AS current_version,
               plugins.active_slot, plugins.lifecycle_state, plugins.generation
        FROM plugins.plugins
        LEFT JOIN plugins.plugin_versions current ON current.id = plugins.current_version_id
        WHERE plugins.plugin_key = $1
        FOR UPDATE OF plugins`, [value.pluginId]))[0];
      const target = rows(await transaction.query(`
        SELECT versions.id
        FROM plugins.plugin_versions versions
        JOIN plugins.runtime_slots slots ON slots.plugin_version_id = versions.id
        WHERE versions.plugin_id = $1 AND versions.version = $2
          AND versions.slot = $3 AND versions.install_state = 'staging'
          AND slots.slot_state = 'healthy'`, [previous.id, value.version, value.slot]))[0];
      if (!target) throw new Error("only a healthy staged version can be activated");
      await transaction.query(`
        UPDATE plugins.plugins
        SET current_version_id = $2, active_slot = $3,
            lifecycle_state = 'enabled', generation = generation + 1
        WHERE id = $1`, [previous.id, target.id, value.slot]);
      await transaction.query(`
        UPDATE plugins.plugin_versions
        SET install_state = 'healthy', activated_at = $2
        WHERE id = $1`, [target.id, value.now]);
      await transaction.query(`
        UPDATE plugins.runtime_slots SET slot_state = 'active'
        WHERE plugin_id = $1 AND slot = $2`, [previous.id, value.slot]);
      await transaction.query(`
        UPDATE plugins.lifecycle_operations SET stage = 'cutover'
        WHERE plugin_id = $1 AND operation_key = $2`, [previous.id, value.operationKey]);
      return {
        currentVersion: previous.current_version,
        activeSlot: previous.active_slot,
        lifecycleState: previous.lifecycle_state,
        generation: Number(previous.generation),
      };
    });
  }

  async restoreCutover(value) {
    await this.#database.transaction(async (transaction) => {
      const plugin = rows(await transaction.query(`
        SELECT id FROM plugins.plugins WHERE plugin_key = $1 FOR UPDATE`, [value.pluginId]))[0];
      const oldVersion = value.previous.currentVersion
        ? rows(await transaction.query(`SELECT id FROM plugins.plugin_versions WHERE plugin_id = $1 AND version = $2`, [plugin.id, value.previous.currentVersion]))[0]
        : null;
      await transaction.query(`
        UPDATE plugins.plugins
        SET current_version_id = $2, active_slot = $3,
            lifecycle_state = $4, generation = generation + 1
        WHERE id = $1`, [plugin.id, oldVersion?.id ?? null, value.previous.activeSlot, value.previous.lifecycleState]);
      await transaction.query(`
        UPDATE plugins.plugin_versions SET install_state = 'failed', failed_at = $3
        WHERE plugin_id = $1 AND version = $2`, [plugin.id, value.failedVersion, value.now]);
      await transaction.query(`
        UPDATE plugins.runtime_slots SET slot_state = 'failed'
        WHERE plugin_id = $1 AND slot = $2`, [plugin.id, value.failedSlot]);
      if (value.previous.activeSlot) await transaction.query(`
        UPDATE plugins.runtime_slots SET slot_state = 'active'
        WHERE plugin_id = $1 AND slot = $2`, [plugin.id, value.previous.activeSlot]);
    });
  }

  async failStagedVersion(value) {
    await this.#database.transaction(async (transaction) => {
      const plugin = rows(await transaction.query(`SELECT id, current_version_id FROM plugins.plugins WHERE plugin_key = $1 FOR UPDATE`, [value.pluginId]))[0];
      await transaction.query(`
        UPDATE plugins.plugin_versions SET install_state = 'failed', failed_at = $3
        WHERE plugin_id = $1 AND version = $2`, [plugin.id, value.version, value.now]);
      await transaction.query(`UPDATE plugins.runtime_slots SET slot_state = 'failed' WHERE plugin_id = $1 AND slot = $2`, [plugin.id, value.slot]);
      await transaction.query(`UPDATE plugins.plugins SET lifecycle_state = $2 WHERE id = $1`, [plugin.id, plugin.current_version_id ? "enabled" : "failed"]);
      await transaction.query(`
        UPDATE plugins.lifecycle_operations
        SET stage = 'failed', status = 'failed', error_code = $3, completed_at = $4
        WHERE plugin_id = $1 AND operation_key = $2`, [plugin.id, value.operationKey, value.errorCode, value.now]);
    });
  }

  async retireVersion(value) {
    await this.#database.transaction(async (transaction) => {
      await transaction.query(`
        UPDATE plugins.plugin_versions versions
        SET install_state = 'retired', retired_at = $3
        FROM plugins.plugins
        WHERE versions.plugin_id = plugins.id AND plugins.plugin_key = $1
          AND versions.version = $2`, [value.pluginId, value.version, value.now]);
      if (value.slot) await transaction.query(`
        UPDATE plugins.runtime_slots slots SET slot_state = 'retired'
        FROM plugins.plugins
        WHERE slots.plugin_id = plugins.id AND plugins.plugin_key = $1 AND slots.slot = $2`, [value.pluginId, value.slot]);
    });
  }

  async setLifecycle(value) {
    await this.#database.query(`UPDATE plugins.plugins SET lifecycle_state = $2 WHERE plugin_key = $1`, [value.pluginId, value.lifecycleState]);
    return this.getPlugin(value.pluginId);
  }

  async markUninstalled(value) {
    await this.#database.query(`
      UPDATE plugins.plugins
      SET lifecycle_state = 'uninstalled', current_version_id = NULL,
          active_slot = NULL, generation = generation + 1,
          data_retention_state = 'retained'
      WHERE plugin_key = $1`, [value.pluginId]);
    return this.getPlugin(value.pluginId);
  }

  async updateOperation(pluginId, operationKey, changes) {
    const allowed = new Set(["status", "stage", "errorCode"]);
    for (const key of Object.keys(changes)) if (!allowed.has(key)) throw new TypeError("unsupported operation update");
    const result = await this.#database.query(`
      UPDATE plugins.lifecycle_operations operations
      SET status = COALESCE($3, status), stage = COALESCE($4, stage),
          error_code = COALESCE($5, error_code),
          completed_at = CASE WHEN COALESCE($3, status) IN ('succeeded','failed')
            THEN COALESCE(completed_at, clock_timestamp()) ELSE NULL END
      FROM plugins.plugins
      WHERE operations.plugin_id = plugins.id AND plugins.plugin_key = $1
        AND operations.operation_key = $2
      RETURNING operations.*, plugins.plugin_key`, [
      pluginId, operationKey, changes.status ?? null, changes.stage ?? null,
      changes.errorCode ?? null,
    ]);
    return operation(rows(result)[0]);
  }

  async completeOperation(pluginId, operationKey, result, now) {
    const updated = await this.#database.query(`
      UPDATE plugins.lifecycle_operations operations
      SET status = 'succeeded', stage = 'complete', result = $3::jsonb,
          completed_at = $4, error_code = NULL
      FROM plugins.plugins
      WHERE operations.plugin_id = plugins.id AND plugins.plugin_key = $1
        AND operations.operation_key = $2
      RETURNING operations.*, plugins.plugin_key`, [pluginId, operationKey, JSON.stringify(result), now]);
    return operation(rows(updated)[0]);
  }
}
