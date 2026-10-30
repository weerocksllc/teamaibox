import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DurableComputeBackend,
  DurableJobService,
} from "../src/compute/durable-job-service.mjs";
import { ObjectJobPayloadStore } from "../src/compute/job-payload-store.mjs";
import { MemoryDurableJobRepository } from "../src/compute/memory-durable-job-repository.mjs";
import { EnvelopeEncryptedBlobStore } from "../../../services/object-service/src/envelope-encrypted-blob-store.mjs";
import { MemoryVersionedEnvelopeKeyring } from "../../../services/object-service/src/envelope-keyring.mjs";
import { MemoryEnvelopeMetadataRepository } from "../../../services/object-service/src/envelope-metadata-repository.mjs";
import { MemoryBlobStore } from "../../../services/object-service/src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../../../services/object-service/src/memory-repository.mjs";
import { ProtectedObjectService } from "../../../services/object-service/src/object-service.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const capabilityId = "33333333-3333-4333-8333-333333333333";

function fixture({ policy = {}, policySource = null } = {}) {
  let current = new Date("2026-08-10T00:00:00.000Z");
  const rawStore = new MemoryBlobStore({ clock: () => new Date(current) });
  const keyring = new MemoryVersionedEnvelopeKeyring(Buffer.alloc(32, 7));
  const encryptedStore = new EnvelopeEncryptedBlobStore({
    rawStore,
    metadataRepository: new MemoryEnvelopeMetadataRepository(),
    keyring,
    clock: () => new Date(current),
  });
  const objects = new ProtectedObjectService({
    repository: new MemoryObjectRepository({ defaultQuotaBytes: 16 * 1024 * 1024 }),
    blobStore: encryptedStore,
    referenceSigningKey: Buffer.alloc(32, 8),
    clock: () => new Date(current),
  });
  const payloadStore = new ObjectJobPayloadStore({ objectService: objects, clock: () => new Date(current) });
  const repository = new MemoryDurableJobRepository();
  const audit = [];
  const createService = () => new DurableJobService({
    repository,
    payloadStore,
    resolveCapability: async (key) => ({
      capabilityId,
      enabled: key === "chat",
      operations: ["responses", "chat.completions"],
    }),
    clock: () => new Date(current),
    policy,
    policySource,
    audit: async (event) => audit.push(event),
  });
  return {
    audit,
    keyring,
    objects,
    payloadStore,
    rawStore,
    repository,
    service: createService(),
    createService,
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
  };
}

function work(overrides = {}) {
  return {
    ownerIdentityId: owner,
    capabilityKey: "chat",
    operation: "responses",
    requestedModel: "local/reasoning",
    requestedModelProfileId: null,
    dataClass: "confidential",
    priority: 60,
    deadlineAt: new Date("2026-08-10T01:00:00.000Z"),
    idempotencyKey: "response-contract-1",
    correlationId: "request-contract-1234",
    request: { model: "local/reasoning", input: "confidential launch plan" },
    ...overrides,
  };
}

test("submission is durable metadata plus an envelope-encrypted input artifact", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const submitted = await state.service.submit(work());
  assert.equal(submitted.status, "queued");
  assert.match(submitted.responseId, /^resp_[a-f0-9]{32}$/);
  assert.match(submitted.requestDigest, /^sha256:[a-f0-9]{64}$/);
  const stored = (await state.repository.snapshot())[0];
  assert.equal("request" in stored, false);
  assert.equal(stored.requestArtifact.lifecycleState, "verified");
  assert.equal(stored.requestArtifact.extensions.referenceAudience, "compute.worker-input");
  assert.match(stored.requestArtifact.extensions.referenceExpiresAt, /^2026-08-10T00:15:00\.000Z$/);
  const referenced = await state.objects.headByReferenceId({
    context: { identityId: owner, identityKind: "local_user", namespaceAccess: [{ namespaceKey: `user:${owner}`, operations: ["read"] }] },
    referenceId: stored.requestArtifact.object.referenceId,
  });
  assert.equal(referenced.objectId, stored.requestArtifact.object.objectId);
  const refreshed = await state.payloadStore.refreshReference({ ownerIdentityId: owner, artifact: stored.requestArtifact, expiresInSeconds: 60 });
  assert.notEqual(refreshed.object.referenceId, stored.requestArtifact.object.referenceId);
  assert.equal(refreshed.extensions.referenceAudience, "compute.worker-input");
  assert.equal(JSON.stringify(stored).includes("confidential launch plan"), false);

  const rawKeys = await state.rawStore.list();
  assert.equal(rawKeys.length, 1);
  const ciphertext = await state.rawStore.get(rawKeys[0].blobKey);
  assert.equal(ciphertext.includes(Buffer.from("confidential launch plan")), false);
  const events = await state.service.events({ ownerIdentityId: owner, jobId: submitted.jobId });
  assert.deepEqual(events.map((event) => event.eventKind), ["state"]);

  const restarted = state.createService();
  assert.equal((await restarted.get({ ownerIdentityId: owner, jobId: submitted.jobId })).jobId, submitted.jobId);
});

test("internal dispatch views retain correlation without expanding user job views", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const submitted = await state.service.submit(work({ deadlineAt: null }));
  assert.equal(submitted.correlationId, undefined);
  const dispatchable = await state.service.listDispatchable({ limit: 8 });
  assert.equal(dispatchable.length, 1);
  assert.equal(dispatchable[0].correlationId, "request-contract-1234");
  const owned = await state.service.listOwn({ ownerIdentityId: owner });
  assert.equal(owned[0].correlationId, undefined);
});

test("idempotency ignores JSON key order, rejects changed facts, and survives service restart", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const first = await state.service.submit(work({ request: { input: "same", model: "local/reasoning" } }));
  const replay = await state.createService().submit(work({ request: { model: "local/reasoning", input: "same" } }));
  assert.equal(replay.jobId, first.jobId);
  assert.equal((await state.repository.snapshot()).length, 1);
  assert.equal((await state.repository.snapshot())[0].replayCount, 1);
  await assert.rejects(
    state.service.submit(work({ request: { model: "local/reasoning", input: "different" } })),
    (error) => error.code === "idempotency_conflict" && error.status === 409,
  );
  await assert.rejects(
    state.service.submit(work({ request: { input: "same", model: "local/reasoning" }, priority: 61 })),
    (error) => error.code === "idempotency_conflict",
  );
  assert.ok(state.audit.some((event) => event.action === "compute.job_replayed"));
});

test("concurrent duplicate submissions have one durable identity", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const jobs = await Promise.all(Array.from({ length: 12 }, () => state.service.submit(work())));
  assert.equal(new Set(jobs.map((job) => job.jobId)).size, 1);
  assert.equal((await state.repository.snapshot()).length, 1);
  assert.equal((await state.repository.snapshot())[0].replayCount, 11);
});

test("quota, request-size, priority, capability, and deadline policy fail before dispatch", async (t) => {
  const state = fixture({ policy: { maxQueuedPerOwner: 1, maxRequestBytes: 256 } });
  t.after(() => state.keyring.close());
  await state.service.submit(work({ idempotencyKey: "first" }));
  await assert.rejects(
    state.service.submit(work({ idempotencyKey: "second", request: { input: "second", model: "local/reasoning" } })),
    (error) => error.code === "compute_quota_exceeded" && error.retryable,
  );
  assert.equal((await state.repository.snapshot()).length, 1);
  await assert.rejects(
    state.service.submit(work({ ownerIdentityId: otherOwner, idempotencyKey: "large", request: { input: "x".repeat(300) } })),
    (error) => error.code === "compute_request_too_large" && error.status === 413,
  );
  await assert.rejects(state.service.submit(work({ ownerIdentityId: otherOwner, priority: 101 })),
    (error) => error.code === "invalid_compute_priority");
  await assert.rejects(state.service.submit(work({ ownerIdentityId: otherOwner, capabilityKey: "ocr" })),
    (error) => error.code === "capability_unavailable");
  await assert.rejects(state.service.submit(work({ ownerIdentityId: otherOwner, deadlineAt: "2026-08-09T23:59:59Z" })),
    (error) => error.code === "invalid_compute_deadline");
});

test("revisioned queue admission policy is loaded for every submission", async (t) => {
  let active = {
    minimumPriority: 20, maximumPriority: 80, maxQueuedPerOwner: 1, maxActivePerOwner: 4,
    maxQueuedPerCapability: 256, maxDailySubmissionsPerOwner: 1000,
    maxRequestBytes: 1024, maxDeadlineMs: 60_000,
  };
  const state = fixture({ policySource: { async submissionPolicy() { return active; } } });
  t.after(() => state.keyring.close());
  await assert.rejects(state.service.submit(work({ priority: 10, deadlineAt: null })),
    (error) => error.code === "invalid_compute_priority");
  await state.service.submit(work({ idempotencyKey: "dynamic-1", priority: 20, deadlineAt: null }));
  await assert.rejects(state.service.submit(work({ idempotencyKey: "dynamic-2", priority: 20, deadlineAt: null })),
    (error) => error.code === "compute_quota_exceeded");
  active = { ...active, maxQueuedPerOwner: 2, maximumPriority: 90 };
  const accepted = await state.service.submit(work({ idempotencyKey: "dynamic-2", priority: 90, deadlineAt: null }));
  assert.equal(accepted.priority, 90);
});

test("progress, ownership, cooperative cancellation, and resumable events are monotonic", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const submitted = await state.service.submit(work());
  await state.service.markPreparing(submitted.jobId);
  await state.service.reportProgress(submitted.jobId, { value: 0.2, messageKey: "tasks.compute.loading" });
  await state.service.markRunning(submitted.jobId);
  await state.service.reportProgress(submitted.jobId, { value: 0.7, messageKey: "tasks.compute.executing", payload: { step: 7 } });
  await assert.rejects(state.service.reportProgress(submitted.jobId, { value: 0.6 }),
    (error) => error.code === "invalid_job_progress");
  await assert.rejects(state.service.cancel({ ownerIdentityId: otherOwner, jobId: submitted.jobId }),
    (error) => error.code === "job_not_found");
  const requested = await state.service.cancel({ ownerIdentityId: owner, jobId: submitted.jobId });
  assert.equal(requested.status, "running");
  assert.ok(requested.cancelRequestedAt);
  assert.equal((await state.service.acknowledgeCancellation(submitted.jobId)).status, "cancelled");
  const events = await state.service.events({ ownerIdentityId: owner, jobId: submitted.jobId, afterSequence: 2 });
  assert.ok(events.every((event) => event.sequence > 2));
  assert.deepEqual(events.map((event) => event.sequence), [...events.map((event) => event.sequence)].sort((a, b) => a - b));
});

test("scheduler waiting reasons are durable, actionable, and idempotent", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const submitted = await state.service.submit(work());
  const first = await state.service.markWaiting(submitted.jobId, "insufficient_resource_capacity");
  const replay = await state.service.markWaiting(submitted.jobId, "insufficient_resource_capacity");
  assert.equal(first.status, "queued");
  assert.equal(first.waitingReason, "insufficient_resource_capacity");
  assert.equal(replay.waitingReason, first.waitingReason);
  const events = await state.service.events({ ownerIdentityId: owner, jobId: submitted.jobId });
  assert.deepEqual(events.map((event) => event.eventKind), ["state", "waiting"]);
  assert.deepEqual(events[1].payload, { waitingReason: "insufficient_resource_capacity" });
  assert.equal(state.audit.filter((event) => event.action === "compute.job_waiting").length, 1);
});

test("a stale scheduler waiting decision cannot reclaim a preparing external job", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const submitted = await state.service.submit(work());
  const preparing = await state.service.markPreparing(submitted.jobId, "external_provider_preparing", "external_provider");
  const stale = await state.service.markWaiting(submitted.jobId, "no_eligible_target");
  assert.equal(preparing.status, "preparing");
  assert.equal(stale.status, "preparing");
  assert.equal(stale.route, "external_provider");
  assert.equal(stale.waitingReason, "external_provider_preparing");
  const events = await state.service.events({ ownerIdentityId: owner, jobId: submitted.jobId });
  assert.deepEqual(events.map((event) => event.eventKind), ["state", "state"]);
  assert.equal(state.audit.filter((event) => event.action === "compute.job_waiting").length, 0);
});

test("terminal results remain encrypted and retry classification remains actionable", async (t) => {
  const completedState = fixture();
  t.after(() => completedState.keyring.close());
  const submitted = await completedState.service.submit(work());
  await completedState.service.markRunning(submitted.jobId);
  const completed = await completedState.service.complete(submitted.jobId, {
    resultSchema: "teamaibox.ai.response.v1",
    result: { id: "resp_result", object: "response", status: "completed", output: [{ text: "secret answer" }] },
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result.output[0].text, "secret answer");
  const restored = await completedState.createService().get({ ownerIdentityId: owner, responseId: submitted.responseId });
  assert.equal(restored.result.output[0].text, "secret answer");
  const owned = await completedState.createService().listOwn({ ownerIdentityId: owner });
  assert.deepEqual(owned[0].results, [{ label: "tasks.result.output", artifactRef: submitted.jobId }]);
  assert.equal(JSON.stringify(owned).includes("secret answer"), false);
  assert.equal(JSON.stringify(owned).includes("resultArtifact"), false);
  const refreshed = await completedState.createService().resultReference({ ownerIdentityId: owner, jobId: submitted.jobId });
  assert.equal(refreshed.taskId, submitted.jobId);
  assert.match(refreshed.referenceId, /^[0-9a-f-]{36}$/);
  await assert.rejects(
    completedState.createService().resultReference({ ownerIdentityId: otherOwner, jobId: submitted.jobId }),
    (error) => error.code === "task_result_not_found" && error.status === 404,
  );
  const stored = (await completedState.repository.snapshot())[0];
  assert.equal(JSON.stringify(stored).includes("secret answer"), false);

  const failedState = fixture();
  t.after(() => failedState.keyring.close());
  const failedJob = await failedState.service.submit(work());
  await failedState.service.markRunning(failedJob.jobId);
  const failed = await failedState.service.fail(failedJob.jobId, {
    code: "provider_timeout",
    message: "Provider timed out before acceptance",
    retryClassification: "retryable",
    guidanceKey: "tasks.compute.retry_provider",
    retryAction: "retry.same_request",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryClassification, "retryable");
  assert.equal(failed.error.retryable, true);
});

test("persisted result objects receive fresh scoped references after expiry and service restart", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const namespaceKey = `user:${owner}`;
  const objectContext = {
    identityId: owner,
    identityKind: "local_user",
    namespaceAccess: [{ namespaceKey, operations: ["write", "read", "reference:create"] }],
  };
  const bytes = Buffer.from("encrypted drawing result", "utf8");
  const stored = await state.objects.upload({
    context: objectContext,
    namespaceKey,
    objectKey: "ai-results/drawing/restart-test/result.png",
    contentType: "image/png",
    content: bytes,
  });
  const original = await state.objects.createScopedReference({
    context: objectContext,
    namespaceKey,
    objectId: stored.objectId,
    version: stored.version,
    audience: "compute.user-result",
    operations: ["head", "read", "range"],
    expiresAt: new Date("2026-08-10T00:15:00.000Z"),
  });
  const submitted = await state.service.submit(work({ idempotencyKey: "result-reference-refresh" }));
  await state.service.markRunning(submitted.jobId);
  await state.service.complete(submitted.jobId, {
    result: {
      schema: "teamaibox.ai.image-result.v1",
      outputs: [{
        object_id: stored.objectId,
        object_version: stored.version,
        reference_id: original.reference.referenceId,
        preview_path: `/api/v1/objects/references/${original.reference.referenceId}/content`,
        download_path: `/api/v1/objects/references/${original.reference.referenceId}/content?download=1`,
      }],
    },
  });
  state.advance(15 * 60 * 1000 + 1);
  const restored = await state.createService().get({ ownerIdentityId: owner, jobId: submitted.jobId });
  const output = restored.result.outputs[0];
  assert.notEqual(output.reference_id, original.reference.referenceId);
  assert.equal(output.object_id, stored.objectId);
  assert.equal(output.preview_path, `/api/v1/objects/references/${output.reference_id}/content`);
  assert.equal(output.download_path, `/api/v1/objects/references/${output.reference_id}/content?download=1`);
  const downloaded = await state.objects.downloadByReferenceId({
    context: objectContext,
    referenceId: output.reference_id,
  });
  assert.equal(downloaded.content.toString("utf8"), "encrypted drawing result");
});

test("deadline reconciliation expires queued work and marks running work incomplete", async (t) => {
  const queuedState = fixture();
  t.after(() => queuedState.keyring.close());
  const queued = await queuedState.service.submit(work({ deadlineAt: "2026-08-10T00:00:01Z" }));
  queuedState.advance(1001);
  assert.equal((await queuedState.service.expireDeadlines())[0].status, "expired");

  const runningState = fixture();
  t.after(() => runningState.keyring.close());
  const running = await runningState.service.submit(work({ deadlineAt: "2026-08-10T00:00:01Z" }));
  await runningState.service.markRunning(running.jobId);
  runningState.advance(1001);
  const reconciled = (await runningState.service.expireDeadlines())[0];
  assert.equal(reconciled.status, "incomplete");
  assert.equal(reconciled.retryClassification, "manual_reconcile");
});

test("sync and streaming execution bridges observe a durable job before dispatch", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const execution = {
    async awaitResult({ jobId }) {
      assert.equal((await state.repository.snapshot()).some((job) => job.jobId === jobId), true);
      await state.service.markRunning(jobId);
      return state.service.complete(jobId, {
        result: { id: "resp_sync", object: "response", status: "completed", output: [] },
      });
    },
    async streamResult({ jobId }) {
      assert.equal((await state.repository.snapshot()).some((job) => job.jobId === jobId), true);
      return (async function* events() { yield { event: "response.created", data: { type: "response.created" } }; }());
    },
  };
  const backend = new DurableComputeBackend({
    jobService: state.service,
    execution,
    realtimeAdmission: {
      admit: async () => ({}),
      connect: async () => ({}),
      heartbeat: async () => ({}),
      disconnect: async () => ({}),
    },
  });
  const invoked = await backend.invoke(work());
  assert.equal(invoked.body.status, "completed");
  const streamWork = work({ idempotencyKey: "stream-contract", request: { model: "local/reasoning", input: "stream" } });
  const events = await backend.stream(streamWork);
  const received = [];
  for await (const event of events) received.push(event);
  assert.equal(received[0].event, "response.created");
});

test("lists only the selected owner's durable tasks in newest-first order", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const first = await state.service.submit(work());
  state.advance(1_000);
  const second = await state.service.submit(work({ idempotencyKey: "job-list-second" }));
  await state.service.submit(work({ ownerIdentityId: otherOwner, idempotencyKey: "other-owner-job" }));
  assert.deepEqual((await state.service.listOwn({ ownerIdentityId: owner })).map((job) => job.jobId), [second.jobId, first.jobId]);
  assert.equal((await state.service.listOwn({ ownerIdentityId: otherOwner })).length, 1);
});

test("startup reconciliation resumes a durable queued job after a process restart", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const profileId = "44444444-4444-4444-8444-444444444444";
  const queued = await state.service.submit(work({ deadlineAt: null, requestedModelProfileId: profileId }));
  const calls = [];
  const dispatchChecks = [];
  const backend = new DurableComputeBackend({
    jobService: state.createService(),
    execution: {
      canDispatch(input) {
        dispatchChecks.push(input);
        return input.operation === "responses" && input.requestedModel === "local/reasoning"
          && input.requestedModelProfileId === profileId;
      },
      async dispatch(input) { calls.push(input); },
      async awaitResult() {},
      async streamResult() {},
    },
    realtimeAdmission: {
      admit: async () => ({}), connect: async () => ({}),
      heartbeat: async () => ({}), disconnect: async () => ({}),
    },
  });
  const result = await backend.reconcile();
  assert.deepEqual(result, { inspected: 1, dispatched: 1 });
  assert.deepEqual(dispatchChecks, [{ operation: "responses", requestedModel: "local/reasoning",
    requestedModelProfileId: profileId }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ jobId: queued.jobId, ownerIdentityId: owner }]);
});

test("background submission remains queued until reconciliation and can be cancelled before dispatch", async (t) => {
  const state = fixture();
  t.after(() => state.keyring.close());
  const calls = [];
  const backend = new DurableComputeBackend({
    jobService: state.service,
    execution: {
      canDispatch() { return true; },
      async dispatch(input) { calls.push(input); },
      async awaitResult() {},
      async streamResult() {},
      async cancel() { throw new Error("queued cancellation must not reach execution"); },
    },
    realtimeAdmission: {
      admit: async () => ({}), connect: async () => ({}),
      heartbeat: async () => ({}), disconnect: async () => ({}),
    },
  });
  const queued = await backend.submit(work({ deferDispatch: true, idempotencyKey: "deferred-background" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queued.status, "queued");
  assert.deepEqual(calls, []);
  const cancelled = await backend.cancelJob({ ownerIdentityId: owner, jobId: queued.jobId });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(await backend.reconcile(), { inspected: 0, dispatched: 0 });
  assert.deepEqual(calls, []);
});
