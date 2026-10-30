import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAgentSessionRepository } from "../src/postgres-session-repository.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const CONVERSATION = "018f6f18-24d7-7c21-9b62-8c017419958b";
const BINDING = "018f6f18-24d7-7c21-9b62-8c017419958c";
const RUN = "018f6f18-24d7-7c21-9b62-8c017419958d";
const PROMPT = "018f6f18-24d7-7c21-9b62-8c017419958e";
const EVENT = "018f6f18-24d7-7c21-9b62-8c017419958f";
const CONNECTION = "018f6f18-24d7-7c21-9b62-8c0174199590";
const RECONCILIATION = "018f6f18-24d7-7c21-9b62-8c0174199591";
const NOW = new Date("2026-08-11T04:00:00.000Z");
const BYTES = Buffer.alloc(32, 7);
const DIGEST = `sha256:${BYTES.toString("hex")}`;

function bindingRow(overrides = {}) {
  return {
    id: BINDING,
    owner_identity_id: OWNER,
    platform_conversation_id: CONVERSATION,
    workspace_key: "workspace.user-1",
    sandbox_key: "sandbox.user-1",
    adapter_key: "opencode.http.v1.18",
    upstream_version: "1.18.16",
    upstream_artifact_digest: BYTES,
    opencode_session_id: "ses_123",
    state: "active",
    crash_generation: 0,
    event_tail_sequence: 0,
    terminal: null,
    created_at: NOW,
    updated_at: NOW,
    reconciled_at: null,
    ...overrides,
  };
}

function promptRow(overrides = {}) {
  return {
    id: PROMPT,
    binding_id: BINDING,
    platform_run_id: RUN,
    idempotency_key: "prompt-one",
    request_digest: BYTES,
    opencode_message_id: "msg_123",
    status: "admitted",
    acceptance_boundary: "none",
    terminal: null,
    revision: 1,
    created_at: NOW,
    submitted_at: null,
    accepted_at: null,
    completed_at: null,
    updated_at: NOW,
    ...overrides,
  };
}

function transactionDatabase(handler) {
  const calls = [];
  const database = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return handler(sql, values, calls);
    },
    transaction: async (operation) => operation(database),
  };
  return { database, calls };
}

test("PostgreSQL binding creation serializes an immutable conversation mapping", async () => {
  const fixture = transactionDatabase((sql) => {
    if (sql.includes("INSERT INTO platform.agent_session_bindings")) return { rows: [{ id: BINDING }] };
    if (sql.includes("SELECT * FROM platform.agent_session_bindings")) return { rows: [bindingRow()] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = new PostgresAgentSessionRepository({ database: fixture.database });
  const result = await repository.insertBinding({
    id: BINDING, ownerIdentityId: OWNER, platformConversationId: CONVERSATION,
    workspaceKey: "workspace.user-1", sandboxKey: "sandbox.user-1",
    adapterKey: "opencode.http.v1.18", upstreamVersion: "1.18.16",
    upstreamArtifactDigest: DIGEST, opencodeSessionId: "ses_123",
    state: "active", crashGeneration: 0, eventTailSequence: 0, terminal: null,
    createdAt: NOW, updatedAt: NOW, reconciledAt: null,
  });
  assert.equal(result.inserted, true);
  assert.equal(result.binding.upstreamArtifactDigest, DIGEST);
  assert.match(fixture.calls[0].sql, /ON CONFLICT \(owner_identity_id, platform_conversation_id\) DO NOTHING/);
  assert.match(fixture.calls[1].sql, /FOR UPDATE/);
});

test("PostgreSQL prompt admission locks the binding and persists only a request digest", async () => {
  const fixture = transactionDatabase((sql) => {
    if (sql.includes("SELECT 1 FROM platform.agent_session_bindings")) return { rows: [{ present: 1 }] };
    if (sql.includes("SELECT * FROM platform.agent_prompts") && sql.includes("idempotency_key")) return { rows: [] };
    if (sql.includes("INSERT INTO platform.agent_prompts")) return { rows: [promptRow()] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = new PostgresAgentSessionRepository({ database: fixture.database });
  const value = await repository.insertPrompt({
    id: PROMPT, bindingId: BINDING, platformRunId: RUN, idempotencyKey: "prompt-one",
    requestDigest: DIGEST, opencodeMessageId: "msg_123", status: "admitted",
    acceptanceBoundary: "none", terminal: null, revision: 1, createdAt: NOW,
    submittedAt: null, acceptedAt: null, completedAt: null, updatedAt: NOW,
  });
  assert.equal(value.inserted, true);
  assert.equal(value.prompt.requestDigest, DIGEST);
  assert.equal(fixture.calls[2].values[4].toString("hex"), BYTES.toString("hex"));
  assert.ok(!JSON.stringify(fixture.calls).includes("private prompt"));
});

test("PostgreSQL event append locks the cursor, deduplicates connection order, and advances atomically", async () => {
  const fixture = transactionDatabase((sql) => {
    if (sql.includes("SELECT * FROM platform.agent_session_bindings")) return { rows: [bindingRow()] };
    if (sql.includes("SELECT * FROM platform.agent_events")) return { rows: [] };
    if (sql.includes("SELECT 1 FROM platform.agent_prompts")) return { rows: [{ present: 1 }] };
    if (sql.includes("INSERT INTO platform.agent_events")) return { rows: [{
      event_id: EVENT, binding_id: BINDING, sequence: 1, prompt_id: PROMPT,
      connection_id: CONNECTION, connection_ordinal: 1, upstream_event_id: "evt_1",
      event_type: "session.updated", event_data: { sessionId: "ses_123" }, created_at: NOW,
    }] };
    if (sql.includes("UPDATE platform.agent_session_bindings")) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = new PostgresAgentSessionRepository({ database: fixture.database });
  const value = await repository.appendEvent({
    id: EVENT, bindingId: BINDING, promptId: PROMPT, connectionId: CONNECTION,
    connectionOrdinal: 1, upstreamEventId: "evt_1", eventType: "session.updated",
    eventData: { sessionId: "ses_123" }, createdAt: NOW,
  });
  assert.equal(value.inserted, true);
  assert.equal(value.event.sequence, 1);
  assert.match(fixture.calls[0].sql, /FOR UPDATE/);
  assert.match(fixture.calls.at(-1).sql, /event_tail_sequence/);
});

test("PostgreSQL crash admission atomically fences active prompts for reconciliation", async () => {
  let bindingReads = 0;
  const fixture = transactionDatabase((sql) => {
    if (sql.includes("SELECT * FROM platform.agent_session_bindings")) {
      bindingReads += 1;
      return { rows: [bindingRow(bindingReads > 1 ? { state: "reconciling", crash_generation: 1 } : {})] };
    }
    if (sql.includes("SELECT * FROM platform.agent_crash_reconciliations")) return { rows: [] };
    if (sql.includes("UPDATE platform.agent_session_bindings")) return { rows: [] };
    if (sql.includes("UPDATE platform.agent_prompts")) return { rows: [] };
    if (sql.includes("INSERT INTO platform.agent_crash_reconciliations")) return { rows: [{
      id: RECONCILIATION, binding_id: BINDING, crash_generation: 1, state: "open",
      reason_code: "sandbox_crash", upstream_session_exists: null,
      accepted_message_ids: null, outcome: null, created_at: NOW, resolved_at: null,
    }] };
    if (sql.includes("SELECT * FROM platform.agent_prompts")) return { rows: [promptRow({ status: "reconcile_required", acceptance_boundary: "unknown", revision: 2 })] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = new PostgresAgentSessionRepository({ database: fixture.database });
  const value = await repository.beginCrashReconciliation({
    reconciliationId: RECONCILIATION, bindingId: BINDING, reasonCode: "sandbox_crash", now: NOW,
  });
  assert.equal(value.binding.state, "reconciling");
  assert.equal(value.binding.crashGeneration, 1);
  assert.equal(value.prompts[0].status, "reconcile_required");
  assert.ok(fixture.calls.some((call) => call.sql.includes("status NOT IN ('admitted', 'completed', 'failed', 'cancelled', 'incomplete')")));
});

test("PostgreSQL Agent session repository requires transactional storage", () => {
  assert.throws(() => new PostgresAgentSessionRepository({ database: { query() {} } }), /transactions/);
});
