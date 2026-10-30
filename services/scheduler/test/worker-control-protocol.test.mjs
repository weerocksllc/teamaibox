import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { assertWorkerControlResponse, createWorkerControlEnvelope } from "../src/worker-control-protocol.mjs";

function request() {
  return createWorkerControlEnvelope({
    workerId: randomUUID(),
    type: "worker.prepare.request",
    correlationId: "correlation.protocol-1",
    leaseId: randomUUID(),
    fencingToken: 9,
    payload: { generation: 2 },
    sentAt: new Date("2026-08-11T01:00:00Z"),
  });
}

function responseFor(value, overrides = {}) {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    workerId: value.workerId,
    type: "worker.prepare.ready",
    sentAt: "2026-08-11T01:00:01Z",
    correlationId: value.correlationId,
    jobId: null,
    attemptId: null,
    leaseId: value.leaseId,
    fencingToken: value.fencingToken,
    payload: { generation: 2 },
    extensions: { replyTo: value.messageId },
    ...overrides,
  };
}

test("builds a bounded fenced v1 control request", () => {
  const value = request();
  assert.equal(value.protocolVersion, 1);
  assert.equal(value.type, "worker.prepare.request");
  assert.equal(value.fencingToken, 9);
  assert.equal(Object.isFrozen(value), true);
  assert.throws(() => createWorkerControlEnvelope({ ...value, type: "shell.execute" }), /unsupported/);
});

test("response matching rejects stale fences, workers, and reply identities", () => {
  const value = request();
  assert.equal(assertWorkerControlResponse(value, responseFor(value), ["worker.prepare.ready"]).type, "worker.prepare.ready");
  for (const changed of [
    { workerId: randomUUID() },
    { fencingToken: 8 },
    { extensions: { replyTo: randomUUID() } },
    { type: "worker.execute.succeeded" },
  ]) {
    assert.throws(() => assertWorkerControlResponse(value, responseFor(value, changed), ["worker.prepare.ready"]), /match the fenced request/);
  }
});
