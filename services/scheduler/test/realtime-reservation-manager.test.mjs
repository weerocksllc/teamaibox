import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { LeaseManager } from "../src/lease-manager.mjs";
import { MemoryLeaseRepository } from "../src/memory-lease-repository.mjs";
import {
  RealtimeConnectionLifecycle,
  RealtimeReservationManager,
} from "../src/realtime-reservation-manager.mjs";

const START = new Date("2026-08-10T04:00:00.000Z");
const RESOURCE = Object.freeze({
  cpuMillis: 1_000,
  unifiedMemoryBytes: 2_000,
  acceleratorUnits: 0,
  codecSessions: 1,
  storageBytes: 0,
  networkBitsPerSecond: 1_000,
});

function node(overrides = {}) {
  return {
    nodeId: "node-a",
    lifecycleState: "ready",
    generation: 3,
    capacity: {
      cpuMillis: 4_000,
      unifiedMemoryBytes: 8_000,
      acceleratorUnits: 1,
      codecSessions: 2,
      storageBytes: 10_000,
      networkBitsPerSecond: 4_000,
    },
    codec: { encodeSessions: 1, decodeSessions: 2 },
    ...structuredClone(overrides),
  };
}

function placement(overrides = {}) {
  return {
    nodeId: "node-a",
    nodeGeneration: 3,
    modelProfileId: "profile-realtime",
    route: "local",
    resources: RESOURCE,
    codecDirections: { encodeSessions: 0, decodeSessions: 1 },
    latencyBudgetMilliseconds: 250,
    observedLatencyMilliseconds: 8,
    warm: true,
    ...structuredClone(overrides),
  };
}

function fixture({ nodes = [node()], placements = [placement()] } = {}) {
  let now = new Date(START);
  const repository = new MemoryLeaseRepository({ nodes });
  const manager = new RealtimeReservationManager({
    repository,
    placementResolver: { resolve: async () => structuredClone(placements) },
    clock: () => new Date(now),
    connectionGraceMilliseconds: 30_000,
  });
  return {
    repository,
    manager,
    setNow(value) { now = new Date(value); },
  };
}

async function admit(manager, overrides = {}) {
  return manager.admit({
    ownerIdentityId: "user-a",
    correlationId: "request-realtime-a",
    capability: "translation",
    model: "local/realtime-translation",
    expiresInSeconds: 60,
    admissionKey: "admission-a",
    input: { language: "zh-CN" },
    output: { language: "en" },
    ...structuredClone(overrides),
  });
}

test("realtime admission records exact session configuration and ownership", async () => {
  const { repository, manager } = fixture();
  const session = await admit(manager);
  const snapshot = await repository.snapshot();

  assert.equal(session.state, "admitted");
  assert.equal(session.reservation.priority_class, "latency");
  assert.equal(session.reservation.protected_from_batch, true);
  assert.equal(session.reservation.resources.codec_decode_sessions, 1);
  assert.equal(snapshot.realtimeSessions[0].schedulerPriority, 100);
  assert.equal(snapshot.realtimeSessions[0].state, "admitted");
  assert.equal("leaseToken" in session.reservation, false);
  assert.equal("nodeId" in session.reservation, false);
});

test("declared network capacity is not advance-booked", async () => {
  const { repository, manager } = fixture({
    nodes: [node({ capacity: { ...node().capacity, networkBitsPerSecond: 999 } })],
  });
  assert.equal((await admit(manager)).state,'admitted');
  assert.equal((await repository.snapshot()).realtimeSessions.length, 1);
});

test("realtime sessions do not pre-charge shared memory against batch work", async () => {
  const { repository, manager } = fixture({
    nodes: [node({ capacity: { ...node().capacity, unifiedMemoryBytes: 3_000 } })],
  });
  await admit(manager);
  const leases = new LeaseManager({ repository });
  await assert.rejects(leases.acquire({
    acquisitionKey: "batch-after-realtime",
    jobId: "job-batch",
    nodeId: "node-a",
    nodeGeneration: 3,
    modelProfileId: "profile-batch",
    reservation: { ...RESOURCE, codecSessions: 0, unifiedMemoryBytes: 2_000 },
    now: START,
  }), { code: "job_not_found" });

  const withJob = new MemoryLeaseRepository({
    nodes: [node({ capacity: { ...node().capacity, unifiedMemoryBytes: 3_000 } })],
    jobs: [{ jobId: "job-batch", status: "queued", cancelRequestedAt: null }],
  });
  const realtime = new RealtimeReservationManager({
    repository: withJob,
    placementResolver: { resolve: async () => [placement()] },
    clock: () => START,
  });
  await admit(realtime);
  const lease=await new LeaseManager({ repository: withJob }).acquire({
    acquisitionKey: "batch-after-realtime",
    jobId: "job-batch",
    nodeId: "node-a",
    nodeGeneration: 3,
    modelProfileId: "profile-batch",
    reservation: { ...RESOURCE, codecSessions: 0, unifiedMemoryBytes: 2_000 },
    now: START,
  });
  assert.equal(lease.state,'active');
});

test("codec direction configuration does not consume advance session slots", async () => {
  const nodes = [
    node({ nodeId: "node-a", codec: { encodeSessions: 0, decodeSessions: 0 } }),
    node({ nodeId: "node-b", generation: 5, codec: { encodeSessions: 1, decodeSessions: 1 } }),
  ];
  const placements = [
    placement({ codecDirections: { encodeSessions: 1, decodeSessions: 0 } }),
    placement({ nodeId: "node-b", nodeGeneration: 5, codecDirections: { encodeSessions: 1, decodeSessions: 0 }, warm: false }),
  ];
  const { repository, manager } = fixture({ nodes, placements });
  const session = await admit(manager);
  assert.equal(session.state, "admitted");
  assert.equal((await repository.snapshot()).realtimeSessions[0].nodeId, "node-a");
});

test("connection deadline, absolute expiry, ownership, and reconciliation fail closed", async () => {
  const { repository, manager, setNow } = fixture();
  const session = await admit(manager);
  await assert.rejects(manager.connect({
    ownerIdentityId: "user-b", sessionId: session.sessionId, connectionId: "connection-b", now: START,
  }), { code: "realtime_session_not_found" });
  setNow(new Date(START.getTime() + 31_000));
  await assert.rejects(manager.connect({
    ownerIdentityId: "user-a", sessionId: session.sessionId, connectionId: "connection-a",
  }), { code: "realtime_session_expired" });
  assert.equal((await repository.snapshot()).realtimeSessions[0].releaseReason, "connection_timeout");

  const admitted = await admit(manager, { admissionKey: "admission-b" });
  setNow(new Date(START.getTime() + 92_000));
  const outcomes = await manager.reconcile();
  assert.equal(outcomes.some((outcome) => outcome.sessionId === admitted.sessionId), true);
  assert.equal((await manager.active()).length, 0);
});

class FakeSocket extends EventEmitter {
  destroyed = false;

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

test("WebSocket disconnect releases capacity immediately and cleanup is idempotent", async () => {
  const { repository, manager } = fixture();
  const admitted = await admit(manager);
  const socket = new FakeSocket();
  const lifecycle = new RealtimeConnectionLifecycle({ reservations: manager, clock: () => START });
  const attached = await lifecycle.attach({
    socket, ownerIdentityId: "user-a", sessionId: admitted.sessionId, connectionId: "connection-a",
  });
  assert.equal(attached.session.state, "connected");
  socket.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  await attached.finish();
  const stored = (await repository.snapshot()).realtimeSessions[0];
  assert.equal(stored.state, "released");
  assert.equal(stored.releaseReason, "websocket_disconnect");
});

test("realtime memory observation does not reject an otherwise valid session", async () => {
  const nodes = [node(), node({ nodeId: "node-b", generation: 5 })];
  const repository = new MemoryLeaseRepository({ nodes });
  const checked = [];
  const manager = new RealtimeReservationManager({
    repository,
    placementResolver: { resolve: async () => [
      placement(),
      placement({ nodeId: "node-b", nodeGeneration: 5, warm: false }),
    ] },
    clock: () => START,
    memoryGuard: {
      evaluate(snapshot) {
        checked.push(structuredClone(snapshot.workload));
        return {severity:'critical'};
      },
    },
    memorySnapshotProvider: { async snapshot({ nodeId }) { return { nodeId }; } },
  });
  const admitted = await admit(manager);
  assert.equal((await repository.snapshot()).realtimeSessions[0].nodeId, "node-a");
  assert.equal(admitted.state, "admitted");
  assert.deepEqual(checked.map((item) => item.class), ["realtime"]);
  assert.deepEqual(checked.map((item) => item.coldLoad), [false]);
});
