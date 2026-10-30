import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { createPlatformApiServer } from "../server/platform-api.mjs";
import { AssistantHttpApi } from "../src/assistant/assistant-http-api.mjs";
import { AssistantService } from "../src/assistant/assistant-service.mjs";
import { MemoryAssistantRepository } from "../src/assistant/memory-repository.mjs";
import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { PasswordHasher } from "../src/identity/password.mjs";
import { IdentityPreferencesService } from "../src/identity/preferences-service.mjs";
import { MemoryTaskCenterRepository } from "../src/tasks/memory-repository.mjs";
import { TaskCenter } from "../src/tasks/task-center.mjs";
import { PlatformError } from "../../../packages/observability/src/index.mjs";

const publicOrigin = "https://spark.test";
const password = "correct horse battery staple";

function request(server, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port: address.port, method, path, headers }, (response) => {
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

async function fixture({ agentRunner = null } = {}) {
  const identityRepository = new MemoryIdentityRepository();
  const authentication = await LocalAuthentication.create({
    repository: identityRepository,
    hasher: new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 }),
  });
  await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password });
  const preferences = new IdentityPreferencesService({ repository: identityRepository });
  const assistantService = new AssistantService({
    repository: new MemoryAssistantRepository(),
    taskCenter: new TaskCenter({ repository: new MemoryTaskCenterRepository() }),
    answerRunner: {
      async run({ emit }) {
        await emit({ type: "text_delta", delta: "统一回答" });
        await emit({ type: "usage.updated", usage: { inputTokens: 4, outputTokens: 2 } });
      },
    },
    agentRunner: agentRunner ?? {
      async run({ emit }) {
        await emit({ type: "tool.started", toolCallId: "tool.read.1", name: "filesystem.read", summary: "Read a file" });
        await emit({ type: "tool.completed", toolCallId: "tool.read.1", status: "succeeded", summary: "Read complete" });
        await emit({ type: "text_delta", delta: "Agent 完成" });
      },
    },
  });
  const server = createPlatformApiServer({
    authentication,
    preferences,
    publicOrigin,
    logger: { warn() {}, info() {}, error() {} },
    assistantApi: new AssistantHttpApi({ service: assistantService }),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, assistantService };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
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
    body: JSON.stringify({ loginName: "owner", password }),
  });
  assert.equal(response.status, 200, response.text);
  const body = JSON.parse(response.text);
  return {
    csrf: body.csrfToken,
    cookie: response.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; "),
  };
}

function protectedHeaders(session, extras = {}) {
  return {
    cookie: session.cookie,
    origin: publicOrigin,
    "x-csrf-token": session.csrf,
    "x-forwarded-proto": "https",
    ...extras,
  };
}

test("serves the authenticated unified Assistant conversation and resumable SSE contract", async (t) => {
  const { server, assistantService } = await fixture();
  t.after(() => server.close());
  const session = await signIn(server);

  const create = await request(server, {
    method: "POST",
    path: "/api/v1/assistant/conversations",
    headers: protectedHeaders(session, { "content-type": "application/json" }),
    body: JSON.stringify({ title: "统一会话" }),
  });
  assert.equal(create.status, 201, create.text);
  const conversation = JSON.parse(create.text);

  const missingIdempotency = await request(server, {
    method: "POST",
    path: `/api/v1/assistant/conversations/${conversation.id}/messages`,
    headers: protectedHeaders(session, { "content-type": "application/json" }),
    body: JSON.stringify({ input: "你好", mode: "answer" }),
  });
  assert.equal(missingIdempotency.status, 400);
  assert.equal(JSON.parse(missingIdempotency.text).error.code, "assistant_idempotency_required");

  const submit = await request(server, {
    method: "POST",
    path: `/api/v1/assistant/conversations/${conversation.id}/messages`,
    headers: protectedHeaders(session, {
      "content-type": "application/json",
      "idempotency-key": "browser-message-1",
    }),
    body: JSON.stringify({ input: "你好", mode: "answer" }),
  });
  assert.equal(submit.status, 202, submit.text);
  const run = JSON.parse(submit.text).run;
  assert.equal((await assistantService.waitForRun(run.id)).status, "completed");

  const events = await request(server, {
    path: `/api/v1/assistant/conversations/${conversation.id}/events?once=1&after=0`,
    headers: { cookie: session.cookie, "x-forwarded-proto": "https" },
  });
  assert.equal(events.status, 200, events.text);
  assert.match(events.headers["content-type"], /^text\/event-stream/);
  assert.match(events.text, /id: 1\nevent: message\.created/);
  assert.match(events.text, /event: routing\.selected/);
  assert.match(events.text, /event: response\.delta/);
  assert.match(events.text, /event: usage\.updated/);
  assert.match(events.text, /event: run\.completed/);

  const detail = await request(server, {
    path: `/api/v1/assistant/conversations/${conversation.id}`,
    headers: { cookie: session.cookie, "x-forwarded-proto": "https" },
  });
  assert.equal(detail.status, 200, detail.text);
  const state = JSON.parse(detail.text);
  assert.deepEqual(state.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(state.messages[1].content, "统一回答");
  assert.deepEqual(state.messages[1].usage, { inputTokens: 4, outputTokens: 2, costMicrounits: 0, currency: "CNY" });
});

test("Assistant mutations enforce same origin and CSRF", async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const session = await signIn(server);
  const crossOrigin = await request(server, {
    method: "POST",
    path: "/api/v1/assistant/conversations",
    headers: {
      cookie: session.cookie,
      origin: "https://evil.test",
      "x-csrf-token": session.csrf,
      "x-forwarded-proto": "https",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(JSON.parse(crossOrigin.text).error.code, "origin_denied");

  const badCsrf = await request(server, {
    method: "POST",
    path: "/api/v1/assistant/conversations",
    headers: protectedHeaders({ ...session, csrf: "A".repeat(43) }, { "content-type": "application/json" }),
    body: "{}",
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(JSON.parse(badCsrf.text).error.code, "csrf_failed");
});

test("Assistant SSE ownership fails before the HTTP boundary can send success headers", async () => {
  let streamed = false;
  const unavailable = async () => null;
  const service = {
    createConversation: unavailable,
    listConversations: unavailable,
    getConversation: unavailable,
    submitMessage: unavailable,
    cancelRun: unavailable,
    decideConfirmation: unavailable,
    artifactDownload: unavailable,
    async listEvents() {
      throw new PlatformError("assistant_conversation_not_found", "Assistant conversation was not found", { status: 404 });
    },
    async *streamEvents() { streamed = true; },
  };
  const api = new AssistantHttpApi({ service });
  await assert.rejects(api.handle({
    method: "GET",
    pathname: "/api/v1/assistant/conversations/11111111-1111-4111-8111-111111111111/events",
    context: { identityId: "22222222-2222-4222-8222-222222222222" },
    query: new URLSearchParams("after=0"),
  }), { code: "assistant_conversation_not_found", status: 404 });
  assert.equal(streamed, false);
});

test("Agent confirmation HTTP decisions are scoped to the initiating session and resume the same conversation", async (t) => {
  const { server, assistantService } = await fixture({
    agentRunner: {
      async run({ emit, requestConfirmation }) {
        await emit({ type: "tool.started", toolCallId: "tool.write.1", name: "filesystem.write", summary: "Write report" });
        const decision = await requestConfirmation({
          operationKind: "filesystem_write",
          titleKey: "agent.confirm.write_file",
          scope: { path: "/workspace/report.md", action: "write" },
        });
        await emit({ type: "tool.completed", toolCallId: "tool.write.1", status: decision === "approved" ? "succeeded" : "cancelled", summary: decision });
        await emit({ type: "text_delta", delta: decision });
      },
    },
  });
  t.after(() => server.close());
  const session = await signIn(server);
  const created = await request(server, {
    method: "POST",
    path: "/api/v1/assistant/conversations",
    headers: protectedHeaders(session, { "content-type": "application/json" }),
    body: "{}",
  });
  const conversation = JSON.parse(created.text);
  const submitted = await request(server, {
    method: "POST",
    path: `/api/v1/assistant/conversations/${conversation.id}/messages`,
    headers: protectedHeaders(session, { "content-type": "application/json", "idempotency-key": "agent-http-confirmation" }),
    body: JSON.stringify({ input: "写入报告", mode: "agent" }),
  });
  assert.equal(submitted.status, 202, submitted.text);
  const run = JSON.parse(submitted.text).run;
  const confirmation = await waitFor(async () => {
    const detail = await request(server, {
      path: `/api/v1/assistant/conversations/${conversation.id}`,
      headers: { cookie: session.cookie, "x-forwarded-proto": "https" },
    });
    return JSON.parse(detail.text).confirmations.find((item) => item.status === "pending");
  }, "HTTP confirmation");
  const decision = await request(server, {
    method: "POST",
    path: `/api/v1/assistant/confirmations/${confirmation.id}/decision`,
    headers: protectedHeaders(session, { "content-type": "application/json" }),
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(decision.status, 200, decision.text);
  assert.equal(JSON.parse(decision.text).status, "approved");
  assert.equal((await assistantService.waitForRun(run.id)).status, "completed");
  const detail = await assistantService.getConversation(JSON.parse((await request(server, {
    path: "/api/auth/session",
    headers: { cookie: session.cookie, "x-forwarded-proto": "https" },
  })).text).identity.id, conversation.id);
  assert.equal(detail.messages[1].content, "approved");
  assert.equal(detail.messages[1].toolCalls[0].status, "succeeded");
});
