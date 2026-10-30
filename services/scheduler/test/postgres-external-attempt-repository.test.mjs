import assert from "node:assert/strict";
import test from "node:test";

import { PostgresExternalAttemptRepository } from "../src/postgres-external-attempt-repository.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const NOW = new Date("2026-08-11T08:00:00Z");
const compact = (sql) => sql.replace(/\s+/g, " ").trim();
function row(overrides = {}) { return { attempt_id: uuid(1), attempt_number: "1", job_id: uuid(2), owner_identity_id: uuid(3), provider_id: uuid(4), model_profile_id: uuid(5), provider_model: "large-model", request_digest: Buffer.alloc(32, 1), provider_idempotency_key: null, replay_contract: { idempotencyMode: "none", replayAfterAcceptance: "prohibited", reconcileMode: "none", cancellationMode: "none", sideEffectClass: "none" }, lifecycle_state: "dispatching", acceptance_state: "not_accepted", provider_request_id: null, cancellation_state: "none", cancellation_outcome: null, cancel_requested_at: null, last_output_sequence: "0", observed_output_bytes: "0", output_chain_digest: null, result_object_id: null, result_object_version: null, result_sha256: null, result_size_bytes: null, error_code: null, retry_action: null, retry_classification: null, reconciliation_reason: null, reconciled: false, started_at: NOW, accepted_at: null, finished_at: null, revision: "1", ...overrides }; }
class Database { queries = []; constructor(handler) { this.handler = handler; } async query(sql, parameters = []) { const normalized = compact(sql); this.queries.push({ sql: normalized, parameters }); return this.handler(normalized, parameters); } async transaction(operation) { return operation({ query: (sql, parameters = []) => this.query(sql, parameters) }); } }

test("PostgreSQL begin locks job and provider before one durable external attempt and event", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT job.id")) return { rows: [{ owner_identity_id: uuid(3), status: "queued", cancel_requested_at: null, provider_kind: "external_openai", lifecycle_state: "healthy", contract_state: "passed" }] };
    if (sql.startsWith("SELECT attempt_id")) return { rows: [] };
    if (sql.startsWith("SELECT coalesce")) return { rows: [{ value: "1" }] };
    if (sql.startsWith("SELECT nextval")) return { rows: [{ value: "9" }] };
    if (sql.startsWith("INSERT INTO compute.external_attempt_dispatches")) return { rows: [row()] };
    return { rows: [] };
  });
  const result = await new PostgresExternalAttemptRepository({ database }).begin({ attemptId: uuid(1), jobId: uuid(2), ownerIdentityId: uuid(3), providerId: uuid(4), modelProfileId: uuid(5), providerModel: "large-model", requestDigest: `sha256:${"01".repeat(32)}`, idempotencyKey: null, replayContract: row().replay_contract, startedAt: NOW });
  assert.equal(result.attemptNumber, 1);
  assert.ok(database.queries[0].sql.includes("FOR UPDATE OF job,provider"));
  assert.equal(database.queries.some(({ sql }) => sql.startsWith("INSERT INTO compute.attempts")), true);
  assert.equal(database.queries.some(({ sql }) => sql.startsWith("INSERT INTO compute.external_attempt_events")), true);
  assert.equal(database.queries.some(({ parameters }) => parameters.some((value) => typeof value === "string" && value.includes("protected-reference-only"))), false);
});

test("PostgreSQL output observation locks the attempt and advances only digest/size facts", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT external.*")) return { rows: [row({ lifecycle_state: "accepted", acceptance_state: "accepted_no_output", provider_request_id: "provider-1", accepted_at: NOW })] };
    if (sql.startsWith("UPDATE compute.external_attempt_dispatches")) return { rows: [row({ lifecycle_state: "streaming", acceptance_state: "output_observed", provider_request_id: "provider-1", accepted_at: NOW, last_output_sequence: "1", observed_output_bytes: "32", output_chain_digest: Buffer.alloc(32, 3) })] };
    return { rows: [] };
  });
  const result = await new PostgresExternalAttemptRepository({ database }).observeOutput(uuid(1), { sequence: 1, sizeBytes: 32, sha256: `sha256:${"02".repeat(32)}`, observedAt: NOW });
  assert.equal(result.acceptanceState, "output_observed");
  assert.equal(result.observedOutputBytes, 32);
  assert.ok(database.queries[0].sql.includes("FOR UPDATE OF external,attempt"));
  assert.equal(database.queries.some(({ parameters }) => parameters.includes(32)), true);
});

test("PostgreSQL history keeps events attached to their exact ordered attempts", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT external.*")) return { rows: [row(), row({ attempt_id: uuid(6), attempt_number: "2", lifecycle_state: "failed", finished_at: NOW })] };
    if (sql.startsWith("SELECT * FROM compute.external_attempt_events")) return { rows: [
      { attempt_id: uuid(1), sequence_id: "1", event_kind: "dispatch_started", acceptance_state: "not_accepted", output_sequence: null, size_bytes: null, sha256: null, error_code: null, retry_action: null, cancellation_outcome: null, occurred_at: NOW },
      { attempt_id: uuid(6), sequence_id: "2", event_kind: "failed", acceptance_state: "not_accepted", output_sequence: null, size_bytes: null, sha256: null, error_code: "provider_failed", retry_action: "terminal", cancellation_outcome: null, occurred_at: NOW },
    ] };
    return { rows: [] };
  });
  const history = await new PostgresExternalAttemptRepository({ database }).history(uuid(2));
  assert.deepEqual(history.map((attempt) => [attempt.attemptNumber, attempt.events.length]), [[1, 1], [2, 1]]);
});

test("PostgreSQL failure terminal timestamp remains explicitly typed inside a CASE expression", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT external.*")) return { rows: [row()] };
    if (sql.startsWith("UPDATE compute.external_attempt_dispatches")) {
      return { rows: [row({ lifecycle_state: "failed", error_code: "provider_overloaded", retry_action: "failover", retry_classification: "retryable", finished_at: NOW })] };
    }
    return { rows: [] };
  });
  await new PostgresExternalAttemptRepository({ database }).fail(uuid(1), {
    errorCode: "provider_overloaded",
    decision: { action: "failover", retryClassification: "retryable" },
    finishedAt: NOW,
  });
  const jobUpdate = database.queries.find(({ sql }) => sql.startsWith("UPDATE compute.jobs"));
  assert.ok(jobUpdate.sql.includes("'retryable',$6::boolean"));
  assert.ok(jobUpdate.sql.includes("ELSE $7::timestamptz END"));
  assert.ok(jobUpdate.sql.includes("updated_at=$7::timestamptz"));
});

test("PostgreSQL external attempt repository requires transactions", () => {
  assert.throws(() => new PostgresExternalAttemptRepository({ database: { query() {} } }), /query and transaction/);
});
