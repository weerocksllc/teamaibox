export class PluginLifecycleError extends Error {
  constructor(code, message, { retryable = false, stage = null, causeCode = null } = {}) {
    super(message);
    this.name = "PluginLifecycleError";
    this.code = code;
    this.retryable = retryable;
    this.stage = stage;
    this.causeCode = typeof causeCode === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(causeCode) ? causeCode : null;
  }
}

function fail(code, message, options) {
  throw new PluginLifecycleError(code, message, options);
}

function requireAdministrator(context) {
  if (!context || !Array.isArray(context.permissions) || !context.permissions.includes("plugin:manage")) {
    fail("plugin_administrator_required", "Plugin lifecycle changes require an administrator");
  }
}

function requireOperationKey(operationKey) {
  if (typeof operationKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(operationKey)) {
    fail("operation_key_invalid", "A bounded idempotency key is required");
  }
}

function versionParts(version) {
  if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(version)) {
    fail("plugin_version_invalid", "Plugin version must be SemVer");
  }
  return version.split("-", 1)[0].split(".").map(Number);
}

function compareVersion(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

function protectedOfficial(manifest) {
  return manifest.official === true
    && manifest.publisher?.id === "teamaibox"
    && manifest.extensions?.lifecycle?.protected === true;
}

function publicPlugin(plugin) {
  if (!plugin) return null;
  return Object.freeze({
    pluginId: plugin.pluginId,
    pluginType: plugin.pluginType,
    lifecycleState: plugin.lifecycleState,
    currentVersion: plugin.currentVersion,
    activeSlot: plugin.activeSlot,
    generation: plugin.generation,
    protectedOfficial: plugin.protectedOfficial,
    dataRetentionState: plugin.data?.retentionState,
  });
}

function lifecycleFailure(error, stage) {
  if (error instanceof PluginLifecycleError) return error;
  return new PluginLifecycleError("plugin_lifecycle_failed", "Plugin lifecycle gate failed", {
    retryable: true, stage,
    causeCode: typeof error?.code === "string" ? error.code : null,
  });
}

export class PluginLifecycleService {
  #verifiedImports;
  #repository;
  #nodeAgent;
  #migrationRunner;
  #sandboxPolicy;
  #clock;
  #healthSink;
  #onHealthSinkError;
  #audit;
  #delegationRevoker;
  #lifecycleAuthority;

  constructor({ verifiedImports, repository, nodeAgent, migrationRunner, sandboxPolicy, delegationRevoker = null,
    lifecycleAuthority = null, clock = () => new Date(), healthSink = null, onHealthSinkError = async () => {}, audit = async () => {} }) {
    if (!verifiedImports?.get || !repository?.runExclusive || !nodeAgent || !migrationRunner || !sandboxPolicy?.compile
        || ((delegationRevoker === null) !== (lifecycleAuthority === null))
        || (delegationRevoker !== null && typeof delegationRevoker.revokeForPlugin !== "function")
        || (lifecycleAuthority !== null && typeof lifecycleAuthority.issuePluginLifecycle !== "function")
        || (healthSink !== null && typeof healthSink.recordPluginHealth !== "function") || typeof onHealthSinkError !== "function" || typeof audit !== "function") {
      throw new TypeError("plugin lifecycle dependencies are required");
    }
    this.#verifiedImports = verifiedImports;
    this.#repository = repository;
    this.#nodeAgent = nodeAgent;
    this.#migrationRunner = migrationRunner;
    this.#sandboxPolicy = sandboxPolicy;
    this.#clock = clock;
    this.#healthSink = healthSink;
    this.#onHealthSinkError = onHealthSinkError;
    this.#audit = audit;
    this.#delegationRevoker = delegationRevoker;
    this.#lifecycleAuthority = lifecycleAuthority;
  }

  async #revokeDelegations(plugin, reason) {
    if (!this.#delegationRevoker) return;
    await this.#delegationRevoker.revokeForPlugin({
      authority: this.#lifecycleAuthority.issuePluginLifecycle({ pluginId: plugin.pluginId, pluginGeneration: plugin.generation }),
      pluginId: plugin.pluginId,
      reason,
    });
  }

  async #publishHealth(pluginId, lifecycleState, operation, health) {
    try { await this.#healthSink?.recordPluginHealth({ pluginId, lifecycleState, operation, health: { ...health, observedAt: this.#clock().toISOString() } }); }
    catch (error) { try { await this.#onHealthSinkError(error, { pluginId, lifecycleState, operation }); } catch { /* diagnostics reporting cannot invalidate plugin lifecycle */ } }
  }

  install(input) {
    return this.#deploy("install", input);
  }

  upgrade(input) {
    return this.#deploy("upgrade", input);
  }

  async recoverEnabledApplications({ operationKey, completed = new Set(), canContinue = () => true }) {
    requireOperationKey(operationKey);
    let pending = 0;
    for (const entry of await this.#repository.listPlugins()) {
      if (!canContinue()) return { pending: 1 };
      if (entry.pluginType !== "ApplicationPlugin" || entry.lifecycleState !== "enabled" || !entry.currentVersion) continue;
      await this.#repository.runExclusive(entry.pluginId, async () => {
        const plugin = await this.#repository.getPlugin(entry.pluginId);
        if (!canContinue() || plugin?.lifecycleState !== "enabled" || plugin.pluginType !== "ApplicationPlugin"
          || !plugin.currentVersion || !new Set(["blue", "green"]).has(plugin.activeSlot)) return;
        const key = `${plugin.pluginId}:${plugin.generation}:${plugin.currentVersion}:${plugin.activeSlot}`;
        if (completed.has(key)) return;
        try {
          const imported = await this.#verifiedImports.get(plugin.pluginId, plugin.currentVersion);
          // Seeded, protected built-in pages are served by the core, not by
          // this signed-plugin container runtime. Do not invent their images.
          if (!imported && plugin.protectedOfficial) { completed.add(key); return; }
          const health = await this.#nodeAgent.recoverApplication({ pluginId: plugin.pluginId,
            version: plugin.currentVersion, slot: plugin.activeSlot, operationKey });
          if (!health?.healthy) throw new Error("plugin_boot_recovery_health_failed");
          // Refresh persisted catalog health after live route recovery without
          // changing the version/slot or relabeling a retained container.
          await this.#repository.recordRecoveredApplication?.({pluginId:plugin.pluginId,
            version:plugin.currentVersion,slot:plugin.activeSlot,health,now:this.#clock().toISOString()});
          completed.add(key);
          if (health.restarted) await this.#audit({ action: "plugin.runtime_recovered", pluginId: plugin.pluginId,
            version: plugin.currentVersion, operationKey, lifecycleState: "enabled", outcome: "succeeded",
            occurredAt: this.#clock().toISOString() });
        } catch (error) {
          pending += 1;
          if (error?.code && /^[a-z][a-z0-9_]{2,63}$/.test(error.code)) {
            await this.#audit({ action: "plugin.runtime_recovery_failed", pluginId: plugin.pluginId,
              operationKey, errorCode: error.code, outcome: "failed", occurredAt: this.#clock().toISOString() });
          }
        }
      });
    }
    return { pending };
  }

  async #deploy(kind, { context, pluginId, version, operationKey }) {
    requireAdministrator(context);
    requireOperationKey(operationKey);
    return this.#repository.runExclusive(pluginId, async () => {
      const replay = await this.#repository.getOperation(pluginId, operationKey);
      if (replay?.status === "succeeded") return Object.freeze(structuredClone(replay.result));
      if (replay) fail("plugin_operation_in_progress", "This lifecycle operation already exists", { retryable: true, stage: replay.stage });
      const imported = await this.#verifiedImports.get(pluginId, version);
      if (!imported || imported.state !== "verified" || !imported.manifest) fail("verified_import_required", "A verified plugin import is required before staging");
      let plugin = await this.#repository.getPlugin(pluginId);
      if (kind === "install" && plugin?.currentVersion) fail("plugin_already_installed", "Plugin is already installed");
      if (kind === "upgrade" && !plugin?.currentVersion) fail("plugin_not_installed", "Plugin must be installed before upgrade");
      if (kind === "upgrade" && compareVersion(version, plugin.currentVersion) <= 0) fail("plugin_upgrade_not_forward", "Upgrade version must be newer than the active version");
      if (plugin?.protectedOfficial && (!protectedOfficial(imported.manifest) || imported.manifest.publisher.id !== plugin.publisherId)) {
        fail("protected_plugin_takeover_denied", "A protected official plugin can only be upgraded by its official publisher");
      }
      const now = this.#clock().toISOString();
      plugin = await this.#repository.ensurePlugin({
        pluginId,
        pluginType: imported.pluginType,
        publisherId: imported.manifest.publisher.id,
        protectedOfficial: protectedOfficial(imported.manifest),
        now,
      });
      const oldVersion = plugin.currentVersion;
      const oldSlot = plugin.activeSlot;
      const slot = oldSlot === "blue" ? "green" : "blue";
      await this.#repository.beginOperation({
        pluginId, operationKey, kind, fromVersion: oldVersion, toVersion: version, createdAt: now,
      });
      let migrationSession = null;
      let cutover = null;
      const appliedMigrations = [];
      let stage = "staging";
      try {
        await this.#repository.stageVersion({
          pluginId,
          version,
          manifestPayloadDigest: imported.manifestPayloadDigest,
          bundlePayloadDigest: imported.bundlePayloadDigest,
          manifest: imported.manifest,
          slot,
          operationKey,
          now,
        });
        const sandbox = await this.#sandboxPolicy.compile({
          manifest: imported.manifest,
          pluginId,
          version,
          operationKey,
        });
        await this.#nodeAgent.stage({
          pluginId,
          version,
          slot,
          images: imported.manifest.images,
          resources: imported.manifest.resources,
          sandbox,
          operationKey,
        });
        stage = "migrations";
        migrationSession = await this.#migrationRunner.begin({
          pluginId,
          fromVersion: oldVersion,
          toVersion: version,
          dataNamespace: plugin.data.namespace,
          operationKey,
        });
        for (let index = 0; index < imported.manifest.migrations.length; index += 1) {
          const migration = imported.manifest.migrations[index];
          await this.#repository.recordMigration({ pluginId, version, migration, sequence: index + 1, status: "running", operationKey, now: this.#clock().toISOString() });
          try {
            await migrationSession.apply(migration);
            appliedMigrations.push({ migration, sequence: index + 1 });
            await this.#repository.recordMigration({ pluginId, version, migration, sequence: index + 1, status: "applied", operationKey, now: this.#clock().toISOString() });
          } catch (error) {
            await this.#repository.recordMigration({ pluginId, version, migration, sequence: index + 1, status: "failed", operationKey, errorCode: "migration_failed", now: this.#clock().toISOString() });
            throw error;
          }
        }
        stage = "startup";
        await this.#nodeAgent.start({ pluginId, version, slot, operationKey });
        stage = "health";
        const health = await this.#nodeAgent.waitHealthy({
          pluginId,
          version,
          slot,
          probes: imported.manifest.health,
          requiredConsecutive: 3,
          operationKey,
        });
        if (!health || health.healthy !== true || health.consecutive < 3) fail("plugin_health_failed", "Staged plugin did not become continuously healthy", { stage });
        await this.#repository.markSlotHealthy({ pluginId, version, slot, health, operationKey, now: this.#clock().toISOString() });
        stage = "cutover";
        cutover = await this.#repository.activateVersion({ pluginId, version, slot, operationKey, now: this.#clock().toISOString() });
        stage = "delegation-revocation";
        await this.#revokeDelegations(await this.#repository.getPlugin(pluginId), "plugin_version_changed");
        stage = "migration-commit";
        await migrationSession.commit();
        for (let index = 0; index < imported.manifest.migrations.length; index += 1) {
          const migration = imported.manifest.migrations[index];
          await this.#repository.recordMigration({ pluginId, version, migration, sequence: index + 1, status: "committed", operationKey, now: this.#clock().toISOString() });
        }
        await this.#nodeAgent.promote({ pluginId, version, slot, operationKey });
        let retirementPending = false;
        if (oldVersion) {
          try {
            await this.#nodeAgent.retire({ pluginId, version: oldVersion, slot: oldSlot, operationKey });
            await this.#repository.retireVersion({ pluginId, version: oldVersion, slot: oldSlot, now: this.#clock().toISOString() });
          } catch { retirementPending = true; }
        }
        const current = await this.#repository.getPlugin(pluginId);
        const result = { ...publicPlugin(current), operationKey, retirementPending };
        await this.#repository.completeOperation(pluginId, operationKey, result, this.#clock().toISOString());
        await this.#publishHealth(pluginId, result.lifecycleState, kind, { healthy: true });
        await this.#audit({ action: kind === "install" ? "plugin.installed" : "plugin.upgraded", actorIdentityId: context.identityId,
          pluginId, version, operationKey, lifecycleState: result.lifecycleState, occurredAt: this.#clock().toISOString() });
        return Object.freeze(result);
      } catch (error) {
        const failure = lifecycleFailure(error, stage);
        try { await migrationSession?.rollback(); } catch { /* reconciliation retains the failed operation */ }
        for (const { migration, sequence } of appliedMigrations) {
          try {
            await this.#repository.recordMigration({ pluginId, version, migration, sequence, status: "rolled_back", operationKey, errorCode: failure.code, now: this.#clock().toISOString() });
          } catch { /* operation reconciliation retains prior migration evidence */ }
        }
        try { await this.#nodeAgent.stop({ pluginId, version, slot, operationKey }); } catch { /* Node Agent reconciliation owns cleanup */ }
        try { await this.#nodeAgent.removeStaged({ pluginId, version, slot, operationKey }); } catch { /* retryable reconciliation */ }
        if (cutover) {
          await this.#repository.restoreCutover({ pluginId, failedVersion: version, failedSlot: slot, previous: cutover, operationKey, now: this.#clock().toISOString() });
          await this.#repository.updateOperation(pluginId, operationKey, { status: "failed", errorCode: failure.code });
        } else {
          await this.#repository.failStagedVersion({ pluginId, version, slot, operationKey, errorCode: failure.code, now: this.#clock().toISOString() });
        }
        await this.#publishHealth(pluginId, plugin?.lifecycleState ?? "disabled", kind, { healthy: false, errorCode: failure.code });
        await this.#audit({ action: "plugin.lifecycle_failed", actorIdentityId: context.identityId, pluginId, version, operationKey,
          operation: kind, errorCode: failure.code, stage: failure.stage ?? stage, outcome: "failed", occurredAt: this.#clock().toISOString() });
        throw failure;
      }
    });
  }

  async enable({ context, pluginId, operationKey }) {
    requireAdministrator(context);
    requireOperationKey(operationKey);
    return this.#repository.runExclusive(pluginId, async () => {
      const replay = await this.#repository.getOperation(pluginId, operationKey);
      if (replay?.status === "succeeded") return Object.freeze(structuredClone(replay.result));
      if (replay) fail("plugin_operation_in_progress", "This lifecycle operation already exists", { retryable: true, stage: replay.stage });
      const plugin = await this.#repository.getPlugin(pluginId);
      if (!plugin?.currentVersion) fail("plugin_not_installed", "Plugin is not installed");
      if (plugin.lifecycleState === "enabled") return publicPlugin(plugin);
      await this.#repository.beginOperation({ pluginId, operationKey, kind: "enable", fromVersion: plugin.currentVersion, toVersion: plugin.currentVersion, createdAt: this.#clock().toISOString() });
      let stage = "delegation-revocation";
      try {
        await this.#revokeDelegations(plugin, "plugin_reenabled");
        stage = "startup";
        await this.#nodeAgent.start({ pluginId, version: plugin.currentVersion, slot: plugin.activeSlot, operationKey });
        stage = "health";
        const health = await this.#nodeAgent.waitHealthy({ pluginId, version: plugin.currentVersion, slot: plugin.activeSlot, probes: plugin.versions[plugin.currentVersion].manifest.health, requiredConsecutive: 3, operationKey });
        if (!health?.healthy || health.consecutive < 3) fail("plugin_health_failed", "Plugin could not be enabled because health checks failed");
        const current = await this.#repository.setLifecycle({ pluginId, lifecycleState: "enabled", now: this.#clock().toISOString() });
        const result = publicPlugin(current);
        await this.#repository.completeOperation(pluginId, operationKey, result, this.#clock().toISOString());
        await this.#publishHealth(pluginId, result.lifecycleState, "enable", { healthy: true });
        await this.#audit({ action: "plugin.enabled", actorIdentityId: context.identityId, pluginId, version: plugin.currentVersion,
          operationKey, lifecycleState: result.lifecycleState, occurredAt: this.#clock().toISOString() });
        return result;
      } catch (error) {
        const failure = lifecycleFailure(error, stage);
        try { await this.#nodeAgent.stop({ pluginId, version: plugin.currentVersion, slot: plugin.activeSlot, operationKey }); } catch { /* reconciliation */ }
        await this.#repository.setLifecycle({ pluginId, lifecycleState: "disabled", now: this.#clock().toISOString() });
        await this.#repository.updateOperation(pluginId, operationKey, { status: "failed", stage: failure.stage ?? stage, errorCode: failure.code });
        await this.#publishHealth(pluginId, "disabled", "enable", { healthy: false, errorCode: failure.code });
        await this.#audit({ action: "plugin.lifecycle_failed", actorIdentityId: context.identityId, pluginId, version: plugin.currentVersion,
          operationKey, operation: "enable", errorCode: failure.code, stage: failure.stage ?? stage, outcome: "failed", occurredAt: this.#clock().toISOString() });
        throw failure;
      }
    });
  }

  async disable({ context, pluginId, operationKey }) {
    requireAdministrator(context);
    requireOperationKey(operationKey);
    return this.#repository.runExclusive(pluginId, async () => {
      const replay = await this.#repository.getOperation(pluginId, operationKey);
      if (replay?.status === "succeeded") return Object.freeze(structuredClone(replay.result));
      if (replay) fail("plugin_operation_in_progress", "This lifecycle operation already exists", { retryable: true, stage: replay.stage });
      const plugin = await this.#repository.getPlugin(pluginId);
      if (!plugin?.currentVersion) fail("plugin_not_installed", "Plugin is not installed");
      if (plugin.protectedOfficial) fail("protected_plugin_operation_denied", "Protected official plugins cannot be disabled");
      if (plugin.lifecycleState === "disabled") return publicPlugin(plugin);
      await this.#repository.beginOperation({ pluginId, operationKey, kind: "disable", fromVersion: plugin.currentVersion, toVersion: null, createdAt: this.#clock().toISOString() });
      let stage = "stop";
      try {
        await this.#nodeAgent.stop({ pluginId, version: plugin.currentVersion, slot: plugin.activeSlot, operationKey });
        const current = await this.#repository.setLifecycle({ pluginId, lifecycleState: "disabled", now: this.#clock().toISOString() });
        stage = "delegation-revocation";
        await this.#revokeDelegations(current, "plugin_disabled");
        const result = publicPlugin(current);
        await this.#repository.completeOperation(pluginId, operationKey, result, this.#clock().toISOString());
        await this.#audit({ action: "plugin.disabled", actorIdentityId: context.identityId, pluginId, version: plugin.currentVersion,
          operationKey, lifecycleState: result.lifecycleState, occurredAt: this.#clock().toISOString() });
        return result;
      } catch (error) {
        const failure = lifecycleFailure(error, stage);
        await this.#repository.updateOperation(pluginId, operationKey, { status: "failed", stage: failure.stage ?? stage, errorCode: failure.code });
        await this.#audit({ action: "plugin.lifecycle_failed", actorIdentityId: context.identityId, pluginId, version: plugin.currentVersion,
          operationKey, operation: "disable", errorCode: failure.code, stage: failure.stage ?? stage, outcome: "failed", occurredAt: this.#clock().toISOString() });
        throw failure;
      }
    });
  }

  async uninstall({ context, pluginId, operationKey, purgeData = false }) {
    requireAdministrator(context);
    requireOperationKey(operationKey);
    if (purgeData) fail("plugin_data_purge_separate", "Uninstall cannot delete persistent plugin data");
    return this.#repository.runExclusive(pluginId, async () => {
      const replay = await this.#repository.getOperation(pluginId, operationKey);
      if (replay?.status === "succeeded") return Object.freeze(structuredClone(replay.result));
      if (replay) fail("plugin_operation_in_progress", "This lifecycle operation already exists", { retryable: true, stage: replay.stage });
      const plugin = await this.#repository.getPlugin(pluginId);
      if (!plugin) fail("plugin_not_installed", "Plugin is not installed");
      if (plugin.protectedOfficial) fail("protected_plugin_operation_denied", "Protected official plugins cannot be uninstalled");
      await this.#repository.beginOperation({ pluginId, operationKey, kind: "uninstall", fromVersion: plugin.currentVersion, toVersion: null, createdAt: this.#clock().toISOString() });
      let stage = "stop";
      try {
        if (plugin.currentVersion) await this.#nodeAgent.stop({ pluginId, version: plugin.currentVersion, slot: plugin.activeSlot, operationKey });
        stage = "remove";
        await this.#nodeAgent.removeRuntime({ pluginId, retainData: true, operationKey });
        const current = await this.#repository.markUninstalled({ pluginId, now: this.#clock().toISOString() });
        stage = "delegation-revocation";
        await this.#revokeDelegations(current, "plugin_uninstalled");
        const result = publicPlugin(current);
        await this.#repository.completeOperation(pluginId, operationKey, result, this.#clock().toISOString());
        await this.#audit({ action: "plugin.uninstalled", actorIdentityId: context.identityId, pluginId, operationKey,
          lifecycleState: result.lifecycleState, occurredAt: this.#clock().toISOString() });
        return result;
      } catch (error) {
        const failure = lifecycleFailure(error, stage);
        await this.#repository.updateOperation(pluginId, operationKey, { status: "failed", stage: failure.stage ?? stage, errorCode: failure.code });
        await this.#audit({ action: "plugin.lifecycle_failed", actorIdentityId: context.identityId, pluginId, operationKey,
          operation: "uninstall", errorCode: failure.code, stage: failure.stage ?? stage, outcome: "failed", occurredAt: this.#clock().toISOString() });
        throw failure;
      }
    });
  }
}
