import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  ComputeHttpApi,
  selectedOpenAiOperations,
} from "../src/compute/compute-http-api.mjs";

const context = Object.freeze({ identityId: "11111111-1111-4111-8111-111111111111" });
const MAIN_DRAWING_PROFILE = "06c9542e-4bf3-5f4f-a41e-c7768398e2ea";
const LONGCAT_DRAWING_PROFILE = "c6799c69-7c01-5031-94c3-45d3785e7e43";

test("ordinary drawing follows deployment configuration and refuses the replaced profile", async () => {
  const backend = new FakeComputeBackend();
  const drawingProfileId = "33333333-3333-4333-8333-333333333333";
  const api = new ComputeHttpApi({ backend, drawingProfileId });
  for (const alias of ["drawing.automatic", "drawing.fast"]) {
    const request = { method: "POST", pathname: "/v1/images/generations", context,
      body: { model: alias, prompt: "office test", x_teamaibox: { background: true } } };
    assert.equal((await api.handle(request)).status, 202);
    assert.equal(backend.submissions.at(-1).requestedModelProfileId, drawingProfileId);
    assert.equal(backend.submissions.at(-1).request.x_teamaibox.routing_authorization.model_profile_id, drawingProfileId);
    await assert.rejects(api.handle({ ...request, body: { ...request.body,
      x_teamaibox: { background: true, model_profile_id: MAIN_DRAWING_PROFILE } } }),
      { code: "model_profile_selection_forbidden" });
  }
});

class FakeComputeBackend {
  submissions = [];
  invocations = [];
  streams = [];
  admissions = [];
  jobs = new Map();

  createJob(work, overrides = {}) {
    const job = {
      jobId: randomUUID(),
      responseId: `resp_${randomUUID().replaceAll("-", "")}`,
      operation: work.operation,
      status: "queued",
      route: "unassigned",
      model: work.requestedModel,
      profileId: null,
      attemptId: null,
      output: [],
      error: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      ...overrides,
    };
    this.jobs.set(job.jobId, job);
    this.jobs.set(job.responseId, job);
    return structuredClone(job);
  }

  async submit(work) {
    this.submissions.push(structuredClone(work));
    return this.createJob(work);
  }

  async invoke(work) {
    this.invocations.push(structuredClone(work));
    const job = this.createJob(work, { status: "succeeded", route: "local" });
    const bodies = {
      "chat.completions": {
        id: "chatcmpl_test", object: "chat.completion", created: 1786320000,
        model: work.requestedModel,
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      responses: {
        id: "resp_test", object: "response", created_at: 1786320000,
        status: "completed", model: work.requestedModel, output: [], error: null,
      },
      embeddings: {
        object: "list", model: work.requestedModel,
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
      "images.generations": {
        created: 1786320000,
        data: [{ b64_json: "dGVzdA==" }],
      },
    };
    return { job, body: bodies[work.operation] };
  }

  async stream(work) {
    this.streams.push(structuredClone(work));
    const operation = work.operation;
    return (async function* events() {
      if (operation === "chat.completions") {
        yield { data: { id: "chatcmpl_stream", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] } };
        yield { data: { id: "chatcmpl_stream", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] } };
      } else {
        yield { event: "response.created", data: { type: "response.created", response: { id: "resp_stream", status: "in_progress" } } };
        yield { event: "response.completed", data: { type: "response.completed", response: { id: "resp_stream", status: "completed" } } };
      }
    }());
  }

  async getJob({ ownerIdentityId, jobId, responseId }) {
    assert.equal(ownerIdentityId, context.identityId);
    return structuredClone(this.jobs.get(jobId ?? responseId));
  }

  async cancelJob({ ownerIdentityId, jobId, responseId }) {
    assert.equal(ownerIdentityId, context.identityId);
    const job = this.jobs.get(jobId ?? responseId);
    job.status = "cancelled";
    return structuredClone(job);
  }

  async admitRealtime(request) {
    this.admissions.push(structuredClone(request));
    const sessionId = randomUUID();
    return {
      sessionId,
      expiresAt: "2026-08-10T00:05:00.000Z",
      reservation: {
        reservation_id: sessionId,
        reservation_kind: "realtime",
        priority_class: "latency",
        latency_budget_milliseconds: 250,
        protected_from_batch: true,
        resources: {
          cpu_millis: 1000,
          unified_memory_bytes: 2_147_483_648,
          accelerator_units: 0,
          codec_sessions: 1,
          storage_bytes: 0,
          network_bits_per_second: 100_000_000,
          codec_encode_sessions: 0,
          codec_decode_sessions: 1,
        },
      },
    };
  }

  async connectRealtime(request) {
    return {
      sessionId: request.sessionId,
      state: "connected",
      capability: "translation",
      model: "local/realtime-translation",
      expiresAt: "2026-08-10T00:05:00.000Z",
      reservation: { reservation_id: request.sessionId },
    };
  }

  async heartbeatRealtime(request) {
    return this.connectRealtime(request);
  }

  async disconnectRealtime(request) {
    return { ...(await this.connectRealtime(request)), state: "released" };
  }
}

function fixture() {
  const backend = new FakeComputeBackend();
  return { backend, api: new ComputeHttpApi({ backend }) };
}

test("image inputs above 32000 characters reach the model adapter without truncation", async () => {
  const { api, backend } = fixture();
  const prompt = "细节".repeat(20000), negative = "避免".repeat(20000);
  const generation = await api.handle({ method: "POST", pathname: "/v1/images/generations", context,
    body: { model: "local/image", prompt, x_teamaibox: { background: true, extensions: { drawing: { negative_prompt: negative } } } } });
  assert.equal(generation.status, 202);
  assert.equal(backend.submissions[0].request.prompt, prompt);
  assert.equal(backend.submissions[0].request.x_teamaibox.extensions.drawing.negative_prompt, negative);
  const edit = await api.handle({ method: "POST", pathname: "/api/v1/ai/images/edits", context,
    body: { model: "local/image", prompt, negative_prompt: negative, input: { reference_id: randomUUID() } } });
  assert.equal(edit.status, 202);
  assert.equal(backend.submissions[1].request.prompt, prompt);
  assert.equal(backend.submissions[1].request.negativePrompt, negative);
});

test("publishes the selected standard OpenAI paths without physical routing", () => {
  assert.deepEqual(selectedOpenAiOperations, {
    "/v1/chat/completions": "chat.completions",
    "/v1/responses": "responses",
    "/v1/embeddings": "embeddings",
    "/v1/images/generations": "images.generations",
  });
});

test("synchronous Chat Completions preserves the standard response and adds a queued-job extension", async () => {
  const { api, backend } = fixture();
  const result = await api.handle({
    method: "POST",
    pathname: "/v1/chat/completions",
    context,
    requestId: "request-chat-1234",
    headers: { "idempotency-key": "chat-request-1" },
    body: {
      model: "local/chat-default",
      messages: [{ role: "user", content: "hello" }],
      x_teamaibox: { data_class: "confidential", priority: 70 },
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.object, "chat.completion");
  assert.equal(result.body.choices[0].message.content, "hello");
  assert.equal(result.body.x_teamaibox.state, "succeeded");
  assert.equal(backend.invocations.length, 1);
  assert.equal(backend.invocations[0].idempotencyKey, "chat-request-1");
  assert.equal(backend.invocations[0].dataClass, "confidential");
  assert.equal("x_teamaibox" in backend.invocations[0].request, false);
  assert.equal("providerId" in backend.invocations[0], false);
});

test("Responses background mode returns a pollable OpenAI response backed by one job", async () => {
  const { api, backend } = fixture();
  const accepted = await api.handle({
    method: "POST",
    pathname: "/v1/responses",
    context,
    body: { model: "local/reasoning", input: "work for a while", background: true },
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.object, "response");
  assert.equal(accepted.body.background, true);
  assert.equal(accepted.body.status, "queued");
  assert.equal(backend.submissions.length, 1);

  const polled = await api.handle({
    method: "GET",
    pathname: `/v1/responses/${accepted.body.id}`,
    context,
  });
  assert.equal(polled.body.x_teamaibox.job_id, accepted.body.x_teamaibox.job_id);
  const cancelled = await api.handle({
    method: "POST",
    pathname: `/v1/responses/${accepted.body.id}/cancel`,
    context,
  });
  assert.equal(cancelled.body.status, "cancelled");
});

test("Chat and Responses streams preserve their respective SSE event conventions", async () => {
  const { api } = fixture();
  const chat = await api.handle({
    method: "POST",
    pathname: "/v1/chat/completions",
    context,
    body: { model: "local/chat", messages: [{ role: "user", content: "hi" }], stream: true },
  });
  assert.equal(chat.kind, "sse");
  assert.equal(chat.doneMarker, "[DONE]");
  const chatEvents = [];
  for await (const event of chat.events) chatEvents.push(event);
  assert.equal(chatEvents.length, 2);
  assert.equal(chatEvents[1].data.choices[0].finish_reason, "stop");

  const responses = await api.handle({
    method: "POST",
    pathname: "/v1/responses",
    context,
    body: { model: "local/reasoning", input: "hi", stream: true },
  });
  assert.equal(responses.doneMarker, null);
  const responseEvents = [];
  for await (const event of responses.events) responseEvents.push(event);
  assert.deepEqual(responseEvents.map((event) => event.event), ["response.created", "response.completed"]);
});

test("Embeddings and image generation retain standard operation response shapes", async () => {
  const { api, backend } = fixture();
  const embedding = await api.handle({
    method: "POST", pathname: "/v1/embeddings", context,
    body: { model: "local/embedding", input: ["one", "two"] },
  });
  assert.equal(embedding.body.object, "list");
  assert.equal(embedding.body.data[0].object, "embedding");
  const image = await api.handle({
    method: "POST", pathname: "/v1/images/generations", context,
    body: { model: "local/image", prompt: "a tiny robot", n: 1 },
  });
  assert.equal(image.body.data[0].b64_json, "dGVzdA==");
  const queued = await api.handle({
    method: "POST", pathname: "/v1/images/generations", context,
    headers: { "idempotency-key": "drawing-seeded-one" },
    body: {
      model: "local/image", prompt: "a tiny robot", n: 1, size: "1024x1024",
      x_teamaibox: {
        background: true,
        extensions: { drawing: { preset_key: "drawing.balanced.v1", seed: 42, steps: 28, output_format: "png" } },
      },
    },
  });
  assert.equal(queued.status, 202);
  assert.deepEqual(backend.submissions.at(-1).request.x_teamaibox.extensions.drawing, {
    preset_key: "drawing.balanced.v1", seed: 42, steps: 28, output_format: "png",
  });
});

test("ordinary Drawing intents are server-normalized to the exact protected main-box profile", async () => {
  const { api, backend } = fixture();
  const result = await api.handle({
    method: "POST", pathname: "/v1/images/generations", context,
    body: { model: "drawing.automatic", prompt: "an office diagram", background: false,
      x_teamaibox: { background: true } },
  });
  assert.equal(result.status, 202);
  const submitted = backend.submissions[0];
  assert.equal(submitted.requestedModelProfileId, MAIN_DRAWING_PROFILE);
  assert.equal(submitted.request.size, "512x512");
  assert.equal(submitted.request.n, 1);
  assert.deepEqual(submitted.request.x_teamaibox.routing_authorization, {
    schema: "teamaibox.drawing-route-authorization.v2",
    policy_version: "protected-main-default.v1",
    selection_class: "ordinary-protected",
    model_alias: "drawing.automatic",
    operation: "images.generations",
    model_profile_id: MAIN_DRAWING_PROFILE,
  });
});

test("rejects unsupported protected Drawing parameters before creating a queued job", async () => {
  for (const extra of [{ size: "1024x1024" }, { n: 2 },
    { x_teamaibox: { extensions: { drawing: { guidance_scale: 4 } } } },
    { x_teamaibox: { extensions: { drawing: { steps: 20 } } } },
    { x_teamaibox: { extensions: { drawing: { output_format: "jpeg" } } } }]) {
    const { api, backend } = fixture();
    await assert.rejects(api.handle({ method: "POST", pathname: "/v1/images/generations", context,
      body: { model: "drawing.automatic", prompt: "an office diagram", ...extra },
    }), { code: "invalid_compute_request" });
    assert.equal(backend.submissions.length, 0);
  }
});

test("ordinary users cannot construct an auxiliary Drawing profile selection", async () => {
  const { api, backend } = fixture();
  await assert.rejects(api.handle({
    method: "POST", pathname: "/v1/images/generations", context,
    body: { model: "drawing.high-quality", prompt: "an office poster",
      x_teamaibox: { model_profile_id: LONGCAT_DRAWING_PROFILE } },
  }), (error) => error.code === "model_profile_selection_forbidden" && error.status === 403);
  await assert.rejects(api.handle({
    method: "POST", pathname: "/v1/images/generations", context,
    body: { model: "local/image", prompt: "an office poster",
      x_teamaibox: { model_profile_id: LONGCAT_DRAWING_PROFILE } },
  }), (error) => error.code === "model_profile_selection_forbidden" && error.status === 403);
  assert.equal(backend.invocations.length + backend.submissions.length, 0);
});

test("model inventory viewers receive one exact advanced Drawing authorization", async () => {
  const { api, backend } = fixture();
  const privileged = { ...context, permissions: ["model:view"] };
  await api.handle({
    method: "POST", pathname: "/v1/images/generations", context: privileged,
    body: { model: "drawing.high-quality", prompt: "an office poster",
      x_teamaibox: { background: true, model_profile_id: LONGCAT_DRAWING_PROFILE } },
  });
  const submitted = backend.submissions[0];
  assert.equal(submitted.requestedModelProfileId, LONGCAT_DRAWING_PROFILE);
  assert.deepEqual(submitted.request.x_teamaibox.routing_authorization, {
    schema: "teamaibox.drawing-route-authorization.v2",
    policy_version: "protected-main-default.v1",
    selection_class: "advanced-explicit",
    model_alias: "drawing.high-quality",
    operation: "images.generations",
    model_profile_id: LONGCAT_DRAWING_PROFILE,
  });
  await assert.rejects(api.handle({
    method: "POST", pathname: "/v1/images/generations", context: privileged,
    body: { model: "drawing.fast", prompt: "an office poster",
      x_teamaibox: { model_profile_id: LONGCAT_DRAWING_PROFILE } },
  }), (error) => error.code === "invalid_compute_request" && error.status === 400);
});

test("clients cannot submit the internal Drawing routing authorization marker", async () => {
  const { api } = fixture();
  await assert.rejects(api.handle({
    method: "POST", pathname: "/v1/images/generations", context,
    body: { model: "drawing.automatic", prompt: "diagram",
      x_teamaibox: { routing_authorization: { selection_class: "advanced-explicit" } } },
  }), (error) => error.code === "invalid_compute_request"
    && error.details?.param === "x_teamaibox.routing_authorization");
});

test("image edits queue scoped encrypted inputs with reproducibility parameters", async () => {
  const { api, backend } = fixture();
  const result = await api.handle({
    method: "POST", pathname: "/api/v1/ai/images/edits", context,
    headers: { "idempotency-key": "drawing-edit-one" },
    body: {
      model: "local/image", prompt: "replace the sky with dusk",
      input: { reference_id: "22222222-2222-4222-8222-222222222222" },
      mask: { reference_id: "33333333-3333-4333-8333-333333333333" },
      preset_key: "drawing.balanced.v1", seed: 1337, strength: 0.7,
      size: "1024x1024", output_format: "png",
      x_teamaibox: { data_class: "confidential", background: true },
    },
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.operation, "images.edits");
  assert.equal(result.body.result_schema, "teamaibox.ai.image-result.v1");
  assert.equal(backend.submissions[0].request.input.referenceId, "22222222-2222-4222-8222-222222222222");
  assert.equal(backend.submissions[0].request.mask.referenceId, "33333333-3333-4333-8333-333333333333");
  assert.equal(backend.submissions[0].request.seed, 1337);
  await assert.rejects(api.handle({
    method: "POST", pathname: "/api/v1/ai/images/edits", context,
    body: { prompt: "edit", input: { reference_id: "bad" } },
  }), (error) => error.code === "invalid_compute_request");
});

test("advanced Drawing edits require model permission and preserve the trusted routing tuple", async () => {
  const { api, backend } = fixture();
  const body = {
    model: "drawing.edit", prompt: "replace the sky",
    input: { reference_id: "22222222-2222-4222-8222-222222222222" },
    x_teamaibox: { background: true, model_profile_id: "bc266009-bf57-589e-b8c4-dcf9ec892692" },
  };
  await assert.rejects(api.handle({
    method: "POST", pathname: "/api/v1/ai/images/edits", context, body,
  }), (error) => error.code === "model_profile_selection_forbidden" && error.status === 403);
  const result = await api.handle({
    method: "POST", pathname: "/api/v1/ai/images/edits",
    context: { ...context, permissions: ["model:manage"] }, body,
  });
  assert.equal(result.status, 202);
  assert.equal(backend.submissions[0].requestedModelProfileId, "bc266009-bf57-589e-b8c4-dcf9ec892692");
  assert.equal(backend.submissions[0].request.x_teamaibox.routing_authorization.selection_class, "advanced-explicit");
  assert.equal(backend.submissions[0].request.x_teamaibox.routing_authorization.operation, "images.edits");
});

test("failed drawing job polling exposes only actionable closed error facts", async () => {
  const { api, backend } = fixture();
  const job = backend.createJob({ operation: "images.generations", requestedModel: "local/image" }, {
    status: "failed",
    error: {
      code: "compute_worker_unavailable",
      message: "The queued model execution could not be completed",
      retryable: true,
      guidanceKey: "tasks.compute.retry_later",
      retryAction: "retry",
      physicalOrigin: "http://worker-secret:8000",
    },
  });
  const result = await api.handle({ method: "GET", pathname: `/api/v1/jobs/${job.jobId}`, context });
  assert.deepEqual(result.body.error, {
    code: "compute_worker_unavailable",
    message: "The queued model execution could not be completed",
    retryable: true,
    guidance_key: "tasks.compute.retry_later",
    retry_action: "retry",
  });
  assert.equal(JSON.stringify(result.body).includes("worker-secret"), false);
});

test("OCR, ASR, and translation extensions accept scoped references and always return jobs", async () => {
  const { api, backend } = fixture();
  const referenceId = "22222222-2222-4222-8222-222222222222";
  const ocr = await api.handle({
    method: "POST",
    pathname: "/api/v1/ai/ocr",
    context,
    headers: { "idempotency-key": "ocr-one" },
    body: {
      input: { reference_id: referenceId },
      output_format: "markdown",
      language_hints: ["zh-CN", "en"],
      x_teamaibox: { background: true },
    },
  });
  assert.equal(ocr.status, 202);
  assert.equal(ocr.body.operation, "ocr");
  assert.equal(ocr.body.result_schema, "teamaibox.ai.ocr-result.v1");
  assert.match(ocr.body.links.self, /^\/api\/v1\/jobs\//);
  assert.equal(backend.submissions[0].request.input.referenceId, referenceId);
  assert.equal(backend.submissions[0].deferDispatch, true);

  const asr = await api.handle({
    method: "POST",
    pathname: "/api/v1/ai/transcriptions",
    context,
    headers: { "idempotency-key": "asr-one" },
    body: {
      input: { reference_id: referenceId },
      language: "zh-CN",
      output_format: "json",
      timestamp_granularities: ["segment", "word"],
      speaker_information: true,
    },
  });
  assert.equal(asr.status, 202);
  assert.equal(asr.body.operation, "transcriptions");
  assert.equal(asr.body.result_schema, "teamaibox.ai.asr-result.v1");
  assert.deepEqual(backend.submissions[1].request.timestampGranularities, ["segment", "word"]);
  assert.equal(backend.submissions[1].request.speakerInformation, true);

  const translation = await api.handle({
    method: "POST",
    pathname: "/api/v1/ai/translations",
    context,
    body: { input_text: "你好", source_language: "zh-CN", target_language: "en" },
  });
  assert.equal(translation.status, 202);
  assert.equal(translation.body.operation, "translations");
  assert.equal(translation.body.result_schema, "teamaibox.ai.translation-result.v1");
  assert.deepEqual(backend.submissions[2].request.input, { text: "你好" });
  assert.equal(backend.submissions[2].request.inputKind, "text");
  assert.deepEqual(backend.submissions[2].request.workflow, [
    { stageId: "translate", capabilityKey: "translation", dependsOn: [] },
  ]);

  const mediaTranslation = await api.handle({
    method: "POST",
    pathname: "/api/v1/ai/translations",
    context,
    body: {
      input_reference: { reference_id: referenceId },
      input_kind: "video",
      target_language: "en",
      output_format: "vtt",
      include_intermediates: true,
    },
  });
  assert.equal(mediaTranslation.status, 202);
  assert.deepEqual(backend.submissions[3].request.workflow.map((stage) => stage.capabilityKey), [
    "asr", "translation", "subtitle-compose",
  ]);

  const ocrHandoff = await api.handle({
    method: "POST", pathname: "/api/v1/ai/translations", context,
    body: {
      input_reference: { reference_id: referenceId }, input_kind: "document",
      input_representation: "ocr-result", target_language: "en",
    },
  });
  assert.equal(ocrHandoff.status, 202);
  assert.deepEqual(backend.submissions[4].request.workflow.map((stage) => stage.capabilityKey), ["translation"]);
});

test("translation composition rejects ambiguous inputs and subtitles for non-media", async () => {
  const { api } = fixture();
  const referenceId = randomUUID();
  await assert.rejects(api.handle({
    method: "POST", pathname: "/api/v1/ai/translations", context,
    body: { input_reference: { reference_id: referenceId }, target_language: "en" },
  }), (error) => error.code === "invalid_compute_request" && error.details?.param === "input_kind");
  await assert.rejects(api.handle({
    method: "POST", pathname: "/api/v1/ai/translations", context,
    body: { input_text: "hello", target_language: "zh-CN", output_format: "srt" },
  }), (error) => error.code === "invalid_compute_request" && error.details?.param === "output_format");
  await assert.rejects(api.handle({
    method: "POST", pathname: "/api/v1/ai/translations", context,
    body: { input_reference: { reference_id: referenceId }, input_kind: "image", input_representation: "asr-result", target_language: "en" },
  }), (error) => error.code === "invalid_compute_request" && error.details?.param === "input_representation");
});

test("realtime admission is visible as a bounded reservation and bypasses job submission", async () => {
  const { api, backend } = fixture();
  const admitted = await api.handle({
    method: "POST",
    pathname: "/api/v1/realtime/sessions",
    context,
    body: {
      capability: "translation",
      model: "local/realtime-translation",
      expires_in_seconds: 300,
      input: { language: "zh-CN" },
      output: { language: "en" },
    },
  });
  assert.equal(admitted.status, 201);
  assert.equal(admitted.body.status, "admitted");
  assert.equal(admitted.body.protocol_version, 1);
  assert.match(admitted.body.websocket_url, /^\/api\/v1\/realtime\/sessions\//);
  assert.equal(backend.submissions.length, 0);
  assert.equal(backend.admissions.length, 1);
});

test("realtime WebSocket lifecycle is owner scoped and forwards one stable connection identity", async () => {
  const { api } = fixture();
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const connected = await api.connectRealtimeSession({
    pathname: `/api/v1/realtime/sessions/${sessionId}/stream`,
    context,
    connectionId: "connection-a",
    now: new Date("2026-08-10T00:00:01.000Z"),
  });
  assert.equal(connected.state, "connected");
  const heartbeat = await api.heartbeatRealtimeSession({
    sessionId, context, connectionId: "connection-a",
  });
  assert.equal(heartbeat.sessionId, sessionId);
  const released = await api.disconnectRealtimeSession({
    sessionId, context, connectionId: "connection-a", reason: "websocket_disconnect",
  });
  assert.equal(released.state, "released");
  await assert.rejects(api.connectRealtimeSession({
    pathname: "/api/v1/realtime/sessions/not-a-uuid/stream", context, connectionId: "connection-b",
  }), { code: "not_found" });
});

test("requests cannot pin physical infrastructure and conflicting idempotency facts fail closed", async () => {
  const { api } = fixture();
  await assert.rejects(api.handle({
    method: "POST",
    pathname: "/v1/chat/completions",
    context,
    body: {
      model: "local/chat",
      messages: [{ role: "user", content: "hi" }],
      x_teamaibox: { node_id: "spark-a" },
    },
  }), (error) => error.code === "invalid_compute_request" && error.status === 400);
  await assert.rejects(api.handle({
    method: "POST",
    pathname: "/v1/embeddings",
    context,
    headers: { "idempotency-key": "header-key" },
    body: {
      model: "local/embed",
      input: "hi",
      x_teamaibox: { idempotency_key: "body-key" },
    },
  }), (error) => error.code === "invalid_compute_request");
  await assert.rejects(api.handle({
    method: "POST",
    pathname: "/api/v1/ai/ocr",
    context,
    body: {
      input: { reference_id: "22222222-2222-4222-8222-222222222222", unexpected: true },
      output_formt: "text",
    },
  }), (error) => error.code === "invalid_compute_request" && error.details?.param === "output_formt");
});
