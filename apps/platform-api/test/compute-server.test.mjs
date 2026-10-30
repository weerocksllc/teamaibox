import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { createPlatformApiServer } from "../server/platform-api.mjs";
import { ComputeHttpApi } from "../src/compute/compute-http-api.mjs";
import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { PasswordHasher } from "../src/identity/password.mjs";
import { IdentityPreferencesService } from "../src/identity/preferences-service.mjs";

const publicOrigin = "https://spark.test";
const ownerPassword = "correct horse battery staple";
const bearerSecret = "taib_dev_compute_contract_secret_123456789";

function request(server, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method,
      path,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    if (body !== null) outgoing.write(body);
    outgoing.end();
  });
}

function websocket(server, { path, headers = {} }) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        ...headers,
      },
    });
    outgoing.once("upgrade", (response, socket, head) => {
      const finish = (payload) => {
        socket.destroy();
        resolve({ status: response.statusCode, payload });
      };
      if (head.length) finish(head);
      else socket.once("data", finish);
      socket.setTimeout(2_000, () => {
        socket.destroy();
        reject(new Error("Realtime WebSocket bootstrap timed out"));
      });
    });
    outgoing.once("response", (response) => reject(new Error(`unexpected WebSocket response ${response.statusCode}`)));
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function websocketPayload(frame) {
  const length = frame[1] & 0x7f;
  if (length < 126) return frame.subarray(2, 2 + length);
  if (length === 126) {
    const extended = frame.readUInt16BE(2);
    return frame.subarray(4, 4 + extended);
  }
  throw new Error("test does not accept 64-bit WebSocket frame lengths");
}

function maskedWebsocketFrame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const mask = randomBytes(4);
  let header;
  if (payload.byteLength < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.byteLength]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.byteLength, 2);
  }
  const encoded = Buffer.from(payload);
  for (let index = 0; index < encoded.byteLength; index += 1) encoded[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, encoded]);
}

function websocketConversation(server, { path, headers = {} }) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        ...headers,
      },
    });
    outgoing.once("upgrade", (response, socket, head) => resolve({ response, socket, head }));
    outgoing.once("response", (response) => reject(new Error(`unexpected WebSocket response ${response.statusCode}`)));
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function websocketEvents(socket, head = Buffer.alloc(0)) {
  let pending = Buffer.from(head);
  const events = [];
  const waiters = [];
  const parse = () => {
    while (pending.byteLength >= 2) {
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.byteLength < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      }
      if (length === 127 || pending.byteLength < offset + length) return;
      const opcode = pending[0] & 0x0f;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      pending = Buffer.from(pending.subarray(offset + length));
      if (opcode === 1) {
        const item = JSON.parse(payload.toString("utf8"));
        events.push(item);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(item)) {
            clearTimeout(waiter.timer);
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(item);
          }
        }
      }
    }
  };
  socket.on("data", (chunk) => { pending = Buffer.concat([pending, chunk]); parse(); });
  parse();
  return {
    events,
    wait(predicate, timeoutMilliseconds = 2_000) {
      const matched = events.find(predicate);
      if (matched) return Promise.resolve(matched);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`WebSocket event timed out: ${JSON.stringify(events)}`));
        }, timeoutMilliseconds);
        waiters.push(waiter);
      });
    },
  };
}

class ComputeBackend {
  calls = [];
  realtimeCalls = [];
  realtimeSessions = new Map();

  job(work, overrides = {}) {
    return {
      jobId: randomUUID(),
      responseId: `resp_${randomUUID().replaceAll("-", "")}`,
      operation: work.operation,
      status: "succeeded",
      route: "local",
      createdAt: "2026-08-10T00:00:00.000Z",
      ...overrides,
    };
  }

  async invoke(work) {
    this.calls.push(work);
    return {
      job: this.job(work),
      body: {
        id: "chatcmpl_http_contract",
        object: "chat.completion",
        created: 1786320000,
        model: work.requestedModel,
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      },
    };
  }

  async stream(work) {
    this.calls.push(work);
    return (async function* events() {
      yield {
        data: {
          id: "chatcmpl_http_stream",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
        },
      };
    }());
  }

  async submit(work) {
    this.calls.push(work);
    return this.job(work, { status: "queued", route: "unassigned" });
  }

  async getJob() {
    throw new Error("not used");
  }

  async cancelJob() {
    throw new Error("not used");
  }

  async admitRealtime(input) {
    this.realtimeCalls.push({ operation: "admit", input: structuredClone(input) });
    const sessionId = randomUUID();
    this.realtimeSessions.set(sessionId, { capability: input.capability, model: input.model });
    return {
      sessionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reservation: {
        reservation_id: sessionId,
        reservation_kind: "realtime",
        priority_class: "latency",
        latency_budget_milliseconds: 250,
        protected_from_batch: true,
        resources: {
          cpu_millis: 1_000,
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

  async connectRealtime(input) {
    this.realtimeCalls.push({ operation: "connect", input: structuredClone(input) });
    const declared = this.realtimeSessions.get(input.sessionId) ?? { capability: "translation", model: "local/realtime-translation" };
    return {
      sessionId: input.sessionId,
      state: "connected",
      capability: declared.capability,
      model: declared.model,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reservation: { reservation_id: input.sessionId },
    };
  }

  async heartbeatRealtime(input) {
    this.realtimeCalls.push({ operation: "heartbeat", input: structuredClone(input) });
    return this.connectRealtime(input);
  }

  async disconnectRealtime(input) {
    this.realtimeCalls.push({ operation: "disconnect", input: structuredClone(input) });
    return { ...(await this.connectRealtime(input)), state: "released" };
  }
}

async function fixture({ enableCompute = true, credentialContext = null, realtimeSpeechTransport = null } = {}) {
  const repository = new MemoryIdentityRepository();
  const authentication = await LocalAuthentication.create({
    repository,
    hasher: new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 }),
  });
  await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password: ownerPassword });
  const preferences = new IdentityPreferencesService({ repository });
  const backend = new ComputeBackend();
  const credentialCalls = [];
  const credentialAuthentication = {
    async authenticate(input) {
      credentialCalls.push(structuredClone(input));
      if (input.secret !== bearerSecret) throw new Error("test rejected credential");
      return credentialContext ?? { identityId: "22222222-2222-4222-8222-222222222222", credentialId: randomUUID() };
    },
  };
  const warnings = [];
  const logger = { warn: (...values) => warnings.push(values), info() {}, error() {} };
  const server = createPlatformApiServer({
    authentication,
    preferences,
    publicOrigin,
    logger,
    computeApi: enableCompute ? new ComputeHttpApi({ backend }) : null,
    credentialAuthentication,
    realtimeSpeechTransport,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, backend, credentialCalls, warnings };
}

async function signIn(server) {
  const response = await request(server, {
    method: "POST",
    path: "/api/auth/sign-in",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ loginName: "owner", password: ownerPassword }),
  });
  assert.equal(response.status, 200, response.text);
  const body = JSON.parse(response.text);
  return {
    cookie: response.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; "),
    csrfToken: body.csrfToken,
  };
}

function chatBody(extra = {}) {
  return JSON.stringify({
    model: "local/chat",
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  });
}

test("OpenAI-compatible routes require authentication and use the OpenAI error envelope", async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const response = await request(server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-forwarded-proto": "https",
    },
    body: chatBody(),
  });
  assert.equal(response.status, 401);
  const failure = JSON.parse(response.text).error;
  assert.equal(failure.type, "authentication_error");
  assert.equal(failure.code, "invalid_session");
  assert.equal(failure.param, null);
  assert.equal(failure.x_teamaibox.correlation_id, response.headers["x-request-id"]);
});

test("browser compute calls require same-origin CSRF and retain the standard response shape", async (t) => {
  const { server, backend } = await fixture();
  t.after(() => server.close());
  const session = await signIn(server);
  const missingCsrf = await request(server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      origin: publicOrigin,
      "x-forwarded-proto": "https",
    },
    body: chatBody(),
  });
  assert.equal(missingCsrf.status, 401);
  assert.equal(JSON.parse(missingCsrf.text).error.code, "invalid_session");

  const badCsrf = await request(server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": "A".repeat(43),
      "x-forwarded-proto": "https",
    },
    body: chatBody(),
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(JSON.parse(badCsrf.text).error.code, "csrf_failed");

  const completed = await request(server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": session.csrfToken,
      "x-forwarded-proto": "https",
    },
    body: chatBody(),
  });
  assert.equal(completed.status, 200, completed.text);
  const body = JSON.parse(completed.text);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "hello");
  assert.equal(body.x_teamaibox.route, "local");
  assert.equal(backend.calls.length, 1);
});

test("Bearer credentials invoke compute without browser origin state and are never logged", async (t) => {
  const { server, backend, credentialCalls, warnings } = await fixture();
  t.after(() => server.close());
  const completed = await request(server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      authorization: `Bearer ${bearerSecret}`,
      "content-type": "application/json",
      "x-forwarded-proto": "https",
    },
    body: chatBody(),
  });
  assert.equal(completed.status, 200, completed.text);
  assert.equal(credentialCalls.length, 1);
  assert.equal(credentialCalls[0].permission, "ai:invoke");
  assert.deepEqual(credentialCalls[0].operation, { method: "POST", pathname: "/v1/chat/completions" });
  assert.equal(backend.calls[0].ownerIdentityId, "22222222-2222-4222-8222-222222222222");

  const rejected = await request(server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      authorization: "Bearer too-short",
      "content-type": "application/json",
      "x-forwarded-proto": "https",
    },
    body: chatBody(),
  });
  assert.equal(rejected.status, 401);
  assert.equal(JSON.parse(rejected.text).error.code, "invalid_credential");
  assert.equal(JSON.stringify(warnings).includes(bearerSecret), false);
});

test("sandbox Bearer credentials cannot escape their projected backend model aliases", async (t) => {
  const { server, backend } = await fixture({
    credentialContext: {
      identityId: "22222222-2222-4222-8222-222222222222",
      credentialId: randomUUID(),
      identityKind: "agent_sandbox",
      modelAliases: ["local/agent-only"],
    },
  });
  t.after(() => server.close());
  const denied = await request(server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { authorization: `Bearer ${bearerSecret}`, "content-type": "application/json", "x-forwarded-proto": "https" },
    body: chatBody(),
  });
  assert.equal(denied.status, 403, denied.text);
  assert.equal(JSON.parse(denied.text).error.code, "access_denied");
  assert.equal(backend.calls.length, 0);
});

test("Chat streaming is serialized as standard SSE and terminates with the done marker", async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const response = await request(server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      authorization: `Bearer ${bearerSecret}`,
      "content-type": "application/json",
      "x-forwarded-proto": "https",
    },
    body: chatBody({ stream: true }),
  });
  assert.equal(response.status, 200, response.text);
  assert.match(response.headers["content-type"], /^text\/event-stream/);
  assert.match(response.text, /data: \{"id":"chatcmpl_http_stream"/);
  assert.match(response.text, /data: \[DONE\]\n\n$/);
});

test("admitted realtime WebSocket connects with the owner and releases on disconnect", async (t) => {
  const { server, backend } = await fixture();
  t.after(() => server.close());
  const session = await signIn(server);
  const admittedResponse = await request(server, {
    method: "POST",
    path: "/api/v1/realtime/sessions",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": session.csrfToken,
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({
      capability: "translation",
      model: "local/realtime-translation",
      expires_in_seconds: 60,
      input: { language: "zh-CN" },
      output: { language: "en" },
    }),
  });
  assert.equal(admittedResponse.status, 201, admittedResponse.text);
  const admitted = JSON.parse(admittedResponse.text);
  const upgraded = await websocket(server, {
    path: admitted.websocket_url,
    headers: {
      cookie: session.cookie,
      origin: publicOrigin,
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(upgraded.status, 101);
  assert.match(websocketPayload(upgraded.payload).toString("utf8"), /realtime\.session\.ready/);
  for (let attempt = 0; attempt < 50
    && !backend.realtimeCalls.some((call) => call.operation === "disconnect"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const connected = backend.realtimeCalls.find((call) => call.operation === "connect");
  const disconnected = backend.realtimeCalls.find((call) => call.operation === "disconnect");
  assert.equal(connected.input.sessionId, admitted.session_id);
  assert.equal(disconnected.input.sessionId, admitted.session_id);
  assert.equal(disconnected.input.connectionId, connected.input.connectionId);
  assert.equal(disconnected.input.reason, "websocket_disconnect");
});

test("realtime ASR WebSocket forwards bounded audio and returns the worker transcript", async (t) => {
  const transportCalls = [];
  const realtimeSpeechTransport = {
    maximumChunkBytes: 128,
    async transcribe(input) {
      transportCalls.push({ contentType: input.contentType, language: input.language, audio: Buffer.from(input.audio) });
      return {
        text: "Team AI Box realtime speech.", language: "en", duration: 1.25,
        segments: [{ id: 0, start: 0, end: 1.25, text: "Team AI Box realtime speech." }],
      };
    },
  };
  const { server, backend } = await fixture({ realtimeSpeechTransport });
  t.after(() => server.close());
  const session = await signIn(server);
  const admittedResponse = await request(server, {
    method: "POST",
    path: "/api/v1/realtime/sessions",
    headers: {
      cookie: session.cookie, "content-type": "application/json", origin: publicOrigin,
      "x-csrf-token": session.csrfToken, "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ capability: "asr", model: "local/realtime-asr", expires_in_seconds: 60 }),
  });
  assert.equal(admittedResponse.status, 201, admittedResponse.text);
  const admitted = JSON.parse(admittedResponse.text);
  assert.match(admitted.websocket_url, /\/stream$/);
  const upgraded = await websocketConversation(server, {
    path: admitted.websocket_url,
    headers: { cookie: session.cookie, origin: publicOrigin, "x-forwarded-proto": "https" },
  });
  assert.equal(upgraded.response.statusCode, 101);
  const events = websocketEvents(upgraded.socket, upgraded.head);
  await events.wait((item) => item.type === "realtime.session.ready");
  const audio = Buffer.alloc(128, 0x2a);
  upgraded.socket.write(Buffer.concat([
    maskedWebsocketFrame(1, JSON.stringify({
      type: "realtime.input_audio.configure", content_type: "audio/wav", language: "en",
    })),
    maskedWebsocketFrame(2, audio),
  ]));
  await events.wait((item) => item.type === "realtime.input_audio.configured");
  const completed = await events.wait((item) => item.type === "realtime.transcription.completed");
  assert.equal(completed.payload.text, "Team AI Box realtime speech.");
  assert.equal(completed.payload.durationSeconds, 1.25);
  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].contentType, "audio/wav");
  assert.equal(transportCalls[0].language, "en");
  assert.deepEqual(transportCalls[0].audio, audio);
  upgraded.socket.destroy();
  for (let attempt = 0; attempt < 50
    && !backend.realtimeCalls.some((call) => call.operation === "disconnect"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(backend.realtimeCalls.find((call) => call.operation === "disconnect")?.input.reason, "websocket_disconnect");
});

test("realtime ASR WebSocket fails closed and releases its reservation when the worker fails", async (t) => {
  const realtimeSpeechTransport = {
    maximumChunkBytes: 1024 * 1024,
    async transcribe() {
      throw Object.assign(new Error("worker unavailable"), { code: "realtime_worker_unavailable", retryable: true });
    },
  };
  const { server, backend } = await fixture({ realtimeSpeechTransport });
  t.after(() => server.close());
  const session = await signIn(server);
  const admittedResponse = await request(server, {
    method: "POST", path: "/api/v1/realtime/sessions",
    headers: {
      cookie: session.cookie, "content-type": "application/json", origin: publicOrigin,
      "x-csrf-token": session.csrfToken, "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ capability: "asr", model: "local/realtime-asr", expires_in_seconds: 60 }),
  });
  const admitted = JSON.parse(admittedResponse.text);
  const upgraded = await websocketConversation(server, {
    path: admitted.websocket_url,
    headers: { cookie: session.cookie, origin: publicOrigin, "x-forwarded-proto": "https" },
  });
  const events = websocketEvents(upgraded.socket, upgraded.head);
  await events.wait((item) => item.type === "realtime.session.ready");
  upgraded.socket.write(maskedWebsocketFrame(2, Buffer.alloc(128, 0x2a)));
  const failure = await events.wait((item) => item.type === "realtime.error");
  assert.equal(failure.payload.code, "realtime_worker_unavailable");
  for (let attempt = 0; attempt < 50
    && !backend.realtimeCalls.some((call) => call.operation === "disconnect"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(backend.realtimeCalls.find((call) => call.operation === "disconnect")?.input.reason, "realtime_worker_failed");
});

test("physical routing fields fail closed and unavailable compute remains explicit", async (t) => {
  const active = await fixture();
  t.after(() => active.server.close());
  const rejected = await request(active.server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      authorization: `Bearer ${bearerSecret}`,
      "content-type": "application/json",
      "x-forwarded-proto": "https",
    },
    body: chatBody({ x_teamaibox: { worker_address: "10.0.0.2:9999" } }),
  });
  assert.equal(rejected.status, 400);
  const error = JSON.parse(rejected.text).error;
  assert.equal(error.type, "invalid_request_error");
  assert.equal(error.param, "x_teamaibox.worker_address");

  const unavailable = await fixture({ enableCompute: false });
  t.after(() => unavailable.server.close());
  const response = await request(unavailable.server, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body: chatBody(),
  });
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.text).error.code, "compute_unavailable");
});
