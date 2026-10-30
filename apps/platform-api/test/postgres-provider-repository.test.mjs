import assert from "node:assert/strict";
import test from "node:test";

import { PostgresExternalProviderRepository } from "../src/providers/postgres-provider-repository.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const NOW = new Date("2026-08-11T11:00:00Z");
function compact(sql) { return sql.replace(/\s+/g, " ").trim(); }
function row(overrides = {}) {
  return {
    id: uuid(1), provider_key: "external.lab", display_name: "External Lab", provider_kind: "external_openai",
    endpoint_uri: "https://a100.lab.example/v1", secret_ref: `provider.${uuid(1)}.auth`, auth_scheme: "bearer", auth_header_name: "Authorization",
    ca_secret_ref: null, trust_policy: { mode: "system_ca", serverName: null }, data_policy: "approved_external",
    allowed_data_classes: ["public", "internal"], concurrency_limit: "8", rate_limits: { requestsPerMinute: 120, tokensPerMinute: 2_000_000 },
    timeout_policy: { connectMilliseconds: 2_000, requestMilliseconds: 60_000, idleStreamMilliseconds: 10_000 },
    execution_contract: { idempotencyMode: "none", replayAfterAcceptance: "prohibited", reconcileMode: "none", cancellationMode: "none", sideEffectClass: "none", idempotencyHeader: null, statusPathTemplate: null, cancelPathTemplate: null, cancelMethod: null },
    health_check: { path: "/models", intervalSeconds: 30, timeoutMilliseconds: 2_000, failureThreshold: 2 },
    health: { state: "unknown", latencyMilliseconds: null, errorCode: null, observedAt: null, consecutiveFailures: 0 },
    cost_accounting: { currency: "USD", inputMicrounitsPerMillionTokens: 100, outputMicrounitsPerMillionTokens: 200, imageMicrounitsPerRequest: 0, audioMicrounitsPerMinute: 0, accountingMode: "provider_reported" },
    lifecycle_state: "disabled", contract_state: "untested", contract_evidence_digest: null, contract_tested_at: null,
    contract_failed_checks: [], revision: "1", created_by: uuid(9), created_at: NOW, updated_at: NOW,
    configuration: { resourceControl: null },
    ...structuredClone(overrides),
  };
}
function mappingRow() { return { provider_id: uuid(1), model_profile_id: uuid(2), provider_model_name: "giant-llm", enabled: true, routing_weight: "100", operations: ["responses"], context_window: "131072", maximum_output_tokens: "8192", contract_state: "untested", limits: {} }; }
function value() {
  return {
    providerId: uuid(1), providerKey: "external.lab", displayName: "External Lab", endpoint: "https://a100.lab.example/v1",
    credentialSecretKey: `provider.${uuid(1)}.auth`, auth: { scheme: "bearer", headerName: "Authorization" }, caSecretKey: null,
    trust: { mode: "system_ca", serverName: null }, allowedDataClasses: ["public", "internal"],
    limits: { concurrency: 8, requestsPerMinute: 120, tokensPerMinute: 2_000_000 },
    timeouts: { connectMilliseconds: 2_000, requestMilliseconds: 60_000, idleStreamMilliseconds: 10_000 },
    executionContract: row().execution_contract, resourceControl: {
      mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
      statusPath: "/models/status", idleSeconds: 180,
    },
    healthCheck: { path: "/models", intervalSeconds: 30, timeoutMilliseconds: 2_000, failureThreshold: 2 },
    health: row().health, costAccounting: row().cost_accounting, lifecycleState: "disabled",
    modelMappings: [{ modelProfileId: uuid(2), providerModelName: "giant-llm", enabled: true, routingWeight: 100, operations: ["responses"], contextWindow: 131_072, maximumOutputTokens: 8_192 }],
    createdBy: uuid(9), createdAt: NOW,
  };
}
class Database {
  queries = []; transactions = 0;
  constructor(handler) { this.handler = handler; }
  async query(sql, parameters = []) { return this.handler(compact(sql), parameters); }
  async transaction(operation) { this.transactions += 1; return operation({ query: async (sql, parameters = []) => { const normalized = compact(sql); this.queries.push({ sql: normalized, parameters }); return this.handler(normalized, parameters); } }); }
}

test("PostgreSQL provider creation locks identity, verifies mappings, and stores only protected references", async () => {
  let inserted = false;
  const database = new Database((sql) => {
    if (sql.includes("WHERE provider_key=$1 FOR UPDATE")) return { rows: [] };
    if (sql.includes("FROM compute.model_profiles") && sql.includes("ANY($1::uuid[])")) return { rows: [{ id: uuid(2) }] };
    if (sql.startsWith("INSERT INTO compute.providers")) { inserted = true; return { rows: [] }; }
    if (sql.startsWith("INSERT INTO compute.provider_model_profiles")) return { rows: [] };
    if (inserted && sql.startsWith("SELECT * FROM compute.providers WHERE id=$1")) return { rows: [row()] };
    if (sql.includes("FROM compute.provider_model_profiles") && sql.includes("provider_id = $1")) return { rows: [mappingRow()] };
    return { rows: [] };
  });
  const created = await new PostgresExternalProviderRepository({ database }).create(value());
  assert.equal(created.providerKey, "external.lab");
  assert.equal(database.transactions, 1);
  const statements = database.queries.map((item) => item.sql);
  assert.ok(statements.findIndex((sql) => sql.includes("provider_key=$1 FOR UPDATE")) < statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.providers")));
  assert.equal(JSON.stringify(database.queries).includes("provider-secret-value"), false);
  assert.ok(JSON.stringify(database.queries).includes(`provider.${uuid(1)}.auth`));
  assert.ok(JSON.stringify(database.queries).includes("replayAfterAcceptance"));
  assert.ok(JSON.stringify(database.queries).includes("resourceControl"));
});

test("PostgreSQL contract result appends immutable evidence before changing routable state", async () => {
  let updated = false;
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT * FROM compute.providers WHERE id=$1")) return { rows: [row(updated ? { revision: "2", contract_state: "passed", contract_evidence_digest: Buffer.from("a".repeat(64), "hex"), contract_tested_at: NOW, health: { ...row().health, state: "healthy", observedAt: NOW.toISOString() } } : {})] };
    if (sql.includes("FROM compute.provider_model_profiles")) return { rows: [mappingRow()] };
    if (sql.startsWith("UPDATE compute.providers")) { updated = true; return { rows: [] }; }
    return { rows: [] };
  });
  const repository = new PostgresExternalProviderRepository({ database });
  const result = await repository.recordContractTest(uuid(1), 1, {
    lifecycleState: "disabled",
    health: { state: "healthy", latencyMilliseconds: 5, errorCode: null, observedAt: NOW, consecutiveFailures: 0 },
    contract: { state: "passed", evidenceDigest: `sha256:${"a".repeat(64)}`, testedAt: NOW, failedChecks: [] },
    updatedAt: NOW, actorIdentityId: uuid(9),
  });
  assert.equal(result.contract.state, "passed");
  const statements = database.queries.map((item) => item.sql);
  const contractEvidence = statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.provider_contract_test_runs"));
  const healthEvidence = statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.provider_health_events"));
  const update = statements.findIndex((sql) => sql.startsWith("UPDATE compute.providers"));
  assert.ok(contractEvidence >= 0 && healthEvidence > contractEvidence && update > healthEvidence);
});

test("PostgreSQL health refresh appends evidence without changing the configuration revision", async () => {
  let updated = false;
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT * FROM compute.providers WHERE id=$1")) return { rows: [row(updated
      ? { lifecycle_state: "healthy", health: { state: "healthy", latencyMilliseconds: 7, errorCode: null, observedAt: NOW.toISOString(), consecutiveFailures: 0 } }
      : { lifecycle_state: "degraded", contract_state: "passed" })] };
    if (sql.includes("FROM compute.provider_model_profiles")) return { rows: [mappingRow()] };
    if (sql.startsWith("UPDATE compute.providers")) { updated = true; return { rows: [] }; }
    return { rows: [] };
  });
  const result = await new PostgresExternalProviderRepository({ database }).recordHealth(uuid(1), {
    lifecycleState: "healthy",
    health: { state: "healthy", latencyMilliseconds: 7, errorCode: null, observedAt: NOW, consecutiveFailures: 0 },
  });
  assert.equal(result.lifecycleState, "healthy");
  assert.equal(result.revision, 1);
  assert.ok(database.queries.some((item) => item.sql.startsWith("INSERT INTO compute.provider_health_events")));
  assert.equal(database.queries.some((item) => item.sql.includes("revision=revision+1")), false);
});

test("PostgreSQL health refresh excludes retired managed-node routes", async () => {
  let updated = false;
  const managed = row({ provider_kind: "managed_node", provider_key: "managed.hunyuan",
    data_policy: "internal_only", contract_state: "passed" });
  const database = new Database((sql) => {
    if (sql.includes("provider_kind='external_openai'")) return {rows:[]};
    if (sql.startsWith("SELECT * FROM compute.providers WHERE id=$1")) return { rows: [updated
      ? { ...managed, lifecycle_state: "healthy", health: { state: "healthy", latencyMilliseconds: 5,
        errorCode: null, observedAt: NOW.toISOString(), consecutiveFailures: 0 } }
      : { ...managed, lifecycle_state: "degraded" }] };
    if (sql.includes("FROM compute.provider_model_profiles")) return { rows: [mappingRow()] };
    if (sql.startsWith("UPDATE compute.providers")) { updated = true; return { rows: [] }; }
    return { rows: [] };
  });
  const result = await new PostgresExternalProviderRepository({ database }).recordHealth(uuid(1), {
    lifecycleState: "healthy",
    health: { state: "healthy", latencyMilliseconds: 5, errorCode: null, observedAt: NOW,
      consecutiveFailures: 0 },
  });
  assert.equal(result, null);
  assert.equal(updated, false);
  assert.ok(database.queries.some((item) => item.sql.includes("provider_kind='external_openai'")));
});

test("PostgreSQL provider repository requires transactions", () => {
  assert.throws(() => new PostgresExternalProviderRepository({ database: { query() {} } }), /query and transaction/);
});

test("PostgreSQL routing inventory excludes retired auxiliary providers", async () => {
  const managed = row({ provider_kind: "managed_node", provider_key: "managed.hunyuan",
    data_policy: "internal_only" });
  const database = new Database((sql) => {
    if (sql.includes("provider_kind IN ('managed_node','external_openai')")) return { rows: [managed] };
    if (sql.includes("provider_kind='external_openai'")) return { rows: [] };
    if (sql.includes("FROM compute.provider_model_profiles")) return { rows: [mappingRow()] };
    return { rows: [] };
  });
  const repository = new PostgresExternalProviderRepository({ database });
  assert.deepEqual(await repository.list(), []);
  const routed = await repository.listRoutable();
  assert.deepEqual(routed, []);
});

test("PostgreSQL provider removal is a revision-fenced tombstone that preserves evidence", async () => {
  let removed = false;
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT * FROM compute.providers WHERE id=$1")) return { rows: [row(removed ? { lifecycle_state: "removed", revision: "2" } : {})] };
    if (sql.includes("FROM compute.provider_model_profiles")) return { rows: [mappingRow()] };
    if (sql.startsWith("UPDATE compute.providers SET lifecycle_state='removed'")) { removed = true; return { rows: [] }; }
    return { rows: [] };
  });
  const result = await new PostgresExternalProviderRepository({ database }).remove(uuid(1), 1, NOW);
  assert.equal(result.lifecycleState, "removed");
  assert.equal(result.revision, 2);
  assert.equal(database.queries.some((item) => item.sql.startsWith("DELETE")), false);
});
