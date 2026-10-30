import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MemoryWorkerRepository } from "../src/memory-worker-repository.mjs";
import { WorkerLifecycleManager } from "../src/worker-lifecycle-manager.mjs";

const ids = Object.freeze({
  workerId: "00000000-0000-4000-8000-000000000101",
  nodeId: "00000000-0000-4000-8000-000000000102",
  pluginId: "00000000-0000-4000-8000-000000000103",
  profileId: "00000000-0000-4000-8000-000000000104",
  controlLeaseId: "00000000-0000-4000-8000-000000000105",
  jobId: "00000000-0000-4000-8000-000000000106",
  attemptId: "00000000-0000-4000-8000-000000000107",
  leaseId: "00000000-0000-4000-8000-000000000108",
  secondJobId: "00000000-0000-4000-8000-000000000109",
  secondAttemptId: "00000000-0000-4000-8000-000000000110",
  secondLeaseId: "00000000-0000-4000-8000-000000000111",
});

function response(request, type, payload = {}) {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    workerId: request.workerId,
    type,
    sentAt: new Date().toISOString(),
    correlationId: request.correlationId,
    jobId: request.jobId,
    attemptId: request.attemptId,
    leaseId: request.leaseId,
    fencingToken: request.fencingToken,
    payload: { generation: request.payload.generation, ...payload },
    extensions: { replyTo: request.messageId },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture({ lifecyclePolicy = {}, send, publish, workerHealth, capabilityRegistrar = null,
  capabilityDescriptorResolver = null, bindAttempt = false, stopWorker,
  placementClass = "warm-optional", maintenanceGeneration = 1, maintenanceAuthorizer = null,
  image = "registry.local/worker@sha256:" + "a".repeat(64) } = {}) {
  let now = new Date("2026-08-11T01:00:00Z");
  const repository = new MemoryWorkerRepository();
  const events = [];
  const nodeCalls = [];
  const controlCalls = [];
  const nodeAgent = {
    async startWorker(value) { nodeCalls.push(["start", value]); return { status: "running" }; },
    async workerHealth(value) { nodeCalls.push(["health", value]); return workerHealth ? workerHealth(value, nodeCalls.length) : { status: "running", health: "healthy" }; },
    async stopWorker(value) { nodeCalls.push(["stop", value]); return stopWorker ? stopWorker(value) : { status: "removed" }; },
  };
  const workerControl = {
    async send(request, options) {
      controlCalls.push([request, options]);
      if (send) return send(request, options);
      const types = {
        "worker.prepare.request": "worker.prepare.ready",
        "worker.execute.request": "worker.execute.succeeded",
        "worker.cancel.request": "worker.cancel.cancelled",
        "worker.unload.request": "worker.unload.succeeded",
      };
      return response(request, types[request.type], request.type === "worker.prepare.request" ? { modelProfileId: ids.profileId } : { result: { artifactRef: "artifact-a" } });
    },
  };
  const manager = new WorkerLifecycleManager({
    repository, nodeAgent, workerControl,
    eventSink: { async publish(event) { if (publish) await publish(event); events.push(event); } },
    capabilityRegistrar, capabilityDescriptorResolver, clock: () => new Date(now), lifecyclePolicy,
    maintenanceAuthorizer,
  });
  await manager.provision({
    workerId: ids.workerId, nodeId: ids.nodeId, nodeGeneration: 7, computePluginId: ids.pluginId,
    modelProfileId: ids.profileId,
    attemptId: ids.attemptId,
    image,
    architecture: "linux/arm64/v8",
    resources: { cpuMillis: 1000, unifiedMemoryBytes: 16_000_000_000, storageBytes: 1_000_000, networkBitsPerSecond: 1_000_000_000, acceleratorUnits: 1, codecSessions: 0 },
    controlLeaseId: ids.controlLeaseId, controlFencingToken: 7,
    maxConcurrentAttempts: 1, placementClass, maintenanceGeneration, now,
  });
  if (bindAttempt) await manager.bindAttempt({ workerId: ids.workerId, attemptId: ids.attemptId,
    leaseId: ids.leaseId, fencingToken: 11, correlationId: "correlation.lifecycle-1", now });
  return {
    manager, repository, events, nodeCalls, controlCalls,
    setNow(value) { now = new Date(value); },
  };
}

async function markProtectedReady(value) {
  const readyAt = new Date("2026-08-11T01:00:00Z");
  return value.repository.mutate(ids.workerId, (worker) => {
    worker.lifecycleState = "ready";
    worker.health = { state: "healthy", generation: worker.generation, observedAt: readyAt, reasonCode: null };
    worker.loadedAt = readyAt;
    worker.lastHeartbeatAt = readyAt;
    worker.idleSince = readyAt;
    worker.updatedAt = readyAt;
    return worker;
  });
}

const correlationId = "correlation.lifecycle-1";

test('offline image worker lifecycle preserves the exact content reference', async () => {
  const image = 'sha256:' + 'c'.repeat(64);
  const {manager, repository, nodeCalls} = await fixture({image});
  await manager.ensureReady({workerId: ids.workerId, correlationId});
  assert.equal((await repository.get(ids.workerId)).image, image);
  assert.equal(nodeCalls.find(([kind]) => kind === 'start')[1].worker.image, image);
  await assert.rejects(fixture({image: 'local/worker:latest'}), /digest-pinned/);
});

test("cold start prepares once and a subsequent request reuses the warm worker", async () => {
  const value = await fixture();
  const cold = await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  assert.equal(cold.warmReuse, false);
  assert.equal(cold.worker.lifecycleState, "ready");
  assert.equal(cold.worker.generation, 2);
  assert.deepEqual(value.nodeCalls.map(([type]) => type), ["start", "health", "health"]);
  assert.deepEqual(value.controlCalls.map(([request]) => request.type), ["worker.prepare.request"]);

  const warm = await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  assert.equal(warm.warmReuse, true);
  assert.equal(value.nodeCalls.length, 3);
  assert.equal(value.controlCalls.length, 1);
  assert.ok(value.events.some((event) => event.type === "worker.warm_reused"));
});

test("a controller restart resumes the same persisted starting generation", async () => {
  const value = await fixture();
  await value.repository.mutate(ids.workerId, (worker) => {
    worker.generation = 2;
    worker.lifecycleState = "starting";
    worker.health = { state: "starting", generation: 2, observedAt: new Date("2026-08-11T01:00:00Z"), reasonCode: null };
    return worker;
  });
  const resumed = await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  assert.equal(resumed.worker.generation, 2);
  assert.equal(resumed.worker.lifecycleState, "ready");
  assert.deepEqual(value.nodeCalls.map(([type]) => type), ["start", "health", "health"]);
  assert.ok(value.events.some((event) => event.type === "worker.start_resumed"));
});

test("prepared worker waits for Docker HEALTH before becoming executable", async () => {
  let checks = 0;
  const value = await fixture({ lifecyclePolicy: { dockerHealthTimeoutMilliseconds: 100, dockerHealthPollMilliseconds: 1 },
    workerHealth() { checks += 1; return { status: "running", health: checks < 3 ? "starting" : "healthy" }; } });
  const ready = await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  assert.equal(ready.worker.lifecycleState, "ready");
  assert.equal(checks, 3);
});

test("scheduler readiness registers and refreshes the exact ComputePlugin capability", async () => {
  const registrations = [];
  const value = await fixture({
    capabilityDescriptorResolver: { async resolve(input) {
      assert.deepEqual(input, { computePluginId: ids.pluginId, modelProfileId: ids.profileId });
      return { pluginId: "example.text-transform", operations: ["chat.completions"] };
    } },
    capabilityRegistrar: { async registerReadyWorker(input) { registrations.push(structuredClone(input)); return [{ registrationId: randomUUID() }]; } },
  });
  await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].pluginId, "example.text-transform");
  assert.deepEqual(registrations[0].operations, ["chat.completions"]);
  assert.equal(registrations[0].worker.lifecycleState, "ready");
  assert.equal(registrations[0].worker.health.state, "healthy");
});

test("worker preparation fails closed when its scheduler capability cannot register", async () => {
  const value = await fixture({
    capabilityDescriptorResolver: { async resolve() { return { pluginId: "example.text-transform", operations: ["chat.completions"] }; } },
    capabilityRegistrar: { async registerReadyWorker() { throw new Error("registration unavailable"); } },
  });
  await assert.rejects(value.manager.ensureReady({ workerId: ids.workerId, correlationId }), { code: "worker_prepare_failed" });
  const worker = await value.repository.get(ids.workerId);
  assert.equal(worker.lifecycleState, "failed");
  assert.equal(worker.health.state, "unhealthy");
  assert.equal(value.nodeCalls.at(-1)[0], "stop");
});

test("execute accounts active concurrency and returns the worker to warm idle", async () => {
  const gate = deferred();
  const value = await fixture({ bindAttempt: true, send(request) {
    if (request.type === "worker.prepare.request") return response(request, "worker.prepare.ready", { modelProfileId: ids.profileId });
    if (request.type === "worker.execute.request") return gate.promise;
    return response(request, "worker.unload.succeeded");
  } });
  await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  const execution = value.manager.execute({
    workerId: ids.workerId, jobId: ids.jobId, attemptId: ids.attemptId,
    leaseId: ids.leaseId, fencingToken: 11, correlationId, input: { artifactRefs: ["object-a"] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await value.repository.get(ids.workerId)).lifecycleState, "busy");
  await assert.rejects(() => value.manager.bindAttempt({
    workerId: ids.workerId, attemptId: ids.secondAttemptId,
    leaseId: ids.secondLeaseId, fencingToken: 12, correlationId,
  }), /binding capacity is exhausted/);
  const executeRequest = value.controlCalls.find(([request]) => request.type === "worker.execute.request")[0];
  gate.resolve(response(executeRequest, "worker.execute.succeeded", { result: { artifactRef: "result-a", privateText: "must-not-enter-events" } }));
  const completed = await execution;
  assert.equal(completed.outcome, "succeeded");
  assert.equal(completed.worker.lifecycleState, "ready");
  assert.deepEqual(completed.worker.activeAttemptIds, []);
  assert.deepEqual((await value.repository.get(ids.workerId)).attemptBindings, {});
  const terminalEvent = value.events.find((event) => event.type === "worker.execution_succeeded");
  assert.deepEqual(terminalEvent.payload.resultArtifactRefs, ["result-a"]);
  assert.equal(JSON.stringify(terminalEvent).includes("must-not-enter-events"), false);
});

test("completion preserves more than 1024 distinct result references", async () => {
  const refs = Array.from({ length: 1205 }, (_, i) => `result-${i}`);
  const value = await fixture({ bindAttempt: true, send(request) {
    if (request.type === "worker.prepare.request") return response(request, "worker.prepare.ready", { modelProfileId: ids.profileId });
    if (request.type === "worker.execute.request") return response(request, "worker.execute.succeeded", {
      result: { artifactRef: refs[0], artifactRefs: [...refs, refs[0], null], privateText: "not-for-events" },
    });
    return response(request, "worker.unload.succeeded");
  } });
  await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  await value.manager.execute({ workerId: ids.workerId, jobId: ids.jobId, attemptId: ids.attemptId,
    leaseId: ids.leaseId, fencingToken: 11, correlationId, input: {} });
  const event = value.events.find(item => item.type === "worker.execution_succeeded");
  assert.deepEqual(event.payload.resultArtifactRefs, refs);
  assert.equal(JSON.stringify(event).includes("not-for-events"), false);
});

test("two distinct jobs reuse one warm worker while rotating and retiring attempt authority", async () => {
  const value = await fixture();
  const cold = await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  await value.manager.bindAttempt({ workerId: ids.workerId, attemptId: ids.attemptId,
    leaseId: ids.leaseId, fencingToken: 11, correlationId });
  const first = await value.manager.execute({ workerId: ids.workerId, jobId: ids.jobId,
    attemptId: ids.attemptId, leaseId: ids.leaseId, fencingToken: 11, correlationId, input: { text: "one" } });
  assert.equal(first.outcome, "succeeded");
  await assert.rejects(() => value.manager.execute({ workerId: ids.workerId, jobId: ids.jobId,
    attemptId: ids.attemptId, leaseId: ids.leaseId, fencingToken: 11, correlationId, input: {} }),
  { code: "stale_worker_attempt_fence" });

  await value.manager.bindAttempt({ workerId: ids.workerId, attemptId: ids.secondAttemptId,
    leaseId: ids.secondLeaseId, fencingToken: 12, correlationId });
  const warm = await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  const second = await value.manager.execute({ workerId: ids.workerId, jobId: ids.secondJobId,
    attemptId: ids.secondAttemptId, leaseId: ids.secondLeaseId, fencingToken: 12,
    correlationId, input: { text: "two" } });
  assert.equal(second.outcome, "succeeded");
  assert.equal(warm.warmReuse, true);
  assert.equal(warm.worker.generation, cold.worker.generation);
  assert.equal(value.nodeCalls.filter(([type]) => type === "start").length, 1);
  assert.deepEqual((await value.repository.get(ids.workerId)).attemptBindings, {});
  assert.deepEqual(value.events.filter((event) => event.type === "worker.attempt_bound")
    .map((event) => event.payload.attemptId), [ids.attemptId, ids.secondAttemptId]);
  assert.equal(value.events.filter((event) => event.type === "worker.attempt_released").length, 2);
});

test("cooperative cancellation keeps ownership until the worker confirms cancellation", async () => {
  const executeGate = deferred();
  const value = await fixture({ bindAttempt: true, send(request) {
    if (request.type === "worker.prepare.request") return response(request, "worker.prepare.ready", { modelProfileId: ids.profileId });
    if (request.type === "worker.execute.request") return executeGate.promise;
    if (request.type === "worker.cancel.request") return response(request, "worker.cancel.cancelled");
    return response(request, "worker.unload.succeeded");
  } });
  await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  const execution = value.manager.execute({ workerId: ids.workerId, jobId: ids.jobId, attemptId: ids.attemptId, leaseId: ids.leaseId, fencingToken: 11, correlationId, input: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await value.manager.cancel({ workerId: ids.workerId, jobId: ids.jobId, attemptId: ids.attemptId, leaseId: ids.leaseId, fencingToken: 11, correlationId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.worker.lifecycleState, "ready");
  const executeRequest = value.controlCalls.find(([request]) => request.type === "worker.execute.request")[0];
  executeGate.resolve(response(executeRequest, "worker.execute.cancelled"));
  assert.equal((await execution).outcome, "cancelled");
  assert.equal(value.events.filter((event) => event.type === "worker.execution_cancelled").length, 1);
  const terminal = await value.repository.get(ids.workerId);
  assert.deepEqual(terminal.attemptStates, {});
  assert.ok(value.events.findIndex((event) => event.type === "worker.cancel_requested")
    < value.events.findIndex((event) => event.type === "worker.execution_cancelled"));
});

test("accepted cancellation cannot resurrect attempt state after a concurrent terminal response", async () => {
  const value = await fixture({ bindAttempt: true, send(request) {
    if (request.type === "worker.prepare.request") return response(request, "worker.prepare.ready", { modelProfileId: ids.profileId });
    if (request.type === "worker.execute.request") return new Promise((resolve) => { value.finishExecution = () => resolve(response(request, "worker.execute.cancelled")); });
    if (request.type === "worker.cancel.request") {
      value.finishExecution();
      return new Promise((resolve) => setImmediate(() => resolve(response(request, "worker.cancel.accepted"))));
    }
    return response(request, "worker.unload.succeeded");
  } });
  await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  const execution = value.manager.execute({ workerId: ids.workerId, jobId: ids.jobId,
    attemptId: ids.attemptId, leaseId: ids.leaseId, fencingToken: 11, correlationId, input: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const cancellation = await value.manager.cancel({ workerId: ids.workerId, jobId: ids.jobId,
    attemptId: ids.attemptId, leaseId: ids.leaseId, fencingToken: 11, correlationId });
  assert.equal((await execution).outcome, "cancelled");
  assert.equal(cancellation.status, "cancelled");
  assert.deepEqual((await value.repository.get(ids.workerId)).attemptStates, {});
  assert.deepEqual((await value.repository.get(ids.workerId)).attemptBindings, {});
});

test("idle sweep cooperatively unloads then asks only Node Agent to stop Docker", async () => {
  const value = await fixture({ lifecyclePolicy: { idleTimeoutMilliseconds: 1_000 } });
  await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  value.setNow("2026-08-11T01:00:02Z");
  const stopped = await value.manager.stopIdle({ correlationId, now: new Date("2026-08-11T01:00:02Z") });
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].lifecycleState, "stopped");
  assert.ok(value.controlCalls.some(([request]) => request.type === "worker.unload.request"));
  assert.equal(value.nodeCalls.at(-1)[0], "stop");
  assert.deepEqual(value.nodeCalls.at(-1)[1].authority, { leaseId: ids.controlLeaseId, fencingToken: 7, nodeGeneration: 7 });
});

test("idle sweep never unloads a protected-resident Worker", async () => {
  const value = await fixture({
    lifecyclePolicy: { idleTimeoutMilliseconds: 1_000 },
    placementClass: "protected-resident",
    maintenanceGeneration: 4,
  });
  await markProtectedReady(value);
  value.setNow("2026-08-11T01:00:02Z");
  assert.deepEqual(await value.manager.stopIdle({
    correlationId,
    now: new Date("2026-08-11T01:00:02Z"),
  }), []);
  assert.equal((await value.repository.get(ids.workerId)).lifecycleState, "ready");
  assert.equal(value.controlCalls.some(([request]) => request.type === "worker.unload.request"), false);
  assert.equal(value.nodeCalls.some(([operation]) => operation === "stop"), false);
});

test("protected-resident cold start requires the complete protected-set recovery path", async () => {
  const value = await fixture({
    placementClass: "protected-resident",
    maintenanceGeneration: 4,
  });
  await assert.rejects(value.manager.ensureReady({ workerId: ids.workerId, correlationId }),
    { code: "protected_set_recovery_required" });
  assert.equal((await value.repository.get(ids.workerId)).lifecycleState, "stopped");
  assert.equal(value.nodeCalls.some(([operation]) => operation === "start"), false);
});

test("ordinary unload cannot turn a per-worker signature into protected maintenance authority", async () => {
  const authorizerCalls = [];
  const value = await fixture({
    placementClass: "protected-resident",
    maintenanceGeneration: 4,
    maintenanceAuthorizer: async ({ context, operation, workers }) => {
      authorizerCalls.push({ context, operation, workers });
      return {
        authorized: true,
        signatureVerified: true,
        transactionId: context.transactionId,
        workerIds: context.workerIds,
        operation,
        maintenanceGeneration: context.maintenanceGeneration,
      };
    },
  });
  await markProtectedReady(value);
  await assert.rejects(value.manager.unload({ workerId: ids.workerId, correlationId }),
    { code: "protected_resident_maintenance_required" });
  assert.equal((await value.repository.get(ids.workerId)).lifecycleState, "ready");
  assert.equal(value.nodeCalls.some(([operation]) => operation === "stop"), false);

  await assert.rejects(value.manager.unload({
    workerId: ids.workerId,
    correlationId,
    reason: "signed_maintenance",
    maintenanceContext: {
      transactionId: "maintenance.worker-0001",
      workerIds: [ids.workerId],
      allowedOperations: ["worker.unload"],
      maintenanceGeneration: 4,
      issuedAt: "2026-08-11T00:59:00Z",
      expiresAt: "2026-08-11T01:05:00Z",
    },
    now: new Date("2026-08-11T01:00:00Z"),
  }), { code: "protected_resident_maintenance_required" });
  assert.equal(authorizerCalls.length, 0);
  assert.equal((await value.repository.get(ids.workerId)).lifecycleState, "ready");
  assert.equal(value.controlCalls.some(([request]) => request.type === "worker.unload.request"), false);
  assert.equal(value.nodeCalls.some(([operation]) => operation === "stop"), false);
});

test("protected-resident crash handling preserves the container for aggregate recovery", async () => {
  const value = await fixture({
    placementClass: "protected-resident",
    maintenanceGeneration: 5,
  });
  await markProtectedReady(value);
  const crashed = await value.manager.recordCrash({
    workerId: ids.workerId,
    correlationId,
    reasonCode: "worker_runtime_lost",
    now: new Date("2026-08-11T01:00:00Z"),
  });
  assert.equal(crashed.worker.lifecycleState, "failed");
  assert.equal(value.nodeCalls.some(([operation]) => operation === "stop"), false);
  const event = value.events.find((item) => item.type === "worker.protected_recovery_required");
  assert.equal(event?.payload.containerRemoved, false);
  assert.equal(event?.payload.reasonCode, "worker_runtime_lost");
});

test("repeated crashes back off, open the circuit, expose affected attempts, and half-open after expiry", async () => {
  const value = await fixture({ lifecyclePolicy: {
    crashThreshold: 3, crashWindowMilliseconds: 10_000,
    backoffBaseMilliseconds: 100, backoffMaximumMilliseconds: 1_000,
    circuitOpenMilliseconds: 5_000,
  } });
  const first = await value.manager.recordCrash({ workerId: ids.workerId, reasonCode: "model_load_crash", correlationId, now: new Date("2026-08-11T01:00:00Z") });
  assert.equal(first.worker.lifecycleState, "failed");
  assert.equal(first.worker.nextRetryAt.toISOString(), "2026-08-11T01:00:00.100Z");
  await value.manager.recordCrash({ workerId: ids.workerId, reasonCode: "model_load_crash", correlationId, now: new Date("2026-08-11T01:00:01Z") });
  const third = await value.manager.recordCrash({ workerId: ids.workerId, reasonCode: "model_load_crash", correlationId, now: new Date("2026-08-11T01:00:02Z") });
  assert.equal(third.worker.lifecycleState, "circuit_open");
  assert.equal(value.nodeCalls.filter(([type]) => type === "stop").length, 3);
  await assert.rejects(() => value.manager.ensureReady({ workerId: ids.workerId, correlationId, now: new Date("2026-08-11T01:00:03Z") }), /circuit is open/);
  assert.equal((await value.manager.recoverCircuits({ now: new Date("2026-08-11T01:00:06Z"), correlationId })).length, 0);
  const recovered = await value.manager.recoverCircuits({ now: new Date("2026-08-11T01:00:08Z"), correlationId });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].lifecycleState, "failed");
});

test("a crash revokes bound authority even before the attempt becomes active", async () => {
  const value = await fixture({ bindAttempt: true });
  const crashed = await value.manager.recordCrash({
    workerId: ids.workerId,
    reasonCode: "worker_runtime_lost",
    correlationId,
    now: new Date("2026-08-11T01:00:00Z"),
  });
  assert.deepEqual(crashed.affectedAttemptIds, [ids.attemptId]);
  assert.deepEqual(crashed.worker.activeAttemptIds, []);
  assert.deepEqual(crashed.worker.attemptStates, {});
  assert.deepEqual(crashed.worker.attemptBindings, {});
  assert.equal(crashed.worker.bindingRevision, 2);
  assert.deepEqual(value.events.find((event) => event.type === "worker.crashed")?.payload.affectedAttemptIds,
    [ids.attemptId]);
});

test("crash cleanup failure opens the circuit and never advertises the container as removed", async () => {
  const value = await fixture({
    stopWorker() { throw new Error("node agent cannot remove the crashed container"); },
    lifecyclePolicy: { circuitOpenMilliseconds: 5_000 },
  });
  await assert.rejects(value.manager.recordCrash({
    workerId: ids.workerId,
    reasonCode: "worker_runtime_lost",
    correlationId,
    now: new Date("2026-08-11T01:00:00Z"),
  }), (error) => {
    assert.equal(error.code, "worker_transport_lost");
    assert.equal(error.retryable, true);
    assert.equal(error.fatalWorker, true);
    return true;
  });
  const worker = await value.repository.get(ids.workerId);
  assert.equal(worker.lifecycleState, "circuit_open");
  assert.equal(worker.lastFailureCode, "worker_crash_cleanup_failed");
  assert.equal(worker.circuitOpenUntil.toISOString(), "2026-08-11T01:00:05.000Z");
  assert.equal(value.events.some((event) => event.type === "worker.crash_cleanup_failed"), true);
  assert.equal(value.events.some((event) => event.payload?.containerRemoved === true), false);
});

test("exact reconciliation after transport recovery clears restart delay only after Worker removal", async () => {
  let transportUnavailable = true;
  const value = await fixture({
    stopWorker() {
      if (transportUnavailable) throw new Error("node agent path is interrupted");
      return { status: "removed" };
    },
    lifecyclePolicy: { circuitOpenMilliseconds: 15 * 60_000 },
  });
  await assert.rejects(value.manager.recordCrash({
    workerId: ids.workerId,
    reasonCode: "worker_transport_lost",
    correlationId,
    now: new Date("2026-08-11T01:00:00Z"),
  }), { code: "worker_transport_lost" });
  const uncertain = await value.repository.get(ids.workerId);
  assert.equal(uncertain.lifecycleState, "circuit_open");
  assert.equal(uncertain.nextRetryAt.toISOString(), "2026-08-11T01:15:00.000Z");

  transportUnavailable = false;
  const stopped = await value.manager.unload({
    workerId: ids.workerId,
    correlationId,
    reason: "network_loss_reconcile",
    now: new Date("2026-08-11T01:00:01Z"),
  });
  assert.equal(stopped.lifecycleState, "stopped");
  assert.equal(stopped.nextRetryAt, null);
  assert.equal(stopped.circuitOpenUntil, null);

  const recovered = await value.manager.ensureReady({
    workerId: ids.workerId,
    correlationId,
    now: new Date("2026-08-11T01:00:01.001Z"),
  });
  assert.equal(recovered.warmReuse, false);
  assert.equal(recovered.worker.lifecycleState, "ready");
  assert.equal(recovered.worker.crashCount, 0);
  assert.equal(recovered.worker.lastFailureCode, null);
});

test("prepare failure stops the partial container and enters restart backoff", async () => {
  const value = await fixture({ send(request) {
    if (request.type === "worker.prepare.request") throw new Error("model loader exited");
    return response(request, "worker.unload.succeeded");
  } });
  await assert.rejects(() => value.manager.ensureReady({ workerId: ids.workerId, correlationId }), /failed to start or prepare/);
  const worker = await value.repository.get(ids.workerId);
  assert.equal(worker.lifecycleState, "failed");
  assert.equal(worker.lastFailureCode, "worker_prepare_failed");
  assert.equal(value.nodeCalls.filter(([operation]) => operation === "stop").length, 1);
  const failure = value.events.find((event) => event.type === "worker.prepare_failed");
  assert.deepEqual(failure?.payload, { stage: "worker_prepare", causeCode: "worker_prepare_failed" });
});

test("durable event failure before dispatch releases concurrency without calling the worker", async () => {
  let rejectExecutionEvent = false;
  const value = await fixture({ bindAttempt: true, publish(event) {
    if (rejectExecutionEvent && event.type === "worker.execution_started") throw new Error("outbox unavailable");
  } });
  await value.manager.ensureReady({ workerId: ids.workerId, correlationId });
  rejectExecutionEvent = true;
  await assert.rejects(() => value.manager.execute({
    workerId: ids.workerId, jobId: ids.jobId, attemptId: ids.attemptId,
    leaseId: ids.leaseId, fencingToken: 11, correlationId, input: {},
  }), /could not be persisted/);
  const worker = await value.repository.get(ids.workerId);
  assert.equal(worker.lifecycleState, "ready");
  assert.deepEqual(worker.activeAttemptIds, []);
  assert.equal(value.controlCalls.some(([request]) => request.type === "worker.execute.request"), false);
});
