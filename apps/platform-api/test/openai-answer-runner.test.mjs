import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedAssistantRoutingPolicy, OpenAiQueuedAnswerRunner } from "../src/assistant/openai-answer-runner.mjs";

function stream(parts) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

test("queued OpenAI answer runner streams text, usage, sources, and artifacts through one logical model route", async () => {
  const calls = [];
  const outputs = [];
  const runner = new OpenAiQueuedAnswerRunner({
    computeGatewayOrigin: "http://compute-gateway:8080",
    model: "llm.spark.nvfp4",
    tokenProvider: async () => "token-contract-1234567890",
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      return new Response(stream([
        'data: {"choices":[{"delta":{"content":"统一"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"回答"}}],"usage":{"prompt_tokens":8,"completion_tokens":2},"x_teamaibox":{"cost_microunits":12,"currency":"CNY","sources":[{"referenceId":"object:source:1","label":"Source","url":"/source"}],"artifacts":[{"referenceId":"artifact:report:1","label":"Report","mimeType":"text/markdown","sizeBytes":12,"downloadPath":"/report"}]}}\n\n',
        "data: [DONE]\n\n",
      ]), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  await runner.run({
    run: { id: "00000000-0000-4000-8000-000000008201", conversationId: "00000000-0000-4000-8000-000000008202" },
    history: [{ role: "user", content: "问题" }],
    signal: new AbortController().signal,
    emit: async (output) => outputs.push(output),
  });
  assert.equal(calls[0].url, "http://compute-gateway:8080/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer token-contract-1234567890");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "llm.spark.nvfp4");
  assert.equal(body.stream, true);
  assert.equal(body.x_teamaibox.data_class, "confidential");
  assert.deepEqual(outputs.map((output) => output.type), [
    "text_delta", "text_delta", "usage.updated", "source.cited", "artifact.created",
  ]);
});

test("queued OpenAI answer runner fails closed on incomplete or rejected streams", async () => {
  const rejected = new OpenAiQueuedAnswerRunner({
    computeGatewayOrigin: "https://compute.example",
    model: "model",
    fetchImplementation: async () => new Response("busy", { status: 429 }),
  });
  await assert.rejects(
    rejected.run({ run: { id: "run" }, history: [], signal: new AbortController().signal, emit: async () => {} }),
    (error) => error.code === "assistant_compute_busy" && error.retryable,
  );
  const incomplete = new OpenAiQueuedAnswerRunner({
    computeGatewayOrigin: "https://compute.example",
    model: "model",
    fetchImplementation: async () => new Response(stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  });
  await assert.rejects(
    incomplete.run({ run: { id: "run" }, history: [], signal: new AbortController().signal, emit: async () => {} }),
    (error) => error.code === "assistant_compute_incomplete",
  );
});

test("routing disclosure names the configured answer model while reserving Agent for the bridge", () => {
  const policy = fixedAssistantRoutingPolicy({ model: "llm.spark.nvfp4", profileKey: "llm.spark.nvfp4.profile.v1" });
  const answer = policy({ requestedMode: "answer", content: "question" });
  assert.equal(answer.modelKey, "llm.spark.nvfp4");
  assert.equal(answer.profileKey, "llm.spark.nvfp4.profile.v1");
  const agent = policy({ requestedMode: "auto", content: "write code" });
  assert.equal(agent.effectiveMode, "agent");
  assert.equal(agent.modelKey, "agent.bridge");
  assert.equal(agent.profileKey, "llm.spark.nvfp4.profile.v1");
});
