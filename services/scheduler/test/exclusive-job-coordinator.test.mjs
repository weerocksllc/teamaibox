import assert from "node:assert/strict";
import test from "node:test";
import policy from "../../../deploy/compose/resource-policy.json" with { type: "json" };
import { ExclusiveJobCoordinator, requiredCoreSurvivalDomains } from "../src/exclusive-job-coordinator.mjs";
import { LeaseManager } from "../src/lease-manager.mjs";
import { MemoryLeaseRepository } from "../src/memory-lease-repository.mjs";

const now = new Date("2026-08-11T02:00:00Z");
const reservation = {
  cpuMillis: 8_000, unifiedMemoryBytes: 96 * 2 ** 30,
  acceleratorUnits: 1, codecSessions: 0, storageBytes: 10 * 2 ** 30,
  networkBitsPerSecond: 2_000_000_000,
};
const demand = {
  cpuMillis: 8_000, unifiedMemoryBytes: 96 * 2 ** 30,
  diskReadBytesPerSecond: 512 * 2 ** 20,
  diskWriteBytesPerSecond: 256 * 2 ** 20,
  networkBitsPerSecond: 2_000_000_000,
};
const capacity = {
  ...reservation,
  cpuMillis: 20_000, unifiedMemoryBytes: 128 * 2 ** 30,
  acceleratorUnits: 2, codecSessions: 2, storageBytes: 2 ** 40,
  diskReadBytesPerSecond: 2 ** 30, diskWriteBytesPerSecond: 512 * 2 ** 20,
  networkBitsPerSecond: 10_000_000_000,
};

function fixture({
  failPhase = null, incompleteDrain = false, abortAfterFirstDrain = null,
  acquisitionFailures = 0, acquisitionFailureCode = "lease_capacity_exhausted",
  conflicts = [{ workerId: "worker-b" }, { workerId: "worker-a" }],
  maintenanceAuthorizer = null,
} = {}) {
  const repository = new MemoryLeaseRepository({
    nodes: [{ nodeId: "node-a", lifecycleState: "ready", generation: 7, capacity }],
    jobs: [{ jobId: "job-exclusive", status: "queued", cancelRequestedAt: null }],
  });
  const leaseManager = new LeaseManager({ repository });
  let remainingAcquisitionFailures = acquisitionFailures;
  let acquisitionAttempts = 0;
  const waits = [];
  const coordinatorLeaseManager = {
    beginExclusiveIntent: (value) => leaseManager.beginExclusiveIntent(value),
    cancelExclusiveIntent: (value) => leaseManager.cancelExclusiveIntent(value),
    release: (value) => leaseManager.release(value),
    async acquire(value) {
      acquisitionAttempts += 1;
      if (remainingAcquisitionFailures > 0) {
        remainingAcquisitionFailures -= 1;
        throw Object.assign(new Error(acquisitionFailureCode), { code: acquisitionFailureCode });
      }
      return leaseManager.acquire(value);
    },
  };
  const order = [];
  const events = [];
  const coordinator = new ExclusiveJobCoordinator({
    leaseManager: coordinatorLeaseManager,
    workerDrainer: {
      async listConflictingWorkers() { order.push("list"); return structuredClone(conflicts); },
      async drainWorker(input) {
        order.push("drain:" + input.workerId);
        if (input.workerId === "worker-b") abortAfterFirstDrain?.abort();
        return { workerId: input.workerId, state: incompleteDrain ? "draining" : "stopped", leasesReleased: !incompleteDrain };
      },
      async restoreWorker(input) { order.push("restore:" + input.workerId); return { workerId: input.workerId, state: "running" }; },
    },
    survivalProbe: { async check({ domains, phase }) {
      order.push("health:" + phase);
      return Object.fromEntries(domains.map((domain) => [domain, { healthy: phase !== failPhase, latencyMilliseconds: 2 }]));
    } },
    eventSink: { async publish(event) { events.push(event); } },
    resourcePolicy: policy,
    clock: () => new Date(now),
    capacityRefreshTimeoutMilliseconds: 5_000,
    capacityRefreshPollMilliseconds: 1_000,
    wait: async (milliseconds, signal) => {
      signal?.throwIfAborted();
      waits.push(milliseconds);
    },
    maintenanceAuthorizer,
  });
  return {
    coordinator, repository, order, events, waits,
    acquisitionAttempts: () => acquisitionAttempts,
  };
}

function input(overrides = {}) {
  return {
    intentId: "intent-exclusive", acquisitionKey: "acquire-exclusive",
    jobId: "job-exclusive", nodeId: "node-a", nodeGeneration: 7,
    modelProfileId: "profile-exclusive", reservation,
    controlPlaneDemand: demand, nodeCapacity: capacity,
    leaseTtlMilliseconds: 60_000, intentTtlMilliseconds: 120_000,
    attemptId: "attempt-exclusive", leaseToken: "lease-exclusive",
    correlationId: "correlation.exclusive-1", now,
    ...overrides,
  };
}

test("exclusive preparation gates admissions, drains workers, verifies seven domains, then acquires", async () => {
  const value = fixture();
  const prepared = await value.coordinator.prepare(input());
  assert.equal(prepared.lease.nodeExclusive, true);
  assert.deepEqual(prepared.drained.map((worker) => worker.workerId), ["worker-b", "worker-a"]);
  assert.deepEqual(value.order, [
    "health:before_drain", "list", "drain:worker-b", "drain:worker-a",
    "health:after_drain", "health:after_exclusive_lease",
  ]);
  assert.deepEqual(Object.keys(policy.serviceSurvivalDomains).sort(), [...requiredCoreSurvivalDomains].sort());
  assert.equal(value.events[0].type, "scheduler.node_exclusive_ready");
  assert.deepEqual(value.events[0].payload.drainedWorkerIds, ["worker-a", "worker-b"]);
  const restored = await value.coordinator.restore({ jobId: "job-exclusive", nodeId: "node-a", nodeGeneration: 7,
    correlationId: "correlation.exclusive-1", lease: prepared.lease, drained: prepared.drained });
  assert.deepEqual(restored.map((item) => item.workerId), ["worker-a", "worker-b"]);
  assert.equal(value.events[1].type, "scheduler.node_exclusive_restored");
});

test("core-service failure after lease acquisition releases the exclusive lease", async () => {
  const value = fixture({ failPhase: "after_exclusive_lease" });
  await assert.rejects(() => value.coordinator.prepare(input()), { code: "core_service_survival_failed" });
  const snapshot = await value.repository.snapshot();
  assert.equal(snapshot.leaseSets[0].state, "released");
  assert.equal(snapshot.exclusiveIntents[0].state, "completed");
});

test("incomplete drain cancels the pending intent before any exclusive lease exists", async () => {
  const value = fixture({ incompleteDrain: true });
  await assert.rejects(() => value.coordinator.prepare(input()), { code: "exclusive_worker_drain_incomplete" });
  const snapshot = await value.repository.snapshot();
  assert.equal(snapshot.leaseSets.length, 0);
  assert.equal(snapshot.exclusiveIntents[0].state, "cancelled");
});

test("reserve violation is rejected before intent creation or worker drain", async () => {
  const value = fixture();
  await assert.rejects(() => value.coordinator.prepare(input({
    controlPlaneDemand: { ...demand, unifiedMemoryBytes: 124 * 2 ** 30 },
  })), { code: "control_plane_reserve_violation" });
  assert.equal((await value.repository.snapshot()).exclusiveIntents.length, 0);
  assert.deepEqual(value.order, []);
});

test("cancellation during drain restores stopped workers and prevents lease acquisition", async () => {
  const controller = new AbortController();
  const value = fixture({ abortAfterFirstDrain: controller });
  await assert.rejects(() => value.coordinator.prepare(input({ signal: controller.signal })), { name: "AbortError" });
  const snapshot = await value.repository.snapshot();
  assert.equal(snapshot.leaseSets.length, 0);
  assert.equal(snapshot.exclusiveIntents[0].state, "cancelled");
  assert.deepEqual(value.order, ["health:before_drain", "list", "drain:worker-b", "restore:worker-b"]);
});

test("capacity exhaustion after drain waits for a fresh node heartbeat without draining twice", async () => {
  const value = fixture({ acquisitionFailures: 1 });
  const prepared = await value.coordinator.prepare(input());
  assert.equal(prepared.lease.state, "active");
  assert.equal(value.acquisitionAttempts(), 2);
  assert.deepEqual(value.waits, [1_000]);
  assert.equal(value.order.filter((entry) => entry === "drain:worker-b").length, 1);
  assert.equal(value.order.filter((entry) => entry === "drain:worker-a").length, 1);
  assert.equal((await value.repository.snapshot()).exclusiveIntents.length, 1);
});

test("stale capacity metrics after drain wait for a fresh authenticated snapshot", async () => {
  const value = fixture({ acquisitionFailures: 1, acquisitionFailureCode: "node_capacity_metrics_stale" });
  const prepared = await value.coordinator.prepare(input());
  assert.equal(prepared.lease.state, "active");
  assert.equal(value.acquisitionAttempts(), 2);
  assert.deepEqual(value.waits, [1_000]);
});

test("pre-drain unified-memory pressure waits for a post-drain snapshot without weakening the guard", async () => {
  const value = fixture({ acquisitionFailures: 2, acquisitionFailureCode: "unified_memory_pressure" });
  const prepared = await value.coordinator.prepare(input());
  assert.equal(prepared.lease.state, "active");
  assert.equal(value.acquisitionAttempts(), 3);
  assert.deepEqual(value.waits, [1_000, 1_000]);
  assert.equal(value.order.filter((entry) => entry.startsWith("drain:")).length, 2);
});

test("non-capacity lease failures are not retried and restore every drained worker", async () => {
  const value = fixture({ acquisitionFailures: 1, acquisitionFailureCode: "lease_repository_unavailable" });
  await assert.rejects(() => value.coordinator.prepare(input()), { code: "lease_repository_unavailable" });
  assert.equal(value.acquisitionAttempts(), 1);
  assert.deepEqual(value.waits, []);
  assert.deepEqual(value.order.slice(-2), ["restore:worker-a", "restore:worker-b"]);
  assert.equal((await value.repository.snapshot()).exclusiveIntents[0].state, "cancelled");
});

test("ordinary exclusive work fails closed before draining a protected-resident conflict", async () => {
  const value = fixture({ conflicts: [
    { workerId: "worker-warm", placementClass: "warm-optional", maintenanceGeneration: 3 },
    { workerId: "worker-protected", placementClass: "protected-resident", maintenanceGeneration: 3 },
  ] });
  await assert.rejects(value.coordinator.prepare(input()), {
    code: "protected_resident_maintenance_required",
  });
  assert.deepEqual(value.order, ["health:before_drain", "list"]);
  const snapshot = await value.repository.snapshot();
  assert.equal(snapshot.leaseSets.length, 0);
  assert.equal(snapshot.exclusiveIntents[0].state, "cancelled");
});

test("exclusive work cannot use a per-drain signature to stop a protected-resident Worker", async () => {
  const authorizations = [];
  const conflicts = [
    { workerId: "worker-protected", placement_class: "protected-resident", maintenance_generation: 3 },
    { workerId: "worker-warm", placementClass: "warm-optional", maintenanceGeneration: 3 },
  ];
  const value = fixture({
    conflicts,
    maintenanceAuthorizer: async ({ context, operation, workers }) => {
      authorizations.push({ context, operation, workers });
      return {
        authorized: true,
        signatureVerified: true,
        transactionId: context.transactionId,
        workerIds: context.workerIds,
        operation,
        maintenanceGeneration: context.maintenanceGeneration,
      };
    },
  });
  const maintenanceContext = {
    transactionId: "maintenance.exclusive-0001",
    workerIds: ["worker-warm", "worker-protected"],
    allowedOperations: ["exclusive.drain"],
    maintenanceGeneration: 3,
    issuedAt: "2026-08-11T01:59:00Z",
    expiresAt: "2026-08-11T02:10:00Z",
  };
  await assert.rejects(value.coordinator.prepare(input({ maintenanceContext })), {
    code: "protected_resident_maintenance_required",
  });
  assert.equal(authorizations.length, 0);
  assert.deepEqual(value.order, ["health:before_drain", "list"]);
  assert.equal((await value.repository.snapshot()).exclusiveIntents[0].state, "cancelled");
});

test("exclusive work rejects every signed protected scope before the first drain", async () => {
  let verified = false;
  const value = fixture({
    conflicts: [
      { workerId: "worker-protected", placementClass: "protected-resident", maintenanceGeneration: 3 },
      { workerId: "worker-warm", placementClass: "warm-optional", maintenanceGeneration: 3 },
    ],
    maintenanceAuthorizer: async () => { verified = true; return { authorized: true }; },
  });
  await assert.rejects(value.coordinator.prepare(input({ maintenanceContext: {
    transactionId: "maintenance.exclusive-0002",
    workerIds: ["worker-protected"],
    allowedOperations: ["exclusive.drain"],
    maintenanceGeneration: 3,
    issuedAt: "2026-08-11T01:59:00Z",
    expiresAt: "2026-08-11T02:10:00Z",
  } })), { code: "protected_resident_maintenance_required" });
  assert.equal(verified, false);
  assert.deepEqual(value.order, ["health:before_drain", "list"]);
});
