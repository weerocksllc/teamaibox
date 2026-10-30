import assert from "node:assert/strict";
import test from "node:test";
import { PostgresWorkerRepository } from "../src/postgres-worker-repository.mjs";

function row(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    node_id: "00000000-0000-4000-8000-000000000102",
    node_generation: "7",
    compute_plugin_id: "00000000-0000-4000-8000-000000000103",
    model_profile_id: "00000000-0000-4000-8000-000000000104",
    attempt_id: "00000000-0000-4000-8000-000000000106",
    image_reference: "registry.local/worker@sha256:" + "a".repeat(64),
    architecture: "linux/arm64/v8",
    generation: "2",
    lifecycle_state: "ready",
    health_state: "healthy",
    health_observed_at: "2026-08-11T01:00:00Z",
    health_generation: "2",
    health_reason_code: null,
    resources: { cpuMillis: 1, unifiedMemoryBytes: 2, storageBytes: 3, networkBitsPerSecond: 4, acceleratorUnits: 1, codecSessions: 0 },
    max_concurrent_attempts: 1,
    active_attempt_ids: [],
    attempt_states: {},
    attempt_bindings: {},
    binding_revision: "0",
    reservation_ids: [],
    control_lease_id: "00000000-0000-4000-8000-000000000105",
    control_fencing_token: "7",
    loaded_at: "2026-08-11T01:00:00Z",
    last_heartbeat_at: "2026-08-11T01:00:00Z",
    idle_since: "2026-08-11T01:00:00Z",
    crash_timestamps: [],
    crash_count: 0,
    next_retry_at: null,
    circuit_open_until: null,
    last_failure_code: null,
    created_at: "2026-08-11T00:59:00Z",
    updated_at: "2026-08-11T01:00:00Z",
    ...overrides,
  };
}

test("PostgreSQL mutation locks the worker row and persists the complete lifecycle projection", async () => {
  const queries = [];
  const database = {
    async query() { throw new Error("outside-transaction query was unexpected"); },
    async transaction(operation) {
      const transaction = { async query(sql, values) {
        queries.push([sql, values]);
        if (sql.includes("FOR UPDATE")) return { rows: [row()] };
        if (sql.includes("UPDATE compute.worker_instances")) return { rows: [row({ lifecycle_state: "busy", active_attempt_ids: ["00000000-0000-4000-8000-000000000106"], attempt_states: { "00000000-0000-4000-8000-000000000106": "running" }, idle_since: null })] };
        throw new Error("unexpected query");
      } };
      return operation(transaction);
    },
  };
  const repository = new PostgresWorkerRepository({ database });
  const result = await repository.mutate(row().id, (worker) => {
    worker.lifecycleState = "busy";
    worker.activeAttemptIds = ["00000000-0000-4000-8000-000000000106"];
    worker.attemptStates[worker.activeAttemptIds[0]] = "running";
    worker.idleSince = null;
    return worker;
  });
  assert.equal(result.lifecycleState, "busy");
  assert.ok(queries[0][0].includes("FOR UPDATE"));
  assert.ok(queries[1][0].includes("attempt_bindings = $12::jsonb"));
  assert.equal(queries[1][1][0], row().id);
});

test("PostgreSQL create keeps Worker identity immutable while allowing a new attempt binding", async () => {
  let selected = row();
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({ async query(sql) {
        if (sql.includes("INSERT INTO compute.worker_instances")) return { rows: [] };
        if (sql.includes("FOR UPDATE")) return { rows: [selected] };
        throw new Error("unexpected query");
      } });
    },
  };
  const repository = new PostgresWorkerRepository({ database });
  const worker = {
    workerId: selected.id, nodeId: selected.node_id, nodeGeneration: 7, computePluginId: selected.compute_plugin_id,
    modelProfileId: selected.model_profile_id, image: selected.image_reference,
    attemptId: selected.attempt_id,
    architecture: selected.architecture, generation: 2, lifecycleState: "ready",
    health: { state: "healthy", observedAt: new Date(), generation: 2, reasonCode: null },
    resources: selected.resources, maxConcurrentAttempts: 1, activeAttemptIds: [],
    attemptStates: {}, reservationIds: [], controlLeaseId: selected.control_lease_id,
    attemptBindings: {}, bindingRevision: 0,
    controlFencingToken: 7, loadedAt: new Date(), lastHeartbeatAt: new Date(),
    idleSince: new Date(), crashTimestamps: [], crashCount: 0,
    nextRetryAt: null, circuitOpenUntil: null, lastFailureCode: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  assert.equal((await repository.create(worker)).workerId, worker.workerId);
  selected = row({ attempt_id: "00000000-0000-4000-8000-000000000206" });
  assert.equal((await repository.create(worker)).workerId, worker.workerId);
  for (const changed of [
    { image_reference: "registry.local/other@sha256:" + "b".repeat(64) },
    { control_lease_id: "00000000-0000-4000-8000-000000000205" },
    { control_fencing_token: "8" },
  ]) {
    selected = row(changed);
    await assert.rejects(() => repository.create(worker), /different immutable facts/);
  }
});

test("PostgreSQL list filters lifecycle states in the database", async () => {
  let captured;
  const database = {
    async query(sql, values) { captured = [sql, values]; return { rows: [row()] }; },
    async transaction() { throw new Error("transaction was unexpected"); },
  };
  const repository = new PostgresWorkerRepository({ database });
  assert.equal((await repository.list({ states: ["ready", "busy"] })).length, 1);
  assert.ok(captured[0].includes("ANY($1::text[])"));
  assert.deepEqual(captured[1], [["ready", "busy"]]);
});
