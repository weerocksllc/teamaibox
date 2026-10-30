import assert from "node:assert/strict";
import test from "node:test";

import { LeaseManager } from "../src/lease-manager.mjs";
import { PostgresLeaseRepository } from "../src/postgres-lease-repository.mjs";

const ACQUIRED = new Date("2026-08-10T02:00:00.000Z");

function normalized(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function leaseRow(overrides = {}) {
  return {
    id: "lease-set-a",
    acquisition_key: "acquire-a",
    node_id: "node-a",
    node_generation: "7",
    job_id: "job-a",
    attempt_id: "attempt-a",
    model_profile_id: "profile-a",
    lease_token: "lease-token-a",
    fencing_token: "1",
    state: "active",
    dispatch_state: "pending",
    dispatch_id: null,
    reservation: {
      cpuMillis: 2_000,
      unifiedMemoryBytes: 8_000,
      acceleratorUnits: 1,
      codecSessions: 0,
      storageBytes: 1_000,
      networkBitsPerSecond: 100,
    },
    acquired_at: ACQUIRED,
    heartbeat_at: ACQUIRED,
    expires_at: new Date(ACQUIRED.getTime() + 30_000),
    dispatched_at: null,
    accepted_at: null,
    released_at: null,
    release_reason: null,
    reconciliation_count: "0",
    last_reconciled_at: null,
    node_exclusive: false,
    node_lifecycle_state: "ready",
    current_node_generation: "7",
    attempt_status: "pending",
    attempt_number: "1",
    acceptance_state: "not_accepted",
    job_status: "admitted",
    ...structuredClone(overrides),
  };
}

class RecordingDatabase {
  queries = [];
  transactions = 0;
  completedTransactions = 0;

  constructor(handler) {
    this.handler = handler;
  }

  async query(sql, parameters = []) {
    this.queries.push({ sql: normalized(sql), parameters, transaction: false });
    return this.handler(normalized(sql), parameters);
  }

  async transaction(operation) {
    this.transactions += 1;
    const executor = {
      query: async (sql, parameters = []) => {
        const compact = normalized(sql);
        this.queries.push({ sql: compact, parameters, transaction: true });
        return this.handler(compact, parameters);
      },
    };
    const result = await operation(executor);
    this.completedTransactions += 1;
    return result;
  }
}

function acquisition() {
  return {
    acquisitionKey: "acquire-a",
    jobId: "job-a",
    nodeId: "node-a",
    nodeGeneration: 7,
    modelProfileId: "profile-a",
    reservation: leaseRow().reservation,
    ttlMilliseconds: 30_000,
    now: ACQUIRED,
    attemptId: "attempt-a",
    leaseToken: "lease-token-a",
  };
}

test("PostgreSQL acquisition locks facts, does not book resource totals, allocates a fence, and commits one lease set", async () => {
  let finalSelects = 0;
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("lease_set.acquisition_key = $1")) return { rows: [] };
    if (sql.includes("FROM compute.jobs WHERE id = $1 FOR UPDATE")) {
      return { rows: [{
        id: "job-a",
        capability_id: "capability-a",
        requested_model_profile_id: "profile-a",
        status: "queued",
        cancel_requested_at: null,
      }] };
    }
    if (sql.includes("FROM compute.nodes WHERE id = $1 FOR UPDATE")) {
      return { rows: [{
        id: "node-a",
        generation: "7",
        lifecycle_state: "ready",
        trust_kind: "managed_appliance",
        labels: { localAppliance: true },
        capacity: {
          cpuMillis: 10_000,
          unifiedMemoryBytes: 32_000,
          acceleratorUnits: 2,
          codecSessions: 2,
          storageBytes: 100_000,
          networkBitsPerSecond: 10_000,
        },
      }] };
    }
    if (sql.includes("FROM compute.model_profiles WHERE id = $1 FOR SHARE")) {
      return { rows: [{ id: "profile-a", capability_id: "capability-a", certification_state: "certified" }] };
    }
    if (sql.includes("lease_set.node_id = $1") && sql.includes("lease_set.expires_at <= $2")) return { rows: [] };
    if (sql.includes("lease_set.job_id = $1") && sql.includes("lease_set.state = 'active'")) return { rows: [] };
    if (sql.includes("COALESCE(sum((reservation->>'cpuMillis')::bigint)")) {
      return { rows: [{
        cpu_millis: "0",
        unified_memory_bytes: "0",
        accelerator_units: "0",
        codec_sessions: "0",
        storage_bytes: "0",
        network_bits_per_second: "0",
      }] };
    }
    if (sql.startsWith("INSERT INTO compute.node_lease_fences")) return { rows: [{ fencing_token: "1" }] };
    if (sql.includes("SELECT COALESCE(max(attempt_number), 0) + 1")) return { rows: [{ attempt_number: "1" }] };
    if (sql.startsWith("INSERT INTO compute.lease_sets")) return { rows: [{ id: "lease-set-a" }] };
    if (sql.includes("WHERE lease_set.id = $1")) {
      finalSelects += 1;
      return { rows: [leaseRow()] };
    }
    return { rows: [] };
  });
  const manager = new LeaseManager({ repository: new PostgresLeaseRepository({ database }) });
  const lease = await manager.acquire(acquisition());

  assert.equal(lease.fencingToken, 1);
  assert.equal(lease.leaseSetId, "lease-set-a");
  assert.equal(database.transactions, 1);
  assert.equal(database.completedTransactions, 1);
  assert.equal(finalSelects, 1);
  assert.ok(database.queries.every((query) => query.transaction));

  const statements = database.queries.map((query) => query.sql);
  const jobLock = statements.findIndex((sql) => sql.includes("FROM compute.jobs WHERE id = $1 FOR UPDATE"));
  const nodeLock = statements.findIndex((sql) => sql.includes("FROM compute.nodes WHERE id = $1 FOR UPDATE"));
  const capacity = statements.findIndex((sql) => sql.includes("sum((reservation->>'cpuMillis')::bigint"));
  const fence = statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.node_lease_fences"));
  const attempt = statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.attempts"));
  const leaseSet = statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.lease_sets"));
  assert.ok(jobLock >= 0 && nodeLock > jobLock && fence > nodeLock);
  assert.equal(capacity,-1);
  assert.ok(attempt > fence && leaseSet > attempt);
  assert.equal(statements.filter((sql) => sql.startsWith("INSERT INTO compute.leases")).length, 0);
  assert.ok(statements.some((sql) => sql.includes("SET status = 'admitted'")));
});

test("an expired PostgreSQL heartbeat durably closes the lease before returning the fence error", async () => {
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("lease_set.lease_token = $1")) {
      return { rows: [leaseRow({
        expires_at: new Date(ACQUIRED.getTime() + 1_000),
        job_status: "admitted",
      })] };
    }
    return { rows: [] };
  });
  const repository = new PostgresLeaseRepository({ database });
  const manager = new LeaseManager({ repository });

  await assert.rejects(manager.heartbeat({
    leaseToken: "lease-token-a",
    fencingToken: 1,
    now: new Date(ACQUIRED.getTime() + 2_000),
  }), { code: "lease_expired" });

  assert.equal(database.transactions, 1);
  assert.equal(database.completedTransactions, 1);
  assert.ok(database.queries.some((query) =>
    query.sql.includes("UPDATE compute.lease_sets") && query.sql.includes("release_reason"),
  ));
  assert.ok(database.queries.some((query) => query.sql.includes("SET status = 'queued'")));
  assert.ok(database.queries.some((query) => query.sql.includes("UPDATE compute.leases")));
});

test("the fifth unaccepted dispatch failure terminalizes the job instead of requeueing forever", async () => {
  let selects = 0;
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("lease_set.lease_token = $1")) {
      selects += 1;
      return { rows: [leaseRow({
        attempt_number: "5",
        state: selects === 1 ? "active" : "released",
        release_reason: selects === 1 ? null : "dispatch_failed",
      })] };
    }
    if (sql.includes("WHERE lease_set.id = $1")) {
      return { rows: [leaseRow({ attempt_number: "5", state: "released", release_reason: "dispatch_failed" })] };
    }
    return { rows: [] };
  });
  const manager = new LeaseManager({ repository: new PostgresLeaseRepository({ database }) });

  await manager.release({
    leaseToken: "lease-token-a",
    fencingToken: 1,
    reason: "dispatch_failed",
    now: new Date(ACQUIRED.getTime() + 500),
  });

  const statements = database.queries.map((query) => query.sql);
  assert.ok(statements.some((sql) => sql.includes("SET status = $2, retryable = $3")
    && sql.includes("error_code = $4")));
  assert.ok(database.queries.some((query) => query.parameters.includes("dispatch_retry_exhausted")));
  assert.ok(statements.some((sql) => sql.includes("SET status = 'failed'")
    && sql.includes("managed_dispatch_retry_exhausted")));
  assert.equal(statements.some((sql) => sql.includes("SET status = 'queued'")), false);
});

test("releasing an already closed exclusive lease idempotently completes its acquired intent", async () => {
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("lease_set.lease_token = $1")) {
      return { rows: [leaseRow({
        state: "released",
        node_exclusive: true,
        release_reason: "worker_completed",
      })] };
    }
    return { rows: [] };
  });
  const manager = new LeaseManager({ repository: new PostgresLeaseRepository({ database }) });

  const lease = await manager.release({
    leaseToken: "lease-token-a",
    fencingToken: 1,
    reason: "scheduler_release",
    now: new Date(ACQUIRED.getTime() + 2_000),
  });

  assert.equal(lease.state, "released");
  const completion = database.queries.find((query) =>
    query.sql.includes("UPDATE compute.node_exclusive_intents")
      && query.sql.includes("WHERE lease_set_id = $1 AND state = 'acquired'"));
  assert.ok(completion);
  assert.equal(completion.parameters[0], "lease-set-a");
  assert.equal(completion.parameters[2], "worker_completed");
});

test("lease reconciliation completes acquired intents whose exclusive lease is already closed", async () => {
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("WHERE lease_set.state = 'active'") && sql.includes("ORDER BY lease_set.acquired_at")) {
      return { rows: [] };
    }
    if (sql.includes("WHERE intent.state = 'acquired' AND lease_set.state <> 'active'")) {
      return { rows: [{
        intent_id: "intent-a",
        lease_set_id: "lease-set-a",
        job_id: "job-a",
        lease_state: "released",
      }] };
    }
    if (sql.includes("FROM compute.attempts attempt")) return { rows: [] };
    return { rows: [] };
  });
  const manager = new LeaseManager({ repository: new PostgresLeaseRepository({ database }) });

  const outcomes = await manager.reconcile({ now: new Date(ACQUIRED.getTime() + 3_000) });

  assert.deepEqual(outcomes, [{
    intentId: "intent-a",
    leaseSetId: "lease-set-a",
    state: "completed",
    reason: "lease_closed",
  }]);
  const completion = database.queries.find((query) =>
    query.sql.includes("UPDATE compute.node_exclusive_intents")
      && query.parameters.includes("lease_closed"));
  assert.ok(completion);
  assert.ok(database.queries.every((query) => query.transaction));
});

test("PostgreSQL dispatch claim checks for a reused dispatch identity inside the lease transaction", async () => {
  let selectCount = 0;
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("lease_set.lease_token = $1")) {
      selectCount += 1;
      return { rows: [leaseRow({
        dispatch_state: selectCount === 1 ? "pending" : "claimed",
        dispatch_id: selectCount === 1 ? null : "dispatch-a",
        dispatched_at: selectCount === 1 ? null : new Date(ACQUIRED.getTime() + 100),
        attempt_status: selectCount === 1 ? "pending" : "dispatched",
        job_status: selectCount === 1 ? "admitted" : "preparing",
      })] };
    }
    if (sql.includes("SELECT id FROM compute.lease_sets WHERE dispatch_id = $1 FOR UPDATE")) return { rows: [] };
    if (sql.includes("WHERE lease_set.id = $1")) {
      return { rows: [leaseRow({
        dispatch_state: "claimed",
        dispatch_id: "dispatch-a",
        dispatched_at: new Date(ACQUIRED.getTime() + 100),
        attempt_status: "dispatched",
        job_status: "preparing",
      })] };
    }
    return { rows: [] };
  });
  const manager = new LeaseManager({ repository: new PostgresLeaseRepository({ database }) });
  const claimed = await manager.claimDispatch({
    leaseToken: "lease-token-a",
    fencingToken: 1,
    dispatchId: "dispatch-a",
    now: new Date(ACQUIRED.getTime() + 100),
  });

  assert.equal(claimed.dispatchState, "claimed");
  assert.equal(database.transactions, 1);
  assert.ok(database.queries.some((query) =>
    query.sql.includes("WHERE dispatch_id = $1 FOR UPDATE"),
  ));
  assert.ok(database.queries.some((query) => query.sql.includes("SET status = 'dispatched'")));
  assert.ok(database.queries.some((query) => query.sql.includes("SET status = 'preparing'")));
});

test("PostgreSQL repository requires a transactional database adapter", () => {
  assert.throws(() => new PostgresLeaseRepository({ database: { query() {} } }), /query and transaction/);
});

test("PostgreSQL attempt history retains target generation and acceptance facts in order", async () => {
  const jobId = "00000000-0000-4000-8000-000000000101";
  const database = {
    async query(sql, values) {
      assert.match(sql, /LEFT JOIN compute\.lease_sets/);
      assert.deepEqual(values, [jobId]);
      return { rows: [{
        id: "00000000-0000-4000-8000-000000000201", job_id: jobId,
        attempt_number: 1, node_id: "00000000-0000-4000-8000-000000000301",
        node_generation: "7", model_profile_id: "00000000-0000-4000-8000-000000000401",
        dispatch_fence: "11", status: "lost", acceptance_state: "not_accepted",
        retryable: true, error_code: "node_fence_changed", dispatched_at: null,
        accepted_at: null, started_at: null, finished_at: "2026-08-11T08:00:01Z",
        created_at: "2026-08-11T08:00:00Z",
      }] };
    },
    async transaction() { throw new Error("transaction was unexpected"); },
  };
  const manager = new LeaseManager({ repository: new PostgresLeaseRepository({ database }) });
  const history = await manager.attemptHistory({ jobId });
  assert.equal(history[0].nodeGeneration, 7);
  assert.equal(history[0].acceptanceState, "not_accepted");
  assert.equal(history[0].retryable, true);
  assert.equal(history[0].errorCode, "node_fence_changed");
});

test("PostgreSQL node-exclusive acquisition treats realtime sessions as conflicts", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/postgres-lease-repository.mjs", import.meta.url), "utf8"));
  assert.match(source, /activeRealtimeSessions/);
  assert.match(source, /FROM compute\.realtime_sessions[\s\S]*FOR UPDATE/);
  assert.match(source, /activeNodeLeases\.length \|\| activeRealtimeSessions\.length/);
});





test("PostgreSQL node-exclusive lease uses distinct resource-key and node UUID parameters", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/postgres-lease-repository.mjs", import.meta.url), "utf8"));
  assert.match(source,
    /'exclusive', \$1, \$2, \$3, uuidv7\(\), \$4,[\s\S]*\$5, \$6, \$5, \$7, \$8, 1/);
  assert.match(source,
    /`\$\{input\.nodeId\}:exclusive`, input\.jobId[\s\S]*inserted\.id, input\.nodeId/);
});

test("PostgreSQL exclusive intent serializes the job and node before becoming an admission gate", async () => {
  const requestedAt = new Date(ACQUIRED);
  const deadlineAt = new Date(ACQUIRED.getTime() + 60_000);
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("SET state = 'expired'")) return { rows: [] };
    if (sql.includes("WHERE id = $1 FOR UPDATE") && sql.includes("node_exclusive_intents")) return { rows: [] };
    if (sql.includes("FROM compute.jobs WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ id: "job-a", status: "queued", cancel_requested_at: null }] };
    }
    if (sql.includes("FROM compute.nodes") && sql.includes("WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ id: "node-a", lifecycle_state: "ready" }] };
    }
    if (sql.includes("WHERE node_id = $1 AND state IN ('pending','acquired')")) return { rows: [] };
    if (sql.startsWith("INSERT INTO compute.node_exclusive_intents")) {
      return { rows: [{
        id: "intent-a", node_id: "node-a", job_id: "job-a", state: "pending",
        lease_set_id: null, requested_at: requestedAt, deadline_at: deadlineAt,
        finished_at: null, finish_reason: null,
      }] };
    }
    return { rows: [] };
  });
  const manager = new LeaseManager({ repository: new PostgresLeaseRepository({ database }) });
  const intent = await manager.beginExclusiveIntent({
    intentId: "intent-a", jobId: "job-a", nodeId: "node-a",
    ttlMilliseconds: 60_000, now: requestedAt,
  });
  assert.equal(intent.state, "pending");
  const statements = database.queries.map((query) => query.sql);
  const jobLock = statements.findIndex((sql) => sql.includes("FROM compute.jobs WHERE id = $1 FOR UPDATE"));
  const nodeLock = statements.findIndex((sql) => sql.includes("FROM compute.nodes") && sql.includes("FOR UPDATE"));
  const gateRead = statements.findIndex((sql) => sql.includes("WHERE node_id = $1 AND state IN ('pending','acquired')"));
  const insert = statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.node_exclusive_intents"));
  assert.ok(jobLock >= 0 && nodeLock > jobLock && gateRead > nodeLock && insert > gateRead);
  assert.ok(database.queries.every((query) => query.transaction));
});
