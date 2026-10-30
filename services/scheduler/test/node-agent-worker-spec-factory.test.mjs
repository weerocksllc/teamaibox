import assert from "node:assert/strict";
import test from "node:test";

import { NodeAgentWorkerSpecFactory } from "../src/node-agent-worker-spec-factory.mjs";

test("worker spec projection strips scheduler routing facts", async () => {
  const factory = new NodeAgentWorkerSpecFactory();
  const payload = await factory.buildStartPayload({ worker: {
    nodeId: "00000000-0000-4000-8000-000000000001", nodeGeneration: 7,
    workerId: "00000000-0000-4000-8000-000000000002", attemptId: "00000000-0000-4000-8000-000000000003",
    modelProfileId: "00000000-0000-4000-8000-000000000004", workloadKind: "compute-worker",
    image: `registry.local/worker@sha256:${"a".repeat(64)}`, limits: {}, security: {}, mounts: [], publishedPorts: [],
  } });
  assert.equal(payload.nodeId, undefined);
  assert.equal(payload.nodeGeneration, undefined);
  assert.equal(payload.workerId, "00000000-0000-4000-8000-000000000002");
});

test("worker spec projection preserves the deliberately empty non-model identity for plugins", async () => {
  const factory = new NodeAgentWorkerSpecFactory();
  const payload = await factory.buildStartPayload({ worker: {
    workerId: "00000000-0000-4000-8000-000000000012", attemptId: "", modelProfileId: "",
    workloadKind: "application-plugin", pluginId: "example.team-notes",
    image: `registry.local/plugin@sha256:${"b".repeat(64)}`, network: "none",
    limits: {}, security: {}, mounts: [], publishedPorts: [], applicationPort: 8080,
  } });
  assert.equal(payload.attemptId, "");
  assert.equal(payload.modelProfileId, "");
  assert.equal(payload.pluginId, "example.team-notes");
  assert.equal(payload.applicationPort, 8080);
});

test("worker spec projection rejects a plugin masquerading as a model attempt", async () => {
  const factory = new NodeAgentWorkerSpecFactory();
  await assert.rejects(factory.buildStartPayload({ worker: {
    workerId: "00000000-0000-4000-8000-000000000012",
    attemptId: "00000000-0000-4000-8000-000000000013",
    modelProfileId: "00000000-0000-4000-8000-000000000014",
    workloadKind: "application-plugin",
  } }), /identity is invalid/);
});

test("protected worker projection preserves exact placement generation and configuration identity", async () => {
  const factory = new NodeAgentWorkerSpecFactory();
  const configDigest = `sha256:${"c".repeat(64)}`;
  const payload = await factory.buildStartPayload({ worker: {
    nodeId: "00000000-0000-4000-8000-000000000001", nodeGeneration: 7,
    workerId: "00000000-0000-4000-8000-000000000002",
    attemptId: "00000000-0000-4000-8000-000000000003",
    modelProfileId: "00000000-0000-4000-8000-000000000004",
    image: `registry.local/office@sha256:${"a".repeat(64)}`,
    resources: { unifiedMemoryBytes: 8 * 1024 ** 3 },
    placementClass: "protected-resident", maintenanceGeneration: 7, configDigest,
  } });
  assert.equal(payload.placementClass, "protected-resident");
  assert.equal(payload.maintenanceGeneration, 7);
  assert.equal(payload.configDigest, configDigest);
  assert.equal(payload.limits.memoryBytes, 8 * 1024 ** 3);
});

test("full protected WorkerStart projection preserves structured health, tmpfs, and frozen entrypoint", async () => {
  const factory = new NodeAgentWorkerSpecFactory();
  const healthCheck = {
    test: ["CMD-SHELL", "test -r /proc/1/status"],
    intervalNanoseconds: 10_000_000_000,
    timeoutNanoseconds: 2_000_000_000,
    startPeriodNanoseconds: 30_000_000_000,
    retries: 3,
  };
  const payload = await factory.buildStartPayload({ worker: {
    workerId: "00000000-0000-4000-8000-000000000022",
    attemptId: "00000000-0000-4000-8000-000000000023",
    modelProfileId: "00000000-0000-4000-8000-000000000024",
    workloadKind: "compute-worker",
    image: `registry.local/lmt4@sha256:${"d".repeat(64)}`,
    network: "compute-internal", limits: {}, security: {}, mounts: [], publishedPorts: [],
    healthCheck, tmpfsExecutable: true,
    entrypoint: ["/opt/teamaibox/worker-entrypoint", "--fixed-mode"],
    placementClass: "protected-resident", maintenanceGeneration: 7,
    configDigest: `sha256:${"e".repeat(64)}`,
  } });
  assert.deepEqual(payload.healthCheck, healthCheck);
  assert.equal(payload.tmpfsExecutable, true);
  assert.deepEqual(payload.entrypoint, ["/opt/teamaibox/worker-entrypoint", "--fixed-mode"]);
  assert.equal(Object.isFrozen(payload.entrypoint), true);
});

test("ordinary scheduler projection does not forward an entrypoint override", async () => {
  const factory = new NodeAgentWorkerSpecFactory();
  const payload = await factory.buildStartPayload({ worker: {
    workerId: "00000000-0000-4000-8000-000000000032",
    attemptId: "00000000-0000-4000-8000-000000000033",
    modelProfileId: "00000000-0000-4000-8000-000000000034",
    image: `registry.local/ordinary@sha256:${"f".repeat(64)}`,
    resources: {}, entrypoint: ["/bin/sh"],
  } });
  assert.equal(payload.entrypoint, undefined);
});
