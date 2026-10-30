import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryTaskCenterRepository } from "../src/tasks/memory-repository.mjs";
import { TaskCenter } from "../src/tasks/task-center.mjs";

function fixture() {
  let current = new Date("2026-08-10T00:00:00.000Z");
  const repository = new MemoryTaskCenterRepository();
  const taskCenter = new TaskCenter({ repository, clock: () => new Date(current) });
  return {
    taskCenter,
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
  };
}

test("creates queued tasks and lists only the current user's work", async () => {
  const { taskCenter } = fixture();
  const own = await taskCenter.createTask({ ownerIdentityId: "user-a", taskKind: "asr", titleKey: "tasks.asr.title" });
  await taskCenter.createTask({ ownerIdentityId: "user-b", taskKind: "ocr", titleKey: "tasks.ocr.title" });
  assert.equal(own.kind, "task");
  assert.equal(own.state, "queued");
  assert.deepEqual((await taskCenter.listOwnTasks("user-a")).map((task) => task.id), [own.id]);
  await assert.rejects(taskCenter.taskEvents("user-b", own.id), (error) => error.code === "task_not_found");
});

test("records ordered state and monotonic progress events with resumable cursors", async () => {
  const { taskCenter, advance } = fixture();
  const task = await taskCenter.createTask({ ownerIdentityId: "user-a", taskKind: "asr", titleKey: "tasks.asr.title" });
  advance(1_000);
  await taskCenter.transition(task.id, "preparing");
  await taskCenter.reportProgress(task.id, { progress: 12, messageKey: "tasks.asr.loading" });
  await taskCenter.transition(task.id, "running");
  await taskCenter.reportProgress(task.id, { progress: 68, messageKey: "tasks.asr.transcribing", payload: { shard: 7, shards: 10 } });
  const events = await taskCenter.taskEvents("user-a", task.id);
  assert.deepEqual(events.map((event) => event.state), ["queued", "preparing", "preparing", "running", "running"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual((await taskCenter.taskEvents("user-a", task.id, 3)).map((event) => event.sequence), [4, 5]);
  await assert.rejects(
    taskCenter.reportProgress(task.id, { progress: 60 }),
    (error) => error.code === "invalid_task_progress",
  );
});

test("supports explicit progress revision reset while preparing a retry", async () => {
  const { taskCenter } = fixture();
  const task = await taskCenter.createTask({ ownerIdentityId: "user-a", taskKind: "ocr", titleKey: "tasks.ocr.title" });
  await taskCenter.transition(task.id, "preparing");
  await taskCenter.reportProgress(task.id, { progress: 40 });
  const retry = await taskCenter.beginRetry(task.id);
  assert.equal(retry.progress, 0);
  assert.equal(retry.progressRevision, 2);
});

test("cancellation is an idempotent request until execution reaches cancelled", async () => {
  const { taskCenter } = fixture();
  const task = await taskCenter.createTask({ ownerIdentityId: "user-a", taskKind: "drawing", titleKey: "tasks.drawing.title" });
  const first = await taskCenter.requestCancellation("user-a", task.id);
  const second = await taskCenter.requestCancellation("user-a", task.id);
  assert.equal(first.cancellationRequested, true);
  assert.equal(second.cancellationRequested, true);
  assert.equal((await taskCenter.taskEvents("user-a", task.id)).filter((event) => event.eventKind === "cancellation_requested").length, 1);
  const cancelled = await taskCenter.transition(task.id, "cancelled");
  assert.equal(cancelled.state, "cancelled");
  await assert.rejects(
    taskCenter.requestCancellation("user-a", task.id),
    (error) => error.code === "task_already_terminal",
  );
});

test("completed tasks expose labeled result references and cannot transition again", async () => {
  const { taskCenter } = fixture();
  const task = await taskCenter.createTask({ ownerIdentityId: "user-a", taskKind: "translation", titleKey: "tasks.translation.title" });
  await taskCenter.transition(task.id, "preparing");
  await taskCenter.transition(task.id, "running");
  const completed = await taskCenter.complete(task.id, [{ label: "subtitle", artifactRef: "artifact:v1:subtitle-1" }]);
  assert.equal(completed.state, "completed");
  assert.equal(completed.progress, 100);
  assert.deepEqual(completed.results, [{ label: "subtitle", artifactRef: "artifact:v1:subtitle-1" }]);
  await assert.rejects(taskCenter.transition(task.id, "running"), (error) => error.code === "invalid_task_transition");
});

test("failed tasks retain actionable retry guidance", async () => {
  const { taskCenter } = fixture();
  const task = await taskCenter.createTask({ ownerIdentityId: "user-a", taskKind: "asr", titleKey: "tasks.asr.title" });
  await taskCenter.transition(task.id, "preparing");
  const failed = await taskCenter.fail(task.id, {
    errorCode: "model_memory_unavailable",
    guidanceKey: "tasks.retry.wait_for_memory",
    retryable: true,
    retryAction: "retry.same_request",
  });
  assert.deepEqual(failed.failure, {
    errorCode: "model_memory_unavailable",
    guidanceKey: "tasks.retry.wait_for_memory",
    retryable: true,
    retryAction: "retry.same_request",
  });
});

test("Agent operation confirmations never appear as tasks or compute approvals", async () => {
  const { taskCenter } = fixture();
  const task = await taskCenter.createTask({ ownerIdentityId: "user-a", taskKind: "agent", titleKey: "tasks.agent.title" });
  const confirmation = await taskCenter.createAgentConfirmation({
    ownerIdentityId: "user-a",
    agentSessionKey: "agent-session-1",
    operationKind: "filesystem_write",
    titleKey: "agent.confirm.write_file",
    scope: { path: "/workspace/report.md", action: "write" },
    expiresAt: "2026-08-10T00:05:00.000Z",
  });
  assert.equal(confirmation.kind, "agent_operation_confirmation");
  assert.equal(confirmation.status, "pending");
  assert.equal((await taskCenter.listOwnTasks("user-a"))[0].id, task.id);
  assert.equal((await taskCenter.listOwnAgentConfirmations("user-a"))[0].id, confirmation.id);
  const approved = await taskCenter.decideAgentConfirmation("user-a", confirmation.id, "approved");
  assert.equal(approved.status, "approved");
  await assert.rejects(
    taskCenter.decideAgentConfirmation("user-a", confirmation.id, "approved"),
    (error) => error.code === "confirmation_not_pending",
  );
});

test("Agent confirmations expire and cannot be decided by another user", async () => {
  const { taskCenter, advance } = fixture();
  const confirmation = await taskCenter.createAgentConfirmation({
    ownerIdentityId: "user-a",
    agentSessionKey: "agent-session-2",
    operationKind: "package_install",
    titleKey: "agent.confirm.install_package",
    scope: { ecosystem: "pip", package: "pandas" },
    expiresAt: "2026-08-10T00:01:00.000Z",
  });
  await assert.rejects(
    taskCenter.decideAgentConfirmation("user-b", confirmation.id, "denied"),
    (error) => error.code === "confirmation_not_found",
  );
  advance(60_001);
  assert.equal((await taskCenter.listOwnAgentConfirmations("user-a"))[0].status, "expired");
  await assert.rejects(
    taskCenter.decideAgentConfirmation("user-a", confirmation.id, "approved"),
    (error) => error.code === "confirmation_not_pending",
  );
});
