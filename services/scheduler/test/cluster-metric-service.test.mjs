import assert from "node:assert/strict";
import test from "node:test";

import { ClusterMetricService, normalizeNodeMetricSnapshot } from "../src/cluster-metric-service.mjs";
import { MemoryClusterMetricRepository } from "../src/memory-cluster-metric-repository.mjs";
import { MemoryManagedNodeRepository } from "../src/memory-managed-node-repository.mjs";

const NODE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const NODE_TWO = "018f6f18-24d7-7c21-9b62-8c0174199503";
const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const CERT = `sha256:${"c".repeat(64)}`;
const WORKER = "018f6f18-24d7-7c21-9b62-8c0174199510";
const PROFILE = "018f6f18-24d7-7c21-9b62-8c0174199511";
const JOB = "018f6f18-24d7-7c21-9b62-8c0174199512";
const BOOT = "018f6f18-24d7-7c21-9b62-8c0174199513";
const viewer = { identityId: ADMIN, permissions: ["operations:view"] };

function measured(value) { return { status: "measured", value, reasonCode: null }; }
function unsupported(reasonCode = "driver_metric_unsupported") { return { status: "unsupported", value: null, reasonCode }; }
function unavailable(reasonCode = "collector_temporarily_unavailable") { return { status: "unavailable", value: null, reasonCode }; }

function snapshot({ observedAt = "2026-08-11T08:00:00.000Z", sequence = 1, cpu = 40, memory = 32_000_000_000 } = {}) {
  return { schemaVersion: 1, observedAt, sequence, collector: { agentVersion: "1.2.3", bootId: BOOT },
    domains: {
      cpu: { logicalCores: measured(20), utilizationPercent: measured(cpu), load1: measured(4.5) },
      unifiedMemory: { totalBytes: measured(128_000_000_000), usedBytes: measured(memory), availableBytes: measured(96_000_000_000), dedicatedAcceleratorMemoryBytes: unsupported("unified_memory_architecture") },
      accelerator: { utilizationPercent: measured(65), temperatureCelsius: measured(61), powerWatts: unavailable(), powerLimitWatts: unsupported() },
      storage: { totalBytes: measured(4_000_000_000_000), usedBytes: measured(1_000_000_000_000), availableBytes: measured(3_000_000_000_000), readBytesPerSecond: measured(12_000), writeBytesPerSecond: measured(4_000) },
      network: { receiveBytesPerSecond: measured(8_000), transmitBytesPerSecond: measured(3_000), availableBitsPerSecond: measured(10_000_000_000), receiveErrors: measured(0), transmitErrors: measured(0) },
      codecs: { encodeActive: measured(1), encodeCapacity: measured(4), decodeActive: measured(2), decodeCapacity: measured(4) },
    },
    memoryPressure: { someAverage10: measured(0.0125), fullAverage10: measured(0.0005) },
    processes: [{ targetKind: "worker", targetId: WORKER, cpuPercent: measured(23), unifiedMemoryBytes: measured(20_000_000_000), cgroupMemoryBytes: measured(20_100_000_000), acceleratorMemoryBytes: unsupported("unified_memory_architecture") }],
    workers: [{ workerId: WORKER, state: "busy", profileId: PROFILE, jobId: JOB, cpuPercent: measured(23), unifiedMemoryBytes: measured(20_000_000_000), acceleratorUtilizationPercent: measured(65),
      cgroup: { currentBytes: 20_100_000_000, peakBytes: 21_000_000_000, maximumBytes: 24_000_000_000, events: { high: 0, max: 0, oom: 0, oomKill: 0, oomGroupKill: 0 } },
      process: { residentBytes: 1_000_000_000 },
      engine: { status: "unavailable", reasonCode: "worker_engine_memory_not_reported", allocatedBytes: null, modelBytes: null, cacheBytes: null, certifiedEnvelopeBytes: null },
      runtime: { status: "measured", reasonCode: null, oomKilled: false } }],
    models: [{ profileId: PROFILE, state: "loaded", workerId: WORKER, unifiedMemoryBytes: measured(19_000_000_000), loadMilliseconds: measured(8500) }],
    jobs: { queued: measured(2), preparing: measured(1), running: measured(1), succeeded: measured(50), failed: measured(1), cancelled: measured(2) },
    queues: [{ queueKey: "llm.interactive", depth: measured(2), oldestWaitMilliseconds: measured(350), reasons: [{ reasonCode: "worker_busy", count: 2 }] }],
    reservations: { cpuMillis: measured(4_000), unifiedMemoryBytes: measured(24_000_000_000), acceleratorUnits: measured(1), codecSessions: measured(1), storageBytes: measured(0), networkBitsPerSecond: measured(50_000_000) },
    coreServices: [{ serviceKey: "platform.api", state: "healthy", availabilityPercent: measured(100), latencyMilliseconds: measured(12), errorRatePercent: measured(0) }],
  };
}

async function fixture({ healthSink = null, onHealthSinkError = async () => {} } = {}) {
  let now = new Date("2026-08-11T08:00:01.000Z");
  const nodes = new MemoryManagedNodeRepository();
  for (const [nodeId, nodeKey] of [[NODE, "spark-node-01"], [NODE_TWO, "spark-node-02"]]) await nodes.createNode({ nodeId, nodeKey, architecture: "arm64", trustKind: "managed_appliance", lifecycleState: "ready", generation: 1, agentVersion: "1.2.3", labels: {}, capacity: {}, health: { state: "healthy" }, inventory: null, inventoryDigest: null, lastSeenAt: now, certificateFingerprint: CERT, certificateNotAfter: new Date("2027-08-11T00:00:00Z"), certificateRevokedAt: null, enrollmentId: ADMIN, revision: 1, createdAt: now, updatedAt: now });
  const repository = new MemoryClusterMetricRepository();
  const service = new ClusterMetricService({ localNodeId: NODE, repository, managedNodeRepository: nodes, clock: () => new Date(now), staleAfterMilliseconds: 30_000, healthSink, onHealthSinkError });
  return { service, repository, nodes, setNow(value) { now = new Date(value); } };
}

function transport(nodeId = NODE) { return { mutualTls: true, certificateVerified: true, subjectNodeId: nodeId, certificateFingerprint: CERT }; }

test("metric lists retain every entry above legacy count limits", () => {
  const value = snapshot();
  const uuid = (i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
  for (const [section, identity] of [["processes", "targetId"], ["workers", "workerId"], ["models", "profileId"]]) {
    const item = value[section][0];
    value[section] = Array.from({ length: 601 }, (_, i) => ({ ...structuredClone(item), [identity]: uuid(i) }));
  }
  value.queues = Array.from({ length: 301 }, (_, i) => ({ ...value.queues[0], queueKey: `queue.${i}`,
    reasons: Array.from({ length: 81 }, (_, n) => ({ reasonCode: `waiting.${n}`, count: n })) }));
  value.coreServices = Array.from({ length: 301 }, (_, i) => ({ ...value.coreServices[0], serviceKey: `service.${i}` }));
  const actual = normalizeNodeMetricSnapshot(value, { memoryBudget: () => 256 * 2 ** 20 });
  for (const section of ["processes", "workers", "models", "queues", "coreServices"]) {
    assert.equal(actual[section].length, value[section].length);
  }
  assert.equal(actual.workers.at(-1).workerId, uuid(600));
  assert.equal(actual.queues.at(-1).reasons.length, 81);
  assert.throws(() => normalizeNodeMetricSnapshot(value, { memoryBudget: () => 1024 }), { code: "node_metric_memory_unavailable" });
  value.workers[600].workerId = value.workers[0].workerId;
  assert.throws(() => normalizeNodeMetricSnapshot(value, { memoryBudget: () => 256 * 2 ** 20 }), { code: "node_metric_invalid" });
});

test("node metrics preserve support status and aggregate only measured fresh evidence", async () => {
  const f = await fixture();
  const accepted = await f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot() });
  assert.equal(accepted.freshness.status, "fresh");
  assert.equal(accepted.domains.unifiedMemory.dedicatedAcceleratorMemoryBytes.status, "unsupported");
  assert.equal(accepted.domains.unifiedMemory.dedicatedAcceleratorMemoryBytes.value, null);
  const cluster = await f.service.getCluster({ context: viewer });
  assert.equal(cluster.collectionStatus, "fresh");
  assert.equal(cluster.aggregate.domains.cpu.logicalCores.status, "measured");
  assert.equal(cluster.aggregate.domains.cpu.logicalCores.value, 20);
  assert.equal(cluster.aggregate.domains.unifiedMemory.dedicatedAcceleratorMemoryBytes.status, "unsupported");
  assert.equal(cluster.aggregate.processes[0].targetKind, "worker");
  assert.equal(cluster.aggregate.workers[0].workerId, WORKER);
  assert.equal(accepted.memoryPressure.someAverage10.value, 0.0125);
  assert.equal(accepted.workers[0].cgroup.maximumBytes, 24_000_000_000);
  assert.equal(accepted.workers[0].runtime.oomKilled, false);
  assert.equal(cluster.aggregate.models[0].profileId, PROFILE);
  assert.equal(cluster.aggregate.jobs.running.value, 1);
  assert.equal(cluster.aggregate.reservations.unifiedMemoryBytes.value, 24_000_000_000);
  assert.equal(cluster.aggregate.queues[0].reasons[0].reasonCode, "worker_busy");
  assert.equal(cluster.aggregate.coreServices[0].serviceKey, "platform.api");
});

test("authenticated inactive file cache is bounded and retained separately", async () => {
  const f = await fixture(), value = snapshot();
  value.workers[0].cgroup.inactiveFileBytes = 1_000_000;
  const accepted = await f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: value });
  assert.equal(accepted.workers[0].cgroup.inactiveFileBytes, 1_000_000);
  value.sequence += 1; value.workers[0].cgroup.inactiveFileBytes = value.workers[0].cgroup.currentBytes + 1;
  await assert.rejects(f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: value }));
});

test("stale snapshots are visibly stale and contribute no aggregate value", async () => {
  const f = await fixture();
  await f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot() });
  f.setNow("2026-08-11T08:00:31.001Z");
  const node = await f.service.getNode({ context: viewer, nodeId: NODE });
  assert.equal(node.node.freshness.status, "stale");
  assert.equal(node.node.metrics.domains.cpu.utilizationPercent.effectiveStatus, "stale");
  assert.equal(node.node.metrics.processes[0].unifiedMemoryBytes.effectiveStatus, "stale");
  assert.equal(node.node.metrics.workers[0].cpuPercent.effectiveStatus, "stale");
  assert.equal(node.node.metrics.models[0].loadMilliseconds.effectiveStatus, "stale");
  assert.equal(node.node.metrics.jobs.running.effectiveStatus, "stale");
  assert.equal(node.node.metrics.queues[0].depth.effectiveStatus, "stale");
  assert.equal(node.node.metrics.reservations.cpuMillis.effectiveStatus, "stale");
  assert.equal(node.node.metrics.coreServices[0].availabilityPercent.effectiveStatus, "stale");
  const cluster = await f.service.getCluster({ context: viewer });
  assert.equal(cluster.collectionStatus, "stale");
  assert.equal(cluster.aggregate.domains.cpu.utilizationPercent.status, "stale");
  assert.equal(cluster.aggregate.domains.cpu.utilizationPercent.value, null);
  assert.equal(cluster.aggregate.workers.length, 0);
});

test("node generation, mTLS, timestamp, sequence, and sensitive-field boundaries fail closed", async () => {
  const f = await fixture();
  await assert.rejects(f.service.ingest({ transportIdentity: { ...transport(), mutualTls: false }, nodeId: NODE, nodeGeneration: 1, snapshot: snapshot() }), { code: "managed_node_mtls_required" });
  await assert.rejects(f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 2, snapshot: snapshot() }), { code: "stale_node_generation" });
  await assert.rejects(f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot({ observedAt: "2026-08-11T08:00:07.000Z" }) }), { code: "node_metric_clock_skew" });
  const secret = snapshot(); secret.apiToken = "not-allowed";
  await assert.rejects(f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: secret }), { code: "node_metric_sensitive" });
  const invalid = snapshot(); invalid.domains.unifiedMemory.availableBytes = measured(120_000_000_000);
  await assert.rejects(f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: invalid }), { code: "node_metric_invalid" });
  await f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot() });
  await assert.rejects(f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot({ sequence: 1, cpu: 41 }) }), { code: "node_metric_sequence_conflict" });
  await f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot({ sequence: 3 }) });
  await assert.rejects(f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot({ sequence: 2 }) }), { code: "node_metric_sequence_stale" });
});

test("contract normalization rejects missing status instead of interpreting it as zero", () => {
  const value = snapshot(); delete value.domains.accelerator.powerWatts.status;
  assert.throws(() => normalizeNodeMetricSnapshot(value), { code: "node_metric_invalid" });
  const unknown = snapshot(); unknown.processes[0].command = "python private.py";
  assert.throws(() => normalizeNodeMetricSnapshot(unknown), { code: "node_metric_sensitive" });
});

test("metric dashboard access is permission gated", async () => {
  const f = await fixture();
  await assert.rejects(f.service.getCluster({ context: { identityId: ADMIN, permissions: [] } }), { code: "operations_permission_required" });
  await assert.rejects(f.service.getCluster({ context: null }), { code: "invalid_session" });
});

test("accepted node snapshots publish node and core-service health without coupling telemetry availability", async () => {
  const published = [];
  const f = await fixture({ healthSink: { async recordNodeMetricHealth(value) { published.push(value); } } });
  await f.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot() });
  assert.equal(published.length, 1);
  assert.equal(published[0].nodeId, NODE);
  assert.equal(published[0].snapshot.coreServices[0].serviceKey, "platform.api");

  const failures = [];
  const isolated = await fixture({ healthSink: { async recordNodeMetricHealth() { throw new Error("diagnostics unavailable"); } },
    onHealthSinkError: async (error, facts) => failures.push([error.message, facts.sequence]) });
  const accepted = await isolated.service.ingest({ transportIdentity: transport(), nodeId: NODE, nodeGeneration: 1, snapshot: snapshot() });
  assert.equal(accepted.sequence, 1);
  assert.deepEqual(failures, [["diagnostics unavailable", 1]]);
});
