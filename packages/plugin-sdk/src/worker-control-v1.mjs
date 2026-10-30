import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_RESPONSES = Object.freeze({
  "worker.prepare.request": new Set(["worker.prepare.ready", "worker.prepare.failed"]),
  "worker.object.begin.request": new Set(["worker.object.begin.accepted", "worker.object.begin.failed"]),
  "worker.object.chunk.request": new Set(["worker.object.chunk.accepted", "worker.object.chunk.failed"]),
  "worker.object.commit.request": new Set(["worker.object.commit.succeeded", "worker.object.commit.failed"]),
  "worker.object.discard.request": new Set(["worker.object.discard.succeeded", "worker.object.discard.failed"]),
  "worker.execute.request": new Set(["worker.execute.accepted", "worker.execute.succeeded", "worker.execute.failed", "worker.execute.cancelled"]),
  "worker.cancel.request": new Set(["worker.cancel.accepted", "worker.execute.cancelled", "worker.cancel.failed"]),
  "worker.unload.request": new Set(["worker.unload.succeeded", "worker.unload.failed"]),
});

export function assertWorkerControlRequestV1(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || request.protocolVersion !== 1 || !UUID.test(request.messageId ?? "")
    || !UUID.test(request.workerId ?? "") || !UUID.test(request.leaseId ?? "")
    || !REQUEST_RESPONSES[request.type] || !Number.isSafeInteger(request.fencingToken)
    || request.fencingToken < 1 || typeof request.correlationId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(request.correlationId)
    || !request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)
    || !Number.isSafeInteger(request.payload.generation) || request.payload.generation < 1) {
    throw new TypeError("worker control request is invalid");
  }
  return request;
}

export function createWorkerControlResponseV1(request, { type, payload, sentAt = new Date(), messageId = randomUUID() }) {
  assertWorkerControlRequestV1(request);
  if (!REQUEST_RESPONSES[request.type].has(type) || !UUID.test(messageId)
    || !payload || typeof payload !== "object" || Array.isArray(payload)
    || (payload.generation !== undefined && payload.generation !== request.payload.generation)) {
    throw new TypeError("worker control response does not match the request");
  }
  const timestamp = sentAt instanceof Date ? sentAt : new Date(sentAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("worker response timestamp is invalid");
  return Object.freeze({
    protocolVersion: 1,
    messageId,
    workerId: request.workerId,
    type,
    sentAt: timestamp.toISOString(),
    correlationId: request.correlationId,
    jobId: request.jobId ?? null,
    attemptId: request.attemptId ?? null,
    leaseId: request.leaseId,
    fencingToken: request.fencingToken,
    payload: structuredClone({ ...payload, generation: request.payload.generation }),
    extensions: Object.freeze({ replyTo: request.messageId }),
  });
}

export const workerControlRequestTypesV1 = Object.freeze(Object.keys(REQUEST_RESPONSES));
