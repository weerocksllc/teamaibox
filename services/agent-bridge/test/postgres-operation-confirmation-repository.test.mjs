import assert from "node:assert/strict";
import test from "node:test";

import { PostgresOperationConfirmationRepository } from "../src/postgres-operation-confirmation-repository.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const BINDING = "018f6f18-24d7-7c21-9b62-8c017419958b";
const PROMPT = "018f6f18-24d7-7c21-9b62-8c017419958c";
const OPERATION = "018f6f18-24d7-7c21-9b62-8c017419958d";
const NOW = new Date("2026-08-11T08:00:00.000Z");

function row(overrides = {}) {
  return {
    id: OPERATION, owner_identity_id: OWNER, binding_id: BINDING, prompt_id: PROMPT,
    upstream_request_id: "per_123", operation_kind: "shell.execute", tool_name: "bash",
    title_key: "agent.operation.shell.execute", operation_scope: { summary: "Run command", scope: { argv: ["make"] } },
    action_digest: Buffer.from("a".repeat(64), "hex"), side_effect_class: "non_idempotent",
    policy_id: "official-agent-operations.v1", policy_revision: 1, policy_disposition: "confirm",
    status: "pending", lifecycle_state: "pending", upstream_reply_state: "none", execution_boundary: "none",
    decision_kind: null, decided_by_identity_id: null, authentication_event_id: null,
    authentication_proof_digest: null, authenticated_at: null, reconciliation_outcome: null,
    reconciliation_reason_code: null, result_digest: null, revision: 1,
    created_at: NOW, expires_at: new Date(NOW.getTime() + 120_000), decided_at: null, updated_at: NOW,
    ...overrides,
  };
}

function value() {
  return {
    id: OPERATION, ownerIdentityId: OWNER, bindingId: BINDING, promptId: PROMPT,
    upstreamRequestId: "per_123", actionKind: "shell.execute", tool: "bash",
    titleKey: "agent.operation.shell.execute", actionScope: { summary: "Run command", scope: { argv: ["make"] } },
    actionDigest: `sha256:${"a".repeat(64)}`, sideEffectClass: "non_idempotent",
    policyId: "official-agent-operations.v1", policyRevision: 1, policyDisposition: "confirm",
    status: "pending", lifecycleState: "pending", upstreamReplyState: "none", executionBoundary: "none",
    decisionKind: null, decisionActorIdentityId: null, authenticationEventId: null,
    authenticationProofDigest: null, authenticatedAt: null, reconciliationOutcome: null,
    reconciliationReasonCode: null, resultDigest: null, revision: 1, createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 120_000), decidedAt: null, updatedAt: NOW,
  };
}

test("PostgreSQL confirmation insert binds owner, session, prompt, action digest, and upstream idempotency", async () => {
  const calls = [];
  const database = {
    async query() { throw new Error("unexpected root query"); },
    async transaction(operation) { return operation(this); },
  };
  database.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO platform.agent_operation_confirmations")) return { rows: [row()] };
    throw new Error(`unexpected query: ${sql}`);
  };
  const repository = new PostgresOperationConfirmationRepository({ database });
  const inserted = await repository.insertOperation(value());
  assert.equal(inserted.inserted, true);
  assert.equal(inserted.operation.actionDigest, `sha256:${"a".repeat(64)}`);
  assert.match(calls[0].sql, /JOIN platform\.agent_prompts/);
  assert.match(calls[0].sql, /b\.owner_identity_id = \$2/);
  assert.match(calls[0].sql, /ON CONFLICT \(binding_id, upstream_request_id\)/);
  assert.equal(calls[0].params[12].length, 32);
});

test("PostgreSQL confirmation updates are revision fenced and expiry claims use skip locked", async () => {
  const calls = [];
  const database = {
    async transaction(operation) { return operation(this); },
    async query(sql) {
      calls.push(sql);
      if (sql.includes("WITH candidates")) return { rows: [row({ status: "expired", lifecycle_state: "timed_out", decision_kind: "timeout", decided_at: NOW, revision: 2 })] };
      if (sql.includes("UPDATE platform.agent_operation_confirmations")) return { rows: [row({ status: "approved", lifecycle_state: "dispatching", decision_kind: "approve", revision: 2 })] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const repository = new PostgresOperationConfirmationRepository({ database });
  const changed = { ...value(), status: "approved", lifecycleState: "dispatching", decisionKind: "approve", revision: 2 };
  assert.equal((await repository.updateOperation(changed, 1)).revision, 2);
  assert.equal((await repository.claimExpired({ now: NOW, limit: 10 }))[0].lifecycleState, "timed_out");
  assert.ok(calls.some((sql) => sql.includes("FOR UPDATE SKIP LOCKED")));
  assert.ok(calls.some((sql) => sql.includes("WHERE id = $1 AND revision = $2")));
});
