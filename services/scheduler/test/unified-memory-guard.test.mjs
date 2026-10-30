import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateUnifiedMemoryPressure,
  MemoryPressureCoordinator,
  UnifiedMemoryGuard,
} from "../src/unified-memory-guard.mjs";

const NOW = new Date("2026-08-10T06:00:00.000Z");
const POLICY = Object.freeze({
  maximumEvidenceAgeMilliseconds: 10_000,
  warningAvailableRatio: 0.2,
  criticalAvailableRatio: 0.1,
  warningCgroupRatio: 0.8,
  criticalCgroupRatio: 0.95,
  warningPsiSomeAverage10: 0.2,
  criticalPsiFullAverage10: 0.1,
  engineEnvelopeToleranceRatio: 0.05,
  maximumIdleUnloadsPerSweep: 2,
});

test("inactive file cache changes pressure only, never resource accounting or hard limits", () => {
  const value = snapshot(); value.workers[0].cgroup.currentBytes = 49_000;
  let result = evaluateUnifiedMemoryPressure(value, { memoryPolicy: POLICY });
  assert(result.reasons.some(r => r.code === "worker_cgroup_memory_critical"));
  value.workers[0].cgroup.inactiveFileBytes = 10_000;
  result = evaluateUnifiedMemoryPressure(value, { memoryPolicy: POLICY });
  assert(!result.reasons.some(r => r.code === "worker_cgroup_memory_critical"));
  value.workers[0].runtime.oomKilled = true;
  assert(evaluateUnifiedMemoryPressure(value, { memoryPolicy: POLICY }).reasons.some(r => r.code === "worker_runtime_oom_killed"));
  value.workers[0].cgroup.inactiveFileBytes = 50_000;
  assert.throws(() => evaluateUnifiedMemoryPressure(value), /inactive file/);
});

function worker(overrides = {}) {
  return {
    workerId: "worker-a",
    observedAt: NOW,
    lifecycleState: "ready",
    activeAttemptCount: 0,
    cgroup: {
      currentBytes: 15_000,
      maximumBytes: 50_000,
      events: { high: 0, max: 0, oom: 0, oomKill: 0, oomGroupKill: 0 },
    },
    process: { residentBytes: 14_000 },
    engine: {
      allocatedBytes: 10_000,
      modelBytes: 8_000,
      cacheBytes: 2_000,
      certifiedEnvelopeBytes: 20_000,
    },
    runtime: { oomKilled: false },
    ...structuredClone(overrides),
  };
}

function snapshot(overrides = {}) {
  return {
    nodeId: "node-a",
    observedAt: NOW,
    host: {
      observedAt: NOW,
      totalBytes: 100_000,
      availableBytes: 60_000,
      pressure: { someAverage10: 0, fullAverage10: 0 },
    },
    driver: {
      observedAt: NOW,
      acceleratorUtilizationPercent: 0,
      dedicatedMemory: { status: "unsupported", reasonCode: "unified_memory_architecture" },
    },
    workers: [worker()],
    activeReservations: [{
      reservationId: "reservation-a", workerId: "worker-a", unifiedMemoryBytes: 20_000,
    }],
    controlPlaneFloorBytes: 10_000,
    workload: { class: "batch", requestedBytes: 10_000, coldLoad: false },
    ...structuredClone(overrides),
  };
}

test("healthy admission reconciles host, reservation, cgroup, process, engine, and driver evidence", () => {
  const result = evaluateUnifiedMemoryPressure(snapshot(), { memoryPolicy: POLICY });
  assert.equal(result.state, "healthy");
  assert.equal("admission" in result, false);
  assert.deepEqual(result.unifiedMemory, {
    totalBytes: 100_000,
    availableBytes: 60_000,
    observedCgroupBytes: 15_000,

  });
  assert.deepEqual(result.dedicatedVram, {
    status: "unavailable", reasonCode: "unified_memory_architecture",
  });
  assert.equal("totalBytes" in result.dedicatedVram, false);
  assert.equal(result.evidence.cgroupWorkerCount, 1);
  assert.equal(result.evidence.processWorkerCount, 1);
  assert.equal(result.evidence.engineWorkerCount, 1);
});

test("legacy reservation totals and floors never gate a new load", () => {
 const result=evaluateUnifiedMemoryPressure(snapshot({activeReservations:[{unifiedMemoryBytes:2**40}],controlPlaneFloorBytes:2**40,workload:{requestedBytes:2**40,coldLoad:true}}),{memoryPolicy:POLICY});
 assert.equal(result.state,"healthy"); assert.equal("admission" in result,false);
 assert(!result.actions.includes("reject_new_admission"));
});

test("stale or missing evidence and any fabricated dedicated-VRAM status fail closed", () => {
  const stale = snapshot({ host: { ...snapshot().host, observedAt: new Date(NOW.getTime() - 20_000) } });
  const staleResult = evaluateUnifiedMemoryPressure(stale, { memoryPolicy: POLICY });
  assert.equal("admission" in staleResult, false);
  assert.equal(staleResult.evidence.host.status, "stale");
  const invalidDriver = snapshot({
    driver: { observedAt: NOW, dedicatedMemory: { status: "supported", totalBytes: 20_000 } },
  });
  const invalidResult = evaluateUnifiedMemoryPressure(invalidDriver, { memoryPolicy: POLICY });
  assert.equal("admission" in invalidResult, false);
  assert.equal(invalidResult.reasons.some((item) => item.code === "dedicated_vram_evidence_invalid"), true);

  const missingCgroup = evaluateUnifiedMemoryPressure(snapshot({
    workers: [worker({ cgroup: null, engine: { status: "unavailable" }, runtime: { status: "unavailable" } })],
  }), { memoryPolicy: POLICY });
  assert.equal("admission" in missingCgroup, false);
  assert.equal(missingCgroup.reasons.some((item) => item.code === "worker_cgroup_evidence_missing"), true);
  assert.equal(missingCgroup.reasons.some((item) => item.code === "worker_runtime_evidence_missing"), true);
  assert.equal(missingCgroup.reasons.some((item) => item.code === "worker_engine_evidence_unavailable"), true);
});

test("warning pressure remains observable without batch or realtime budget admission", () => {
  const warningHost = { ...snapshot().host, availableBytes: 19_000 };
  const cold = evaluateUnifiedMemoryPressure(snapshot({
    host: warningHost,
    activeReservations: [], workers: [],
    workload: { class: "batch", requestedBytes: 1_000, coldLoad: true },
  }), { memoryPolicy: POLICY });
  assert.equal(cold.state, "warning");
  assert.equal("admission" in cold, false);
  assert.equal(cold.reasons.some((item) => item.code === "memory_pressure_cold_load_blocked"), false);

  const realtime = evaluateUnifiedMemoryPressure(snapshot({
    host: warningHost,
    activeReservations: [], workers: [],
    workload: { class: "realtime", requestedBytes: 1_000, coldLoad: false },
  }), { memoryPolicy: POLICY });
  assert.equal(realtime.state, "warning");
  assert.equal("admission" in realtime, false);
});

test("new cgroup OOM events, runtime OOMKilled, cgroup limits, and engine overage become critical", () => {
  const guard = new UnifiedMemoryGuard({ memoryPolicy: POLICY });
  assert.equal(guard.evaluate(snapshot()).state, "healthy");
  const pressured = snapshot({
    workers: [worker({
      cgroup: {
        currentBytes: 49_000,
        maximumBytes: 50_000,
        events: { high: 1, max: 1, oom: 1, oomKill: 1, oomGroupKill: 0 },
      },
      engine: {
        allocatedBytes: 22_000, modelBytes: 18_000, cacheBytes: 4_000,
        certifiedEnvelopeBytes: 20_000,
      },
    })],
    activeReservations: [{ reservationId: "reservation-a", unifiedMemoryBytes: 50_000 }],
  });
  const result = guard.evaluate(pressured);
  assert.equal(result.state, "critical");
  assert.equal("admission" in result, false);
  assert.deepEqual(result.oomWorkerIds, ["worker-a"]);
  assert.ok(result.actions.includes("fence_oom_workers"));
  assert.ok(result.actions.includes("alert_administrator"));

  const runtime = new UnifiedMemoryGuard({ memoryPolicy: POLICY }).evaluate(snapshot({
    workers: [worker({ runtime: { oomKilled: true } })],
  }));
  assert.equal(runtime.reasons.some((item) => item.code === "worker_runtime_oom_killed"), true);
});

test("memory monitor reports critical real pressure but has no reservation admission method", () => {
 const guard=new UnifiedMemoryGuard({memoryPolicy:POLICY});
 assert.equal(guard.evaluate(snapshot({host:{...snapshot().host,availableBytes:5000}})).state,"critical");
 assert.equal(guard.assertAdmissible,undefined);
});

test("pressure coordination fences OOM workers, unloads largest idle workers, and emits redacted state", async () => {
  const baselineGuard = new UnifiedMemoryGuard({ memoryPolicy: POLICY });
  baselineGuard.evaluate(snapshot());
  const calls = [];
  const events = [];
  const coordinator = new MemoryPressureCoordinator({
    guard: baselineGuard,
    memoryPolicy: POLICY,
    workerRepository: {
      async list() {
        return [
          { workerId: "worker-small", activeAttemptIds: [], resources: { unifiedMemoryBytes: 10_000 } },
          { workerId: "worker-busy", activeAttemptIds: ["attempt-a"], resources: { unifiedMemoryBytes: 50_000 } },
          { workerId: "worker-large", activeAttemptIds: [], resources: { unifiedMemoryBytes: 30_000 } },
          { workerId: "worker-protected", placement_class: "protected-resident",
            maintenance_generation: 9, activeAttemptIds: [], resources: { unifiedMemoryBytes: 60_000 } },
        ];
      },
    },
    workerLifecycle: {
      async recordCrash(input) { calls.push({ operation: "crash", ...input }); },
      async unload(input) { calls.push({ operation: "unload", ...input }); },
    },
    eventSink: { async publish(event) { events.push(structuredClone(event)); } },
  });
  const result = await coordinator.reconcile(snapshot({
    workers: [worker({
      cgroup: {
        currentBytes: 49_000, maximumBytes: 50_000,
        events: { high: 1, max: 1, oom: 1, oomKill: 1, oomGroupKill: 0 },
      },
    })],
    activeReservations: [{ reservationId: "reservation-a", unifiedMemoryBytes: 50_000 }],
  }));
  assert.deepEqual(result.fenced, ["worker-a"]);
  assert.deepEqual(result.unloaded, ["worker-large", "worker-small"]);
  assert.equal(calls.some((call) => call.workerId === "worker-busy"), false);
  assert.equal(calls.some((call) => call.workerId === "worker-protected"), false);
  assert.deepEqual(Object.keys(events[0].payload).sort(), [
    "fencedWorkerIds", "healthy", "reasonCodes", "state", "unloadedWorkerIds",
  ]);
});

test("memory pressure never fences or unloads a known protected-resident Worker", async () => {
  const guard = new UnifiedMemoryGuard({ memoryPolicy: POLICY });
  guard.evaluate(snapshot({ workers: [], activeReservations: [] }));
  const calls = [];
  const coordinator = new MemoryPressureCoordinator({
    guard,
    memoryPolicy: POLICY,
    workerRepository: { async list() { return [{
      workerId: "worker-protected",
      placementClass: "protected-resident",
      maintenanceGeneration: 12,
      lifecycleState: "ready",
      activeAttemptIds: [],
      resources: { unifiedMemoryBytes: 60_000 },
    }]; } },
    workerLifecycle: {
      async recordCrash(input) { calls.push({ operation: "crash", ...input }); },
      async unload(input) { calls.push({ operation: "unload", ...input }); },
    },
    eventSink: { async publish() {} },
  });
  const result = await coordinator.reconcile(snapshot({
    workers: [worker({
      workerId: "worker-protected",
      cgroup: {
        currentBytes: 49_000, maximumBytes: 50_000,
        events: { high: 1, max: 1, oom: 1, oomKill: 1, oomGroupKill: 0 },
      },
    })],
    activeReservations: [{
      reservationId: "reservation-protected",
      workerId: "worker-protected",
      unifiedMemoryBytes: 50_000,
    }],
  }));
  assert.deepEqual(result.fenced, []);
  assert.deepEqual(result.unloaded, []);
  assert.deepEqual(calls, []);
});
