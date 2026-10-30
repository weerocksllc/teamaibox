import assert from "node:assert/strict";
import { test } from "node:test";

import { QueuedAssistantAnswerRunner } from "../src/assistant/queued-answer-runner.mjs";

test("Assistant answer mode invokes the owner-scoped OpenAI queue and projects streaming text and usage", async () => {
  const calls = [], outputs = [];
  const runner = new QueuedAssistantAnswerRunner({
    modelAlias: "local/qwen-nvfp4",
    computeApi: {
      async handle(input) {
        calls.push(input);
        return {
          kind: "sse",
          events: (async function* events() {
            yield { data: { object: "chat.completion.chunk", choices: [{ delta: { content: "真实" }, finish_reason: null }] } };
            yield { data: { object: "chat.completion.chunk", choices: [{ delta: { content: "回答" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } } };
          }()),
        };
      },
    },
  });
  await runner.run({
    ownerIdentityId: "11111111-1111-4111-8111-111111111111",
    run: { id: "22222222-2222-4222-8222-222222222222", conversationId: "33333333-3333-4333-8333-333333333333" },
    history: [{ role: "user", content: "你好" }],
    emit: async (value) => outputs.push(value),
  });
  assert.equal(calls[0].pathname, "/v1/chat/completions");
  assert.equal(calls[0].context.identityId, "11111111-1111-4111-8111-111111111111");
  assert.equal(calls[0].body.model, "local/qwen-nvfp4");
  assert.equal(calls[0].body.max_tokens, 256);
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[0].body.x_teamaibox.data_class, "confidential");
  assert.deepEqual(outputs.filter((item) => item.type === "text_delta").map((item) => item.delta), ["真实", "回答"]);
  assert.deepEqual(outputs.at(-1).usage, { inputTokens: 3, outputTokens: 2, costMicrounits: 0, currency: "CNY" });
});

test("Assistant answer mode maps retryable queue failures to an actionable Assistant error", async () => {
  const runner = new QueuedAssistantAnswerRunner({
    modelAlias: "local/qwen38-nvfp4",
    computeApi: {
      async handle() {
        return {
          kind: "sse",
          events: (async function* events() {
            const error = new Error("No healthy provider route");
            error.code = "compute_worker_unavailable";
            error.retryable = true;
            throw error;
          }()),
        };
      },
    },
  });
  await assert.rejects(runner.run({
    ownerIdentityId: "11111111-1111-4111-8111-111111111111",
    run: { id: "22222222-2222-4222-8222-222222222222", conversationId: "33333333-3333-4333-8333-333333333333" },
    history: [{ role: "user", content: "你好" }],
    emit: async () => {},
  }), (error) => error.code === "assistant_compute_unavailable" && error.retryable === true);
});
