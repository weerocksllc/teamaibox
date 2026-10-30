import assert from "node:assert/strict";
import test from "node:test";

import { PostgresManagedNodeRepository } from "../src/postgres-managed-node-repository.mjs";

const NODE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const nodeRow = { id: NODE, node_key: "spark-node-02", architecture: "arm64", trust_kind: "managed_appliance", lifecycle_state: "joining", generation: 1, agent_version: "1.2.3", labels: {}, capacity: {}, health: { state: "unknown" },
  appliance_role: "appliance-core", desired_state: { profileIds: [] }, desired_state_revision: 3, observed_state_revision: 2,
  maintenance_generation: 4, recovery_state: "recovering", recovery_reason_code: "worker_restart",
  inventory: null, inventory_digest: null, last_seen_at: null, certificate_fingerprint: Buffer.from("3".repeat(64), "hex"), certificate_not_after: "2027-08-11T00:00:00Z", certificate_revoked_at: null,
  revision: 1, created_at: "2026-08-11T08:02:00Z", updated_at: "2026-08-11T08:02:00Z" };

test("PostgreSQL stale reconciliation increments node generation in one update", async () => {
  const calls = [], database = { async query() { return { rows: [] }; }, async transaction(operation) { return operation({ async query(sql, params) { calls.push([sql, params]); return { rows: [{ ...nodeRow, lifecycle_state: "offline", generation: 2, revision: 2, health: { state: "offline" } }] }; } }); } };
  const repository = new PostgresManagedNodeRepository({ database, localNodeId: NODE });
  const fenced = await repository.fenceStale({ nodeId: NODE, cutoff: new Date("2026-08-11T08:00:00Z"), now: new Date("2026-08-11T08:01:00Z") });
  assert.equal(fenced[0].generation, 2); assert.equal(fenced[0].lifecycleState, "offline");
  assert.match(calls[0][0], /generation=generation\+1/); assert.match(calls[0][0], /COALESCE\(last_seen_at,created_at\) < \$1/); assert.match(calls[0][0], /'draining'/);
});

test("startup quarantines old availability without changing generation, timestamps, or disabled states", async () => {
  const calls = [], database = { async query(sql, params) { calls.push([sql, params]); return { rows: [] }; }, async transaction() {} };
  const repository = new PostgresManagedNodeRepository({ database, localNodeId: NODE });
  const now = new Date("2026-08-11T09:00:00Z");
  await repository.awaitFreshHeartbeats({ now, nodeId: NODE });
  const [sql, args] = calls[0];
  assert.match(sql, /WHEN lifecycle_state='ready' THEN 'joining'/);
  assert.match(sql, /trust_kind='managed_appliance'/);
  assert.match(sql, /lifecycle_state IN \('ready','joining','draining'\)/);
  assert.match(sql, /last_seen_at IS NULL OR last_seen_at < \$1/);
  assert.doesNotMatch(sql.split("WHERE")[0], /generation\s*=|last_seen_at\s*=|capacity\s*=/);
  assert.deepEqual(args, [now, NODE]);
});

test("repository rejects foreign identities before accessing persistence", async () => {
  const database = { query: () => assert.fail("unexpected query"), transaction: () => assert.fail("unexpected transaction") };
  const repository = new PostgresManagedNodeRepository({ database, localNodeId: NODE });
  const foreign = "018f6f18-24d7-7c21-9b62-8c0174199599";
  for (const operation of [() => repository.findNode(foreign), () => repository.updateNode(foreign, 1, {}),
    () => repository.recordHeartbeat(foreign, 1, {}), () => repository.awaitFreshHeartbeats({ nodeId: foreign }),
    () => repository.fenceStale({ nodeId: foreign })]) {
    await assert.rejects(operation, { code: "appliance_node_mismatch" });
  }
});

const installedIdentity = { nodeKey: nodeRow.node_key, certificateFingerprint: `sha256:${"3".repeat(64)}`,
  certificateNotAfter: nodeRow.certificate_not_after, agentVersion: "1.2.3" };

test("fresh appliance initialization creates only the configured identity without enrollment", async () => {
  const queries = [];
  const database = { query() {}, transaction: async operation => operation({ async query(sql, values) {
    queries.push({ sql, values }); return { rows: [nodeRow] };
  } }) };
  const repository = new PostgresManagedNodeRepository({ database, localNodeId: NODE });
  assert.equal((await repository.ensureLocalAppliance(installedIdentity)).nodeId, NODE);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(queries[0].sql, /'appliance-core',false/);
  assert.doesNotMatch(queries[0].sql, /enrollment|node_groups|UPDATE/);
  assert.equal(queries[0].values[0], NODE);
});

test("repeated appliance initialization preserves every existing field and guest reference", async () => {
  const existing = { ...nodeRow, generation: 12, revision: 70, lifecycle_state: "draining", agent_version: "older-installed-version",
    labels: { displayName: "My device" }, capacity: { cpuMillis: 5000 }, desired_state: { phoneId: "saved-phone", volumeId: "saved-volume" } };
  const before = JSON.stringify(existing), queries = [];
  const database = { query() {}, transaction: async operation => operation({ async query(sql, values) {
    queries.push({ sql, values }); return { rows: sql.startsWith("INSERT") ? [] : [existing] };
  } }) };
  const repository = new PostgresManagedNodeRepository({ database, localNodeId: NODE });
  const saved = await repository.ensureLocalAppliance(installedIdentity);
  assert.equal(saved.generation, 12); assert.equal(saved.revision, 70); assert.equal(saved.lifecycleState, "draining");
  assert.equal(saved.agentVersion, "older-installed-version"); assert.deepEqual(saved.desiredState, existing.desired_state);
  assert.equal(JSON.stringify(existing), before); assert.equal(queries.length, 2);
  assert.ok(queries.every(({ sql }) => !/^UPDATE|^DELETE/.test(sql)));
});

test("conflicting appliance initialization fails rather than replacing saved identity", async () => {
  for (const override of [{ node_key: "other-appliance" }, { appliance_role: "extension-pool" },
    { certificate_fingerprint: Buffer.alloc(32, 4) }, { lifecycle_state: "removed" }]) {
    const database = { query() {}, transaction: async operation => operation({ async query(sql) {
      return { rows: sql.startsWith("INSERT") ? [] : [{ ...nodeRow, ...override }] };
    } }) };
    const repository = new PostgresManagedNodeRepository({ database, localNodeId: NODE });
    await assert.rejects(repository.ensureLocalAppliance(installedIdentity), { code: "appliance_identity_conflict" });
  }
});
