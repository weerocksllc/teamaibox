import { randomUUID } from "node:crypto";
import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_TYPES = new Set([
  "worker.prepare.request",
  "worker.object.begin.request",
  "worker.object.chunk.request",
  "worker.object.commit.request",
  "worker.object.discard.request",
  "worker.execute.request",
  "worker.cancel.request",
  "worker.unload.request",
]);

function requiredUuid(value, name) {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a UUID`);
  return value;
}

function timestamp(value, name = "sentAt") {
  const result = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return result.toISOString();
}

export function createWorkerControlEnvelope({
  workerId,
  type,
  correlationId,
  jobId = null,
  attemptId = null,
  leaseId,
  fencingToken,
  payload = {},
  sentAt,
  messageId = randomUUID(),
}) {
  requiredUuid(messageId, "messageId");
  requiredUuid(workerId, "workerId");
  requiredUuid(leaseId, "leaseId");
  if (jobId !== null) requiredUuid(jobId, "jobId");
  if (attemptId !== null) requiredUuid(attemptId, "attemptId");
  if (!REQUEST_TYPES.has(type)) throw new TypeError(`unsupported worker control request type: ${type}`);
  if (typeof correlationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(correlationId)) {
    throw new TypeError("correlationId is invalid");
  }
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new TypeError("fencingToken must be a positive safe integer");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("payload must be an object");
  }
  return Object.freeze({
    protocolVersion: 1,
    messageId,
    workerId,
    type,
    sentAt: timestamp(sentAt),
    correlationId,
    jobId,
    attemptId,
    leaseId,
    fencingToken,
    payload: structuredClone(payload),
  });
}

export function assertWorkerControlResponse(request, response, allowedTypes) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new PlatformError("worker_protocol_invalid", "Worker returned an invalid control response", { status: 502, retryable: true });
  }
  if (response.protocolVersion !== 1
      || !UUID.test(response.messageId)
      || response.workerId !== request.workerId
      || response.correlationId !== request.correlationId
      || response.leaseId !== request.leaseId
      || response.fencingToken !== request.fencingToken
      || response.extensions?.replyTo !== request.messageId
      || !allowedTypes.includes(response.type)
      || !response.payload
      || typeof response.payload !== "object"
      || Array.isArray(response.payload)) {
    throw new PlatformError("worker_protocol_mismatch", "Worker response did not match the fenced request", { status: 502, retryable: true });
  }
  return response;
}

export const workerControlRequestTypes = Object.freeze([...REQUEST_TYPES]);
