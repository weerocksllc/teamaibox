import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";

import { OpenAiWorkerExecutionBridge } from "../src/compute/openai-worker-execution-bridge.mjs";

const JOB = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const MAIN_DRAWING_PROFILE = "06c9542e-4bf3-5f4f-a41e-c7768398e2ea";
const MAIN_DRAWING_PROFILE_KEY = "drawing.flux2-klein-4b.bf16.main-protected.v2";

function ordinaryDrawingAuthorization(modelAlias = "drawing.automatic") {
  return {
    schema: "teamaibox.drawing-route-authorization.v2",
    policy_version: "protected-main-default.v1",
    selection_class: "ordinary-protected",
    model_alias: modelAlias,
    operation: "images.generations",
    model_profile_id: MAIN_DRAWING_PROFILE,
  };
}

async function worker({ toolCall = false, drawing = false, ocr = false, ocrText = "# 团队 AI 盒子\n\nEncrypted OCR result", hunyuanOcr = false, ocrInvalidBoundingBox = false, asr = false, asrDuration = 3.14, asrInvalidTimeline = false, asrDelayMilliseconds = 0, translation = false, translationField = "translations", embedding = false, embeddingInvalid = false } = {}) {
  const requests = [];
  const paths = [];
  const requestHeaders = [];
  const server = createServer(async (request, response) => {
    paths.push(request.url);
    requestHeaders.push({ ...request.headers });
    if (request.url === "/health" || request.url === "/health/ready") { response.end("ok"); return; }
    if (request.url === "/v1/models/prepare") { response.setHeader("content-type", "application/json"); response.end('{"status":"ready"}'); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    if (asr && request.url === "/v1/audio/transcriptions") {
      requests.push({ contentType: request.headers["content-type"], rawBody });
      if (asrDelayMilliseconds) await new Promise((resolve) => setTimeout(resolve, asrDelayMilliseconds));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        task: "transcribe", language: "en", duration: asrDuration, text: "Team AI Box transcription.",
        segments: [{
          id: 0, start: 0, end: asrInvalidTimeline ? -1 : 3.14, text: "Team AI Box transcription.",
          words: [{ word: "Team", start: 0, end: 0.5, probability: 0.99 }],
        }],
      }));
      return;
    }
    const body = JSON.parse(rawBody.toString("utf8"));
    requests.push(body);
    if (embedding && request.url === "/v1/embeddings") {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object: "list", model: body.model,
        data: inputs.map((_, index) => ({
          object: "embedding", index,
          embedding: embeddingInvalid && index === 0 ? [0.25, Number.NaN] : [index + 0.25, index + 0.5, index + 0.75],
        })),
        usage: { prompt_tokens: inputs.length * 2, total_tokens: inputs.length * 2 },
      }));
      return;
    }
    if (translation && request.url === "/v1/chat/completions") {
      const source = JSON.parse(body.messages.at(-1).content);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "chatcmpl_translation", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
          source_language: source.source_language === "auto" ? "zh-CN" : source.source_language,
          [translationField]: source.segments.map((segment) => `Translated: ${segment}`),
        }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }));
      return;
    }
    if (ocr && (request.url === "/layout-parsing" || (hunyuanOcr && request.url === "/ocr"))) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        logId: "ocr-request-1", errorCode: 0, errorMsg: "Success",
        result: { layoutParsingResults: [{
          prunedResult: {
            width: 640, height: 480,
            parsing_res_list: [
              { block_id: 1, block_bbox: ocrInvalidBoundingBox ? null : [10, 20, 310, 58], block_label: "doc_title", block_format: "text", block_content: "团队 AI 盒子", block_score: 0.98, reading_order: 2 },
              { block_id: 2, block_bbox: [[10, 80], [410, 80], [410, 130], [10, 130]], block_label: "table", block_format: "html", block_content: "Encrypted OCR result", reading_order: 9, block_structure: { format: "otsl-v1.0", rows: 1, columns: 1, cells: [{ row: 0, column: 0, row_span: 1, column_span: 1, text: "Encrypted OCR result" }], html: "<table><tr><td>Encrypted OCR result</td></tr></table>" } },
            ],
          },
          markdown: { text: ocrText, images: null },
          outputImages: null,
        }] },
      }));
      return;
    }
    if (drawing && new Set(["/v1/images/generations", "/v1/images/edits"]).has(request.url)) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        created: 1,
        data: [{ b64_json: Buffer.from("real-image-bytes").toString("base64"), revised_prompt: null }],
        x_teamaibox: { seed: 42, steps: 8, guidance_scale: 5, strength: request.url.endsWith("edits") ? 0.7 : null, width: 512, height: 512, output_format: "png", preset_key: "drawing.fast.v1" },
      }));
      return;
    }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (toolCall) {
        response.write(`data: ${JSON.stringify({ id: "chatcmpl_worker_tool", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_write_1", type: "function", function: { name: "write", arguments: null } }] }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "chatcmpl_worker_tool", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '{"filePath":"/workspace/proof.txt","content":"ok"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.write(`data: ${JSON.stringify({ id: "chatcmpl_worker", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "队列" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "chatcmpl_worker", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "chatcmpl_sync", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "完成" }, finish_reason: "stop" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    paths,
    requestHeaders,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function translationWorker(origin) {
  return {
    workerOrigin: origin,
    modelAlias: "local/translation-default",
    servedModel: "qwen3.6-35b-a3b-nvfp4",
    profileId: "99999999-9999-4999-8999-999999999999",
    profileKey: "translation.qwen36-35b-a3b.nvfp4.spark.text-document-audio.v1",
    profileFingerprint: `sha256:${"1".repeat(64)}`,
    engineImageDigest: `sha256:${"2".repeat(64)}`,
  };
}

function embeddingWorker(origin) {
  return {
    workerOrigin: origin,
    modelAlias: "local/qwen3-embedding-0.6b",
    servedModel: "qwen3-embedding-0.6b",
    profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    profileKey: "embedding.qwen3-0.6b.bf16.spark-worker02.v1",
    profileFingerprint: `sha256:${"3".repeat(64)}`,
    engineImageDigest: `sha256:${"4".repeat(64)}`,
  };
}

function jobs() {
  const calls = [], failures = [], completions = [], cancellations = [];
  return {
    calls, failures, completions, cancellations,
    async executionInput(input) {
      calls.push(["executionInput", input]);
      return { job: { jobId: JOB, ownerIdentityId: OWNER, operation: "chat.completions", model: "local/qwen-nvfp4" }, request: { model: "local/qwen-nvfp4", messages: [{ role: "user", content: "测试" }] } };
    },
    async markPreparing(jobId, reason, route) { calls.push(["markPreparing", jobId, reason, route]); },
    async markRunning(jobId) { calls.push(["markRunning", jobId]); },
    async complete(jobId, value) { calls.push(["complete", jobId]); completions.push(value); return { jobId, ownerIdentityId: OWNER, status: "succeeded", result: value.result }; },
    async fail(jobId, value) { failures.push([jobId, value]); return { jobId, status: "failed" }; },
    async acknowledgeCancellation(jobId) { calls.push(["acknowledgeCancellation", jobId]); cancellations.push(jobId); return { jobId, ownerIdentityId: OWNER, status: "cancelled" }; },
  };
}

test("background execution strips stream-only options without changing the saved request", async (context) => {
  const upstream = await worker();
  context.after(() => upstream.close());
  const service = jobs();
  const original = service.executionInput.bind(service);
  let saved;
  service.executionInput = async (input) => {
    const value = await original(input);
    value.request.stream = true;
    value.request.stream_options = { include_usage: true };
    value.request.tools = [{ type: "function", function: { name: "write", parameters: { type: "object", properties: {} } } }];
    value.request.tool_choice = "auto";
    saved = value.request;
    return value;
  };
  const bridge = new OpenAiWorkerExecutionBridge({ jobService: service, workerOrigin: upstream.origin, modelAlias: "local/qwen-nvfp4", servedModel: "qwen-test" });
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(upstream.requests[0].stream, false);
  assert.equal(Object.hasOwn(upstream.requests[0], "stream_options"), false);
  assert.deepEqual(upstream.requests[0].tools, saved.tools);
  assert.equal(upstream.requests[0].tool_choice, "auto");
  assert.equal(saved.stream, true);
  assert.deepEqual(saved.stream_options, { include_usage: true });
});

test("streams a queued chat through the pinned worker and durably completes the aliased result", async (context) => {
  const upstream = await worker();
  context.after(() => upstream.close());
  const service = jobs();
  const bridge = new OpenAiWorkerExecutionBridge({ jobService: service, workerOrigin: upstream.origin, modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4" });
  const events = [];
  for await (const event of await bridge.streamResult({ jobId: JOB, ownerIdentityId: OWNER })) events.push(event);
  assert.deepEqual(service.calls.map((item) => item[0]), ["executionInput", "markPreparing", "markRunning", "complete"]);
  assert.equal(service.calls[1][3], "local");
  assert.equal(upstream.requests[0].model, "qwen3.6-35b-a3b-nvfp4");
  assert.deepEqual(upstream.requests[0].chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(upstream.requests[0].stream_options, { include_usage: true });
  assert.equal("x_teamaibox" in upstream.requests[0], false);
  assert.equal(events.every((item) => item.data.model === "local/qwen-nvfp4"), true);
  assert.equal(service.completions[0].result.choices[0].message.content, "队列完成");
  assert.equal(service.completions[0].result.model, "local/qwen-nvfp4");
  assert.equal(service.failures.length, 0);
});

test("an external-first queued chat streams through the selected Provider route", async (context) => {
  const providerRequestId = `chatcmpl_${"external".repeat(100)}`;
  const local = await worker();
  context.after(() => local.close());
  const service = jobs();
  const requests = [];
  const route = {
    routeKind: "external_provider",
    provider: { providerId: "33333333-3333-4333-8333-333333333333",
      executionContract: { idempotencyMode: "none", replayAfterAcceptance: "prohibited",
        reconcileMode: "none", cancellationMode: "none", sideEffectClass: "none" } },
    mapping: { modelProfileId: "44444444-4444-4444-8444-444444444444",
      providerModelName: "gemma4-31b-redhat-nvfp4-mtp4-64k-cohost-c2" },
  };
  service.executionInput = async (input) => {
    service.calls.push(["executionInput", input]);
    return { job: { jobId: JOB, ownerIdentityId: OWNER,
      capabilityId: "55555555-5555-4555-8555-555555555555", operation: "chat.completions",
      model: "local/qwen-nvfp4", dataClass: "internal", requestDigest: `sha256:${"a".repeat(64)}` },
    request: { model: "local/qwen-nvfp4", messages: [{ role: "user", content: "测试" }] } };
  };
  const attemptCalls = [];
  const externalAttemptRepository = {
    async begin(input) { attemptCalls.push(["begin", input]); return { attemptId: input.attemptId }; },
    async markAccepted(attemptId, input) { attemptCalls.push(["accepted", attemptId, input]); },
    async observeOutput(attemptId, input) { attemptCalls.push(["output", attemptId, input]); },
  };
  const externalProviderRouter = {
    async resolve(input) { requests.push(["resolve", input]); return { selected: route }; },
    async probe(selected) { requests.push(["probe", selected]); return true; },
    async request() { throw new Error("streaming chat must not use the buffered Provider transport"); },
    async stream(selected, input) {
      requests.push(["stream", selected, input]);
      const first = { id: providerRequestId, object: "chat.completion.chunk", created: 1, model: input.body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "副盒" }, finish_reason: null }] };
      const last = { id: providerRequestId, object: "chat.completion.chunk", created: 1, model: input.body.model,
        choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
      return { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" },
        body: Readable.from([Buffer.from(`data: ${JSON.stringify(first)}\n\n`),
          Buffer.from(`data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`)]) };
    },
  };
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: local.origin, modelAlias: "local/qwen-nvfp4",
    servedModel: "qwen3.6-35b-a3b-nvfp4", externalProviderRouter, externalAttemptRepository,
  });
  const events = [];
  for await (const event of await bridge.streamResult({ jobId: JOB, ownerIdentityId: OWNER })) events.push(event);
  assert.equal(requests.find((item) => item[0] === "resolve")[1].localAvailable, true);
  assert.equal(requests.find((item) => item[0] === "stream")[2].body.model, route.mapping.providerModelName);
  assert.equal(service.calls.find((item) => item[0] === "markPreparing")[3], "external_provider");
  assert.equal(service.calls.some((item) => item[0] === "markRunning"), false);
  assert.equal(attemptCalls.filter((item) => item[0] === "begin").length, 1);
  assert.equal(attemptCalls.filter((item) => item[0] === "accepted").length, 1);
  assert.equal(attemptCalls.filter((item) => item[0] === "output").length, 2);
  assert.equal(attemptCalls[0][1].modelProfileId, route.mapping.modelProfileId);
  assert.equal(attemptCalls[1][2].providerRequestId, providerRequestId);
  assert.equal(events.map((item) => item.data.choices[0].delta.content ?? "").join(""), "副盒完成");
  assert.equal(events.every((item) => item.data.model === "local/qwen-nvfp4"), true);
  assert.equal(service.completions[0].result.choices[0].message.content, "副盒完成");
  assert.equal(service.failures.length, 0);
});

test("a synchronous queued chat also persists the result and hides the served model name", async (context) => {
  const upstream = await worker();
  context.after(() => upstream.close());
  const service = jobs();
  const bridge = new OpenAiWorkerExecutionBridge({ jobService: service, workerOrigin: upstream.origin, modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4" });
  const result = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(result.status, "succeeded");
  assert.equal(service.completions[0].result.model, "local/qwen-nvfp4");
  assert.equal(upstream.requests[0].stream, false);
});

test("a streamed tool-only turn remains a successful durable queue result", async (context) => {
  const upstream = await worker({ toolCall: true });
  context.after(() => upstream.close());
  const service = jobs();
  const bridge = new OpenAiWorkerExecutionBridge({ jobService: service, workerOrigin: upstream.origin, modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4" });
  const events = [];
  for await (const event of await bridge.streamResult({ jobId: JOB, ownerIdentityId: OWNER })) events.push(event);
  assert.equal(events.some((event) => event.data.choices[0].delta.tool_calls?.length), true);
  assert.equal(service.failures.length, 0);
  assert.equal(service.completions.length, 1);
  const choice = service.completions[0].result.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, null);
  assert.deepEqual(choice.message.tool_calls, [{
    id: "call_write_1",
    type: "function",
    function: { name: "write", arguments: '{"filePath":"/workspace/proof.txt","content":"ok"}' },
  }]);
});

test("an unavailable worker records a retryable terminal queue fact", async () => {
  const service = jobs();
  const bridge = new OpenAiWorkerExecutionBridge({ jobService: service, workerOrigin: "http://127.0.0.1:9", modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4" });
  await assert.rejects(bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER }), { code: "compute_worker_unavailable" });
  assert.equal(service.failures.length, 1);
  assert.equal(service.failures[0][1].retryClassification, "retryable");
});

test("a queued embedding batch uses the profiled worker and persists finite consistent vectors", async (context) => {
  const upstream = await worker({ embedding: true });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async (input) => {
    service.calls.push(["executionInput", input]);
    return {
      job: { jobId: JOB, ownerIdentityId: OWNER, operation: "embeddings", model: "local/qwen3-embedding-0.6b" },
      request: { model: "local/qwen3-embedding-0.6b", input: ["one", "two"], dimensions: 2 },
    };
  };
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    embeddingWorker: embeddingWorker(upstream.origin),
  });
  const completed = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(completed.status, "succeeded");
  assert.equal(upstream.requests[0].model, "qwen3-embedding-0.6b");
  assert.equal(service.calls.find((call) => call[0] === "markPreparing")[3], "local");
  assert.equal(service.completions[0].result.model, "local/qwen3-embedding-0.6b");
  assert.equal(service.completions[0].result.data.length, 2);
  assert.equal(service.completions[0].result.x_teamaibox.dimensions, 2);
  assert.equal(service.completions[0].result.x_teamaibox.source_dimensions, 3);
  assert.equal(service.completions[0].result.data[0].embedding.length, 2);
  assert.ok(Math.abs(Math.hypot(...service.completions[0].result.data[0].embedding) - 1) < 1e-6);
  assert.equal(service.completions[0].result.x_teamaibox.profile_key, "embedding.qwen3-0.6b.bf16.spark-worker02.v1");
  assert.equal(bridge.canDispatch({ operation: "embeddings", requestedModel: "local/qwen3-embedding-0.6b" }), true);
});

test("an embedding worker with a non-finite vector fails closed", async (context) => {
  const upstream = await worker({ embedding: true, embeddingInvalid: true });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "embeddings", model: "local/qwen3-embedding-0.6b" },
    request: { model: "local/qwen3-embedding-0.6b", input: "one" },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    embeddingWorker: embeddingWorker(upstream.origin),
  });
  await assert.rejects(bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER }), { code: "compute_worker_invalid" });
  assert.equal(service.failures.length, 1);
});

test("embedding base64 output encodes the projected Float32 vector without retaining worker aliases", async (context) => {
  const upstream = await worker({ embedding: true });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "embeddings", model: "local/qwen3-embedding-0.6b" },
    request: { model: "local/qwen3-embedding-0.6b", input: "one", dimensions: 2, encoding_format: "base64" },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    embeddingWorker: embeddingWorker(upstream.origin),
  });
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  const encoded = service.completions[0].result.data[0].embedding;
  assert.equal(typeof encoded, "string");
  assert.equal(Buffer.from(encoded, "base64").byteLength, 8);
  assert.equal(service.completions[0].result.x_teamaibox.encoding_format, "base64");
});

test("a queued drawing job stores worker image bytes only in protected encrypted objects", async (context) => {
  const upstream = await worker({ drawing: true });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async (input) => {
    service.calls.push(["executionInput", input]);
    return {
      job: { jobId: JOB, ownerIdentityId: OWNER, operation: "images.generations", model: "local/drawing-default", requestDigest: `sha256:${"a".repeat(64)}` },
      request: { model: "local/drawing-default", prompt: "a tiny robot", n: 1, size: "512x512", x_teamaibox: { extensions: { drawing: { seed: 42, steps: 8, guidance_scale: 5, output_format: "png", preset_key: "drawing.fast.v1" } } } },
    };
  };
  const stored = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service,
    workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4",
    servedModel: "qwen3.6-35b-a3b-nvfp4",
    drawingWorker: {
      workerOrigin: upstream.origin,
      modelAlias: "local/drawing-default",
      servedModel: "sdxl-base-1.0-fp16",
      profileId: "33333333-3333-4333-8333-333333333333",
      profileKey: "drawing.sdxl-base-1.0.fp16.spark.v1",
      profileFingerprint: `sha256:${"b".repeat(64)}`,
      engineImageDigest: `sha256:${"c".repeat(64)}`,
    },
    objectGateway: {
      async storeOutput(input) {
        stored.push({ ...input, content: Buffer.from(input.content) });
        return { objectId: "44444444-4444-4444-8444-444444444444", version: 1, size: input.content.byteLength };
      },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-12T00:15:00.000Z" }; },
      async download() { throw new Error("drawing generation must not download an input"); },
    },
  });
  const result = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(result.status, "succeeded");
  assert.equal(upstream.requests[0].model, "sdxl-base-1.0-fp16");
  assert.equal(stored[0].content.toString(), "real-image-bytes");
  assert.equal(stored[0].content.includes(Buffer.from("a tiny robot")), false);
  assert.equal(service.calls.find((call) => call[0] === "markPreparing")[3], "managed_node");
  const completion = service.completions[0];
  assert.equal(completion.result.schema, "teamaibox.ai.image-result.v1");
  assert.equal(completion.result.outputs[0].encrypted, true);
  assert.equal(completion.result.outputs[0].preview_path, "/api/v1/objects/references/55555555-5555-4555-8555-555555555555/content");
  assert.equal(completion.result.provenance.profile_key, "drawing.sdxl-base-1.0.fp16.spark.v1");
});

test("a protected local chat creates its exact durable attempt before worker execution", async (context) => {
  const upstream = await worker();
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async (input) => {
    service.calls.push(["executionInput", input]);
    return { job: { jobId: JOB, ownerIdentityId: OWNER, status: "queued",
      operation: "chat.completions", model: "local/qwen-nvfp4" },
    request: { model: "local/qwen-nvfp4", messages: [{ role: "user", content: "测试" }] } };
  };
  const attempts = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin, modelAlias: "local/qwen-nvfp4",
    servedModel: "qwen3.6-35b-a3b-nvfp4",
    workerId: "33333333-3333-4333-8333-333333333333",
    profileId: "44444444-4444-4444-8444-444444444444",
    localAttemptRepository: { async begin(input) { attempts.push(input); return { admitted: true, attemptId: input.attemptId }; } },
  });
  const completed = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(completed.status, "succeeded");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].workerId, "33333333-3333-4333-8333-333333333333");
  assert.equal(attempts[0].modelProfileId, "44444444-4444-4444-8444-444444444444");
  assert.equal(attempts[0].route, "local");
  assert.equal(service.calls.some((call) => call[0] === "markRunning"), false);
  assert.equal(upstream.requests.length, 1);
});

test("a busy protected local worker leaves the queued job retryable without recording a false failure", async (context) => {
  const upstream = await worker();
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, status: "queued",
      operation: "chat.completions", model: "local/qwen-nvfp4" },
    request: { model: "local/qwen-nvfp4", messages: [{ role: "user", content: "测试" }] },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin, modelAlias: "local/qwen-nvfp4",
    servedModel: "qwen3.6-35b-a3b-nvfp4",
    workerId: "33333333-3333-4333-8333-333333333333",
    profileId: "44444444-4444-4444-8444-444444444444",
    localAttemptRepository: { async begin() { return { admitted: false, reason: "protected_worker_busy" }; } },
  });
  await assert.rejects(bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER }), {
    code: "compute_local_worker_busy", retryable: true,
  });
  assert.equal(service.failures.length, 0);
  assert.equal(upstream.requests.length, 0);
});

test("drawing automatic alias authenticates health, prepare, and generation against the protected worker", async (context) => {
  const upstream = await worker({ drawing: true });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "images.generations", model: "drawing.automatic",
      profileId: MAIN_DRAWING_PROFILE },
    request: { model: "drawing.automatic", prompt: "office diagram", n: 1, size: "512x512",
      x_teamaibox: { routing_authorization: ordinaryDrawingAuthorization() } },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    drawingWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/drawing-default",
      acceptedModelAliases: ["local/drawing-default", "drawing.automatic", "drawing.fast"],
      servedModel: "flux2-klein-4b-bf16", profileId: MAIN_DRAWING_PROFILE,
      profileKey: MAIN_DRAWING_PROFILE_KEY,
      profileFingerprint: `sha256:${"b".repeat(64)}`, engineImageDigest: `sha256:${"c".repeat(64)}`,
      bearerToken: Buffer.from("protected-drawing-token"),
    },
    objectGateway: {
      async storeOutput(input) { return { objectId: "44444444-4444-4444-8444-444444444444", version: 1, size: input.content.byteLength }; },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555" }; },
      async download() { throw new Error("generation must not download"); },
    },
  });
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(bridge.canDispatch({ operation: "images.generations", requestedModel: "drawing.automatic",
    requestedModelProfileId: MAIN_DRAWING_PROFILE }), true);
  assert.equal(bridge.canDispatch({ operation: "images.generations", requestedModel: "drawing.automatic" }), false);
  const protectedPaths = ["/health", "/v1/models/prepare", "/v1/images/generations"];
  for (const path of protectedPaths) {
    const index = upstream.paths.indexOf(path);
    assert.notEqual(index, -1);
    assert.equal(upstream.requestHeaders[index].authorization, "Bearer protected-drawing-token");
    if (path !== "/health") assert.equal(upstream.requestHeaders[index]["x-teamaibox-owner"], OWNER);
  }
  bridge.close();
});

test("ordinary drawing aliases fail closed unless they bind the complete protected main-box profile", async (context) => {
  const upstream = await worker({ drawing: true });
  context.after(() => upstream.close());
  const base = {
    jobService: jobs(), workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    drawingWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/drawing-default",
      acceptedModelAliases: ["local/drawing-default", "drawing.automatic", "drawing.fast"],
      servedModel: "flux2-klein-4b-bf16", profileId: MAIN_DRAWING_PROFILE,
      profileKey: MAIN_DRAWING_PROFILE_KEY,
      profileFingerprint: `sha256:${"b".repeat(64)}`, engineImageDigest: `sha256:${"c".repeat(64)}`,
    },
  };
  const successor = new OpenAiWorkerExecutionBridge({
    ...base,
    objectGateway: { async storeOutput() {}, async issue() {}, async download() {} },
    drawingWorker: { ...base.drawingWorker, profileId: "33333333-3333-4333-8333-333333333333",
      profileKey: "drawing.flux2-klein-4b.bf16.main-protected.successor" },
  });
  assert.equal(successor.canDispatch({ operation: "images.generations", requestedModel: "drawing.automatic",
    requestedModelProfileId: "33333333-3333-4333-8333-333333333333" }), true);
  assert.equal(successor.canDispatch({ operation: "images.generations", requestedModel: "drawing.automatic",
    requestedModelProfileId: MAIN_DRAWING_PROFILE }), false);
  successor.close();
  assert.throws(() => new OpenAiWorkerExecutionBridge({
    ...base,
    drawingWorker: { ...base.drawingWorker, acceptedModelAliases: ["local/drawing-default", "drawing.automatic"] },
  }), /configured protected main-box FLUX profile/);
  assert.throws(() => new OpenAiWorkerExecutionBridge({
    ...base,
    drawingWorker: { ...base.drawingWorker, profileKey: "drawing.flux2-klein-4b.bf16.untrusted.v1" },
  }), /configured protected main-box FLUX profile/);
});

test("ordinary drawing execution rejects a durable task whose server authorization tuple was tampered", async (context) => {
  const upstream = await worker({ drawing: true });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "images.generations", model: "drawing.fast",
      profileId: MAIN_DRAWING_PROFILE },
    request: { model: "drawing.fast", prompt: "office diagram", n: 1, size: "512x512",
      x_teamaibox: { routing_authorization: {
        ...ordinaryDrawingAuthorization("drawing.fast"),
        model_profile_id: "33333333-3333-4333-8333-333333333333",
      } } },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    objectGateway: {
      async storeOutput() { throw new Error("tampered route must not store output"); },
      async issue() { throw new Error("tampered route must not issue output"); },
      async download() { throw new Error("tampered generation must not read input"); },
    },
    drawingWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/drawing-default",
      acceptedModelAliases: ["local/drawing-default", "drawing.automatic", "drawing.fast"],
      servedModel: "flux2-klein-4b-bf16", profileId: MAIN_DRAWING_PROFILE,
      profileKey: MAIN_DRAWING_PROFILE_KEY,
      profileFingerprint: `sha256:${"b".repeat(64)}`, engineImageDigest: `sha256:${"c".repeat(64)}`,
    },
  });
  await assert.rejects(bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER }), {
    code: "compute_route_unavailable",
  });
  assert.equal(upstream.paths.includes("/v1/images/generations"), false);
  bridge.close();
});

test("a queued drawing job can use an external Provider without a configured local drawing Worker", async (context) => {
  const local = await worker();
  context.after(() => local.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, capabilityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operation: "images.generations", model: "local/drawing-default", dataClass: "internal",
      requestDigest: `sha256:${"a".repeat(64)}` },
    request: { model: "local/drawing-default", prompt: "a provider robot", n: 1, size: "512x512",
      x_teamaibox: { extensions: { drawing: { seed: 42, steps: 8, guidance_scale: 5,
        output_format: "png", preset_key: "drawing.provider.v1" } } } },
  });
  const route = {
    provider: { providerId: "33333333-3333-4333-8333-333333333333" },
    mapping: { modelProfileId: "77777777-7777-4777-8777-777777777777", providerModelName: "sdxl-base-1.0-fp16" },
    profile: { profileId: "77777777-7777-4777-8777-777777777777", fingerprint: `sha256:${"b".repeat(64)}`,
      document: { profileKey: "drawing.sdxl.fp16.spark23.provider.v1", engine: { imageDigest: `sha256:${"c".repeat(64)}` } } },
  };
  const providerCalls = [];
  const externalProviderRouter = {
    async resolve(input) { providerCalls.push(["resolve", input]); return { selected: route }; },
    async probe(selected) { providerCalls.push(["probe", selected]); return true; },
    async stream() { throw new Error("drawing must not stream"); },
    async request(selected, input) {
      providerCalls.push(["request", selected, input]);
      return { status: 200, body: { created: 1,
        data: [{ b64_json: Buffer.from("external-image-bytes").toString("base64"), revised_prompt: null }],
        x_teamaibox: { seed: 42, steps: 8, guidance_scale: 5, strength: null, width: 512, height: 512,
          output_format: "png", preset_key: "drawing.provider.v1" } } };
    },
  };
  const stored = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: local.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4", externalProviderRouter,
    objectGateway: {
      async download() { throw new Error("generation must not read an input"); },
      async storeOutput(input) { stored.push(Buffer.from(input.content)); return {
        objectId: "44444444-4444-4444-8444-444444444444", version: 1, size: input.content.byteLength }; },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555" }; },
    },
  });
  assert.equal(bridge.canDispatch({ operation: "images.generations", requestedModel: "local/drawing-default" }), true);
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  const request = providerCalls.find((call) => call[0] === "request")[2];
  assert.equal(request.path, "/images/generations");
  assert.equal(request.body.model, "sdxl-base-1.0-fp16");
  assert.equal(request.body.x_teamaibox.job_id, JOB);
  assert.equal(stored[0].toString(), "external-image-bytes");
  assert.equal(service.calls.find((call) => call[0] === "markPreparing")[3], "external_provider");
  assert.equal(service.completions[0].result.provenance.profile_key, route.profile.document.profileKey);
  assert.equal(service.completions[0].result.provenance.route, "external_provider");
});

test("a resource-controlled managed drawing model prepares, preserves its route, and releases after completion", async (context) => {
  const local = await worker();
  context.after(() => local.close());
  const service = jobs();
  const sequence = [];
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, capabilityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operation: "images.generations", model: "local/drawing-default", dataClass: "internal",
      requestDigest: `sha256:${"a".repeat(64)}` },
    request: { model: "local/drawing-default", prompt: "a residency controlled robot", n: 1, size: "512x512",
      x_teamaibox: { extensions: { drawing: { seed: 42, steps: 4, guidance_scale: 5,
        output_format: "png", preset_key: "drawing.residency.v1" } } } },
  });
  service.markPreparing = async (...input) => { sequence.push("preparing"); service.calls.push(["markPreparing", ...input]); };
  service.markRunning = async (...input) => { sequence.push("running"); service.calls.push(["markRunning", ...input]); };
  service.complete = async (jobId, value) => {
    sequence.push("completed"); service.completions.push(value);
    return { jobId, ownerIdentityId: OWNER, status: "succeeded", result: value.result };
  };
  const route = {
    provider: { providerId: "33333333-3333-4333-8333-333333333333",
      providerKind: "managed_node",
      resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
        statusPath: "/models/status", idleSeconds: 180 } },
    mapping: { modelProfileId: "77777777-7777-4777-8777-777777777777", providerModelName: "sdxl-base-1.0-fp16" },
    profile: { profileId: "77777777-7777-4777-8777-777777777777", fingerprint: `sha256:${"b".repeat(64)}`,
      document: { profileKey: "drawing.sdxl.fp16.spark23.provider.v1", engine: { imageDigest: `sha256:${"c".repeat(64)}` } } },
  };
  const externalProviderRouter = {
    async resolve() { return { selected: route }; },
    async probe() { return true; },
    async prepareModel(selected) { assert.equal(selected, route); sequence.push("prepared"); return { controlled: true, loaded: true, warmReuse: false }; },
    releaseModel(selected) { assert.equal(selected, route); sequence.push("released"); return { controlled: true, scheduled: true }; },
    async stream() { throw new Error("drawing must not stream"); },
    async request(_selected, input) {
      sequence.push("executed");
      assert.equal(input.path, "/images/generations");
      return { status: 200, body: { created: 1,
        data: [{ b64_json: Buffer.from("resource-controlled-image").toString("base64"), revised_prompt: null }],
        x_teamaibox: { seed: 42, steps: 4, guidance_scale: 5, strength: null, width: 512, height: 512,
          output_format: "png", preset_key: "drawing.residency.v1" } } };
    },
  };
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: local.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4", externalProviderRouter,
    objectGateway: {
      async download() { throw new Error("generation must not read an input"); },
      async storeOutput(input) { return { objectId: "44444444-4444-4444-8444-444444444444", version: 1, size: input.content.byteLength }; },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555" }; },
    },
  });
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.deepEqual(sequence, ["preparing", "prepared", "running", "executed", "completed", "released"]);
  assert.equal(service.completions[0].result.provenance.route, "managed_node");
});

test("a failed external drawing prepare remains retryable and never dispatches image execution", async (context) => {
  const local = await worker();
  context.after(() => local.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, capabilityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operation: "images.generations", model: "local/drawing-default", dataClass: "internal",
      requestDigest: `sha256:${"a".repeat(64)}` },
    request: { model: "local/drawing-default", prompt: "prepare failure", n: 1, size: "512x512" },
  });
  let executed = false, released = false;
  const route = {
    provider: { providerId: "33333333-3333-4333-8333-333333333333",
      resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
        statusPath: "/models/status", idleSeconds: 180 } },
    mapping: { modelProfileId: "77777777-7777-4777-8777-777777777777", providerModelName: "sdxl-base-1.0-fp16" },
    profile: { profileId: "77777777-7777-4777-8777-777777777777", fingerprint: `sha256:${"b".repeat(64)}`,
      document: { profileKey: "drawing.sdxl.fp16.spark23.provider.v1", engine: { imageDigest: `sha256:${"c".repeat(64)}` } } },
  };
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: local.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    externalProviderRouter: {
      async resolve() { return { selected: route }; }, async probe() { return true; },
      async prepareModel() { const error = new Error("bounded load failure"); error.code = "provider_model_prepare_failed"; throw error; },
      releaseModel() { released = true; }, async stream() {},
      async request() { executed = true; return { status: 500, body: {} }; },
    },
    objectGateway: { async download() {}, async storeOutput() {}, async issue() {} },
  });
  await assert.rejects(bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER }), { code: "compute_worker_unavailable", retryable: true });
  assert.equal(executed, false);
  assert.equal(released, false);
  assert.equal(service.failures[0][1].retryClassification, "retryable");
});

test("a running external drawing cancellation is acknowledged only after the Provider confirms it", async (context) => {
  const local = await worker();
  context.after(() => local.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, capabilityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operation: "images.generations", model: "local/drawing-default", dataClass: "internal",
      requestDigest: `sha256:${"a".repeat(64)}` },
    request: { model: "local/drawing-default", prompt: "cancel this running drawing", n: 1, size: "512x512",
      x_teamaibox: { extensions: { drawing: { seed: 42, steps: 80, guidance_scale: 5,
        output_format: "png", preset_key: "drawing.cancel.v1" } } } },
  });
  const route = {
    provider: { providerId: "33333333-3333-4333-8333-333333333333" },
    mapping: { modelProfileId: "77777777-7777-4777-8777-777777777777", providerModelName: "sdxl-base-1.0-fp16" },
    profile: { profileId: "77777777-7777-4777-8777-777777777777", fingerprint: `sha256:${"b".repeat(64)}`,
      document: { profileKey: "drawing.sdxl.fp16.spark23.provider.v1", engine: { imageDigest: `sha256:${"c".repeat(64)}` } } },
  };
  const calls = [];
  const externalProviderRouter = {
    async resolve() { return { selected: route }; }, async probe() { return true; }, async stream() {},
    async request(_selected, input) {
      calls.push(input.path);
      if (input.path.endsWith("/cancel")) return { status: 200, body: { cancelled: true, job_id: JOB } };
      return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => {
        const error = new Error("drawing request aborted after confirmed cancellation"); error.name = "AbortError"; reject(error);
      }, { once: true }));
    },
  };
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: local.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4", externalProviderRouter,
    objectGateway: { async download() {}, async storeOutput() { throw new Error("cancelled output must not be stored"); }, async issue() {} },
  });
  const execution = bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  while (!calls.includes("/images/generations")) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await bridge.cancel(JOB), true);
  await assert.rejects(execution, { name: "AbortError" });
  assert.deepEqual(calls, ["/images/generations", `/images/generations/${JOB}/cancel`]);
  assert.deepEqual(service.cancellations, [JOB]);
  assert.equal(service.completions.length, 0);
  assert.equal(service.failures.length, 0);
});

test("an unconfirmed external drawing cancellation keeps the active request authoritative", async (context) => {
  const local = await worker();
  context.after(() => local.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, capabilityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operation: "images.generations", model: "local/drawing-default", dataClass: "internal",
      requestDigest: `sha256:${"a".repeat(64)}` },
    request: { model: "local/drawing-default", prompt: "finish if cancellation is not confirmed", n: 1, size: "512x512" },
  });
  const route = {
    provider: { providerId: "33333333-3333-4333-8333-333333333333" },
    mapping: { modelProfileId: "77777777-7777-4777-8777-777777777777", providerModelName: "sdxl-base-1.0-fp16" },
    profile: { profileId: "77777777-7777-4777-8777-777777777777", fingerprint: `sha256:${"b".repeat(64)}`,
      document: { profileKey: "drawing.sdxl.fp16.spark23.provider.v1", engine: { imageDigest: `sha256:${"c".repeat(64)}` } } },
  };
  let finish;
  const response = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: local.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    externalProviderRouter: {
      async resolve() { return { selected: route }; }, async probe() { return true; }, async stream() {},
      async request(_selected, input) {
        calls.push(input.path);
        if (input.path.endsWith("/cancel")) return { status: 200, body: { cancelled: false, job_id: JOB } };
        return response;
      },
    },
    objectGateway: {
      async download() {}, async storeOutput(input) { return { objectId: "44444444-4444-4444-8444-444444444444", version: 1, size: input.content.byteLength }; },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555" }; },
    },
  });
  const execution = bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  while (!calls.includes("/images/generations")) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await bridge.cancel(JOB), false);
  finish({ status: 200, body: { data: [{ b64_json: Buffer.from("completed-image").toString("base64") }],
    x_teamaibox: { seed: 0, steps: 8, guidance_scale: 5, strength: null, width: 512, height: 512,
      output_format: "png", preset_key: "drawing.provider.v1" } } });
  assert.equal((await execution).status, "succeeded");
  assert.deepEqual(service.cancellations, []);
  assert.equal(service.completions.length, 1);
});

test("a queued drawing edit decrypts only scoped inputs and preserves source lineage", async (context) => {
  const upstream = await worker({ drawing: true });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "images.edits", model: "local/drawing-default", requestDigest: `sha256:${"d".repeat(64)}` },
    request: {
      model: "local/drawing-default", prompt: "make it dusk", count: 1, size: "512x512",
      input: { referenceId: sourceReferenceId }, mask: null, seed: 42, steps: 8,
      guidanceScale: 5, strength: 0.7, outputFormat: "png", presetKey: "drawing.fast.v1",
    },
  });
  const downloads = [];
  const sourceBytes = Buffer.from("protected-source-image");
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    drawingWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/drawing-default", servedModel: "sdxl-base-1.0-fp16",
      profileId: "33333333-3333-4333-8333-333333333333", profileKey: "drawing.sdxl-base-1.0.fp16.spark.v1",
      profileFingerprint: `sha256:${"b".repeat(64)}`, engineImageDigest: `sha256:${"c".repeat(64)}`,
    },
    objectGateway: {
      async download(input) { downloads.push(input); return { content: Buffer.from(sourceBytes) }; },
      async storeOutput(input) { return { objectId: "44444444-4444-4444-8444-444444444444", version: 1, size: input.content.byteLength }; },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-12T00:15:00.000Z" }; },
    },
  });
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.deepEqual(downloads, [{ actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:image" }]);
  assert.equal(upstream.requests[0].image_b64, sourceBytes.toString("base64"));
  assert.equal(service.completions[0].result.reproducibility.strength, 0.7);
  assert.equal(service.completions[0].result.provenance.source_reference_id, sourceReferenceId);
});

test("a queued OCR job uses a scoped input and stores a typed encrypted layout result", async (context) => {
  const upstream = await worker({ ocr: true });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: {
      jobId: JOB, ownerIdentityId: OWNER, operation: "ocr", model: "local/ocr-default",
      dataClass: "confidential", requestDigest: `sha256:${"d".repeat(64)}`,
    },
    request: {
      model: "local/ocr-default", input: { referenceId: sourceReferenceId },
      outputFormat: "markdown", languageHints: ["zh-CN", "en"],
    },
  });
  const stored = [];
  const sourceBytes = Buffer.from("real-protected-png");
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    ocrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/ocr-default", servedModel: "PaddleOCR-VL-1.5",
      profileId: "77777777-7777-4777-8777-777777777777", profileKey: "ocr.paddleocr-vl-1.5.bf16.spark.v1",
      profileFingerprint: `sha256:${"e".repeat(64)}`, engineImageDigest: `sha256:${"f".repeat(64)}`,
    },
    objectGateway: {
      async download(input) {
        assert.deepEqual(input, { actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:ocr" });
        return { metadata: { contentType: "image/png" }, content: Buffer.from(sourceBytes) };
      },
      async storeOutput(input) {
        stored.push({ ...input, content: Buffer.from(input.content) });
        return { objectId: "44444444-4444-4444-8444-444444444444", version: 2, size: input.content.byteLength };
      },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-13T00:15:00.000Z" }; },
    },
  });
  assert.equal(bridge.canDispatch({ operation: "ocr", requestedModel: "local/ocr-default" }), true);
  const result = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(upstream.requests[0], { file: sourceBytes.toString("base64"), fileType: 1 });
  assert.equal(stored[0].content.toString(), "# 团队 AI 盒子\n\nEncrypted OCR result");
  const completion = service.completions[0];
  assert.equal(completion.resultSchema, "teamaibox.ai.ocr-result.v1");
  assert.equal(completion.result.pages[0].blocks[0].confidence, 0.98);
  assert.equal(completion.result.pages[0].blocks[0].block_type, "doc_title");
  assert.equal(completion.result.pages[0].blocks[0].content_format, "text");
  assert.equal(completion.result.pages[0].blocks[0].reading_order, 2);
  assert.equal(completion.result.pages[0].blocks[1].confidence, null);
  assert.equal(completion.result.pages[0].blocks[1].block_type, "table");
  assert.equal(completion.result.pages[0].blocks[1].content_format, "html");
  assert.equal(completion.result.pages[0].blocks[1].structure.format, "otsl-v1.0");
  assert.equal(completion.result.pages[0].blocks[1].structure.cells[0].text, "Encrypted OCR result");
  assert.deepEqual(completion.result.pages[0].blocks[1].bounding_box, [10, 80, 410, 80, 410, 130, 10, 130]);
  assert.equal(completion.result.artifacts[0].extensions.encrypted, true);
  assert.equal(completion.result.artifacts[0].dataClass, "confidential");
  assert.equal(completion.result.extensions.provenance.profile_key, "ocr.paddleocr-vl-1.5.bf16.spark.v1");
  assert.equal(completion.result.extensions.provenance.source_reference_id, sourceReferenceId);
  assert.equal(service.calls.find((call) => call[0] === "markPreparing")[2], "ocr_pipeline_preparing");
});

test("OCR preserves text beyond the former 32 MiB product ceiling", async (context) => {
  // This is a protocol-size regression, not a test of the developer machine's
  // fluctuating free memory. Linux acceptance runs in an isolated 2 GiB cgroup;
  // other hosts use explicit test telemetry. Production admission is unchanged.
  if (process.platform !== "linux") context.mock.method(process, "availableMemory", () => 2 * 1024 ** 3);
  const text = "a".repeat(33 * 1024 * 1024);
  const upstream = await worker({ ocr: true, ocrText: text });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "ocr", model: "local/ocr-default", dataClass: "internal" },
    request: { input: { referenceId: "66666666-6666-4666-8666-666666666666" }, outputFormat: "markdown", languageHints: [] },
  });
  let storedBytes = 0;
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/test-model", servedModel: "test-model",
    ocrWorker: { workerOrigin: upstream.origin, modelAlias: "local/ocr-default", servedModel: "hunyuan-ocr",
      profileId: "77777777-7777-4777-8777-777777777777", profileKey: "ocr.test.resource.v1",
      profileFingerprint: `sha256:${"e".repeat(64)}`, engineImageDigest: `sha256:${"f".repeat(64)}` },
    objectGateway: {
      async download() { return { metadata: { contentType: "image/png" }, content: Buffer.from("test-image") }; },
      async storeOutput(input) {
        storedBytes = input.content.length;
        assert.equal(input.content.toString(), text);
        return { objectId: "44444444-4444-4444-8444-444444444444", version: 1, size: storedBytes };
      },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-09-16T10:15:00.000Z" }; },
    },
  });
  assert.equal((await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER })).status, "succeeded");
  assert.equal(storedBytes, text.length);
  assert.equal(service.completions[0].result.text, text);
});

test("a queued HunyuanOCR job uses the managed native protocol and immutable profile model", async (context) => {
  const upstream = await worker({ ocr: true, hunyuanOcr: true });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: {
      jobId: JOB, ownerIdentityId: OWNER, operation: "ocr", model: "local/ocr-default",
      dataClass: "confidential", requestDigest: `sha256:${"d".repeat(64)}`,
    },
    request: {
      model: "local/ocr-default", input: { referenceId: sourceReferenceId },
      outputFormat: "markdown", languageHints: ["zh-CN", "en"],
    },
  });
  const sourceBytes = Buffer.from("real-protected-png");
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen3.8-27b-nvfp4", servedModel: "qwen3.8-27b-nvfp4",
    ocrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/ocr-default", servedModel: "hunyuanocr-1.5-bf16-dflash",
      protocol: "hunyuan-managed-v1",
      profileId: "77777777-7777-4777-8777-777777777777", profileKey: "ocr.hunyuanocr-1.5.bf16-dflash.main-protected.v1",
      profileFingerprint: `sha256:${"e".repeat(64)}`, engineImageDigest: `sha256:${"f".repeat(64)}`,
    },
    objectGateway: {
      async download() { return { metadata: { contentType: "image/png" }, content: Buffer.from(sourceBytes) }; },
      async storeOutput(input) { return { objectId: "44444444-4444-4444-8444-444444444444", version: 2, size: input.content.byteLength }; },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-09-06T00:15:00.000Z" }; },
    },
  });
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(upstream.paths.includes("/ocr"), true);
  assert.deepEqual(upstream.requests.at(-1), {
    model: "hunyuanocr-1.5-bf16-dflash", job_id: JOB,
    file: sourceBytes.toString("base64"), fileType: 1,
    useLayoutDetection: true, formatBlockContent: true, layoutShapeMode: "rect",
    returnMarkdownImages: false, visualize: false, language_hints: ["zh-CN", "en"],
  });
});

test("a queued OCR job can use an external Provider that truthfully declares no geometry", async (context) => {
  const local = await worker();
  context.after(() => local.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: {
      jobId: JOB, ownerIdentityId: OWNER, capabilityId: "88888888-8888-4888-8888-888888888888",
      operation: "ocr", model: "local/ocr-default", dataClass: "internal", requestDigest: `sha256:${"d".repeat(64)}`,
    },
    request: { model: "local/ocr-default", input: { referenceId: sourceReferenceId }, outputFormat: "json", languageHints: ["zh-CN"] },
  });
  const route = {
    provider: { providerId: "33333333-3333-4333-8333-333333333333" },
    mapping: { modelProfileId: "77777777-7777-4777-8777-777777777777", providerModelName: "hunyuanocr-bf16-dflash" },
    profile: {
      profileId: "77777777-7777-4777-8777-777777777777",
      fingerprint: `sha256:${"e".repeat(64)}`,
      document: {
        profileKey: "ocr.hunyuanocr.bf16.dflash.spark-local.external.v1",
        engine: { imageDigest: `sha256:${"f".repeat(64)}` },
      },
    },
  };
  const providerCalls = [];
  const externalProviderRouter = {
    async resolve(input) { providerCalls.push(["resolve", input]); return { selected: route }; },
    async probe(selected) { providerCalls.push(["probe", selected]); return true; },
    async stream() { throw new Error("OCR must not stream"); },
    async request(selected, input) {
      providerCalls.push(["request", selected, input]);
      return { status: 200, body: {
        errorCode: 0,
        result: { layoutParsingResults: [{
          prunedResult: {
            width: null, height: null, geometry_supported: false,
            parsing_res_list: [{ block_id: "text-1", block_content: "团队 AI 盒子外部识别", block_bbox: null,
              confidence: null, block_label: "text", block_format: "markdown", reading_order: 0, geometry_supported: false }],
          },
          markdown: { text: "团队 AI 盒子外部识别" },
        }] },
      } };
    },
  };
  const stored = [];
  const sourceBytes = Buffer.from("real-protected-png");
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: local.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4", externalProviderRouter,
    objectGateway: {
      async download(input) {
        assert.deepEqual(input, { actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:ocr" });
        return { metadata: { contentType: "image/png" }, content: Buffer.from(sourceBytes) };
      },
      async storeOutput(input) {
        stored.push({ ...input, content: Buffer.from(input.content) });
        return { objectId: "44444444-4444-4444-8444-444444444444", version: 2, size: input.content.byteLength };
      },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-24T00:15:00.000Z" }; },
    },
  });
  assert.equal(bridge.canDispatch({ operation: "ocr", requestedModel: "local/ocr-default" }), true);
  const result = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(result.status, "succeeded");
  const request = providerCalls.find((call) => call[0] === "request")[2];
  assert.equal(request.path, "/ocr");
  assert.equal(request.body.model, "hunyuanocr-bf16-dflash");
  assert.equal(request.body.job_id, JOB);
  assert.equal(request.body.file, sourceBytes.toString("base64"));
  assert.equal(request.body.fileType, 1);
  assert.equal(request.body.useLayoutDetection, true);
  assert.equal(request.body.returnMarkdownImages, false);
  assert.deepEqual(request.body.language_hints, ["zh-CN"]);
  assert.equal(service.calls.find((call) => call[0] === "markPreparing")[3], "external_provider");
  const recognized = service.completions[0].result;
  assert.equal(recognized.pages[0].geometry_supported, false);
  assert.equal(recognized.pages[0].width, null);
  assert.equal(recognized.pages[0].blocks[0].bounding_box, null);
  assert.equal(recognized.pages[0].blocks[0].geometry_supported, false);
  assert.equal(recognized.extensions.provenance.profile_key, route.profile.document.profileKey);
  assert.equal(recognized.extensions.provenance.route, "external_provider");
  assert.equal(stored[0].content.includes(Buffer.from("团队 AI 盒子外部识别")), true);
  assert.equal(service.failures.length, 0);
});

test("OCR rejects unsupported protected media before exposing bytes to the worker", async (context) => {
  const upstream = await worker({ ocr: true });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "ocr", model: "local/ocr-default" },
    request: { input: { referenceId: "66666666-6666-4666-8666-666666666666" }, outputFormat: "json", languageHints: [] },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    ocrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/ocr-default", servedModel: "PaddleOCR-VL-1.5",
      profileId: "77777777-7777-4777-8777-777777777777", profileKey: "ocr.paddleocr-vl-1.5.bf16.spark.v1",
      profileFingerprint: `sha256:${"e".repeat(64)}`, engineImageDigest: `sha256:${"f".repeat(64)}`,
    },
    objectGateway: {
      async download() { return { metadata: { contentType: "text/html" }, content: Buffer.from("secret") }; },
      async storeOutput() { throw new Error("must not store"); },
      async issue() { throw new Error("must not issue"); },
    },
  });
  await assert.rejects(bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER }), { code: "compute_artifact_input_invalid" });
  assert.equal(upstream.requests.length, 0);
  assert.equal(service.failures[0][1].retryClassification, "terminal");
});

test("OCR rejects malformed worker geometry instead of fabricating coordinates", async (context) => {
  const upstream = await worker({ ocr: true, ocrInvalidBoundingBox: true });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "ocr", model: "local/ocr-default" },
    request: { input: { referenceId: sourceReferenceId }, outputFormat: "json", languageHints: [] },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    ocrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/ocr-default", servedModel: "PaddleOCR-VL-1.5",
      profileId: "77777777-7777-4777-8777-777777777777", profileKey: "ocr.paddleocr-vl-1.5.bf16.spark.v1",
      profileFingerprint: `sha256:${"e".repeat(64)}`, engineImageDigest: `sha256:${"f".repeat(64)}`,
    },
    objectGateway: {
      async download() { return { metadata: { contentType: "image/png" }, content: Buffer.from("real-protected-png") }; },
      async storeOutput() { throw new Error("must not store"); },
      async issue() { throw new Error("must not issue"); },
    },
  });
  await assert.rejects(bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER }), { code: "compute_worker_invalid" });
  assert.equal(service.failures[0][1].retryClassification, "terminal");
});

test("a queued ASR job sends scoped audio as OpenAI multipart and stores an encrypted timeline", async (context) => {
  const upstream = await worker({ asr: true });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: {
      jobId: JOB, ownerIdentityId: OWNER, operation: "transcriptions", model: "local/asr-default",
      dataClass: "confidential", requestDigest: `sha256:${"d".repeat(64)}`,
    },
    request: {
      model: "local/asr-default", input: { referenceId: sourceReferenceId }, language: "en-US",
      outputFormat: "srt", timestampGranularities: ["segment", "word"], speakerInformation: true,
    },
  });
  const stored = [];
  const sourceBytes = Buffer.from("RIFF-real-protected-wave");
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    asrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/asr-default", servedModel: "whisper-large-v3-fp16",
      profileId: "88888888-8888-4888-8888-888888888888", profileKey: "asr.whisper-large-v3.fp16.spark.v1",
      profileFingerprint: `sha256:${"a".repeat(64)}`, engineImageDigest: `sha256:${"b".repeat(64)}`,
    },
    objectGateway: {
      async download(input) {
        assert.deepEqual(input, { actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:asr" });
        return { metadata: { contentType: "audio/wav" }, content: Buffer.from(sourceBytes) };
      },
      async storeOutput(input) {
        stored.push({ ...input, content: Buffer.from(input.content) });
        return { objectId: "44444444-4444-4444-8444-444444444444", version: 3, size: input.content.byteLength };
      },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-14T00:15:00.000Z" }; },
    },
  });
  assert.equal(bridge.canDispatch({ operation: "transcriptions", requestedModel: "local/asr-default" }), true);
  const completed = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(completed.status, "succeeded");
  assert.match(upstream.requests[0].contentType, /^multipart\/form-data; boundary=/);
  assert.equal(upstream.requests[0].rawBody.includes(sourceBytes), true);
  assert.match(upstream.requests[0].rawBody.toString("latin1"), /whisper-large-v3-fp16/);
  assert.match(upstream.requests[0].rawBody.toString("latin1"), /name="language"\r\n\r\nen/);
  assert.match(stored[0].content.toString(), /00:00:00,000 --> 00:00:03,140/);
  const result = service.completions[0].result;
  assert.equal(service.completions[0].resultSchema, "teamaibox.ai.asr-result.v1");
  assert.equal(result.language.code, "en");
  assert.equal(result.language.requested, "en-US");
  assert.equal(result.segments[0].words[0].confidence, 0.99);
  assert.deepEqual(result.speaker_information, { requested: true, supported: false, speaker_count: null });
  assert.equal(result.artifacts[0].extensions.encrypted, true);
  assert.equal(result.artifacts[0].dataClass, "confidential");
  assert.equal(result.provenance.profile_key, "asr.whisper-large-v3.fp16.spark.v1");
  assert.equal(service.calls.find((call) => call[0] === "markPreparing")[2], "asr_model_preparing");
});

test("ASR preserves MP4 input and accepts a valid duration beyond seven days", async (context) => {
  const upstream = await worker({ asr: true, asrDuration: 8 * 24 * 60 * 60 });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "67666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: {
      jobId: JOB, ownerIdentityId: OWNER, operation: "transcriptions", model: "local/asr-default",
      dataClass: "internal", requestDigest: `sha256:${"c".repeat(64)}`,
    },
    request: {
      model: "local/asr-default", input: { referenceId: sourceReferenceId }, language: null,
      outputFormat: "json", timestampGranularities: ["segment"], speakerInformation: false,
    },
  });
  const sourceBytes = Buffer.from("ftyp-isom-real-protected-video-container");
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    asrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/asr-default", servedModel: "whisper-small-ct2-int8",
      profileId: "88888888-8888-4888-8888-888888888888", profileKey: "asr.whisper-small.ct2-int8.spark-local.realtime.v1",
      profileFingerprint: `sha256:${"a".repeat(64)}`, engineImageDigest: `sha256:${"b".repeat(64)}`,
    },
    objectGateway: {
      async download(input) {
        assert.deepEqual(input, { actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:asr" });
        return { metadata: { contentType: "video/mp4" }, content: Buffer.from(sourceBytes) };
      },
      async storeOutput(input) { return { objectId: "44444444-4444-4444-8444-444444444444", version: 1, size: input.content.byteLength }; },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-30T00:15:00.000Z" }; },
    },
  });
  const completed = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(completed.status, "succeeded");
  const multipart = upstream.requests[0].rawBody;
  assert.match(multipart.toString("latin1"), /filename="source\.mp4"\r\nContent-Type: video\/mp4/);
  assert.equal(multipart.includes(sourceBytes), true);
  assert.equal(service.completions[0].result.provenance.profile_key, "asr.whisper-small.ct2-int8.spark-local.realtime.v1");
  assert.equal(service.completions[0].result.duration_seconds, 8 * 24 * 60 * 60);
});

test("ASR rejects an invalid worker timeline without storing a transcript", async (context) => {
  const upstream = await worker({ asr: true, asrInvalidTimeline: true });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "transcriptions", model: "local/asr-default" },
    request: {
      input: { referenceId: "66666666-6666-4666-8666-666666666666" }, language: null,
      outputFormat: "json", timestampGranularities: ["segment"], speakerInformation: false,
    },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    asrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/asr-default", servedModel: "whisper-large-v3-fp16",
      profileId: "88888888-8888-4888-8888-888888888888", profileKey: "asr.whisper-large-v3.fp16.spark.v1",
      profileFingerprint: `sha256:${"a".repeat(64)}`, engineImageDigest: `sha256:${"b".repeat(64)}`,
    },
    objectGateway: {
      async download() { return { metadata: { contentType: "audio/wav" }, content: Buffer.from("RIFF-invalid-timeline") }; },
      async storeOutput() { throw new Error("must not store"); },
      async issue() { throw new Error("must not issue"); },
    },
  });
  await assert.rejects(bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER }), { code: "compute_worker_invalid" });
  assert.equal(service.failures[0][1].retryClassification, "terminal");
});

test("ASR cancellation fences a late worker result without aborting the multipart transport", async (context) => {
  const upstream = await worker({ asr: true, asrDelayMilliseconds: 250 });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "transcriptions", model: "local/asr-default" },
    request: {
      input: { referenceId: "66666666-6666-4666-8666-666666666666" }, language: null,
      outputFormat: "json", timestampGranularities: ["segment"], speakerInformation: false,
    },
  });
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    asrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/asr-default", servedModel: "whisper-large-v3-fp16",
      profileId: "88888888-8888-4888-8888-888888888888", profileKey: "asr.whisper-large-v3.fp16.spark.v1",
      profileFingerprint: `sha256:${"a".repeat(64)}`, engineImageDigest: `sha256:${"b".repeat(64)}`,
    },
    objectGateway: {
      async download() { return { metadata: { contentType: "audio/wav" }, content: Buffer.alloc(2 * 1024 * 1024, 65) }; },
      async storeOutput() { throw new Error("cancelled ASR output must not be stored"); },
      async issue() { throw new Error("cancelled ASR output must not be issued"); },
    },
  });
  const execution = bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  while (upstream.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await bridge.cancel(JOB), true);
  await assert.rejects(execution, { code: "compute_cancelled" });
  assert.equal(service.cancellations.length >= 1, true);
  assert.equal(service.completions.length, 0);
  assert.equal(service.failures.length, 0);
});

test("a queued text translation normalizes an aligned segments response and stores only an encrypted result", async (context) => {
  const upstream = await worker({ translation: true, translationField: "segments" });
  context.after(() => upstream.close());
  const service = jobs();
  service.executionInput = async () => ({
    job: {
      jobId: JOB, ownerIdentityId: OWNER, operation: "translations", model: "local/translation-default",
      dataClass: "confidential", requestDigest: `sha256:${"3".repeat(64)}`,
    },
    request: {
      model: "local/translation-default", inputKind: "text", inputRepresentation: "source",
      input: { text: "团队 AI 盒子" }, sourceLanguage: null, targetLanguage: "en",
      outputFormat: "json", preserveLayout: true, includeIntermediates: true,
      workflow: [{ stageId: "translate", capabilityKey: "translation", dependsOn: [] }],
    },
  });
  const stored = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    translationWorker: translationWorker(upstream.origin),
    objectGateway: {
      async download() { throw new Error("text translation must not decrypt an object"); },
      async storeOutput(input) {
        stored.push({ ...input, content: Buffer.from(input.content) });
        return { objectId: "44444444-4444-4444-8444-444444444444", version: 4, size: input.content.byteLength };
      },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-14T00:15:00.000Z" }; },
    },
  });
  assert.equal(bridge.canDispatch({ operation: "translations", requestedModel: "local/translation-default" }), true);
  const completed = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(completed.status, "succeeded");
  assert.equal(upstream.requests[0].model, "qwen3.6-35b-a3b-nvfp4");
  assert.deepEqual(upstream.requests[0].response_format, { type: "json_schema", json_schema: {
    name: "aligned_translation", strict: true, schema: { type: "object", properties: {
      source_language: { type: "string" }, translations: { type: "array", items: { type: "string" },
        minItems: 1, maxItems: 1 },
    }, required: ["source_language", "translations"], additionalProperties: false },
  } });
  assert.deepEqual(upstream.requests[0].chat_template_kwargs, { enable_thinking: false });
  const result = service.completions[0].result;
  assert.equal(service.completions[0].resultSchema, "teamaibox.ai.translation-result.v1");
  assert.equal(result.source_language, "zh-CN");
  assert.equal(result.target_language, "en");
  assert.equal(result.text, "Translated: 团队 AI 盒子");
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 });
  assert.equal(result.segments[0].source_text, "团队 AI 盒子");
  assert.equal(result.segments[0].source_reference_id, null);
  assert.equal(result.workflow.stages[0].profile_key, translationWorker(upstream.origin).profileKey);
  assert.deepEqual(result.workflow.intermediates, []);
  assert.equal(result.artifacts[0].extensions.encrypted, true);
  assert.equal(result.artifacts[0].dataClass, "confidential");
  assert.equal(JSON.parse(stored[0].content).schema, "teamaibox.ai.translation-result.v1");
  assert.equal(service.calls.find((call) => call[0] === "markPreparing")[2], "translation_workflow_preparing");
  assert.equal(service.calls.find((call) => call[0] === "markPreparing")[3], "local");
});

test("translation consumes a fresh scoped OCR-result reference without rerunning OCR", async (context) => {
  const upstream = await worker({ translation: true });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, operation: "translations", model: "local/translation-default" },
    request: {
      inputKind: "document", inputRepresentation: "ocr-result", input: { referenceId: sourceReferenceId },
      sourceLanguage: "zh-CN", targetLanguage: "en", outputFormat: "text", preserveLayout: true,
      includeIntermediates: true,
      workflow: [{ stageId: "translate", capabilityKey: "translation", dependsOn: [] }],
    },
  });
  const downloads = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    translationWorker: translationWorker(upstream.origin),
    objectGateway: {
      async download(input) {
        downloads.push(input);
        return { metadata: { contentType: "application/json" }, content: Buffer.from(JSON.stringify({
          schema: "teamaibox.ai.ocr-result.v1", text: "团队 AI 盒子\n加密识别结果",
          pages: [{ blocks: [{ id: "block-1", text: "团队 AI 盒子" }, { id: "block-2", text: "加密识别结果" }] }],
        })) };
      },
      async storeOutput(input) {
        return { objectId: "44444444-4444-4444-8444-444444444444", version: 5, size: input.content.byteLength };
      },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-14T00:15:00.000Z" }; },
    },
  });
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.deepEqual(downloads, [{ actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:translation" }]);
  assert.equal(upstream.requests.length, 1);
  const submitted = JSON.parse(upstream.requests[0].messages.at(-1).content);
  assert.deepEqual(submitted.segments, ["团队 AI 盒子", "加密识别结果"]);
  assert.equal(upstream.requests[0].response_format.json_schema.schema.properties.translations.minItems, 2);
  assert.equal(upstream.requests[0].response_format.json_schema.schema.properties.translations.maxItems, 2);
  const result = service.completions[0].result;
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[1].translated_text, "Translated: 加密识别结果");
  assert.equal(result.segments.every((segment) => segment.source_reference_id === sourceReferenceId), true);
  assert.equal(result.provenance.source_reference_id, sourceReferenceId);
  assert.deepEqual(result.workflow.intermediates, []);
});

test("video translation preserves MP4 for ASR and produces an aligned encrypted WebVTT result", async (context) => {
  const upstream = await worker({ asr: true, translation: true });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "68666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: {
      jobId: JOB, ownerIdentityId: OWNER, operation: "translations", model: "local/translation-default",
      dataClass: "confidential", requestDigest: `sha256:${"d".repeat(64)}`,
    },
    request: {
      inputKind: "video", inputRepresentation: "source", input: { referenceId: sourceReferenceId },
      sourceLanguage: "en", targetLanguage: "zh-CN", outputFormat: "vtt", preserveLayout: true,
      includeIntermediates: true,
      workflow: [
        { stageId: "transcribe", capabilityKey: "asr", dependsOn: [] },
        { stageId: "translate", capabilityKey: "translation", dependsOn: ["transcribe"] },
        { stageId: "compose-subtitles", capabilityKey: "subtitle-compose", dependsOn: ["translate"] },
      ],
    },
  });
  const sourceBytes = Buffer.from("ftyp-isom-protected-video-for-translation");
  const stored = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4", servedModel: "qwen3.6-35b-a3b-nvfp4",
    translationWorker: translationWorker(upstream.origin),
    asrWorker: {
      workerOrigin: upstream.origin, modelAlias: "local/asr-default", servedModel: "whisper-small-ct2-int8",
      profileId: "88888888-8888-4888-8888-888888888888",
      profileKey: "asr.whisper-small.ct2-int8.spark-local.realtime.v1",
      profileFingerprint: `sha256:${"a".repeat(64)}`, engineImageDigest: `sha256:${"b".repeat(64)}`,
      route: "managed_node",
    },
    objectGateway: {
      async download(input) {
        assert.deepEqual(input, { actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:translation" });
        return { metadata: { contentType: "video/mp4" }, content: Buffer.from(sourceBytes) };
      },
      async storeOutput(input) {
        stored.push({ ...input, content: Buffer.from(input.content) });
        return {
          objectId: stored.length === 1 ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          version: 1, size: input.content.byteLength,
        };
      },
      async issue() {
        return { referenceId: stored.length === 1 ? "55555555-5555-4555-8555-555555555555" : "77777777-7777-4777-8777-777777777777",
          expiresAt: "2026-08-30T15:15:00.000Z" };
      },
    },
  });

  const completed = await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });

  assert.equal(completed.status, "succeeded");
  assert.match(upstream.requests[0].contentType, /^multipart\/form-data; boundary=/);
  assert.match(upstream.requests[0].rawBody.toString("latin1"), /filename="source\.mp4"\r\nContent-Type: video\/mp4/);
  assert.equal(upstream.requests[0].rawBody.includes(sourceBytes), true);
  assert.equal(upstream.requests[1].model, "qwen3.6-35b-a3b-nvfp4");
  assert.deepEqual(JSON.parse(upstream.requests[1].messages.at(-1).content).segments, ["Team AI Box transcription."]);
  assert.equal(stored.length, 2);
  assert.equal(JSON.parse(stored[0].content).schema, "teamaibox.ai.asr-result.v1");
  assert.match(stored[1].content.toString(), /^WEBVTT\n\n00:00:00\.000 --> 00:00:03\.140\nTranslated: Team AI Box transcription\./);
  const result = service.completions[0].result;
  assert.equal(result.input_kind, "video");
  assert.equal(result.segments[0].start_ms, 0);
  assert.equal(result.segments[0].end_ms, 3140);
  assert.equal(result.artifacts[0].mediaType, "text/vtt; charset=utf-8");
  assert.equal(result.artifacts[0].extensions.encrypted, true);
  assert.deepEqual(result.workflow.stages.map((stage) => stage.capability), ["asr", "translation", "subtitle-compose"]);
  assert.equal(result.workflow.stages[0].profile_key, "asr.whisper-small.ct2-int8.spark-local.realtime.v1");
  assert.equal(result.workflow.stages[0].route, "managed_node");
  assert.deepEqual(result.workflow.intermediates, [{ kind: "asr-transcript", reference_id: "55555555-5555-4555-8555-555555555555" }]);
});

test("image translation sends the hardened exact schema to its local OCR composition stage", async (context) => {
  const upstream = await worker({ ocr: true, translation: true });
  context.after(() => upstream.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: {
      jobId: JOB,
      ownerIdentityId: OWNER,
      operation: "translations",
      model: "local/translation-default",
      dataClass: "internal",
      requestDigest: `sha256:${"7".repeat(64)}`,
    },
    request: {
      inputKind: "image",
      inputRepresentation: "source",
      input: { referenceId: sourceReferenceId },
      sourceLanguage: null,
      targetLanguage: "en",
      outputFormat: "json",
      preserveLayout: true,
      includeIntermediates: true,
      workflow: [
        { stageId: "extract-text", capabilityKey: "ocr", dependsOn: [] },
        { stageId: "translate", capabilityKey: "translation", dependsOn: ["extract-text"] },
      ],
    },
  });
  const sourceBytes = Buffer.from("synthetic-png");
  const stored = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service,
    workerOrigin: upstream.origin,
    modelAlias: "local/qwen-nvfp4",
    servedModel: "qwen3.6-35b-a3b-nvfp4",
    translationWorker: translationWorker(upstream.origin),
    ocrWorker: {
      workerOrigin: upstream.origin,
      modelAlias: "local/ocr-default",
      servedModel: "paddle-ocr",
      profileId: "88888888-8888-4888-8888-888888888888",
      profileKey: "ocr.local.v1",
      profileFingerprint: `sha256:${"8".repeat(64)}`,
      engineImageDigest: `sha256:${"9".repeat(64)}`,
    },
    objectGateway: {
      async download(input) {
        assert.deepEqual(input, { actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:translation" });
        return { metadata: { contentType: "image/png" }, content: Buffer.from(sourceBytes) };
      },
      async storeOutput(input) {
        stored.push({ ...input, content: Buffer.from(input.content) });
        return {
          objectId: stored.length === 1 ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          version: 1,
          size: input.content.byteLength,
        };
      },
      async issue() {
        return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-29T15:15:00.000Z" };
      },
    },
  });

  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });

  assert.deepEqual(upstream.requests[0], { file: sourceBytes.toString("base64"), fileType: 1 });
  assert.equal(upstream.requests[1].model, "qwen3.6-35b-a3b-nvfp4");
  assert.equal(service.completions[0].result.text, "Translated: 团队 AI 盒子\nTranslated: Encrypted OCR result");
  assert.equal(service.completions[0].result.workflow.stages[0].route, "managed_node");
  assert.equal(stored.length, 2);
});

test("image translation resolves its OCR composition stage through an approved external Provider", async (context) => {
  const local = await worker();
  context.after(() => local.close());
  const service = jobs();
  const sourceReferenceId = "66666666-6666-4666-8666-666666666666";
  service.executionInput = async () => ({
    job: { jobId: JOB, ownerIdentityId: OWNER, capabilityId: "77777777-7777-4777-8777-777777777777",
      operation: "translations", model: "local/translation-default", dataClass: "internal",
      requestDigest: `sha256:${"7".repeat(64)}` },
    request: { inputKind: "image", inputRepresentation: "source", input: { referenceId: sourceReferenceId },
      sourceLanguage: null, targetLanguage: "en", outputFormat: "json", preserveLayout: true,
      includeIntermediates: true, workflow: [
        { stageId: "extract-text", capabilityKey: "ocr", dependsOn: [] },
        { stageId: "translate", capabilityKey: "translation", dependsOn: ["extract-text"] },
      ] },
  });
  const translationRoute = { provider: { providerId: "33333333-3333-4333-8333-333333333333" },
    mapping: { providerModelName: "lmt-nvfp4" }, profile: { document: {} } };
  const ocrRoute = { provider: { providerId: "44444444-4444-4444-8444-444444444444" },
    mapping: { providerModelName: "hunyuan-ocr" },
    profile: { document: { profileKey: "ocr.hunyuan.bf16.external.v1" } } };
  const requests = [];
  const externalProviderRouter = {
    async resolve() { return { selected: translationRoute }; },
    async resolveCapability(input) { requests.push(["resolveCapability", input]); return { selected: ocrRoute }; },
    async probe(route) { requests.push(["probe", route]); return true; },
    async request(route, input) {
      requests.push(["request", route, input]);
      if (input.path === "/ocr") return { status: 200, body: {
        errorCode: 0, result: { layoutParsingResults: [{ prunedResult: { width: 640, height: 480,
          parsing_res_list: [{ block_id: 1, block_bbox: [10, 20, 310, 58], block_label: "text",
            block_format: "text", block_content: "团队 AI 盒子", block_score: 0.98, reading_order: 1 }] },
          markdown: { text: "团队 AI 盒子" } }] },
      } };
      const source = JSON.parse(input.body.messages.at(-1).content);
      return { status: 200, body: { id: "chatcmpl_composed", object: "chat.completion", model: input.body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ source_language: "zh-CN",
          translations: source.segments.map((segment) => `Translated: ${segment}`) }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } } };
    },
    async stream() { throw new Error("composed translation must use buffered transport"); },
  };
  const stored = [];
  const bridge = new OpenAiWorkerExecutionBridge({
    jobService: service, workerOrigin: local.origin, modelAlias: "local/qwen-nvfp4",
    servedModel: "qwen3.6-35b-a3b-nvfp4", translationWorker: translationWorker(local.origin),
    ocrWorker: { workerOrigin: local.origin, modelAlias: "local/ocr-default", servedModel: "paddle-ocr",
      profileId: "88888888-8888-4888-8888-888888888888", profileKey: "ocr.local.v1",
      profileFingerprint: `sha256:${"8".repeat(64)}`, engineImageDigest: `sha256:${"9".repeat(64)}` },
    externalProviderRouter,
    objectGateway: {
      async download(input) {
        assert.deepEqual(input, { actorIdentityId: OWNER, referenceId: sourceReferenceId, audience: "compute:translation" });
        return { metadata: { contentType: "image/png" }, content: Buffer.from("synthetic-png") };
      },
      async storeOutput(input) {
        stored.push({ ...input, content: Buffer.from(input.content) });
        return { objectId: stored.length === 1 ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", version: 1, size: input.content.byteLength };
      },
      async issue() { return { referenceId: "55555555-5555-4555-8555-555555555555", expiresAt: "2026-08-14T00:15:00.000Z" }; },
    },
  });
  await bridge.awaitResult({ jobId: JOB, ownerIdentityId: OWNER });
  assert.equal(requests.find((item) => item[0] === "resolveCapability")[1].operation, "ocr");
  assert.equal(requests.filter((item) => item[0] === "request").map((item) => item[2].path).join(","), "/ocr,/chat/completions");
  assert.deepEqual(requests.find((item) => item[0] === "request" && item[2].path === "/chat/completions")[2].body.response_format, { type: "json_object" });
  const ocrRequest = requests.find((item) => item[0] === "request" && item[2].path === "/ocr")[2].body;
  assert.equal(ocrRequest.model, "hunyuan-ocr");
  assert.equal(ocrRequest.job_id, JOB);
  assert.equal(ocrRequest.file, Buffer.from("synthetic-png").toString("base64"));
  assert.equal(ocrRequest.fileType, 1);
  assert.equal(ocrRequest.useLayoutDetection, true);
  assert.equal(ocrRequest.returnMarkdownImages, false);
  const result = service.completions[0].result;
  assert.equal(result.text, "Translated: 团队 AI 盒子");
  assert.equal(result.workflow.stages[0].profile_key, "ocr.hunyuan.bf16.external.v1");
  assert.equal(result.workflow.stages[0].route, "external_provider");
  assert.equal(result.workflow.stages[1].route, "external_provider");
  assert.equal(result.workflow.intermediates.length, 1);
  const intermediate = JSON.parse(stored[0].content);
  assert.equal(intermediate.provenance.provider_id, ocrRoute.provider.providerId);
  assert.equal(intermediate.provenance.route, "external_provider");
});
