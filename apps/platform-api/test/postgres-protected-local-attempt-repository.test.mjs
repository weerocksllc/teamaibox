import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresProtectedLocalAttemptRepository } from "../src/compute/postgres-protected-local-attempt-repository.mjs";

const JOB = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";
const PROFILE = "44444444-4444-4444-8444-444444444444";
const WORKER = "55555555-5555-4555-8555-555555555555";
const ATTEMPT = "66666666-6666-4666-8666-666666666666";

function database({ active = null, requestedProfile = PROFILE } = {}) {
  const calls = [];
  const adapter = {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("FROM compute.nodes")) return { rows: [{ generation: "4", lifecycle_state: "ready" }] };
      if (sql.includes("INSERT INTO compute.node_lease_fences")) return { rows: [{ fencing_token: "91" }] };
      if (sql.includes("INSERT INTO compute.lease_sets") || sql.includes("INSERT INTO compute.leases")) return { rows: [] };
      if (sql.includes("CROSS JOIN compute.protected_office_sets")) return { rows: [{
        id: JOB, owner_identity_id: OWNER, status: "preparing", cancel_requested_at: null,
        current_attempt_id: null, requested_model_profile_id: requestedProfile,
        node_id: NODE, recovery_state: "healthy", desired_state_revision: "17", observed_state_revision: "17",
        healthy_identities: [{ workerId: WORKER, modelProfileId: PROFILE, healthy: true, state: "running" }],
      }] };
      if (sql.includes("FROM compute.attempts") && sql.includes("worker_instance_key")) {
        return { rows: active ? [active] : [] };
      }
      if (sql.includes("coalesce(max(attempt_number)")) return { rows: [{ value: "2" }] };
      if (sql.includes("INSERT INTO compute.attempts")) return { rows: [] };
      if (sql.includes("UPDATE compute.jobs")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    async transaction(callback) { return callback(adapter); },
  };
  return adapter;
}

function input() {
  return { attemptId: ATTEMPT, jobId: JOB, ownerIdentityId: OWNER, modelProfileId: PROFILE,
    workerId: WORKER, route: "local", startedAt: new Date("2026-09-06T03:00:00.000Z") };
}

test("atomically begins an exact protected-resident local attempt", async () => {
  const db = database();
  const repository = new PostgresProtectedLocalAttemptRepository({ database: db, setId: "office.baseline", nodeId: NODE });
  const result = await repository.begin(input());
  assert.deepEqual(result, {
    admitted: true, attemptId: ATTEMPT, attemptNumber: 2, jobId: JOB, nodeId: NODE,
    modelProfileId: PROFILE, workerId: WORKER, dispatchFence: 91, route: "local",
  });
  const inserted = db.calls.find(({ sql }) => sql.includes("INSERT INTO compute.attempts"));
  assert.equal(inserted.values[0], ATTEMPT);
  assert.equal(inserted.values[3], NODE);
  assert.equal(inserted.values[4], PROFILE);
  assert.equal(inserted.values[5], WORKER);
  assert.equal(inserted.values[6], 91);
  const lease = db.calls.find(({ sql }) => sql.includes("INSERT INTO compute.lease_sets"));
  assert.equal(lease.values[0], ATTEMPT);
  assert.equal(lease.values[3], 4);
  assert.equal(lease.values[7], 91);
  assert.equal(lease.values[10].toISOString(), "2026-09-06T03:31:00.000Z");
  assert.ok(Object.values(JSON.parse(lease.values[8])).every((amount) => amount === 0));
  assert.match(lease.sql, /false,'accepted'/);
  const workerLease = db.calls.find(({ sql }) => sql.includes("INSERT INTO compute.leases ("));
  assert.equal(workerLease.values[0], WORKER);
  assert.equal(workerLease.values[2], ATTEMPT);
  assert.equal(workerLease.values[4], 91);
  assert.match(workerLease.sql, /'worker'/);
  assert.ok(db.calls.some(({ sql }) => sql.includes("current_attempt_id=$2")));
});

test("keeps a conflicting protected Worker request queued with zero new attempt", async () => {
  const db = database({ active: { id: "77777777-7777-4777-8777-777777777777", job_id: "88888888-8888-4888-8888-888888888888" } });
  const repository = new PostgresProtectedLocalAttemptRepository({ database: db, setId: "office.baseline", nodeId: NODE });
  const result = await repository.begin(input());
  assert.equal(result.admitted, false);
  assert.equal(result.reason, "protected_worker_busy");
  assert.equal(db.calls.some(({ sql }) => sql.includes("INSERT INTO compute.attempts")), false);
  assert.equal(db.calls.some(({ sql }) => sql.includes("INSERT INTO compute.lease")), false);
  const queued = db.calls.find(({ sql }) => sql.includes("waiting_reason='protected_worker_busy'"));
  assert.ok(queued);
  assert.equal(queued.values[0], JOB);
});

test("refuses an unready node or unbounded execution lease before creating an attempt", async () => {
  const db = database();
  const original = db.query;
  db.query = async (sql, values) => {
    const result = await original(sql, values);
    if (sql.includes("FROM compute.nodes")) result.rows[0].lifecycle_state = "draining";
    return result;
  };
  const repository = new PostgresProtectedLocalAttemptRepository({ database: db, setId: "office.baseline", nodeId: NODE });
  await assert.rejects(repository.begin(input()), { code: "protected_local_node_not_ready" });
  for (const executionTimeoutMilliseconds of [0, NaN, 3_600_001]) {
    await assert.rejects(repository.begin({ ...input(), executionTimeoutMilliseconds }), TypeError);
  }
  assert.equal(db.calls.some(({ sql }) => sql.includes("INSERT INTO compute.attempts")), false);
});

test("fails closed when the protected set identity is not exact and healthy", async () => {
  const db = database();
  const original = db.query;
  db.query = async (sql, values) => {
    const result = await original(sql, values);
    if (sql.includes("CROSS JOIN compute.protected_office_sets")) result.rows[0].recovery_state = "degraded";
    return result;
  };
  const repository = new PostgresProtectedLocalAttemptRepository({ database: db, setId: "office.baseline", nodeId: NODE });
  await assert.rejects(repository.begin(input()), { code: "protected_local_attempt_boundary_invalid" });
  assert.equal(db.calls.some(({ sql }) => sql.includes("INSERT INTO compute.attempts")), false);
});

test("model-only OpenAI request atomically pins the resolved healthy resident profile", async () => {
  const db = database({ requestedProfile: null });
  const repository = new PostgresProtectedLocalAttemptRepository({ database: db, setId: "office.baseline", nodeId: NODE });
  assert.equal((await repository.begin(input())).admitted, true);
  const update = db.calls.find(({ sql }) => sql.includes("current_attempt_id=$2"));
  assert.match(update.sql, /requested_model_profile_id=COALESCE\(requested_model_profile_id,\$5\)/);
  assert.equal(update.values[4], PROFILE);
});

test("an explicit different profile cannot be replaced by the configured default", async () => {
  const db = database({ requestedProfile: "77777777-7777-4777-8777-777777777777" });
  const repository = new PostgresProtectedLocalAttemptRepository({ database: db, setId: "office.baseline", nodeId: NODE });
  await assert.rejects(repository.begin(input()), { code: "protected_local_attempt_boundary_invalid" });
  assert.equal(db.calls.some(({ sql }) => sql.includes("INSERT INTO compute.attempts")), false);
});

test("model-only request cannot bypass resident identity or set health", async () => {
  const db = database({ requestedProfile: null });
  const original = db.query;
  db.query = async (sql, values) => {
    const result = await original(sql, values);
    if (sql.includes("CROSS JOIN compute.protected_office_sets")) result.rows[0].healthy_identities[0].healthy = false;
    return result;
  };
  const repository = new PostgresProtectedLocalAttemptRepository({ database: db, setId: "office.baseline", nodeId: NODE });
  await assert.rejects(repository.begin(input()), { code: "protected_local_worker_identity_invalid" });
  assert.equal(db.calls.some(({ sql }) => sql.includes("INSERT INTO compute.attempts")), false);
});
