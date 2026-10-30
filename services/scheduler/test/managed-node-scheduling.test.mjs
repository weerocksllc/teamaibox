import assert from "node:assert/strict";
import test from "node:test";

import {
  ManagedNodeSchedulingCatalog,
  projectManagedNodeAvailableResources,
  projectManagedNodeLeaseCapacity,
} from "../src/managed-node-scheduling.mjs";
import { rankSchedulingCandidates } from "../src/routing-engine.mjs";

const GIB = 1024 ** 3;
const NODE = "00000000-0000-4000-8000-000000000101";
const PROFILE = "00000000-0000-4000-8000-000000000201";
const CAPABILITY = "00000000-0000-4000-8000-000000000301";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;

function inventory(overrides = {}) {
  return {
    resources: {
      cpu: { totalMillis: 20_000, availableMillis: 12_000 },
      unifiedMemory: { totalBytes: 128 * GIB, availableBytes: 80 * GIB },
      accelerator: { units: 1 }, codecs: { sessions: 4 },
      storage: { availableBytes: 500 * GIB },
      network: { availableBitsPerSecond: 10_000_000_000 },
    },
    reservations: {
      cpuMillis: 2_000, unifiedMemoryBytes: 16 * GIB, acceleratorUnits: 0,
      codecSessions: 0, storageBytes: 0, networkBitsPerSecond: 500_000_000,
    },
    modelProfiles: [{ profileId: PROFILE, profileKey: "llm.spark.nvfp4", profileFingerprint: FINGERPRINT, lifecycleState: "certified", operations: ["responses"] }],
    capabilities: [{ capabilityKey: "llm.chat", state: "available" }],
    schedulerFacts: {
      accelerator: { kind: "nvidia-blackwell", computeCapability: "12.1", supportedPrecisions: ["nvfp4"], evidenceDigest: `sha256:${"b".repeat(64)}` },
      codec: { encodeSessions: 2, decodeSessions: 2, evidenceDigest: `sha256:${"c".repeat(64)}` },
      storage: { classes: ["encrypted_nvme"], evidenceDigest: `sha256:${"d".repeat(64)}` },
      workerState: "warm", modelArtifactCached: true, inputArtifactIds: ["artifact-a"],
    },
    networkLinks: [{ networkClass: "10gbe", health: "healthy", latencyMicroseconds: 80 }],
    ...structuredClone(overrides),
  };
}

function profile() {
  return {
    profileId: PROFILE, profileKey: "llm.spark.nvfp4", capabilityId: CAPABILITY,
    precision: "nvfp4", compatibility: { architectures: ["linux/arm64/v8"] },
    resourceEnvelope: { cpuMillis: 2_000, unifiedMemoryBytes: 16 * GIB, acceleratorUnits: 1, codecSessions: 0, storageBytes: GIB, networkBitsPerSecond: 1_000_000_000 },
    dataPolicy: { allowedDataClasses: ["internal"], externalProcessing: "forbidden" },
    certification: { state: "certified", evidenceRefs: ["evidence://profile"] },
    coldStart: { estimatedMilliseconds: 90_000 },
    extensions: { schedulerRequirements: { acceleratorKinds: ["nvidia-blackwell"], minimumComputeCapability: "12.0", storageClass: "encrypted_nvme", network: { class: "lan_10gbe", maximumLatencyMilliseconds: 5 } } },
  };
}

test("heartbeat exposes observed resources without adding reservations or subtracting a platform floor", () => {
  const value = inventory();
  const capacity = projectManagedNodeLeaseCapacity(value);
  const available = projectManagedNodeAvailableResources(value);
  assert.equal(capacity.cpuMillis, 12_000);
  assert.equal(capacity.unifiedMemoryBytes, 80 * GIB);
  assert.equal(capacity.networkBitsPerSecond, 10_000_000_000);
  assert.deepEqual(capacity.codec, { encodeSessions: 2, decodeSessions: 2 });
  assert.equal(available.cpuMillis, 12_000);
  assert.equal(available.unifiedMemoryBytes, 80 * GIB);
  assert.equal(available.networkBitsPerSecond, 10_000_000_000);
});

test("directional codec capacity is bounded and missing facts never grant codecs", () => {
  const value = inventory();
  value.resources.codecs.sessions = 1;
  assert.deepEqual(projectManagedNodeLeaseCapacity(value).codec, { encodeSessions: 2, decodeSessions: 2 });
  delete value.schedulerFacts.codec;
  assert.deepEqual(projectManagedNodeLeaseCapacity(value).codec, { encodeSessions: 0, decodeSessions: 0 });
  value.schedulerFacts.codec = { encodeSessions: -1, decodeSessions: 1 };
  assert.throws(() => projectManagedNodeLeaseCapacity(value), /non-negative/);
});

test("a 1 GbE managed worker retains schedulable bandwidth without an invented bandwidth reservation", () => {
  const value = inventory();
  value.resources.network.availableBitsPerSecond = 1_000_000_000;
  value.reservations.networkBitsPerSecond = 0;
  assert.equal(projectManagedNodeLeaseCapacity(value).networkBitsPerSecond, 1_000_000_000);
  assert.equal(projectManagedNodeAvailableResources(value).networkBitsPerSecond, 1_000_000_000);
});

test("only exact registered certified profile evidence becomes a managed-node target", async () => {
  const node = { nodeId: NODE, nodeKey: "spark-b", architecture: "arm64", lifecycleState: "ready", generation: 7, health: { state: "healthy" }, labels: {}, inventory: inventory() };
  const catalog = new ManagedNodeSchedulingCatalog({ localNodeId: NODE,
    nodeRepository: { async findNode(id) { assert.equal(id,NODE); return node; } },
    profileCatalog: { async findByIds() { return [{ profile: profile(), fingerprint: FINGERPRINT }]; } },
  });
  const job = { jobId: "00000000-0000-4000-8000-000000000401", ownerIdentityId: "user-a", capabilityId: CAPABILITY, capabilityKey: "llm.chat", operation: "responses", dataClass: "internal", inputArtifacts: ["artifact-a"] };
  const candidates = await catalog.candidatesFor(job);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].targetKind, "managed_node");
  assert.equal(candidates[0].nodeGeneration, 7);
  assert.deepEqual(candidates[0].network.classes, ["lan_10gbe"]);
  assert.equal(rankSchedulingCandidates({ job, candidates }).selected.targetId, NODE);

  node.inventory.modelProfiles[0].profileFingerprint = `sha256:${"f".repeat(64)}`;
  assert.deepEqual(await catalog.candidatesFor(job), []);
});

test("draining, degraded, and unavailable capability nodes never enter routing", async () => {
  const base = { nodeId: NODE, nodeKey: "spark-b", architecture: "arm64", lifecycleState: "draining", generation: 7, health: { state: "healthy" }, labels: {}, inventory: inventory() };
  const catalog = new ManagedNodeSchedulingCatalog({ localNodeId: NODE,
    nodeRepository: { async findNode(id) { assert.equal(id,NODE); return base; } },
    profileCatalog: { async findByIds() { return [{ profile: profile(), fingerprint: FINGERPRINT }]; } },
  });
  assert.deepEqual(await catalog.candidatesFor({ jobId: "job-a", capabilityId: CAPABILITY, capabilityKey: "llm.chat" }), []);
});
