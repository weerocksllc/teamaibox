import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { NodeAgentExclusiveWorkerDrainer } from "../src/node-agent-exclusive-worker-drainer.mjs";

test("exclusive drainer uses intent fencing before acquisition and lease fencing for restore", async () => {
  const ids = { nodeId: randomUUID(), jobId: randomUUID(), intentId: randomUUID(), leaseSetId: randomUUID() };
  const calls = [];
  const drainer = new NodeAgentExclusiveWorkerDrainer({ nodeAgent: {
    async listConflictingWorkers(input) { calls.push(["list", input.authority]); return [{ workerId: "ocr.vlm" }]; },
    async drainConflictingWorker(input) { calls.push(["drain", input.authority]); return { leasesReleased: true, wasRunning: true }; },
    async restoreConflictingWorker(input) { calls.push(["restore", input.authority]); return { state: "running", health: "healthy" }; },
  } });
  const base = { nodeId: ids.nodeId, nodeGeneration: 3, exclusiveJobId: ids.jobId, intentId: ids.intentId, correlationId: "correlation-exclusive-drain" };
  await drainer.listConflictingWorkers(base);
  await drainer.drainWorker({ ...base, workerId: "ocr.vlm" });
  await drainer.restoreWorker({ ...base, workerId: "ocr.vlm", lease: { leaseSetId: ids.leaseSetId, fencingToken: 9 } });
  assert.deepEqual(calls.map((item) => item[1]), [
    { leaseId: ids.intentId, fencingToken: 1, nodeGeneration: 3 },
    { leaseId: ids.intentId, fencingToken: 1, nodeGeneration: 3 },
    { leaseId: ids.leaseSetId, fencingToken: 9, nodeGeneration: 3 },
  ]);
});
