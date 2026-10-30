import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAgentSandboxRepository } from "../src/postgres-sandbox-repository.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const SANDBOX = "018f6f18-24d7-7c21-9b62-8c017419958b";
const WORKER = "018f6f18-24d7-7c21-9b62-8c017419958c";
const NODE = "018f6f18-24d7-7c21-9b62-8c017419958d";
const OPERATION = "018f6f18-24d7-7c21-9b62-8c017419958e";
const NOW = new Date("2026-08-11T06:00:00.000Z");
const FINGERPRINT_BYTES = Buffer.alloc(32, 9);
const FINGERPRINT = `sha256:${FINGERPRINT_BYTES.toString("hex")}`;
const IMAGE = `registry.local/agent@sha256:${"a".repeat(64)}`;

function row(overrides = {}) {
  return {
    id: SANDBOX,
    owner_identity_id: OWNER,
    worker_id: WORKER,
    sandbox_key: `sandbox.${"b".repeat(32)}`,
    workspace_key: `workspace.${"b".repeat(32)}`,
    workspace_volume: `teamaibox-agent-${"b".repeat(32)}-workspace`,
    workspace_quota_bytes: 100 * 1024 ** 3,
    image_reference: IMAGE,
    runtime_fingerprint: FINGERPRINT_BYTES,
    state: "stopped",
    generation: 0,
    active_operations: 0,
    node_id: null,
    container_id: null,
    last_error_code: null,
    last_activity_at: NOW,
    idle_deadline_at: null,
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function value(overrides = {}) {
  return {
    id: SANDBOX,
    ownerIdentityId: OWNER,
    workerId: WORKER,
    sandboxKey: `sandbox.${"b".repeat(32)}`,
    workspaceKey: `workspace.${"b".repeat(32)}`,
    workspaceVolume: `teamaibox-agent-${"b".repeat(32)}-workspace`,
    workspaceQuotaBytes: 100 * 1024 ** 3,
    image: IMAGE,
    runtimeFingerprint: FINGERPRINT,
    state: "stopped",
    generation: 0,
    activeOperations: 0,
    nodeId: null,
    containerId: null,
    lastErrorCode: null,
    lastActivityAt: NOW,
    idleDeadlineAt: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function database(handler) {
  const calls = [];
  const db = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return handler(sql, values, calls);
    },
    transaction: async (operation) => operation(db),
  };
  return { db, calls };
}

test("PostgreSQL enforces one durable logical sandbox per owner", async () => {
  const fixture = database((sql) => {
    if (sql.includes("INSERT INTO platform.agent_sandboxes")) return { rows: [{ id: SANDBOX }] };
    if (sql.includes("SELECT * FROM platform.agent_sandboxes")) return { rows: [row()] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = new PostgresAgentSandboxRepository({ database: fixture.db });
  const result = await repository.ensureSandbox(value());
  assert.equal(result.inserted, true);
  assert.equal(result.sandbox.runtimeFingerprint, FINGERPRINT);
  assert.match(fixture.calls[0].sql, /ON CONFLICT \(owner_identity_id\) DO NOTHING/);
  assert.match(fixture.calls[1].sql, /FOR UPDATE/);
});

test("PostgreSQL operation acquisition increments the active count in the same transaction", async () => {
  let sandboxReads = 0;
  const fixture = database((sql) => {
    if (sql.includes("SELECT * FROM platform.agent_sandbox_operations")) return { rows: [] };
    if (sql.includes("SELECT * FROM platform.agent_sandboxes")) {
      sandboxReads += 1;
      return { rows: [row({ state: "running", generation: 1, active_operations: 0, node_id: NODE, container_id: "container-a" })] };
    }
    if (sql.includes("INSERT INTO platform.agent_sandbox_operations")) return { rows: [{ id: OPERATION, sandbox_id: SANDBOX, state: "active", created_at: NOW, released_at: null }] };
    if (sql.includes("UPDATE platform.agent_sandboxes")) return { rows: [row({
      state: "running", generation: 1, active_operations: 1, node_id: NODE,
      container_id: "container-a", revision: 2,
    })] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = new PostgresAgentSandboxRepository({ database: fixture.db });
  const result = await repository.acquireOperation({ operationId: OPERATION, sandboxId: SANDBOX, now: NOW });
  assert.equal(result.sandbox.activeOperations, 1);
  assert.equal(result.operation.state, "active");
  assert.match(fixture.calls[1].sql, /FOR UPDATE/);
  assert.ok(fixture.calls.at(-1).values.includes(1));
});

test("PostgreSQL idle claiming uses skip-locked rows and moves only zero-operation sandboxes", async () => {
  const fixture = database((sql) => {
    if (sql.includes("SELECT * FROM platform.agent_sandboxes") && sql.includes("SKIP LOCKED")) {
      return { rows: [row({ state: "running", generation: 1, node_id: NODE, container_id: "container-a", idle_deadline_at: NOW })] };
    }
    if (sql.includes("UPDATE platform.agent_sandboxes")) return { rows: [row({
      state: "stopping", generation: 1, node_id: NODE, container_id: "container-a",
      idle_deadline_at: NOW, revision: 2,
    })] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = new PostgresAgentSandboxRepository({ database: fixture.db });
  const claimed = await repository.claimIdle({ now: NOW, limit: 20 });
  assert.equal(claimed[0].state, "stopping");
  assert.match(fixture.calls[0].sql, /active_operations = 0/);
  assert.match(fixture.calls[0].sql, /FOR UPDATE SKIP LOCKED/);
});

test("PostgreSQL sandbox repository requires transactional storage", () => {
  assert.throws(() => new PostgresAgentSandboxRepository({ database: { query() {} } }), /transactions/);
});
