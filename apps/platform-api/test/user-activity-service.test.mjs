import assert from "node:assert/strict";
import test from "node:test";

import { MemoryTaskCenterRepository } from "../src/tasks/memory-repository.mjs";
import { TaskCenter } from "../src/tasks/task-center.mjs";
import { CatalogUserServiceAvailabilitySource, ClusterUserServiceAvailabilitySource, UserActivityService } from "../src/tasks/user-activity-service.mjs";

const USER_A = "018f6f18-24d7-7c21-9b62-8c0174199581";
const USER_B = "018f6f18-24d7-7c21-9b62-8c0174199582";
const context = (identityId = USER_A, permissions = ["task:own:view", "task:own:manage"]) => ({ identityId, permissions });

test("completed tasks show their final outcome rather than a late cancellation request", async () => {
  const service = new UserActivityService({ taskSource:{async listOwn(){return [{jobId:USER_B,status:'succeeded',capabilityKey:'image',
    progress:{value:1},cancelRequestedAt:'2026-09-15T21:18:00Z'}];}} });
  const task=(await service.overview({context:context()})).tasks[0];
  assert.equal(task.state,'completed');assert.equal(task.progress,100);assert.equal(task.cancellationRequested,false);assert.equal(task.canCancel,false);
});

test("cancelling one's task never invokes global health and retains the authoritative outcome", async () => {
  const service = new UserActivityService({
    taskSource: { async listOwn() { return []; }, async cancelOwn({ ownerIdentityId, taskId }) {
      assert.equal(ownerIdentityId, USER_A); return { jobId: taskId, status: "cancelled", capabilityKey: "ocr" };
    } }, availabilitySource: { async snapshot() { assert.fail("cancellation must not check the entire fleet"); } },
  });
  assert.equal((await service.cancelOwn({ context: context(), taskId: USER_B })).state, "cancelled");
});

test("own tasks survive an unrelated availability lookup failure without inventing healthy services", async () => {
  const service = new UserActivityService({
    taskSource: { async listOwn({ ownerIdentityId }) {
      assert.equal(ownerIdentityId, USER_A); return [{ jobId: USER_B, status: "running", capabilityKey: "ocr" }];
    } }, availabilitySource: { async snapshot() { throw new Error("unrelated health unavailable"); } },
  });
  const result = await service.overview({ context: context() });
  assert.equal(result.tasks.length, 1); assert.equal(result.tasks[0].state, "running");
  assert.deepEqual(result.availability, []);
});

test("service strip uses the actor's actual app catalog, never unrelated healthy providers or invented zero waits", async () => {
  const actor = context();
  const source = new CatalogUserServiceAvailabilitySource({ applicationCatalogService: { async list({ context: received }) {
    assert.equal(received, actor);
    return { applications: [{ pluginKey: "official.drawing", authorized: true, launchable: false, privateOrigin: "secret" },
      { pluginKey: "official.ocr", authorized: true, launchable: true },
      { pluginKey: "official.asr", authorized: false, launchable: true }] };
  } } });
  const result = await source.snapshot({ context: actor });
  assert.deepEqual(result.map((r) => r.state), ["unavailable", "available"]);
  assert.ok(result.every((r) => r.wait.estimatedSeconds === null));
  assert.doesNotMatch(JSON.stringify(result), /secret|privateOrigin|asr/);
  const activity = new UserActivityService({ taskSource: { async listOwn() { return []; } }, availabilitySource: source });
  assert.equal((await activity.overview({ context: actor })).availability[0].state, "unavailable");
});

test("own activity exposes safe progress and wait guidance without owner, prompt, file, route, or other-user facts", async () => {
  const tasks = new TaskCenter({ repository: new MemoryTaskCenterRepository(), clock: () => new Date("2026-08-11T12:00:00.000Z") });
  const own = await tasks.createTask({ ownerIdentityId: USER_A, taskKind: "drawing", titleKey: "tasks.kind.drawing" });
  await tasks.createTask({ ownerIdentityId: USER_B, taskKind: "asr", titleKey: "tasks.kind.asr" });
  const availabilitySource = { async snapshot() { return [{ applicationKey: "official.drawing", capabilityKey: "drawing", state: "busy", reasonKey: "services.reason.busy", wait: { estimateStatus: "estimated", estimatedSeconds: 48, basis: "queue_age_proxy" }, observedAt: "2026-08-11T12:00:00.000Z", prompt: "forbidden", nodeId: "private-node" }]; } };
  const service = new UserActivityService({ taskSource: tasks, availabilitySource, clock: () => new Date("2026-08-11T12:00:01.000Z") });
  const result = await service.overview({ context: context() });
  assert.deepEqual(result.tasks.map((task) => task.taskId), [own.id]);
  assert.equal(result.tasks[0].wait.estimatedSeconds, 48);
  assert.equal(result.tasks[0].wait.reasonKey, "services.reason.busy");
  assert.doesNotMatch(JSON.stringify(result.tasks[0]), /ownerIdentityId|prompt|filename|route|worker|nodeId/);
  assert.doesNotMatch(JSON.stringify(result), /forbidden|private-node|nodeId|prompt/);
  assert.equal(result.summary.active, 1);
});

test("durable task projection removes backend messages and unknown scheduler reasons", async () => {
  const source = {
    async listOwn({ ownerIdentityId, includeResult }) {
      assert.equal(ownerIdentityId, USER_A); assert.equal(includeResult, false);
      return [{ schemaVersion: 1, jobId: "018f6f18-24d7-7c21-9b62-8c0174199591", ownerIdentityId: USER_A,
        capabilityKey: "asr", status: "failed", progress: { value: 0.37, revision: 2 }, waitingReason: "internal_node_17_memory_fence",
        error: { code: "model_memory_unavailable", message: "secret prompt /team/private.wav", guidanceKey: "tasks.retry.wait_for_memory", retryable: true, retryAction: "retry.same_request" },
        route: "node:spark-private", requestedModel: "private-model", createdAt: "2026-08-11T11:00:00.000Z", updatedAt: "2026-08-11T11:01:00.000Z", terminalAt: "2026-08-11T11:01:00.000Z" }];
    },
    async cancel() { throw new Error("not called"); },
  };
  const service = new UserActivityService({ taskSource: source });
  const result = await service.overview({ context: context() });
  assert.equal(result.tasks[0].progress, 37);
  assert.equal(result.tasks[0].wait.reasonKey, "tasks.wait.capacity_busy");
  assert.deepEqual(result.tasks[0].failure, { code: "model_memory_unavailable", guidanceKey: "tasks.retry.wait_for_memory", retryable: true, retryAction: "retry.same_request" });
  assert.doesNotMatch(JSON.stringify(result), /secret prompt|private.wav|spark-private|private-model|ownerIdentityId/);
});

test("own-task view and cancellation require separate permissions and preserve not-found ownership semantics", async () => {
  const tasks = new TaskCenter({ repository: new MemoryTaskCenterRepository() });
  const task = await tasks.createTask({ ownerIdentityId: USER_A, taskKind: "ocr", titleKey: "tasks.kind.ocr" });
  const service = new UserActivityService({ taskSource: tasks });
  await assert.rejects(service.overview({ context: context(USER_A, []) }), { code: "task_permission_required" });
  await assert.rejects(service.cancelOwn({ context: context(USER_A, ["task:own:view"]), taskId: task.id }), { code: "task_permission_required" });
  await assert.rejects(service.cancelOwn({ context: context(USER_B), taskId: task.id }), { code: "task_not_found" });
  const cancelled = await service.cancelOwn({ context: context(), taskId: task.id });
  assert.equal(cancelled.cancellationRequested, true);
});

test("own-task result access refreshes only the authenticated owner's protected reference", async () => {
  const calls = [];
  const source = {
    async listOwn() { return []; },
    async resultReference(input) { calls.push(input); return { taskId: input.jobId, referenceId: USER_B }; },
  };
  const service = new UserActivityService({ taskSource: source });
  await assert.rejects(service.resultOwn({ context: context(USER_A, []), taskId: USER_B }), { code: "task_permission_required" });
  const result = await service.resultOwn({ context: context(USER_A, ["task:own:view"]), taskId: USER_B });
  assert.equal(result.referenceId, USER_B);
  assert.deepEqual(calls, [{ ownerIdentityId: USER_A, jobId: USER_B, expiresInSeconds: 300 }]);
});

test("cluster availability publishes only application state and explicit estimate basis", async () => {
  const source = new ClusterUserServiceAvailabilitySource({
    clock: () => new Date("2026-08-11T12:00:00.000Z"),
    managedNodeService: { async list() { return { data: [{ nodeId: "private-node", nodeKey: "secret", lifecycleState: "ready", inventory: { capabilities: [{ capabilityKey: "image", state: "available" }] } }] }; } },
    clusterMetricService: { async getCluster() { return { collectionStatus: "fresh", aggregate: { queues: [{ queueKey: "image.batch", depth: { status: "measured", value: 3 }, oldestWaitMilliseconds: { status: "measured", value: 42_001 }, reasons: [{ reasonCode: "private_reason", count: 3 }] }] } }; } },
    externalProviderService: { async listOperations() { return { data: [{ providerId: "private-provider", lifecycleState: "healthy", health: { state: "healthy" }, modelMappings: [{ enabled: true, operations: ["responses"] }] }] }; } },
  });
  const snapshot = await source.snapshot();
  const drawing = snapshot.find((item) => item.capabilityKey === "drawing");
  const assistant = snapshot.find((item) => item.capabilityKey === "assistant");
  assert.equal(drawing.state, "busy");
  assert.deepEqual(drawing.wait, { estimateStatus: "estimated", estimatedSeconds: 43, basis: "queue_age_proxy" });
  assert.equal(assistant.state, "available");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-node|secret|private-provider|private_reason/);
});
