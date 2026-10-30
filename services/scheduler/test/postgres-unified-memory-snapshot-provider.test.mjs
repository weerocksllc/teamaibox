import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresUnifiedMemorySnapshotProvider,
  unifiedMemoryPolicyFromEnvironment,
} from "../src/postgres-unified-memory-snapshot-provider.mjs";
import { evaluateUnifiedMemoryPressure } from "../src/unified-memory-guard.mjs";

const NODE = "00000000-0000-4000-8000-000000000001";
const WORKER = "00000000-0000-4000-8000-000000000002";
const PROFILE = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-26T01:00:00.000Z");
const GIB = 2 ** 30;

function metricRecord(overrides = {}) {
  return {
    nodeId: NODE,
    nodeGeneration: 4,
    sequence: 10,
    observedAt: new Date(NOW.getTime() - 1_000),
    snapshot: {
      domains: { unifiedMemory: {
        totalBytes: { status: "measured", value: 128 * GIB },
        availableBytes: { status: "measured", value: 96 * GIB },
      } },
      memoryPressure: {
        someAverage10: { status: "measured", value: 0.01 },
        fullAverage10: { status: "measured", value: 0 },
      },
      workers: [{
        workerId: WORKER,
        cgroup: { currentBytes: 4 * GIB, peakBytes: 5 * GIB, maximumBytes: 20 * GIB,
          events: { high: 0, max: 0, oom: 0, oomKill: 0, oomGroupKill: 0 } },
        process: { residentBytes: 3 * GIB },
        engine: { status: "measured", reasonCode: null, allocatedBytes: 4 * GIB,
          modelBytes: 3 * GIB, cacheBytes: 1 * GIB, certifiedEnvelopeBytes: 8 * GIB },
        runtime: { status: "measured", reasonCode: null, oomKilled: false },
      }],
    },
    ...structuredClone(overrides),
  };
}

function database({ nodeRows = null, reservationRows = null } = {}) {
  return {
    async query(sql) {
      if (sql.includes("FROM compute.nodes node")) return { rows: nodeRows ?? [{
        node_generation: "4", node_lifecycle_state: "ready", worker_id: WORKER,
        worker_node_generation: "4",
        model_profile_id: PROFILE, worker_lifecycle_state: "ready", active_attempt_count: "0",
      }] };
      if (sql.includes("active_reservations")) return { rows: reservationRows ?? [{
        reservation_id: "lease:00000000-0000-4000-8000-000000000004",
        worker_id: WORKER, unified_memory_bytes: String(8 * GIB),
      }] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async transaction(operation) { return operation(this); },
  };
}

test("PostgreSQL provider reconciles current host, worker, OOM, engine, and reservation evidence", async () => {
  const provider = new PostgresUnifiedMemorySnapshotProvider({
    database: database(), metricRepository: { async latestForNode() { return metricRecord(); } },
    clock: () => NOW, controlPlaneFloorBytes: 8 * GIB,
  });
  const snapshot = await provider.snapshot({ nodeId: NODE, modelProfileId: PROFILE, observedAt: NOW });
  assert.equal(snapshot.host.totalBytes, 128 * GIB);
  assert.equal(snapshot.host.pressure.someAverage10, 0.01);
  assert.equal(snapshot.workers[0].runtime.oomKilled, false);
  assert.equal(snapshot.workers[0].engine.certifiedEnvelopeBytes, 8 * GIB);
  assert.equal("activeReservations" in snapshot,false);
  assert.equal(snapshot.workload.coldLoad, false);
  const decision = evaluateUnifiedMemoryPressure({
    ...snapshot, workload: { class: "batch", requestedBytes: GIB, coldLoad: false },
  }, { memoryPolicy: {
    maximumEvidenceAgeMilliseconds: 15_000,
    coreServiceFloorBytes: 8 * GIB,
    emergencyHeadroomBytes: 2 * GIB,
  } });
  assert.equal("admission" in decision,false);
  assert.equal(decision.state, "healthy");
});

test("casting accounts for authenticated protected residents without inventing job worker rows", async () => {
  const record = metricRecord(); record.snapshot.workers[0].state = "busy";
  const provider = new PostgresUnifiedMemorySnapshotProvider({
    database: database({ nodeRows: [{ node_generation: "4", node_lifecycle_state: "ready", worker_id: null }], reservationRows: [] }),
    metricRepository: { async latestForNode() { return record; } }, clock: () => NOW,
  });
  assert.equal((await provider.snapshot({ nodeId: NODE })).workers.length, 1);
  const snapshot = await provider.snapshot({ nodeId: NODE, includeAuthenticatedWorkers: true });
  assert.equal(snapshot.workers.length, 1); assert.equal(snapshot.workers[0].workerId, WORKER);
  assert.equal(snapshot.workers[0].cgroup.currentBytes, 4 * GIB);
  record.nodeGeneration = 3;
  assert.equal((await provider.snapshot({ nodeId: NODE, includeAuthenticatedWorkers: true })).workers.length, 0);
});

test("a computer reservation uses its authenticated run memory instead of charging the whole limit twice", async () => {
  const record = metricRecord(); record.snapshot.workers[0].state = "busy";
  const provider = new PostgresUnifiedMemorySnapshotProvider({
    database: database({ nodeRows: [{ node_generation: "4", node_lifecycle_state: "ready", worker_id: null }],
      reservationRows: [{ reservation_id: "computer:reservation", worker_id: WORKER, unified_memory_bytes: String(10 * GIB) }] }),
    metricRepository: { async latestForNode() { return record; } }, clock: () => NOW,
  });
  const snapshot = await provider.snapshot({ nodeId: NODE, modelProfileId: PROFILE });
  assert.equal(snapshot.workers.length, 1);
  assert.equal(snapshot.workers[0].workerId, WORKER);
  assert.equal(snapshot.workload.coldLoad, true);
  assert.equal(snapshot.workers[0].cgroup.currentBytes, 4 * GIB);
  assert.equal("activeReservations" in snapshot,false);
});

test("missing, stale-generation, or incomplete worker evidence fails closed", async () => {
  const missing = new PostgresUnifiedMemorySnapshotProvider({
    database: database({ nodeRows: [] }), metricRepository: { async latestForNode() { return null; } },
    clock: () => NOW,
  });
  const missingDecision = evaluateUnifiedMemoryPressure({
    ...(await missing.snapshot({ nodeId: NODE, observedAt: NOW })),
    workload: { class: "batch", requestedBytes: 1, coldLoad: true },
  });
  assert.equal("admission" in missingDecision,false);
  assert.equal(missingDecision.reasons.some((value) => value.code === "host_memory_evidence_stale"), true);

  const incomplete = new PostgresUnifiedMemorySnapshotProvider({
    database: database(), metricRepository: { async latestForNode() {
      const value = metricRecord();
      value.snapshot.workers = [];
      return value;
    } }, clock: () => NOW,
  });
  const incompleteDecision = evaluateUnifiedMemoryPressure({
    ...(await incomplete.snapshot({ nodeId: NODE, modelProfileId: PROFILE, observedAt: NOW })),
    workload: { class: "batch", requestedBytes: 1, coldLoad: false },
  });
  assert.equal("admission" in incompleteDecision,false);
  assert.equal(incompleteDecision.reasons.some((value) => value.code === "worker_cgroup_evidence_missing"), true);
  assert.equal(incompleteDecision.reasons.some((value) => value.code === "worker_runtime_evidence_missing"), true);
});

test("obsolete Worker generations cannot masquerade as current memory pressure", async () => {
  const stale = new PostgresUnifiedMemorySnapshotProvider({
    database: database({ nodeRows: [{
      node_generation: "4", node_lifecycle_state: "ready", worker_id: WORKER,
      worker_node_generation: "3", model_profile_id: PROFILE,
      worker_lifecycle_state: "ready", active_attempt_count: "0",
    }], reservationRows: [] }),
    metricRepository: { async latestForNode() {
      const value = metricRecord();
      value.snapshot.workers = [];
      return value;
    } },
    clock: () => NOW,
  });
  const snapshot = await stale.snapshot({ nodeId: NODE, modelProfileId: PROFILE, observedAt: NOW });
  assert.deepEqual(snapshot.workers, []);
  assert.equal(snapshot.workload.coldLoad, true);
});

test("environment exposes observation freshness, not fixed core reservations", () => {
 assert.deepEqual(Object.keys(unifiedMemoryPolicyFromEnvironment({})),["maximumEvidenceAgeMilliseconds"]);
 assert.throws(()=>unifiedMemoryPolicyFromEnvironment({PLATFORM_UNIFIED_MEMORY_MAXIMUM_EVIDENCE_AGE_MILLISECONDS:"999999999"}),/outside its supported range/);
});
