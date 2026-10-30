import assert from "node:assert/strict";
import test from "node:test";

import { PostgresRoutingPolicyRepository } from "../src/postgres-routing-policy-repository.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const NOW = new Date("2026-08-11T12:30:00Z");
const compact = (sql) => sql.replace(/\s+/g, " ").trim();
function row(overrides = {}) { return { id: uuid(1), policy_key: "overflow.default", display_name: "Default overflow", selector: { capabilityId: null, operation: null, teamId: null, dataClasses: [] }, priority: "100", mode: "internal_first", external_processing_approved: true, pinned_target_id: null, pinned_profile_id: null, target_weights: {}, enabled: true, revision: "1", created_by: uuid(2), created_at: NOW, updated_at: NOW, ...structuredClone(overrides) }; }
class Database { queries = []; transactions = 0; constructor(handler) { this.handler = handler; } async query(sql, parameters = []) { return this.handler(compact(sql), parameters); } async transaction(operation) { this.transactions += 1; return operation({ query: async (sql, parameters = []) => { const normalized = compact(sql); this.queries.push({ sql: normalized, parameters }); return this.handler(normalized, parameters); } }); } }

test("PostgreSQL routing policy creation serializes the key and persists explicit mode facts", async () => {
  const database = new Database((sql) => {
    if (sql.includes("WHERE policy_key=$1 FOR UPDATE")) return { rows: [] };
    if (sql.startsWith("INSERT INTO compute.routing_policies")) return { rows: [row()] };
    return { rows: [] };
  });
  const repository = new PostgresRoutingPolicyRepository({ database });
  const created = await repository.create({ policyId: uuid(1), policyKey: "overflow.default", displayName: "Default overflow", selector: row().selector, priority: 100, routing: { mode: "internal_first", externalProcessingApproved: true, pinnedTargetId: null, pinnedProfileId: null, targetWeights: {} }, enabled: true, createdBy: uuid(2), createdAt: NOW });
  assert.equal(created.routing.mode, "internal_first");
  assert.equal(created.routing.allowExternal, true);
  assert.equal(database.transactions, 1);
  assert.ok(database.queries[0].sql.includes("FOR UPDATE"));
});

test("PostgreSQL routing policy updates are revision fenced", async () => {
  const database = new Database((sql) => {
    if (sql.includes("WHERE id=$1 FOR UPDATE")) return { rows: [row()] };
    if (sql.includes("policy_key=$1 AND id<>$2")) return { rows: [] };
    if (sql.startsWith("UPDATE compute.routing_policies")) return { rows: [row({ revision: "2", mode: "external_first" })] };
    return { rows: [] };
  });
  const result = await new PostgresRoutingPolicyRepository({ database }).update(uuid(1), 1, { policyKey: "overflow.default", displayName: "Default overflow", selector: row().selector, priority: 100, routing: { mode: "external_first", externalProcessingApproved: true, pinnedTargetId: null, pinnedProfileId: null, targetWeights: {} }, enabled: true, updatedAt: NOW });
  assert.equal(result.revision, 2);
  assert.equal(result.routing.mode, "external_first");
});

test("PostgreSQL routing policy repository requires transactions", () => {
  assert.throws(() => new PostgresRoutingPolicyRepository({ database: { query() {} } }), /query and transaction/);
});
