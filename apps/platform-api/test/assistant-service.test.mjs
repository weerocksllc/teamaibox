import assert from "node:assert/strict";
import { test } from "node:test";

import { AssistantService } from "../src/assistant/assistant-service.mjs";
import { MemoryAssistantRepository } from "../src/assistant/memory-repository.mjs";
import { MemoryTaskCenterRepository } from "../src/tasks/memory-repository.mjs";
import { TaskCenter } from "../src/tasks/task-center.mjs";

const ownerA = "00000000-0000-4000-8000-000000008001";
const ownerB = "00000000-0000-4000-8000-000000008002";

test("large runner chunks, complete answers and tool descriptions are not truncated", async () => {
  const delta = "完整回答".repeat(40000), summary = "完整操作说明".repeat(400);
  const { service } = fixture({ agentRunner: { async run({ emit }) {
    await emit({ type: "tool.started", toolCallId: "tool.long", name: "read", summary });
    await emit({ type: "tool.completed", toolCallId: "tool.long", status: "succeeded", summary });
    for (let i = 0; i < 4; i++) await emit({ type: "text_delta", delta });
  } } });
  const conversation = await service.createConversation(ownerA);
  const submitted = await service.submitMessage(ownerA, conversation.id, { content: "测试完整回答", mode: "agent", idempotencyKey: "large-runner-output-1" });
  assert.equal((await service.waitForRun(submitted.run.id)).status, "completed");
  const message = (await service.getConversation(ownerA, conversation.id)).messages.at(-1);
  assert.equal(message.content, delta.repeat(4));
  assert.equal(message.toolCalls[0].summary, summary);
});

test("assistant hands text above the former 64000 character cap to the model runner", async () => {
  const { service, observed } = fixture();
  const conversation = await service.createConversation(ownerA);
  const content = "办公资料".repeat(20000);
  const submitted = await service.submitMessage(ownerA, conversation.id, { content, mode: "answer", idempotencyKey: "long-office-text-1" });
  assert.equal((await service.waitForRun(submitted.run.id)).status, "completed");
  assert.equal(observed.answerHistories[0].at(-1).content, content);
  await assert.rejects(service.submitMessage(ownerA, conversation.id, { content: " ", mode: "answer", idempotencyKey: "empty-text-1" }), { code: "assistant_input_invalid" });
});

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fixture({ answerRunner = null, agentRunner = null } = {}) {
  let now = new Date("2026-08-11T00:00:00.000Z");
  const clock = () => new Date(now);
  const repository = new MemoryAssistantRepository();
  const taskCenter = new TaskCenter({ repository: new MemoryTaskCenterRepository(), clock });
  const observed = { answerHistories: [], agentHistories: [] };
  const service = new AssistantService({
    repository,
    taskCenter,
    clock,
    answerRunner: answerRunner ?? {
      async run({ history, emit }) {
        observed.answerHistories.push(history);
        await emit({ type: "text_delta", delta: "这是" });
        await emit({ type: "text_delta", delta: "回答。" });
        await emit({ type: "source.cited", source: { referenceId: "object:source:1", label: "统一内存资料", url: "/api/v1/objects/source-1" } });
        await emit({ type: "usage.updated", usage: { inputTokens: 8, outputTokens: 3, costMicrounits: 0, currency: "CNY" } });
      },
    },
    agentRunner: agentRunner ?? {
      async run({ history, emit, requestConfirmation }) {
        observed.agentHistories.push(history);
        await emit({ type: "tool.started", toolCallId: "tool.write.1", name: "filesystem.write", summary: "Write report" });
        const decision = await requestConfirmation({
          operationKind: "filesystem_write",
          titleKey: "agent.confirm.write_file",
          scope: { path: "/workspace/report.md", action: "write" },
          expiresAt: "2026-08-11T00:05:00.000Z",
        });
        await emit({ type: "tool.completed", toolCallId: "tool.write.1", status: decision === "approved" ? "succeeded" : "cancelled", summary: decision });
        if (decision === "approved") {
          await emit({
            type: "artifact.created",
            artifact: { referenceId: "artifact.report.1", label: "report.md", mimeType: "text/markdown", sizeBytes: 128, downloadPath: "/api/v1/objects/report" },
          });
        }
        await emit({ type: "text_delta", delta: decision === "approved" ? "报告已写入。" : "操作已取消。" });
      },
    },
  });
  return {
    service,
    observed,
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
  };
}

test("keeps answer and Agent work in one conversation with explicit routing and usage", async () => {
  const { service, observed } = fixture();
  const conversation = await service.createConversation(ownerA);
  const answer = await service.submitMessage(ownerA, conversation.id, {
    content: "解释统一内存",
    mode: "answer",
    idempotencyKey: "message-answer-1",
  });
  assert.equal((await service.waitForRun(answer.run.id)).status, "completed");

  const agent = await service.submitMessage(ownerA, conversation.id, {
    content: "写入报告文件",
    mode: "auto",
    idempotencyKey: "message-agent-1",
  });
  assert.equal(agent.run.effectiveMode, "agent");
  const confirmationEvent = await waitFor(async () => {
    const events = await service.listEvents(ownerA, conversation.id);
    return events.find((event) => event.type === "confirmation.requested");
  }, "Agent confirmation");
  const confirmationId = confirmationEvent.data.confirmation.id;
  await service.decideConfirmation(ownerA, confirmationId, "approved");
  assert.equal((await service.waitForRun(agent.run.id)).status, "completed");

  const state = await service.getConversation(ownerA, conversation.id);
  assert.equal(state.messages.length, 4);
  assert.deepEqual(state.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(state.messages[1].content, "这是回答。");
  assert.deepEqual(state.messages[1].usage, { inputTokens: 8, outputTokens: 3, costMicrounits: 0, currency: "CNY" });
  assert.deepEqual(state.messages[1].sources, [{ referenceId: "object:source:1", label: "统一内存资料", url: "/api/v1/objects/source-1" }]);
  assert.equal(state.messages[3].content, "报告已写入。");
  assert.equal(state.messages[3].toolCalls[0].status, "succeeded");
  assert.equal(state.messages[3].artifacts[0].referenceId, "artifact.report.1");
  assert.equal(observed.agentHistories.length, 1);
  assert.deepEqual(observed.agentHistories[0].map((message) => message.role), ["user", "assistant", "user"]);

  const events = await service.listEvents(ownerA, conversation.id);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  assert.ok(events.some((event) => event.type === "routing.selected" && event.data.modelKey === "auto.agent"));
  assert.ok(events.some((event) => event.type === "artifact.created"));
  assert.ok(events.some((event) => event.type === "source.cited"));
  assert.ok(events.some((event) => event.type === "confirmation.resolved"));
});

test("replays an idempotent prompt but rejects changed facts", async () => {
  const { service } = fixture();
  const conversation = await service.createConversation(ownerA, { title: "Idempotency" });
  const first = await service.submitMessage(ownerA, conversation.id, {
    content: "相同消息", mode: "answer", idempotencyKey: "same-message",
  });
  const replay = await service.submitMessage(ownerA, conversation.id, {
    content: "相同消息", mode: "answer", idempotencyKey: "same-message",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.run.id);
  await assert.rejects(
    service.submitMessage(ownerA, conversation.id, {
      content: "不同消息", mode: "answer", idempotencyKey: "same-message",
    }),
    (error) => error.code === "assistant_idempotency_conflict",
  );
  await service.waitForRun(first.run.id);
  assert.equal((await service.getConversation(ownerA, conversation.id)).messages.length, 2);
});

test("resumable event delivery does not expose another user's conversation", async () => {
  const { service } = fixture();
  const conversation = await service.createConversation(ownerA);
  const submission = await service.submitMessage(ownerA, conversation.id, {
    content: "你好", mode: "answer", idempotencyKey: "event-message",
  });
  await service.waitForRun(submission.run.id);
  const all = [];
  for await (const event of service.streamEvents(ownerA, conversation.id, { once: true })) all.push(event);
  const resumed = [];
  for await (const event of service.streamEvents(ownerA, conversation.id, { afterSequence: 4, once: true })) resumed.push(event);
  assert.ok(all.length > resumed.length);
  assert.ok(resumed.every((event) => Number(event.id) > 4));
  await assert.rejects(
    async () => {
      for await (const _event of service.streamEvents(ownerB, conversation.id, { once: true })) {
        // No event may be yielded.
      }
    },
    (error) => error.code === "assistant_conversation_not_found",
  );
});

test("only the initiating user can decide an Agent operation confirmation", async () => {
  const { service } = fixture();
  const conversation = await service.createConversation(ownerA);
  const submission = await service.submitMessage(ownerA, conversation.id, {
    content: "执行写文件", mode: "agent", idempotencyKey: "confirm-owner",
  });
  const event = await waitFor(async () => (await service.listEvents(ownerA, conversation.id))
    .find((candidate) => candidate.type === "confirmation.requested"), "confirmation event");
  await assert.rejects(
    service.decideConfirmation(ownerB, event.data.confirmation.id, "approved"),
    (error) => error.code === "confirmation_not_found",
  );
  await service.decideConfirmation(ownerA, event.data.confirmation.id, "denied");
  assert.equal((await service.waitForRun(submission.run.id)).status, "completed");
  const state = await service.getConversation(ownerA, conversation.id);
  assert.equal(state.messages[1].content, "操作已取消。");
});

test("expires an unanswered Agent confirmation and releases the waiting run", async () => {
  const clock = () => new Date();
  const repository = new MemoryAssistantRepository();
  const taskCenter = new TaskCenter({ repository: new MemoryTaskCenterRepository(), clock });
  const service = new AssistantService({
    repository,
    taskCenter,
    clock,
    answerRunner: { async run() {} },
    agentRunner: {
      async run({ emit, requestConfirmation }) {
        const decision = await requestConfirmation({
          operationKind: "filesystem_write",
          titleKey: "agent.confirm.write_file",
          scope: { path: "/workspace/expired.md", action: "write" },
          expiresAt: new Date(Date.now() + 40),
        });
        await emit({ type: "text_delta", delta: `确认结果：${decision}` });
      },
    },
  });
  const conversation = await service.createConversation(ownerA);
  const submission = await service.submitMessage(ownerA, conversation.id, {
    content: "等待写文件确认", mode: "agent", idempotencyKey: "confirm-expiry",
  });
  assert.equal((await service.waitForRun(submission.run.id)).status, "completed");
  const state = await service.getConversation(ownerA, conversation.id);
  assert.equal(state.messages[1].content, "确认结果：expired");
  assert.equal(state.confirmations[0].status, "expired");
  assert.ok((await service.listEvents(ownerA, conversation.id))
    .some((event) => event.type === "confirmation.resolved" && event.data.confirmation.status === "expired"));
});

test("cancels an active streaming run without accepting late output", async () => {
  const answerRunner = {
    async run({ emit, signal }) {
      await emit({ type: "text_delta", delta: "开始" });
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
    },
  };
  const { service } = fixture({ answerRunner });
  const conversation = await service.createConversation(ownerA);
  const submission = await service.submitMessage(ownerA, conversation.id, {
    content: "长回答", mode: "answer", idempotencyKey: "cancel-message",
  });
  await waitFor(async () => (await service.listEvents(ownerA, conversation.id)).some((event) => event.type === "response.delta"), "first delta");
  const cancelled = await service.cancelRun(ownerA, submission.run.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await service.waitForRun(submission.run.id)).status, "cancelled");
  const state = await service.getConversation(ownerA, conversation.id);
  assert.equal(state.messages[1].status, "cancelled");
});

test("cancelling a run also closes its pending Agent operation confirmation", async () => {
  const state = fixture({
    agentRunner: {
      async run({ requestConfirmation }) {
        await requestConfirmation({
          operationKind: "filesystem_write", titleKey: "agent.confirm.write_file",
          scope: { path: "/workspace/cancelled.txt" }, expiresAt: "2026-08-11T00:05:00.000Z",
        });
      },
    },
  });
  const conversation = await state.service.createConversation(ownerA);
  const submitted = await state.service.submitMessage(ownerA, conversation.id, {
    content: "创建后取消", mode: "agent", idempotencyKey: "cancel-pending-confirmation",
  });
  await waitFor(async () => (await state.service.getConversation(ownerA, conversation.id)).confirmations
    .some((item) => item.status === "pending"), "pending confirmation");
  await state.service.cancelRun(ownerA, submitted.run.id);
  const detail = await state.service.getConversation(ownerA, conversation.id);
  assert.equal(detail.messages.at(-1).status, "cancelled");
  assert.equal(detail.confirmations.at(-1).status, "cancelled");
  const events = await state.service.listEvents(ownerA, conversation.id);
  assert.ok(events.some((event) => event.type === "confirmation.resolved" && event.data.confirmation.status === "cancelled"));
  assert.ok(events.some((event) => event.type === "run.cancelled"));
});
