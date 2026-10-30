export class MemoryPluginLifecycleRepository {
  #plugins = new Map();
  #operations = new Map();
  #locks = new Map();

  async runExclusive(pluginId, operation) {
    const previous = this.#locks.get(pluginId) ?? Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => next);
    this.#locks.set(pluginId, chained);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.#locks.get(pluginId) === chained) this.#locks.delete(pluginId);
    }
  }

  async getPlugin(pluginId) {
    const value = this.#plugins.get(pluginId);
    return value ? structuredClone(value) : null;
  }

  async listPlugins() {
    return [...this.#plugins.values()]
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
      .map((value) => structuredClone(value));
  }

  async ensurePlugin({ pluginId, pluginType, publisherId, protectedOfficial, now }) {
    const previous = this.#plugins.get(pluginId);
    if (previous) {
      if (previous.pluginType !== pluginType || previous.publisherId !== publisherId) {
        const error = new Error("plugin identity is immutable");
        error.code = "plugin_identity_conflict";
        throw error;
      }
      return structuredClone(previous);
    }
    const plugin = {
      pluginId,
      pluginType,
      publisherId,
      protectedOfficial,
      lifecycleState: "discovered",
      currentVersion: null,
      activeSlot: null,
      generation: 0,
      versions: {},
      slots: {},
      migrations: [],
      data: {
        namespace: `plugin.${pluginId}`,
        retentionState: "retained",
        generation: 1,
      },
      createdAt: now,
      updatedAt: now,
    };
    this.#plugins.set(pluginId, plugin);
    return structuredClone(plugin);
  }

  async getOperation(pluginId, operationKey) {
    const value = this.#operations.get(`${pluginId}|${operationKey}`);
    return value ? structuredClone(value) : null;
  }

  async beginOperation(operation) {
    const key = `${operation.pluginId}|${operation.operationKey}`;
    const previous = this.#operations.get(key);
    if (previous) return structuredClone(previous);
    const stored = { ...structuredClone(operation), status: "running", stage: "created", errorCode: null };
    this.#operations.set(key, stored);
    return structuredClone(stored);
  }

  async stageVersion({ pluginId, version, manifestPayloadDigest, bundlePayloadDigest, manifest, slot, operationKey, now }) {
    const plugin = this.#plugins.get(pluginId);
    plugin.lifecycleState = "staged";
    plugin.versions[version] = {
      version,
      manifestPayloadDigest,
      bundlePayloadDigest,
      manifest: structuredClone(manifest),
      installState: "staging",
      slot,
      health: null,
      stagedAt: now,
      activatedAt: null,
      retiredAt: null,
      failedAt: null,
    };
    plugin.slots[slot] = { version, state: "staging", health: null, updatedAt: now };
    plugin.updatedAt = now;
    await this.updateOperation(pluginId, operationKey, { stage: "staged" });
    return structuredClone(plugin.versions[version]);
  }

  async recordMigration({ pluginId, version, migration, sequence, status, operationKey, now, errorCode = null }) {
    const plugin = this.#plugins.get(pluginId);
    const index = plugin.migrations.findIndex((item) => item.version === version && item.migrationId === migration.id);
    const value = {
      version,
      migrationId: migration.id,
      sequence,
      status,
      transactional: migration.transactional,
      reversible: migration.reversible,
      operationKey,
      errorCode,
      updatedAt: now,
    };
    if (index >= 0) plugin.migrations[index] = value;
    else plugin.migrations.push(value);
    plugin.updatedAt = now;
    return structuredClone(value);
  }

  async markSlotHealthy({ pluginId, version, slot, health, operationKey, now }) {
    const plugin = this.#plugins.get(pluginId);
    plugin.versions[version].health = structuredClone(health);
    plugin.slots[slot] = { version, state: "healthy", health: structuredClone(health), updatedAt: now };
    plugin.updatedAt = now;
    await this.updateOperation(pluginId, operationKey, { stage: "healthy" });
  }

  async activateVersion({ pluginId, version, slot, operationKey, now }) {
    const plugin = this.#plugins.get(pluginId);
    const previous = {
      currentVersion: plugin.currentVersion,
      activeSlot: plugin.activeSlot,
      lifecycleState: plugin.lifecycleState,
      generation: plugin.generation,
    };
    if (plugin.slots[slot]?.state !== "healthy" || plugin.versions[version]?.installState !== "staging") {
      throw new Error("only a healthy staged version can be activated");
    }
    plugin.currentVersion = version;
    plugin.activeSlot = slot;
    plugin.generation += 1;
    plugin.lifecycleState = "enabled";
    plugin.versions[version].installState = "healthy";
    plugin.versions[version].activatedAt = now;
    plugin.slots[slot].state = "active";
    plugin.slots[slot].updatedAt = now;
    plugin.updatedAt = now;
    await this.updateOperation(pluginId, operationKey, { stage: "cutover" });
    return structuredClone(previous);
  }

  async restoreCutover({ pluginId, failedVersion, failedSlot, previous, operationKey, now }) {
    const plugin = this.#plugins.get(pluginId);
    plugin.currentVersion = previous.currentVersion;
    plugin.activeSlot = previous.activeSlot;
    plugin.lifecycleState = previous.lifecycleState;
    plugin.generation += 1;
    if (previous.activeSlot && plugin.slots[previous.activeSlot]) plugin.slots[previous.activeSlot].state = "active";
    if (plugin.versions[failedVersion]) {
      plugin.versions[failedVersion].installState = "failed";
      plugin.versions[failedVersion].failedAt = now;
    }
    if (plugin.slots[failedSlot]) plugin.slots[failedSlot].state = "failed";
    plugin.updatedAt = now;
    await this.updateOperation(pluginId, operationKey, { stage: "rolled-back" });
  }

  async failStagedVersion({ pluginId, version, slot, operationKey, errorCode, now }) {
    const plugin = this.#plugins.get(pluginId);
    if (plugin.versions[version]) {
      plugin.versions[version].installState = "failed";
      plugin.versions[version].failedAt = now;
    }
    if (plugin.slots[slot]) plugin.slots[slot].state = "failed";
    plugin.lifecycleState = plugin.currentVersion ? "enabled" : "failed";
    plugin.updatedAt = now;
    await this.updateOperation(pluginId, operationKey, { stage: "failed", status: "failed", errorCode });
  }

  async retireVersion({ pluginId, version, slot, now }) {
    const plugin = this.#plugins.get(pluginId);
    if (plugin.versions[version]) {
      plugin.versions[version].installState = "retired";
      plugin.versions[version].retiredAt = now;
    }
    if (slot && plugin.slots[slot]) plugin.slots[slot].state = "retired";
    plugin.updatedAt = now;
  }

  async setLifecycle({ pluginId, lifecycleState, now }) {
    const plugin = this.#plugins.get(pluginId);
    plugin.lifecycleState = lifecycleState;
    plugin.updatedAt = now;
    return structuredClone(plugin);
  }

  async markUninstalled({ pluginId, now }) {
    const plugin = this.#plugins.get(pluginId);
    plugin.lifecycleState = "uninstalled";
    plugin.currentVersion = null;
    plugin.activeSlot = null;
    plugin.generation += 1;
    plugin.data.retentionState = "retained";
    plugin.updatedAt = now;
    return structuredClone(plugin);
  }

  async updateOperation(pluginId, operationKey, changes) {
    const key = `${pluginId}|${operationKey}`;
    const operation = this.#operations.get(key);
    if (!operation) throw new Error("lifecycle operation does not exist");
    Object.assign(operation, structuredClone(changes));
    if (new Set(["succeeded", "failed"]).has(operation.status) && !operation.completedAt) {
      operation.completedAt = changes.completedAt ?? new Date().toISOString();
    }
    return structuredClone(operation);
  }

  async completeOperation(pluginId, operationKey, result, now) {
    return this.updateOperation(pluginId, operationKey, { status: "succeeded", stage: "complete", result: structuredClone(result), completedAt: now });
  }
}
