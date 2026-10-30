import assert from "node:assert/strict";
import test from "node:test";

import { PostgresProtectedOfficeSetRepository } from "../src/postgres-protected-office-set-repository.mjs";

const NODE = "00000000-0000-4000-8000-000000007011";
const TX = "protected-office-set-tx-0001";
const NOW = new Date("2026-09-04T08:00:00.000Z");
const LATER = new Date("2026-09-04T08:00:01.000Z");

function txRow(overrides = {}) {
  return {
    id: TX,
    set_id: "office.baseline",
    node_id: NODE,
    revision: "1",
    desired_state_revision: "4",
    maintenance_generation: "7",
    transaction_state: "admitting",
    manifest: JSON.stringify({ setId: "office.baseline", profiles: [] }),
    previous_identities: { "office.assistant": null },
    maintenance_authorization: null,
    admission: { incrementalBytes: 1024 },
    steps: [],
    recovery_steps: [],
    observed_identities: null,
    failure_code: null,
    recovery_failures: [],
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  };
}

function stateRow(overrides = {}) {
  return {
    set_id: "office.baseline",
    node_id: NODE,
    revision: "1",
    desired_state_revision: "4",
    observed_state_revision: "0",
    maintenance_generation: "7",
    recovery_state: "recovering",
    recovery_reason_code: "protected_set_staging",
    healthy_identities: [],
    aggregate_resident_bytes: "0",
    last_transaction_id: TX,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function databaseWith(transaction) {
  return {
    async query() { return { rows: [] }; },
    async transaction(operation) { return operation(transaction); },
  };
}

test("PostgreSQL protected office set repository requires a transactional adapter", () => {
  assert.throws(() => new PostgresProtectedOfficeSetRepository({ database: { query() {} } }), /transactional adapter/);
});

test("PostgreSQL begins a protected-set journal and maps snake-case storage to camelCase", async () => {
  const calls = [];
  const database = {
    async query(sql, parameters) {
      calls.push([sql, parameters]);
      return { rows: [txRow()] };
    },
    async transaction() {},
  };
  const subject = new PostgresProtectedOfficeSetRepository({ database });
  const saved = await subject.beginTransaction({
    transactionId: TX,
    setId: "office.baseline",
    nodeId: NODE,
    desiredStateRevision: 4,
    maintenanceGeneration: 7,
    state: "admitting",
    manifest: { setId: "office.baseline", profiles: [] },
    previousIdentities: { "office.assistant": null },
    maintenanceAuthorization: null,
    admission: { incrementalBytes: 1024 },
    steps: [],
    recoverySteps: [],
    createdAt: NOW,
    updatedAt: NOW,
  });

  assert.equal(saved.transactionId, TX);
  assert.equal(saved.maintenanceGeneration, 7);
  assert.deepEqual(saved.manifest, { setId: "office.baseline", profiles: [] });
  assert.ok(saved.createdAt instanceof Date);
  assert.match(calls[0][0], /INSERT INTO compute\.protected_office_set_transactions/);
  assert.equal(JSON.parse(calls[0][1][6]).setId, "office.baseline");
});

test("PostgreSQL maps the partial unique active-set fence to repository semantics", async () => {
  const error = new Error("duplicate active set");
  error.code = "23505";
  error.constraint = "protected_office_set_transactions_one_active_idx";
  const subject = new PostgresProtectedOfficeSetRepository({ database: {
    async query() { throw error; },
    async transaction() {},
  } });
  await assert.rejects(subject.beginTransaction({ transactionId: TX }), {
    code: "protected_set_transaction_active",
    retryable: true,
  });
});

test("PostgreSQL updateTransaction locks the journal and performs exact revision CAS", async () => {
  const calls = [];
  const transaction = { async query(sql, parameters) {
    calls.push([sql, parameters]);
    if (sql.includes("SELECT *") && sql.includes("FOR UPDATE")) return { rows: [txRow()] };
    if (sql.includes("UPDATE compute.protected_office_set_transactions")) {
      return { rows: [txRow({
        revision: "2", transaction_state: "staging", updated_at: LATER,
        steps: [{ workerId: "office.assistant", state: "staging" }],
      })] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const subject = new PostgresProtectedOfficeSetRepository({ database: databaseWith(transaction) });
  const saved = await subject.updateTransaction(TX, 1, (current) => ({
    state: "staging",
    steps: [...current.steps, { workerId: "office.assistant", state: "staging" }],
    updatedAt: LATER,
  }));

  assert.equal(saved.revision, 2);
  assert.equal(saved.state, "staging");
  assert.match(calls[0][0], /FOR UPDATE/);
  assert.deepEqual(calls[1][1].slice(0, 3), [TX, 1, "staging"]);
});

test("PostgreSQL updateTransaction rejects a stale revision before mutation", async () => {
  let updates = 0;
  const transaction = { async query(sql) {
    if (sql.includes("FOR UPDATE")) return { rows: [txRow({ revision: "2" })] };
    updates += 1;
    return { rows: [] };
  } };
  const subject = new PostgresProtectedOfficeSetRepository({ database: databaseWith(transaction) });
  await assert.rejects(subject.updateTransaction(TX, 1, { state: "staging" }), {
    code: "protected_set_transaction_revision_conflict",
    retryable: true,
  });
  assert.equal(updates, 0);
});

test("PostgreSQL lists recoverable journals and reads a protected-set projection", async () => {
  const database = {
    async query(sql, parameters) {
      if (sql.includes("protected_office_set_transactions")) {
        assert.deepEqual(parameters, ["office.baseline"]);
        assert.match(sql, /NOT IN \('succeeded','rolled-back'\)/);
        return { rows: [txRow({ transaction_state: "recovery-required" })] };
      }
      return { rows: [stateRow()] };
    },
    async transaction() {},
  };
  const subject = new PostgresProtectedOfficeSetRepository({ database });

  assert.equal((await subject.listIncompleteTransactions({ setId: "office.baseline" }))[0].state,
    "recovery-required");
  const state = await subject.getSetState("office.baseline");
  assert.equal(state.setId, "office.baseline");
  assert.equal(state.aggregateResidentBytes, 0);
});

test("PostgreSQL putSetState creates revision one and fences a concurrent insert", async () => {
  const calls = [];
  const transaction = { async query(sql, parameters) {
    calls.push([sql, parameters]);
    if (sql.includes("SELECT *") && sql.includes("FOR UPDATE")) return { rows: [] };
    return { rows: [stateRow()] };
  } };
  const subject = new PostgresProtectedOfficeSetRepository({ database: databaseWith(transaction) });
  const saved = await subject.putSetState("office.baseline", 0, {
    nodeId: NODE,
    desiredStateRevision: 4,
    observedStateRevision: 0,
    maintenanceGeneration: 7,
    recoveryState: "recovering",
    recoveryReasonCode: "protected_set_staging",
    healthyIdentities: [],
    aggregateResidentBytes: 0,
    lastTransactionId: TX,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(saved.revision, 1);
  assert.match(calls[1][0], /INSERT INTO compute\.protected_office_sets/);

  const unique = new Error("concurrent projection");
  unique.code = "23505";
  unique.constraint = "protected_office_sets_pkey";
  const racing = new PostgresProtectedOfficeSetRepository({ database: databaseWith({ async query(sql) {
    if (sql.includes("FOR UPDATE")) return { rows: [] };
    throw unique;
  } }) });
  await assert.rejects(racing.putSetState("office.baseline", 0, {
    nodeId: NODE, createdAt: NOW, updatedAt: NOW,
  }), { code: "protected_set_state_revision_conflict", retryable: true });
});

test("PostgreSQL atomically commits a terminal journal and healthy set projection", async () => {
  const calls = [];
  const observed = [{ workerId: "office.assistant", residentBytes: 1024 }];
  const transaction = { async query(sql, parameters) {
    calls.push([sql, parameters]);
    if (sql.includes("protected_office_set_transactions") && sql.includes("SELECT *")) {
      return { rows: [txRow({ revision: "3", transaction_state: "probing" })] };
    }
    if (sql.includes("protected_office_sets") && sql.includes("SELECT *")) return { rows: [stateRow()] };
    if (sql.includes("UPDATE compute.protected_office_set_transactions")) {
      return { rows: [txRow({
        revision: "4", transaction_state: "succeeded", observed_identities: observed,
        updated_at: LATER, completed_at: LATER,
      })] };
    }
    if (sql.includes("UPDATE compute.protected_office_sets")) {
      return { rows: [stateRow({
        revision: "2", observed_state_revision: "4", recovery_state: "healthy",
        recovery_reason_code: null, healthy_identities: observed,
        aggregate_resident_bytes: "1024", updated_at: LATER,
      })] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const subject = new PostgresProtectedOfficeSetRepository({ database: databaseWith(transaction) });
  const saved = await subject.commitTransactionAndSetState({
    transactionId: TX,
    expectedTransactionRevision: 3,
    transactionPatch: {
      state: "succeeded", observedIdentities: observed,
      updatedAt: LATER, completedAt: LATER,
    },
    setId: "office.baseline",
    expectedSetRevision: 1,
    setState: {
      observedStateRevision: 4,
      recoveryState: "healthy",
      recoveryReasonCode: null,
      healthyIdentities: observed,
      aggregateResidentBytes: 1024,
      updatedAt: LATER,
    },
  });

  assert.equal(saved.transaction.state, "succeeded");
  assert.equal(saved.setState.recoveryState, "healthy");
  assert.deepEqual(calls.slice(0, 2).map(([sql]) => /protected_office_set_transactions/.test(sql)), [true, false]);
  assert.match(calls[0][0], /FOR UPDATE/);
  assert.match(calls[1][0], /FOR UPDATE/);
});

test("PostgreSQL maps persisted terminal immutability to a non-retryable conflict", async () => {
  const error = new Error("terminal protected office transaction cannot change");
  error.code = "23514";
  const transaction = { async query(sql) {
    if (sql.includes("FOR UPDATE")) return { rows: [txRow()] };
    throw error;
  } };
  const subject = new PostgresProtectedOfficeSetRepository({ database: databaseWith(transaction) });
  await assert.rejects(subject.updateTransaction(TX, 1, { state: "staging", updatedAt: LATER }), {
    code: "protected_set_transaction_terminal",
    retryable: false,
  });
});
