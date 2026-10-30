import assert from "node:assert/strict";
import test from "node:test";

import { PostgresPluginLifecycleRepository } from "../src/postgres-lifecycle-repository.mjs";

test('recovered catalog health is persisted only for the exact enabled active generation', async () => {
  const calls = [];let accepted = true;
  const database = {async query(sql,args) {calls.push({sql,args});return {rows:sql.includes('RETURNING s.slot') && accepted ? [{slot:'green'}] : []};},
    async transaction(fn){return fn(this);}};
  const repo = new PostgresPluginLifecycleRepository({database,lockManager:{runExclusive(){}}});
  const input = {pluginId:'official.virtual-phones',version:'0.1.17',slot:'green',
    health:{healthy:true,runtimeGeneration:8,containerId:'new'},now:'2026-10-08T10:00:00Z'};
  await repo.recordRecoveredApplication(input);
  assert.equal(calls.length,2);assert.equal(JSON.parse(calls[0].args[3]).containerId,'new');
  assert.match(calls[0].sql,/p.current_version_id=v.id/);
  assert.match(calls[0].sql,/runtimeGeneration/);
  accepted=false;
  await assert.rejects(repo.recordRecoveredApplication(input),/binding changed/);
  assert.equal(calls.length,3);
  await assert.rejects(repo.recordRecoveredApplication({...input,health:{...input.health,healthy:false}}),/invalid/);
});

test('recovery updates only the still-enabled exact active slot after removal', async () => {
  let row = {health:{runtimeGeneration:5,containerId:'old',healthy:true},slot_state:'active',
    lifecycle_state:'enabled',active_slot:'green',current_version:'0.1.17'};
  const writes = [];
  const database = {async query(sql,args) {
    if (sql.includes('SELECT s.health')) return {rows:row ? [structuredClone(row)] : []};
    writes.push({sql,args});return {rows:[]};
  },async transaction(fn){return fn(this);}};
  const repo = new PostgresPluginLifecycleRepository({database,lockManager:{runExclusive(){}}});
  const input = {pluginId:'official.virtual-phones',version:'0.1.17',slot:'green',previousGeneration:5,currentGeneration:8};
  assert.equal(await repo.rebindRecoveredApplication(input),8);
  assert.deepEqual(writes[0].args,['official.virtual-phones','0.1.17','green',8]);
  assert.match(writes[0].sql,/health=jsonb_build_object/);
  for (const change of [{lifecycle_state:'disabled'},{active_slot:'blue'},{current_version:'0.1.18'},
    {slot_state:'retired'},{health:{runtimeGeneration:6}}]) {
    const old = row;row = {...row,...change};
    await assert.rejects(repo.rebindRecoveredApplication(input),/binding changed/);row = old;
  }
  assert.equal(writes.length,1);
  await assert.rejects(repo.rebindRecoveredApplication({...input,currentGeneration:4}),/generation/);
});

test('runtime generation is durable per slot; new slots use current connection, existing slots retain identity', async () => {
  let row = {health:null,slot_state:'staging'}, writes = 0;
  const database = {async query(sql, parameters) {
    if (sql.includes('SELECT s.health')) return {rows: row ? [structuredClone(row)] : []};
    if (sql.includes('UPDATE plugins.runtime_slots')) {writes++;row.health = {...row.health,runtimeGeneration:parameters[3]};return {rows:[]};}
    assert.fail('unexpected query');
  },async transaction(fn){return fn(this);}};
  const repo = new PostgresPluginLifecycleRepository({database,lockManager:{runExclusive(){}}});
  const input = {pluginId:'official.test',version:'1.0.0',slot:'blue',starting:true,legacyGeneration:5,currentGeneration:6};
  assert.equal(await repo.resolveRuntimeGeneration(input),6);assert.equal(writes,1);
  assert.equal(await repo.resolveRuntimeGeneration({...input,currentGeneration:7}),6);assert.equal(writes,1);
  assert.equal(await repo.resolveRuntimeGeneration({...input,starting:false}),6);
  row = {health:{healthy:true},slot_state:'active'};
  assert.equal(await repo.resolveRuntimeGeneration({...input,starting:false}),5);assert.equal(writes,1);
  row.health.runtimeGeneration = 7;
  await assert.rejects(repo.resolveRuntimeGeneration(input),/binding/);
  row = null;
  await assert.rejects(repo.resolveRuntimeGeneration(input),/missing/);
  for (const currentGeneration of [0,-1,4,6.5]) await assert.rejects(repo.resolveRuntimeGeneration({...input,currentGeneration}),/generation/);
});

test("runtime routing uses one current-version query without version/migration history", async () => {
  const calls = [];
  const repository = new PostgresPluginLifecycleRepository({
    database: { async transaction() { assert.fail("read-only query expected"); }, async query(sql, parameters) {
      calls.push({ sql, parameters }); return { rows: [{ plugin_key: "official.wireless-casting", plugin_type: "application",
        current_version: "0.1.9", active_slot: "green", lifecycle_state: "enabled", generation: "10" }] };
    } }, lockManager: { runExclusive() { assert.fail("read-only query expected"); } },
  });
  assert.deepEqual(await repository.listRuntimePlugins({ pluginKey: "official.wireless-casting" }), [{
    pluginId: "official.wireless-casting", pluginType: "ApplicationPlugin", currentVersion: "0.1.9",
    activeSlot: "green", lifecycleState: "enabled", generation: 10,
  }]);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].parameters, ["official.wireless-casting"]);
  assert.doesNotMatch(calls[0].sql, /migrations|runtime_slots|SELECT p\.\*/);
  await repository.listRuntimePlugins(); assert.deepEqual(calls[1].parameters, [null]);
  await assert.rejects(repository.listRuntimePlugins({ pluginKey: "../bad" }), /invalid/);
});

test("PostgreSQL lifecycle cutover locks the plugin row and atomically changes current version and slot", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(callback) {
      return callback({
        async query(sql, parameters) {
          calls.push({ sql, parameters });
          if (/SELECT plugins\.id, current\.version/.test(sql)) {
            return { rows: [{ id: "plugin-uuid", current_version: "1.0.0", active_slot: "blue", lifecycle_state: "enabled", generation: "3" }] };
          }
          if (/SELECT versions\.id/.test(sql)) return { rows: [{ id: "version-uuid" }] };
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresPluginLifecycleRepository({
    database,
    lockManager: { async runExclusive(_key, callback) { return callback(); } },
  });
  const previous = await repository.activateVersion({
    pluginId: "example.team-notes",
    version: "2.0.0",
    slot: "green",
    operationKey: "upgrade-atomic-001",
    now: "2026-08-11T00:00:00.000Z",
  });
  assert.deepEqual(previous, {
    currentVersion: "1.0.0",
    activeSlot: "blue",
    lifecycleState: "enabled",
    generation: 3,
  });
  assert.match(calls[0].sql, /FOR UPDATE OF plugins/);
  const cutover = calls.find(({ sql }) => /SET current_version_id = \$2/.test(sql));
  assert.ok(cutover);
  assert.match(cutover.sql, /active_slot = \$3/);
  assert.match(cutover.sql, /generation = generation \+ 1/);
  assert.deepEqual(cutover.parameters, ["plugin-uuid", "version-uuid", "green"]);
});

test("PostgreSQL lifecycle staging proves the verified import digests before creating a runtime slot", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(callback) {
      return callback({
        async query(sql, parameters) {
          calls.push({ sql, parameters });
          if (/SELECT plugins\.id AS plugin_id/.test(sql)) return { rows: [{ plugin_id: "plugin-uuid", import_id: "import-uuid" }] };
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresPluginLifecycleRepository({
    database,
    lockManager: { async runExclusive(_key, callback) { return callback(); } },
  });
  await repository.stageVersion({
    pluginId: "example.team-notes",
    version: "2.0.0",
    manifestPayloadDigest: `sha256:${"1".repeat(64)}`,
    bundlePayloadDigest: `sha256:${"2".repeat(64)}`,
    manifest: { id: "example.team-notes" },
    slot: "green",
    operationKey: "upgrade-stage-001",
    now: "2026-08-11T00:00:00.000Z",
  });
  assert.match(calls[0].sql, /imports\.manifest_payload_sha256 = \$3/);
  assert.match(calls[0].sql, /imports\.bundle_payload_sha256 = \$4/);
  assert.ok(calls.some(({ sql }) => /INSERT INTO plugins\.runtime_slots/.test(sql)));
  assert.ok(calls.some(({ sql }) => /lifecycle_state = 'staged'/.test(sql)));
});

test("PostgreSQL lifecycle repository delegates operation serialization to the configured lock manager", async () => {
  const keys = [];
  const repository = new PostgresPluginLifecycleRepository({
    database: { async query() { return { rows: [] }; }, async transaction(callback) { return callback({ query: this.query }); } },
    lockManager: {
      async runExclusive(key, callback) {
        keys.push(key);
        return callback();
      },
    },
  });
  assert.equal(await repository.runExclusive("example.team-notes", async () => "done"), "done");
  assert.deepEqual(keys, ["plugin-lifecycle:example.team-notes"]);
});

test("PostgreSQL lifecycle repository requires durable storage and a lock manager", () => {
  assert.throws(() => new PostgresPluginLifecycleRepository({ database: {}, lockManager: {} }), /lock manager/);
});

test("PostgreSQL lifecycle repository lists complete plugins in stable key order", async () => {
  const calls = [];
  const database = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (/SELECT plugin_key\s+FROM plugins\.plugins\s+ORDER BY plugin_key/.test(sql)) return { rows: [{ plugin_key: "example.alpha" }, { plugin_key: "example.beta" }] };
      if (/SELECT p\.\*, current\.version AS current_version/.test(sql)) return { rows: [{ id: parameters[0], plugin_key: parameters[0], plugin_type: "application", publisher: "example",
        protected: false, lifecycle_state: "uninstalled", current_version: null, active_slot: null, generation: 1, data_namespace: `plugin.${parameters[0]}`,
        data_retention_state: "retained", created_at: new Date("2026-08-14T00:00:00Z"), updated_at: new Date("2026-08-14T00:00:00Z") }] };
      return { rows: [] };
    },
    async transaction(callback) { return callback(this); },
  };
  const repository = new PostgresPluginLifecycleRepository({ database, lockManager: { async runExclusive(_key, callback) { return callback(); } } });
  assert.deepEqual((await repository.listPlugins()).map((item) => item.pluginId), ["example.alpha", "example.beta"]);
  assert.equal(calls.filter((call) => /SELECT p\.\*/.test(call.sql)).length, 2);
});
