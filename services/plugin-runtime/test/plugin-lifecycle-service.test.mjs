import assert from "node:assert/strict";
import test from "node:test";

import { MemoryPluginLifecycleRepository } from "../src/memory-lifecycle-repository.mjs";
import { PluginLifecycleError, PluginLifecycleService } from "../src/plugin-lifecycle-service.mjs";

const context = { identityId: "admin-1", permissions: ["plugin:manage"] };
const digest = (character) => `sha256:${character.repeat(64)}`;

function verifiedImport(version, {
  publisherId = "example.publisher",
  official = false,
  protectedPlugin = false,
  migrations = [],
  memory = 134217728,
} = {}) {
  return {
    schemaVersion: 1,
    pluginId: "example.team-notes",
    pluginType: "ApplicationPlugin",
    version,
    sourceKind: "offline-bundle",
    manifestPayloadDigest: digest(version.startsWith("1") ? "1" : "2"),
    bundlePayloadDigest: digest(version.startsWith("1") ? "3" : "4"),
    state: "verified",
    manifest: {
      id: "example.team-notes",
      type: "ApplicationPlugin",
      version,
      official,
      publisher: { id: publisherId },
      images: [{ name: "notes-app", variants: [{ architecture: "linux/arm64/v8", digest: digest("a") }] }],
      resources: { unifiedMemoryBytes: memory },
      health: {
        startup: { path: "/health/startup" },
        readiness: { path: "/health/ready" },
        liveness: { path: "/health/live" },
      },
      migrations,
      extensions: protectedPlugin ? { lifecycle: { protected: true } } : {},
    },
  };
}

function fixtures(imports, {
  health = {},
  migrationFailure,
  retireFailure = false,
  healthHook,
  healthSink = null,
  onHealthSinkError = async () => {},
  audit = async () => {},
  delegationRevoker = null,
  lifecycleAuthority = null,
  startFailure = null,
} = {}) {
  const repository = new MemoryPluginLifecycleRepository();
  const events = [];
  const migrationEvents = [];
  const records = new Map(imports.map((item) => [`${item.pluginId}@${item.version}`, item]));
  const nodeAgent = {
    async stage(input) { events.push(["stage", input.version, input.slot, input.sandbox]); },
    async start(input) { events.push(["start", input.version, input.slot]); if (startFailure) throw startFailure; },
    async waitHealthy(input) {
      events.push(["health", input.version, input.requiredConsecutive]);
      await healthHook?.(input, repository);
      return health[input.version] ?? { healthy: true, consecutive: 3, observations: 3 };
    },
    async promote(input) { events.push(["promote", input.version, input.slot]); },
    async retire(input) {
      events.push(["retire", input.version, input.slot]);
      if (retireFailure) throw new Error("retire failed");
    },
    async stop(input) { events.push(["stop", input.version, input.slot]); },
    async removeStaged(input) { events.push(["remove-staged", input.version, input.slot]); },
    async removeRuntime(input) { events.push(["remove-runtime", input.retainData]); },
  };
  const migrationRunner = {
    async begin(input) {
      migrationEvents.push(["begin", input.fromVersion, input.toVersion, input.dataNamespace]);
      return {
        async apply(migration) {
          migrationEvents.push(["apply", migration.id]);
          if (migration.id === migrationFailure) throw new Error("migration failed");
        },
        async commit() { migrationEvents.push(["commit"]); },
        async rollback() { migrationEvents.push(["rollback"]); },
      };
    },
  };
  const service = new PluginLifecycleService({
    verifiedImports: { async get(pluginId, version) { return structuredClone(records.get(`${pluginId}@${version}`) ?? null); } },
    repository,
    nodeAgent,
    migrationRunner,
    sandboxPolicy: {
      async compile(input) {
        return { schemaVersion: 1, pluginId: input.pluginId, version: input.version, security: { readOnlyRoot: true } };
      },
    },
    clock: () => new Date("2026-08-11T00:00:00.000Z"),
    healthSink,
    onHealthSinkError,
    audit,
    delegationRevoker,
    lifecycleAuthority,
  });
  return { service, repository, events, migrationEvents };
}

function input(version, operationKey) {
  return { context, pluginId: "example.team-notes", version, operationKey };
}

function expectCode(code) {
  return (error) => error instanceof PluginLifecycleError && error.code === code;
}

test("staged install migrates, proves three healthy observations, and atomically activates blue", async () => {
  const migration = { id: "000001_initialize_notes", transactional: true, reversible: true };
  const setup = fixtures([verifiedImport("1.0.0", { migrations: [migration] })]);
  const result = await setup.service.install(input("1.0.0", "install-0001"));
  assert.equal(result.currentVersion, "1.0.0");
  assert.equal(result.activeSlot, "blue");
  assert.equal(result.lifecycleState, "enabled");
  assert.deepEqual(setup.events.slice(0, 4).map((item) => item[0]), ["stage", "start", "health", "promote"]);
  assert.deepEqual(setup.events[0][3], {
    schemaVersion: 1,
    pluginId: "example.team-notes",
    version: "1.0.0",
    security: { readOnlyRoot: true },
  });
  assert.deepEqual(setup.migrationEvents.map((item) => item[0]), ["begin", "apply", "commit"]);
  const plugin = await setup.repository.getPlugin("example.team-notes");
  assert.equal(plugin.versions["1.0.0"].installState, "healthy");
  assert.equal(plugin.migrations[0].status, "committed");
  const replay = await setup.service.install(input("1.0.0", "install-0001"));
  assert.deepEqual(replay, result);
  assert.equal(setup.events.filter((item) => item[0] === "stage").length, 1);
});

test("lifecycle failure retains only a bounded stable infrastructure cause code", async () => {
  const failure = new Error("sensitive transport detail"); failure.code = "node_agent_transport_unavailable";
  const setup = fixtures([verifiedImport("1.0.0")], { startFailure: failure });
  await assert.rejects(setup.service.install(input("1.0.0", "install-cause-0001")),
    (error) => error instanceof PluginLifecycleError && error.code === "plugin_lifecycle_failed"
      && error.stage === "startup" && error.causeCode === "node_agent_transport_unavailable"
      && !error.message.includes("sensitive"));
});

test("upgrade leaves old version active until green is healthy, then retires old only after cutover", async () => {
  const imports = [verifiedImport("1.0.0"), verifiedImport("2.0.0")];
  let observedDuringHealth;
  const setup = fixtures(imports, {
    async healthHook(input, repository) {
      if (input.version === "2.0.0") observedDuringHealth = await repository.getPlugin("example.team-notes");
    },
  });
  await setup.service.install(input("1.0.0", "install-0002"));
  const upgraded = await setup.service.upgrade(input("2.0.0", "upgrade-0002"));
  assert.equal(observedDuringHealth.currentVersion, "1.0.0");
  assert.equal(observedDuringHealth.activeSlot, "blue");
  assert.equal(upgraded.currentVersion, "2.0.0");
  assert.equal(upgraded.activeSlot, "green");
  const promoteIndex = setup.events.findIndex((event) => event[0] === "promote" && event[1] === "2.0.0");
  const retireIndex = setup.events.findIndex((event) => event[0] === "retire" && event[1] === "1.0.0");
  assert.ok(promoteIndex >= 0 && retireIndex > promoteIndex);
  const plugin = await setup.repository.getPlugin("example.team-notes");
  assert.equal(plugin.versions["1.0.0"].installState, "retired");
});

test("failed upgrade health rolls back the migration session and keeps the old slot active", async () => {
  const migration = { id: "000002_upgrade_notes", transactional: true, reversible: true };
  const setup = fixtures([
    verifiedImport("1.0.0"),
    verifiedImport("2.0.0", { migrations: [migration] }),
  ], { health: { "2.0.0": { healthy: false, consecutive: 1 } } });
  await setup.service.install(input("1.0.0", "install-0003"));
  const dataBefore = (await setup.repository.getPlugin("example.team-notes")).data;
  await assert.rejects(setup.service.upgrade(input("2.0.0", "upgrade-0003")), expectCode("plugin_health_failed"));
  const plugin = await setup.repository.getPlugin("example.team-notes");
  assert.equal(plugin.currentVersion, "1.0.0");
  assert.equal(plugin.activeSlot, "blue");
  assert.equal(plugin.versions["2.0.0"].installState, "failed");
  assert.deepEqual(plugin.data, dataBefore);
  assert.equal(plugin.migrations.find((item) => item.version === "2.0.0").status, "rolled_back");
  assert.ok(setup.migrationEvents.some((item) => item[0] === "rollback"));
  assert.ok(setup.migrationEvents.some((item) => item[0] === "begin" && item[3] === "plugin.example.team-notes"));
  assert.ok(setup.events.some((item) => item[0] === "remove-staged" && item[1] === "2.0.0"));
});

test("migration failure never starts or cuts over the staged version", async () => {
  const migration = { id: "000002_break_notes", transactional: true, reversible: true };
  const setup = fixtures([
    verifiedImport("1.0.0"),
    verifiedImport("2.0.0", { migrations: [migration] }),
  ], { migrationFailure: migration.id });
  await setup.service.install(input("1.0.0", "install-0004"));
  await assert.rejects(setup.service.upgrade(input("2.0.0", "upgrade-0004")), expectCode("plugin_lifecycle_failed"));
  const plugin = await setup.repository.getPlugin("example.team-notes");
  assert.equal(plugin.currentVersion, "1.0.0");
  assert.equal(plugin.migrations.find((item) => item.version === "2.0.0").status, "failed");
  assert.equal(setup.events.some((item) => item[0] === "start" && item[1] === "2.0.0"), false);
});

test("disable and enable are administrator-only, idempotent, and health-gated", async () => {
  const setup = fixtures([verifiedImport("1.0.0")]);
  await assert.rejects(
    setup.service.install({ ...input("1.0.0", "install-0005"), context: { permissions: [] } }),
    expectCode("plugin_administrator_required"),
  );
  await setup.service.install(input("1.0.0", "install-0005"));
  const disabled = await setup.service.disable({ context, pluginId: "example.team-notes", operationKey: "disable-0005" });
  assert.equal(disabled.lifecycleState, "disabled");
  const enabled = await setup.service.enable({ context, pluginId: "example.team-notes", operationKey: "enable-0005" });
  assert.equal(enabled.lifecycleState, "enabled");
  assert.ok(setup.events.some((item) => item[0] === "health" && item[1] === "1.0.0"));
});

test("lifecycle transitions revoke plugin delegations with in-process generation-bound authority", async () => {
  const revocations = [];
  const lifecycleAuthority = {
    issuePluginLifecycle(facts) { return Object.freeze({ kind: "plugin-lifecycle", facts: Object.freeze(structuredClone(facts)) }); },
  };
  const delegationRevoker = {
    async revokeForPlugin(value) {
      assert.equal(value.authority.kind, "plugin-lifecycle");
      assert.equal(value.authority.facts.pluginId, value.pluginId);
      revocations.push({ reason: value.reason, generation: value.authority.facts.pluginGeneration });
    },
  };
  const setup = fixtures([verifiedImport("1.0.0"), verifiedImport("2.0.0")], { delegationRevoker, lifecycleAuthority });
  await setup.service.install(input("1.0.0", "install-revoke-001"));
  await setup.service.disable({ context, pluginId: "example.team-notes", operationKey: "disable-revoke-001" });
  await setup.service.enable({ context, pluginId: "example.team-notes", operationKey: "enable-revoke-001" });
  await setup.service.upgrade(input("2.0.0", "upgrade-revoke-001"));
  await setup.service.uninstall({ context, pluginId: "example.team-notes", operationKey: "remove-revoke-001" });
  assert.deepEqual(revocations, [
    { reason: "plugin_version_changed", generation: 1 },
    { reason: "plugin_disabled", generation: 1 },
    { reason: "plugin_reenabled", generation: 1 },
    { reason: "plugin_version_changed", generation: 2 },
    { reason: "plugin_uninstalled", generation: 3 },
  ]);
});

test("delegation revocation failure prevents re-enable and leaves the plugin disabled", async () => {
  let rejectedReason = null;
  const setup = fixtures([verifiedImport("1.0.0")], {
    lifecycleAuthority: { issuePluginLifecycle: (facts) => Object.freeze({ facts: Object.freeze(structuredClone(facts)) }) },
    delegationRevoker: { async revokeForPlugin({ reason }) { if (reason === rejectedReason) throw new Error("delegation store unavailable"); } },
  });
  await setup.service.install(input("1.0.0", "install-revoke-002"));
  await setup.service.disable({ context, pluginId: "example.team-notes", operationKey: "disable-revoke-002" });
  rejectedReason = "plugin_reenabled";
  await assert.rejects(
    setup.service.enable({ context, pluginId: "example.team-notes", operationKey: "enable-revoke-002" }),
    (error) => error instanceof PluginLifecycleError && error.code === "plugin_lifecycle_failed" && error.stage === "delegation-revocation",
  );
  assert.equal((await setup.repository.getPlugin("example.team-notes")).lifecycleState, "disabled");
  const operation = await setup.repository.getOperation("example.team-notes", "enable-revoke-002");
  assert.equal(operation.status, "failed");
  assert.equal(operation.stage, "delegation-revocation");
  assert.equal(setup.events.some((event) => event[0] === "start" && event[1] === "1.0.0" && event[2] === "blue"), true);
  assert.equal(setup.events.filter((event) => event[0] === "start" && event[1] === "1.0.0").length, 1);
});

test("failed enable remains disabled, stops the unhealthy runtime, and closes the operation", async () => {
  const health = {};
  const setup = fixtures([verifiedImport("1.0.0")], { health });
  await setup.service.install(input("1.0.0", "install-0009"));
  await setup.service.disable({ context, pluginId: "example.team-notes", operationKey: "disable-0009" });
  health["1.0.0"] = { healthy: false, consecutive: 1 };
  await assert.rejects(
    setup.service.enable({ context, pluginId: "example.team-notes", operationKey: "enable-0009" }),
    expectCode("plugin_health_failed"),
  );
  assert.equal((await setup.repository.getPlugin("example.team-notes")).lifecycleState, "disabled");
  assert.equal((await setup.repository.getOperation("example.team-notes", "enable-0009")).status, "failed");
  assert.ok(setup.events.some((item) => item[0] === "stop" && item[1] === "1.0.0"));
});

test("protected official plugins can upgrade only in-place and cannot be disabled or uninstalled", async () => {
  const official = { publisherId: "teamaibox", official: true, protectedPlugin: true };
  const setup = fixtures([
    verifiedImport("1.0.0", official),
    verifiedImport("2.0.0", official),
    verifiedImport("3.0.0", { publisherId: "attacker.publisher" }),
  ]);
  const installed = await setup.service.install(input("1.0.0", "install-0006"));
  assert.equal(installed.protectedOfficial, true);
  await assert.rejects(setup.service.disable({ context, pluginId: "example.team-notes", operationKey: "disable-0006" }), expectCode("protected_plugin_operation_denied"));
  await assert.rejects(setup.service.uninstall({ context, pluginId: "example.team-notes", operationKey: "remove-0006" }), expectCode("protected_plugin_operation_denied"));
  assert.equal((await setup.service.upgrade(input("2.0.0", "upgrade-0006"))).currentVersion, "2.0.0");
  await assert.rejects(setup.service.upgrade(input("3.0.0", "upgrade-0007")), expectCode("protected_plugin_takeover_denied"));
});

test("uninstall removes runtime only, preserves data and migration evidence, and refuses implicit purge", async () => {
  const migration = { id: "000001_initialize_notes", transactional: true, reversible: true };
  const setup = fixtures([verifiedImport("1.0.0", { migrations: [migration] })]);
  await setup.service.install(input("1.0.0", "install-0007"));
  await assert.rejects(
    setup.service.uninstall({ context, pluginId: "example.team-notes", operationKey: "remove-0007", purgeData: true }),
    expectCode("plugin_data_purge_separate"),
  );
  const removed = await setup.service.uninstall({ context, pluginId: "example.team-notes", operationKey: "remove-0008" });
  assert.equal(removed.lifecycleState, "uninstalled");
  assert.equal(removed.dataRetentionState, "retained");
  const plugin = await setup.repository.getPlugin("example.team-notes");
  assert.equal(plugin.data.namespace, "plugin.example.team-notes");
  assert.equal(plugin.data.generation, 1);
  assert.equal(plugin.data.retentionState, "retained");
  assert.equal(plugin.migrations.length, 1);
  assert.ok(setup.events.some((item) => item[0] === "remove-runtime" && item[1] === true));
});

test("post-cutover old-runtime cleanup is reconciled without rolling back the healthy new version", async () => {
  const setup = fixtures([verifiedImport("1.0.0"), verifiedImport("2.0.0")], { retireFailure: true });
  await setup.service.install(input("1.0.0", "install-0008"));
  const result = await setup.service.upgrade(input("2.0.0", "upgrade-0008"));
  assert.equal(result.currentVersion, "2.0.0");
  assert.equal(result.retirementPending, true);
});

test("plugin probe outcomes publish health without coupling diagnostic availability", async () => {
  const observations = [];
  const setup = fixtures([verifiedImport("1.0.0")], { healthSink: { async recordPluginHealth(value) { observations.push(value); } } });
  const installed = await setup.service.install(input("1.0.0", "install-health-001"));
  assert.equal(installed.lifecycleState, "enabled");
  assert.equal(observations[0].health.healthy, true);
  assert.equal(observations[0].pluginId, "example.team-notes");

  const failures = [];
  const isolated = fixtures([verifiedImport("1.0.0")], { healthSink: { async recordPluginHealth() { throw new Error("diagnostics unavailable"); } },
    onHealthSinkError: async (error, facts) => failures.push([error.message, facts.operation]) });
  const accepted = await isolated.service.install(input("1.0.0", "install-health-002"));
  assert.equal(accepted.currentVersion, "1.0.0");
  assert.deepEqual(failures, [["diagnostics unavailable", "install"]]);
});

test("plugin lifecycle success and failure emit bounded administrative audit events", async () => {
  const audits = [], health = {};
  const setup = fixtures([verifiedImport("1.0.0")], { health, audit: async (event) => audits.push(event) });
  await setup.service.install(input("1.0.0", "install-audit-001"));
  await setup.service.disable({ context, pluginId: "example.team-notes", operationKey: "disable-audit-001" });
  health["1.0.0"] = { healthy: false, consecutive: 1 };
  await assert.rejects(setup.service.enable({ context, pluginId: "example.team-notes", operationKey: "enable-audit-001" }), expectCode("plugin_health_failed"));
  assert.deepEqual(audits.map((event) => event.action), ["plugin.installed", "plugin.disabled", "plugin.lifecycle_failed"]);
  assert.equal(audits.at(-1).outcome, "failed");
  assert.equal(JSON.stringify(audits).includes("manifest"), false);
});
