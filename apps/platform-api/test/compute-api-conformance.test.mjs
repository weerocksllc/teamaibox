import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { EnvelopeEncryptedBlobStore } from "../../../services/object-service/src/envelope-encrypted-blob-store.mjs";
import { MemoryVersionedEnvelopeKeyring } from "../../../services/object-service/src/envelope-keyring.mjs";
import { MemoryEnvelopeMetadataRepository } from "../../../services/object-service/src/envelope-metadata-repository.mjs";
import { MemoryBlobStore } from "../../../services/object-service/src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../../../services/object-service/src/memory-repository.mjs";
import { ProtectedObjectService } from "../../../services/object-service/src/object-service.mjs";
import { createPlatformApiServer } from "../server/platform-api.mjs";
import {
  ComputeHttpApi,
  computeApiClaims,
  matchesComputeHttpRoute,
  matchesComputeRealtimeRoute,
} from "../src/compute/compute-http-api.mjs";
import { DurableJobService } from "../src/compute/durable-job-service.mjs";
import { ObjectJobPayloadStore } from "../src/compute/job-payload-store.mjs";
import { MemoryDurableJobRepository } from "../src/compute/memory-durable-job-repository.mjs";

const ownerIdentityId = "11111111-1111-4111-8111-111111111111";
const jobId = "11111111-1111-4111-8111-111111111111";
const responseId = "resp_11111111111111111111111111111111";
const referenceId = "22222222-2222-4222-8222-222222222222";
const artifactReferenceId = "33333333-3333-4333-8333-333333333333";
const bearer = "taib_conformance_bearer_1234567890";

const matrix = JSON.parse(await readFile(
  new URL("../../../architecture/validation/compute-api-conformance.v1.json", import.meta.url),
  "utf8",
));

function artifactRef() {
  return {
    schemaVersion: 1,
    artifactId: "44444444-4444-4444-8444-444444444444",
    relationship: "output",
    label: "recognized.md",
    dataClass: "confidential",
    object: { objectId: "55555555-5555-4555-8555-555555555555", objectVersion: 1, referenceId: artifactReferenceId },
    mediaType: "text/markdown",
    sizeBytes: 12,
    integrity: { algorithm: "sha256", digest: "a".repeat(64) },
    lifecycleState: "verified",
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function job(overrides = {}) {
  return {
    jobId,
    responseId,
    operation: "ocr",
    status: "succeeded",
    route: "local",
    model: "local/test",
    profileId: null,
    attemptId: null,
    output: [{ type: "output_text", text: "done" }],
    result: {
      schema: "teamaibox.ai.ocr-result.v1",
      job_id: jobId,
      text: "recognized",
      pages: [],
      artifacts: [artifactRef()],
    },
    error: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

class ConformanceBackend {
  calls = [];
  cancellations = [];
  realtime = [];

  async submit(work) {
    this.calls.push(structuredClone(work));
    return job({
      jobId: randomUUID(),
      responseId: work.operation === "responses" ? `resp_${randomUUID().replaceAll("-", "")}` : null,
      operation: work.operation,
      status: "queued",
      route: "unassigned",
      model: work.requestedModel,
      output: [],
      result: null,
    });
  }

  async invoke(work) {
    this.calls.push(structuredClone(work));
    const bodies = {
      "chat.completions": {
        id: "chatcmpl_conformance", object: "chat.completion", created: 1786406400,
        model: work.requestedModel,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      },
      responses: {
        id: "resp_conformance", object: "response", created_at: 1786406400,
        status: "completed", model: work.requestedModel, output: [{ type: "output_text", text: "ok" }], error: null,
      },
      embeddings: {
        object: "list", model: work.requestedModel,
        data: [{ object: "embedding", index: 0, embedding: [0.25, 0.75] }],
      },
      "images.generations": { created: 1786406400, data: [{ b64_json: "aW1hZ2U=" }] },
    };
    return { job: job({ operation: work.operation, model: work.requestedModel }), body: bodies[work.operation] };
  }

  async stream(work) {
    this.calls.push(structuredClone(work));
    return (async function* streamEvents() {
      if (work.operation === "chat.completions") {
        yield { data: { id: "chatcmpl_stream", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] } };
      } else {
        yield { event: "response.created", data: { type: "response.created", response: { id: "resp_stream", status: "in_progress" } } };
        yield { event: "response.completed", data: { type: "response.completed", response: { id: "resp_stream", status: "completed" } } };
      }
    }());
  }

  async getJob({ jobId: requestedJobId, responseId: requestedResponseId }) {
    if (requestedJobId === jobId) return job();
    if (requestedResponseId === responseId) {
      return job({ operation: "responses", model: "local/reasoning", result: null });
    }
    throw new PlatformError("job_not_found", "Compute job was not found", { status: 404 });
  }

  async cancelJob({ jobId: requestedJobId, responseId: requestedResponseId }) {
    if (requestedJobId !== jobId && requestedResponseId !== responseId) {
      throw new PlatformError("job_not_found", "Compute job was not found", { status: 404 });
    }
    this.cancellations.push(requestedJobId ?? requestedResponseId);
    return job({
      operation: requestedResponseId ? "responses" : "ocr",
      model: requestedResponseId ? "local/reasoning" : "local/ocr",
      status: "cancelled",
      result: null,
      output: [],
    });
  }

  async admitRealtime(input) {
    this.realtime.push({ type: "admit", input: structuredClone(input) });
    const sessionId = "66666666-6666-4666-8666-666666666666";
    return {
      sessionId,
      expiresAt: "2026-08-11T00:05:00.000Z",
      reservation: {
        reservation_id: sessionId,
        reservation_kind: "realtime",
        priority_class: "latency",
        latency_budget_milliseconds: 250,
        protected_from_batch: true,
        resources: {
          cpu_millis: 1000,
          unified_memory_bytes: 2147483648,
          accelerator_units: 0,
          codec_sessions: 1,
          storage_bytes: 0,
          network_bits_per_second: 100000000,
          codec_encode_sessions: 0,
          codec_decode_sessions: 1
        }
      }
    };
  }

  async connectRealtime(input) {
    this.realtime.push({ type: "connect", input: structuredClone(input) });
    return {
      sessionId: input.sessionId,
      state: "connected",
      capability: "translation",
      model: "local/realtime-translation",
      expiresAt: "2026-08-11T00:05:00.000Z",
      reservation: { reservation_id: input.sessionId },
    };
  }

  async heartbeatRealtime(input) {
    this.realtime.push({ type: "heartbeat", input: structuredClone(input) });
    return this.connectRealtime(input);
  }

  async disconnectRealtime(input) {
    this.realtime.push({ type: "disconnect", input: structuredClone(input) });
    return { ...(await this.connectRealtime(input)), state: "released" };
  }
}

function fixture() {
  const backend = new ConformanceBackend();
  return { api: new ComputeHttpApi({ backend }), backend };
}

function submissionFor(claimId) {
  const structuredSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const inputs = {
    "openai.chat-completions.create": {
      model: "local/chat",
      messages: [{ role: "user", content: [{ type: "text", text: "answer as JSON" }] }],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: structuredSchema } },
    },
    "openai.responses.create": {
      model: "local/reasoning",
      input: [{ role: "user", content: [{ type: "input_text", text: "answer as JSON" }] }],
      text: { format: { type: "json_schema", name: "answer", strict: true, schema: structuredSchema } },
    },
    "openai.embeddings.create": { model: "local/embedding", input: ["one", "two"] },
    "openai.images.generate": { model: "local/image", prompt: "a private robot", n: 1 },
    "extension.images.edit": { prompt: "make it blue", input: { reference_id: referenceId }, seed: 42 },
    "extension.ocr.submit": { input: { reference_id: referenceId }, output_format: "markdown" },
    "extension.asr.submit": { input: { reference_id: referenceId }, output_format: "json", timestamp_granularities: ["segment", "word"] },
    "extension.translations.submit": { input_reference: { reference_id: referenceId }, input_kind: "image", target_language: "en" },
    "extension.realtime.admit": { capability: "translation", model: "local/realtime-translation", expires_in_seconds: 300 },
  };
  return inputs[claimId] ?? null;
}

test("conformance matrix exactly covers every runtime claim and every required dimension", () => {
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.claimPolicy.exactRuntimeClaimSet, true);
  assert.equal(matrix.claimPolicy.missingDimensionBlocksCertification, true);
  const runtime = computeApiClaims.map((claim) => ({ ...claim }));
  const declared = matrix.claims.map(({ representativePath: _path, checks: _checks, ...claim }) => claim);
  assert.deepEqual(declared, runtime);
  assert.equal(new Set(matrix.claims.map((claim) => claim.id)).size, matrix.claims.length);
  for (const claim of matrix.claims) {
    assert.deepEqual(Object.keys(claim.checks).sort(), [...matrix.claimPolicy.requiredDimensions].sort(), claim.id);
    for (const [dimension, check] of Object.entries(claim.checks)) {
      assert.match(check, /^[a-z][a-z0-9-]{2,127}$/, `${claim.id}:${dimension}`);
    }
    const matches = claim.protocol === "websocket"
      ? matchesComputeRealtimeRoute(claim.representativePath)
      : matchesComputeHttpRoute(claim.method, claim.representativePath);
    assert.equal(matches, true, claim.id);
  }
});

for (const claim of matrix.claims) {
  test(`conformance endpoint: ${claim.id}`, async () => {
    const { api, backend } = fixture();
    const context = { identityId: ownerIdentityId };
    if (claim.protocol === "websocket") {
      const connectionId = "conformance-connection";
      const connected = await api.connectRealtimeSession({
        pathname: claim.representativePath, context, connectionId,
      });
      assert.equal(connected.state, "connected");
      const released = await api.disconnectRealtimeSession({
        sessionId: connected.sessionId, context, connectionId, reason: "conformance_complete",
      });
      assert.equal(released.state, "released");
      assert.deepEqual(backend.realtime.filter((event) => event.type === "disconnect").map((event) => event.input.connectionId), [connectionId]);
      return;
    }

    const result = await api.handle({
      method: claim.method,
      pathname: claim.representativePath,
      context,
      headers: submissionFor(claim.id) ? { "idempotency-key": `conformance-${claim.id}` } : {},
      body: submissionFor(claim.id),
      requestId: `conformance-${claim.id}`,
    });
    assert.equal(result.kind, "json");
    if (claim.id === "openai.chat-completions.create") {
      assert.equal(result.body.object, "chat.completion");
      assert.equal(backend.calls[0].request.response_format.json_schema.strict, true);
      assert.equal(backend.calls[0].request.messages[0].content[0].type, "text");
    } else if (claim.id === "openai.responses.create") {
      assert.equal(result.body.object, "response");
      assert.equal(backend.calls[0].capabilityKey, "text-transform");
      assert.equal(backend.calls[0].request.text.format.type, "json_schema");
      assert.equal(backend.calls[0].request.input[0].content[0].type, "input_text");
    } else if (claim.id === "openai.responses.retrieve") {
      assert.equal(result.body.id, responseId);
      assert.deepEqual(result.body.output, [{ type: "output_text", text: "done" }]);
    } else if (claim.id === "openai.responses.cancel") {
      assert.equal(result.status, 200);
      assert.equal(result.body.status, "cancelled");
    } else if (claim.id === "openai.embeddings.create") {
      assert.equal(result.body.data[0].object, "embedding");
    } else if (claim.id === "openai.images.generate") {
      assert.equal(result.body.data[0].b64_json, "aW1hZ2U=");
    } else if (["extension.images.edit", "extension.ocr.submit", "extension.asr.submit", "extension.translations.submit"].includes(claim.id)) {
      assert.equal(result.status, 202);
      assert.equal(backend.calls[0].request.input.referenceId, referenceId);
    } else if (claim.id === "extension.jobs.retrieve") {
      assert.equal(result.status, 200);
      assert.equal(result.body.result.artifacts[0].object.referenceId, artifactReferenceId);
      assert.equal(JSON.stringify(result.body).includes("access_key"), false);
    } else if (claim.id === "extension.jobs.cancel") {
      assert.equal(result.status, 202);
      assert.equal(result.body.status, "cancelled");
    } else if (claim.id === "extension.realtime.admit") {
      assert.equal(result.status, 201);
      assert.match(result.body.websocket_url, /\/stream$/);
      assert.equal(result.body.reservation.protected_from_batch, true);
    }
  });
}

test("conformance streaming preserves Chat and Responses wire shapes", async () => {
  const { api } = fixture();
  const context = { identityId: ownerIdentityId };
  const chat = await api.handle({
    method: "POST", pathname: "/v1/chat/completions", context,
    body: { model: "local/chat", messages: [{ role: "user", content: "hello" }], stream: true },
  });
  assert.equal(chat.doneMarker, "[DONE]");
  const chatEvents = [];
  for await (const event of chat.events) chatEvents.push(event);
  assert.equal(chatEvents.every((event) => event.event === undefined && event.data.object === "chat.completion.chunk"), true);

  const responses = await api.handle({
    method: "POST", pathname: "/v1/responses", context,
    body: { model: "local/reasoning", input: "hello", stream: true },
  });
  assert.equal(responses.doneMarker, null);
  const responseEvents = [];
  for await (const event of responses.events) responseEvents.push(event);
  assert.deepEqual(responseEvents.map((event) => [event.event, event.data.type]), [
    ["response.created", "response.created"],
    ["response.completed", "response.completed"],
  ]);
});

test("conformance rejects malformed structured-output declarations and unsupported streams", async () => {
  const { api } = fixture();
  const context = { identityId: ownerIdentityId };
  await assert.rejects(api.handle({
    method: "POST", pathname: "/v1/chat/completions", context,
    body: {
      model: "local/chat", messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_schema", json_schema: { name: "unsafe", schema: "not-an-object" } },
    },
  }), (error) => error.code === "invalid_compute_request" && error.details?.param === "response_format");
  await assert.rejects(api.handle({
    method: "POST", pathname: "/v1/responses", context,
    body: { model: "local/reasoning", input: "hello", text: { format: { type: "yaml" } } },
  }), (error) => error.code === "invalid_compute_request" && error.details?.param === "text.format.type");
  await assert.rejects(api.handle({
    method: "POST", pathname: "/v1/embeddings", context,
    body: { model: "local/embedding", input: "hello", stream: true },
  }), (error) => error.code === "invalid_compute_request" && error.details?.param === "stream");
});

function invalidRequestFor(claim) {
  if (claim.method === "GET") return null;
  const invalid = {
    "openai.chat-completions.create": { model: "local/chat" },
    "openai.responses.create": { model: "local/reasoning" },
    "openai.responses.cancel": null,
    "openai.embeddings.create": { model: "local/embedding" },
    "openai.images.generate": { model: "local/image" },
    "extension.images.edit": { prompt: "missing input" },
    "extension.ocr.submit": { output_format: "text" },
    "extension.asr.submit": { output_format: "json" },
    "extension.translations.submit": { input_text: "hello" },
    "extension.jobs.cancel": null,
    "extension.realtime.admit": { capability: "unknown" },
  };
  return invalid[claim.id] ?? null;
}

function httpRequestJson(server, { method, path, body }) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method,
      path,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    if (body !== null) request.write(JSON.stringify(body));
    request.end();
  });
}

test("conformance transport emits the declared error schema for every HTTP claim", async (t) => {
  const backend = new ConformanceBackend();
  const server = createPlatformApiServer({
    authentication: {},
    preferences: {},
    publicOrigin: "https://spark.test",
    logger: { warn() {}, info() {}, error() {} },
    computeApi: new ComputeHttpApi({ backend }),
    credentialAuthentication: {
      async authenticate() { return { identityId: ownerIdentityId, credentialId: randomUUID() }; },
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());

  for (const claim of matrix.claims.filter((candidate) => candidate.protocol === "http")) {
    const dynamicMissingPath = claim.representativePath
      .replace(responseId, "resp_99999999999999999999999999999999")
      .replace(jobId, "99999999-9999-4999-8999-999999999999");
    const body = invalidRequestFor(claim);
    const response = await httpRequestJson(server, {
      method: claim.method,
      path: dynamicMissingPath,
      body,
    });
    assert.ok(response.status >= 400 && response.status < 500, claim.id);
    assert.equal(response.headers["x-request-id"].length > 7, true, claim.id);
    if (claim.family === "openai") {
      assert.deepEqual(Object.keys(response.body), ["error"], claim.id);
      assert.equal(typeof response.body.error.message, "string", claim.id);
      assert.equal(typeof response.body.error.type, "string", claim.id);
      assert.equal(typeof response.body.error.code, "string", claim.id);
      assert.equal("param" in response.body.error, true, claim.id);
      assert.equal(response.body.error.x_teamaibox.correlation_id, response.headers["x-request-id"], claim.id);
    } else {
      assert.deepEqual(Object.keys(response.body), ["error"], claim.id);
      assert.equal(typeof response.body.error.code, "string", claim.id);
      assert.equal(typeof response.body.error.retryable, "boolean", claim.id);
      assert.equal(response.body.error.correlationId, response.headers["x-request-id"], claim.id);
    }
  }
});

test("conformance cancellation is idempotent and preserves one terminal state", async () => {
  const { api, backend } = fixture();
  const context = { identityId: ownerIdentityId };
  const first = await api.handle({
    method: "POST", pathname: `/api/v1/jobs/${jobId}/cancel`, context,
  });
  const replay = await api.handle({
    method: "POST", pathname: `/api/v1/jobs/${jobId}/cancel`, context,
  });
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal(first.body.job_id, replay.body.job_id);
  assert.equal(replay.body.status, "cancelled");
  assert.deepEqual(backend.cancellations, [jobId, jobId]);
});

test("conformance durable idempotency covers every non-realtime creation claim", async (t) => {
  const clock = () => new Date("2026-08-11T00:00:00.000Z");
  const rawStore = new MemoryBlobStore({ clock });
  const keyring = new MemoryVersionedEnvelopeKeyring(Buffer.alloc(32, 71));
  t.after(() => keyring.close());
  const objects = new ProtectedObjectService({
    repository: new MemoryObjectRepository({ defaultQuotaBytes: 32 * 1024 * 1024 }),
    blobStore: new EnvelopeEncryptedBlobStore({
      rawStore,
      metadataRepository: new MemoryEnvelopeMetadataRepository(),
      keyring,
      clock,
    }),
    referenceSigningKey: Buffer.alloc(32, 72),
    clock,
  });
  const repository = new MemoryDurableJobRepository();
  const jobs = new DurableJobService({
    repository,
    payloadStore: new ObjectJobPayloadStore({ objectService: objects, clock }),
    resolveCapability: async (capabilityKey) => ({
      capabilityId: "77777777-7777-4777-8777-777777777777",
      enabled: true,
      operations: {
        chat: ["chat.completions"],
        "text-transform": ["responses"],
        embedding: ["embeddings"],
        "image-generation": ["images.generations", "images.edits"],
        ocr: ["ocr"],
        asr: ["transcriptions"],
        translation: ["translations"],
      }[capabilityKey] ?? [],
    }),
    clock,
  });
  const unsupported = async () => { throw new Error("conformance path unexpectedly bypassed the durable queue"); };
  const api = new ComputeHttpApi({
    backend: {
      submit: (work) => jobs.submit(work),
      invoke: unsupported,
      stream: unsupported,
      getJob: (input) => jobs.get(input),
      cancelJob: (input) => jobs.cancel(input),
      admitRealtime: unsupported,
      connectRealtime: unsupported,
      heartbeatRealtime: unsupported,
      disconnectRealtime: unsupported,
    },
  });
  const creations = matrix.claims.filter((claim) => claim.checks.idempotency === "durable-request-fingerprint");
  assert.deepEqual(creations.map((claim) => claim.id), [
    "openai.chat-completions.create",
    "openai.responses.create",
    "openai.embeddings.create",
    "openai.images.generate",
    "extension.images.edit",
    "extension.ocr.submit",
    "extension.asr.submit",
    "extension.translations.submit",
  ]);

  for (const claim of creations) {
    const base = submissionFor(claim.id);
    const body = {
      ...structuredClone(base),
      x_teamaibox: { background: true, priority: 50, data_class: "confidential" },
    };
    const key = `durable-${claim.operation}`;
    const invoke = (requestBody) => api.handle({
      method: claim.method,
      pathname: claim.representativePath,
      context: { identityId: ownerIdentityId },
      headers: { "idempotency-key": key },
      body: requestBody,
      requestId: `idempotency-${claim.id}`,
    });
    const first = await invoke(body);
    const replay = await invoke(structuredClone(body));
    assert.equal(replay.body.x_teamaibox.job_id, first.body.x_teamaibox.job_id, claim.id);
    await assert.rejects(
      invoke({ ...structuredClone(body), x_teamaibox: { ...body.x_teamaibox, priority: 51 } }),
      (error) => error.code === "idempotency_conflict" && error.status === 409,
      claim.id,
    );
  }
  assert.equal((await repository.snapshot()).length, creations.length);
  const raw = await rawStore.list();
  assert.equal(raw.length, creations.length);
});
