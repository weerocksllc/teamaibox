import assert from "node:assert/strict";
import test from "node:test";

import { PostgresWorkerEventSink } from "../src/postgres-worker-event-sink.mjs";

const workerId = "11111111-1111-4111-8111-111111111111";
const nodeId = "22222222-2222-4222-8222-222222222222";
const profileId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";

test("persists a bounded content-safe worker lifecycle projection", async () => {
  const calls = [];
  const sink = new PostgresWorkerEventSink({
    database: { async query(text, parameters) { calls.push({ text, parameters }); return { rows: [] }; } },
  });
  await sink.publish({
    workerId,
    nodeId,
    modelProfileId: profileId,
    generation: 7,
    type: "worker.execution_succeeded",
    correlationId: "worker-lifecycle.test-a1",
    occurredAt: new Date("2026-08-26T00:00:00.000Z"),
    payload: { jobId, attemptId, resultArtifactRefs: ["object-reference-only"] },
  });
  assert.equal(calls.length, 1);
  const parameters = calls[0].parameters;
  assert.equal(parameters[1], "worker-lifecycle.test-a1");
  assert.equal(parameters[2], workerId);
  assert.equal(parameters[3], "worker.execution_succeeded");
  assert.equal(parameters[4], "info");
  assert.deepEqual(JSON.parse(parameters[6]), { nodeId, modelProfileId: profileId, generation: 7 });
  assert.deepEqual(parameters[8], [jobId]);
  assert.deepEqual(parameters[9], [attemptId]);
  assert.equal(calls[0].text.includes("platform.diagnostic_signals"), true);
});

test("fails closed for malformed worker lifecycle events", async () => {
  const sink = new PostgresWorkerEventSink({ database: { async query() { throw new Error("must not persist"); } } });
  await assert.rejects(() => sink.publish({
    workerId: "not-a-worker",
    nodeId,
    type: "worker.ready",
    correlationId: "worker-lifecycle.test-a2",
  }), TypeError);
});
