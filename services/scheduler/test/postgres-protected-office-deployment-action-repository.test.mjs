import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresProtectedOfficeDeploymentActionRepository,
  protectedOfficeDeploymentActionProof,
  protectedOfficeDeploymentResultDigest,
} from "../src/postgres-protected-office-deployment-action-repository.mjs";

const RUN = "protected-office-set-deployment-20260905-a1";
const ACTION = "cold-boot";
const ACTION_ID = "00000000-0000-4000-8000-000000000101";
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-09-05T04:00:00.000Z");

function row(overrides = {}) {
  return {
    run_id: RUN, action: ACTION, action_id: ACTION_ID,
    idempotency_key: Buffer.from("a".repeat(64), "hex"),
    request_digest: Buffer.from("a".repeat(64), "hex"), revision: "1",
    action_state: "running", recovery_count: "0", result_digest: null, result: null,
    failure_code: null, created_at: NOW, updated_at: NOW, persisted_at: null,
    ...overrides,
  };
}

function input(overrides = {}) {
  return { runId: RUN, action: ACTION, actionId: ACTION_ID, idempotencyKey: DIGEST,
    requestDigest: DIGEST, createdAt: NOW, ...overrides };
}

test("action repository requires a transactional PostgreSQL adapter", () => {
  assert.throws(() => new PostgresProtectedOfficeDeploymentActionRepository({ database: { query() {} } }),
    /transactional adapter/);
});

test("begin is idempotent only for the exact run/action identity and request digest", async () => {
  const calls = [];
  const tx = { async query(sql, parameters) {
    calls.push([sql, parameters]);
    if (sql.includes("SELECT *")) return { rows: [row()] };
    if (sql.includes("RETURNING run_id")) return { rows: [{ run_id: RUN }] };
    return { rows: [] };
  } };
  const database = { async query() { return { rows: [] }; }, async transaction(operation) { return operation(tx); } };
  const saved = await new PostgresProtectedOfficeDeploymentActionRepository({ database }).beginAction(input());
  assert.equal(saved.state, "running");
  assert.equal(saved.created, true);
  assert.equal(saved.idempotencyKey, DIGEST);
  assert.match(calls[0][0], /ON CONFLICT \(run_id,action\) DO NOTHING/);
  assert.match(calls[1][0], /FOR UPDATE/);

  tx.query = async (sql) => sql.includes("SELECT *")
    ? { rows: [row({ request_digest: Buffer.from("b".repeat(64), "hex") })] } : { rows: [] };
  await assert.rejects(new PostgresProtectedOfficeDeploymentActionRepository({ database }).beginAction(input()), {
    code: "protected_deployment_action_idempotency_conflict", retryable: false,
  });
});

test("repository persists the bounded v5 deployment identity without weakening legacy compatibility", async () => {
  const runId = "protected-office-set-deployment-v5-20260906-a6";
  const tx = { async query(sql, parameters) {
    if (sql.includes("SELECT *")) return { rows: [row({ run_id: runId })] };
    if (sql.includes("RETURNING run_id")) {
      assert.equal(parameters[0], runId);
      return { rows: [{ run_id: runId }] };
    }
    return { rows: [] };
  } };
  const database = { async query() { return { rows: [] }; }, async transaction(operation) { return operation(tx); } };
  const saved = await new PostgresProtectedOfficeDeploymentActionRepository({ database })
    .beginAction(input({ runId }));
  assert.equal(saved.runId, runId);
  assert.equal(saved.created, true);
});

test("action recovery is journaled before replay and resumes with CAS", async () => {
  const observed = [];
  const tx = { async query(sql, parameters) {
    observed.push([sql, parameters]);
    if (sql.includes("SELECT *")) return { rows: [row()] };
    if (sql.includes("UPDATE")) return { rows: [row({
      revision: "2", action_state: "recovering", recovery_count: "1", updated_at: new Date("2026-09-05T04:01:00.000Z"),
    })] };
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const database = { async query() { return { rows: [] }; }, async transaction(operation) { return operation(tx); } };
  const repository = new PostgresProtectedOfficeDeploymentActionRepository({ database });
  const recovering = await repository.markRecovering(RUN, ACTION, 1, { updatedAt: "2026-09-05T04:01:00.000Z" });
  assert.equal(recovering.state, "recovering");
  assert.equal(recovering.recoveryCount, 1);
  assert.equal(observed[1][1][4], 1);
});

test("successful action stores only a bounded redacted result with its canonical digest", async () => {
  const result = { node: { nodeId: "00000000-0000-4000-8000-000000000201" }, status: "healthy" };
  const resultDigest = protectedOfficeDeploymentResultDigest(result);
  const persisted = new Date("2026-09-05T04:02:00.000Z");
  const tx = { async query(sql) {
    if (sql.includes("SELECT *")) return { rows: [row()] };
    if (sql.includes("UPDATE")) return { rows: [row({ revision: "2", action_state: "succeeded",
      result_digest: Buffer.from(resultDigest.slice(7), "hex"), result, updated_at: persisted, persisted_at: persisted })] };
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const database = { async query() { return { rows: [] }; }, async transaction(operation) { return operation(tx); } };
  const repository = new PostgresProtectedOfficeDeploymentActionRepository({ database });
  const saved = await repository.completeAction(RUN, ACTION, 1, { result, resultDigest, persistedAt: persisted });
  assert.deepEqual(saved.result, result);
  assert.deepEqual(protectedOfficeDeploymentActionProof(saved), {
    runId: RUN, action: ACTION, actionId: ACTION_ID, idempotencyKey: DIGEST,
    revision: 2, state: "succeeded", resultDigest, persistedAt: persisted.toISOString(),
  });
  assert.throws(() => protectedOfficeDeploymentResultDigest({ accessToken: "forbidden" }), /sensitive field/);
  await assert.rejects(repository.completeAction(RUN, ACTION, 1, {
    result, resultDigest: `sha256:${"b".repeat(64)}`, persistedAt: persisted,
  }), /digest drifted/);
});

test("repository lists only incomplete actions and maps failure constraints fail closed", async () => {
  const database = {
    async query(sql, parameters) {
      assert.match(sql, /action_state IN \('running','recovering'\)/);
      assert.deepEqual(parameters, [RUN]);
      return { rows: [row()] };
    },
    async transaction() {},
  };
  const [saved] = await new PostgresProtectedOfficeDeploymentActionRepository({ database })
    .listIncompleteActions({ runId: RUN });
  assert.equal(saved.runId, RUN);

  const violation = new Error("protected deployment action revision is stale");
  violation.code = "23514";
  const broken = { async query() { return { rows: [] }; }, async transaction() { throw violation; } };
  await assert.rejects(new PostgresProtectedOfficeDeploymentActionRepository({ database: broken }).beginAction(input()), {
    code: "protected_deployment_action_revision_conflict", retryable: true,
  });
});
