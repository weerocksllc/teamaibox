import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { OpenCodeBridgeClient } from "../src/opencode-bridge-client.mjs";
import { createOpenCodeBridgeHttpServer, readWorkspaceArtifact } from "../src/opencode-bridge-http-server.mjs";

const TOKEN = "b".repeat(48);
const AUTH = { authorization: `Bearer ${TOKEN}` };

function fixture() {
  const calls = [];
  let eventCancelled = false;
  const adapter = {
    async health() { calls.push(["health"]); return { healthy: true, version: "1.18.16", adapterKey: "opencode.http.v1.18" }; },
    async createSession(input) { calls.push(["createSession", input]); return { id: "ses_123", title: input.title }; },
    async getSession(input) { calls.push(["getSession", input]); return { id: input.sessionId }; },
    async sessionStatus(input) { calls.push(["sessionStatus", input]); return { ses_123: { type: "idle" } }; },
    async prompt(input) { calls.push(["prompt", input]); return { info: { id: "msg_reply" }, parts: [] }; },
    async listMessages(input) { calls.push(["listMessages", input]); return [{ info: { id: "msg_reply" }, parts: [] }]; },
    async interrupt(input) { calls.push(["interrupt", input]); return true; },
    async diff(input) { calls.push(["diff", input]); return [{ file: "README.md" }]; },
    async listArtifacts(input) { calls.push(["listArtifacts", input]); return [{ filename: "README.md", mime: "text/markdown" }]; },
    async listQuestions(input) { calls.push(["listQuestions", input]); return [{ id: "que_123" }]; },
    async replyQuestion(input) { calls.push(["replyQuestion", input]); return true; },
    async rejectQuestion(input) { calls.push(["rejectQuestion", input]); return true; },
    async listToolConfirmations(input) { calls.push(["listToolConfirmations", input]); return [{ id: "per_123" }]; },
    async replyToolConfirmation(input) { calls.push(["replyToolConfirmation", input]); return true; },
    async *events({ directory, signal }) {
      calls.push(["events", { directory }]);
      try {
        yield { adapterKey: "opencode.http.v1.18", connectionOrdinal: 1, upstreamEventId: "evt_1", type: "server.connected", event: { type: "server.connected" } };
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      } finally {
        eventCancelled = true;
      }
    },
  };
  const server = createOpenCodeBridgeHttpServer({ adapter, tokenProvider: async () => TOKEN });
  return {
    calls,
    server,
    get eventCancelled() { return eventCancelled; },
  };
}

async function start(value, context) {
  value.server.listen(0, "127.0.0.1");
  await once(value.server, "listening");
  context.after(async () => {
    value.server.close();
    await once(value.server, "close");
  });
  return `http://127.0.0.1:${value.server.address().port}`;
}

async function json(origin, path, { method = "GET", body, headers = AUTH } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, value: await response.json() };
}

test("authenticated Bridge routes pin every upstream operation to the isolated workspace", async (context) => {
  const value = fixture();
  const origin = await start(value, context);

  const healthz = await json(origin, "/healthz", { headers: {} });
  assert.equal(healthz.response.status, 200);
  assert.equal(healthz.value.status, "ok");
  assert.equal((await json(origin, "/v1/health")).value.version, "1.18.16");
  assert.equal((await json(origin, "/v1/sessions", { method: "POST", body: { title: "Agent task" } })).value.id, "ses_123");
  assert.equal((await json(origin, "/v1/sessions/ses_123")).value.id, "ses_123");
  assert.equal((await json(origin, "/v1/status")).value.ses_123.type, "idle");
  assert.equal((await json(origin, "/v1/sessions/ses_123/prompts", {
    method: "POST",
    body: { messageId: "msg_123", model: { providerId: "teamaibox", modelId: "agent.default" }, parts: [{ type: "text", text: "Write a file" }] },
  })).value.info.id, "msg_reply");
  assert.equal((await json(origin, "/v1/sessions/ses_123/messages")).value.length, 1);
  assert.equal((await json(origin, "/v1/sessions/ses_123/interrupt", { method: "POST", body: {} })).value.interrupted, true);
  assert.equal((await json(origin, "/v1/sessions/ses_123/diff?messageId=msg_123")).value[0].file, "README.md");
  assert.equal((await json(origin, "/v1/sessions/ses_123/artifacts")).value[0].filename, "README.md");
  assert.equal((await json(origin, "/v1/questions")).value[0].id, "que_123");
  assert.equal((await json(origin, "/v1/questions/que_123/reply", { method: "POST", body: { answers: [["Yes"]] } })).value.replied, true);
  assert.equal((await json(origin, "/v1/questions/que_123/reject", { method: "POST", body: {} })).value.rejected, true);
  assert.equal((await json(origin, "/v1/confirmations")).value[0].id, "per_123");
  assert.equal((await json(origin, "/v1/confirmations/per_123/reply", { method: "POST", body: { reply: "once" } })).value.replied, true);

  const upstreamInputs = value.calls.flatMap((call) => call.slice(1));
  assert.ok(upstreamInputs.filter((input) => input && typeof input === "object").every((input) => input.directory === "/workspace"));
  assert.equal(value.calls.find((call) => call[0] === "prompt")[1].model.modelId, "agent.default");
  assert.equal(value.calls.find((call) => call[0] === "diff")[1].messageId, "msg_123");
});

test("Bridge rejects missing credentials, unsafe inputs, and upstream failures without leaking details", async (context) => {
  const value = fixture();
  const origin = await start(value, context);
  const denied = await json(origin, "/v1/status", { headers: {} });
  assert.equal(denied.response.status, 401);
  assert.equal(denied.value.error.code, "agent_bridge_authentication_failed");
  const wrong = await json(origin, "/v1/status", { headers: { authorization: `Bearer ${"x".repeat(48)}` } });
  assert.equal(wrong.response.status, 401);
  const invalid = await fetch(origin + "/v1/sessions", {
    method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "not-json",
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "agent_bridge_json_invalid");
  const method = await json(origin, "/v1/sessions");
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get("allow"), "POST");
});

test("Bridge cancellation closes the upstream OpenCode event subscription", async (context) => {
  const value = fixture();
  const origin = await start(value, context);
  const response = await fetch(origin + "/v1/events", { headers: AUTH });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /id: evt_1/);
  assert.match(first, /"type":"server.connected"/);
  await reader.cancel();
  for (let attempt = 0; attempt < 50 && !value.eventCancelled; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(value.eventCancelled, true);
});

test("Bridge maps bounded upstream errors to the platform error schema", async (context) => {
  const adapter = Object.fromEntries(Object.keys({
    health: 1, createSession: 1, getSession: 1, sessionStatus: 1, prompt: 1, listMessages: 1,
    interrupt: 1, diff: 1, listArtifacts: 1, listQuestions: 1, replyQuestion: 1, rejectQuestion: 1,
    listToolConfirmations: 1, replyToolConfirmation: 1, events: 1,
  }).map((key) => [key, key === "events"
    ? async function* events() { throw new Error("must-not-leak"); }
    : async () => { throw new PlatformError("opencode_unavailable", "OpenCode sandbox is unavailable", { status: 503, retryable: true }); }]));
  const isolated = { server: createOpenCodeBridgeHttpServer({ adapter, tokenProvider: async () => TOKEN }) };
  const origin = await start(isolated, context);
  const result = await json(origin, "/v1/status");
  assert.equal(result.response.status, 503);
  assert.deepEqual({ code: result.value.error.code, retryable: result.value.error.retryable }, { code: "opencode_unavailable", retryable: true });
  assert.ok(!JSON.stringify(result.value).includes("must-not-leak"));
});

test("platform client consumes the stable authenticated Bridge contract and cancels SSE", async (context) => {
  const value = fixture();
  const origin = await start(value, context);
  const client = new OpenCodeBridgeClient({ origin, tokenProvider: async () => TOKEN });
  assert.equal((await client.health()).version, "1.18.16");
  const session = await client.createSession({ title: "Client contract" });
  assert.equal(session.id, "ses_123");
  assert.equal((await client.getSession({ sessionId: session.id })).id, session.id);
  assert.equal((await client.sessionStatus()).ses_123.type, "idle");
  assert.equal((await client.prompt({
    sessionId: session.id,
    messageId: "msg_123",
    model: { providerId: "teamaibox", modelId: "agent.default" },
    parts: [{ type: "text", text: "Write a file" }],
  })).info.id, "msg_reply");
  assert.equal((await client.listMessages({ sessionId: session.id })).length, 1);
  assert.equal(await client.interrupt({ sessionId: session.id }), true);
  assert.equal((await client.diff({ sessionId: session.id, messageId: "msg_123" }))[0].file, "README.md");
  assert.equal((await client.listArtifacts({ sessionId: session.id }))[0].filename, "README.md");
  assert.equal((await client.listQuestions())[0].id, "que_123");
  assert.equal(await client.replyQuestion({ requestId: "que_123", answers: [["Yes"]] }), true);
  assert.equal(await client.rejectQuestion({ requestId: "que_123" }), true);
  assert.equal((await client.listToolConfirmations())[0].id, "per_123");
  assert.equal(await client.replyToolConfirmation({ requestId: "per_123", reply: "once" }), true);
  const events = client.events()[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.type, "server.connected");
  await events.return();
  for (let attempt = 0; attempt < 50 && !value.eventCancelled; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(value.eventCancelled, true);

  const denied = new OpenCodeBridgeClient({ origin, tokenProvider: async () => "x".repeat(48) });
  await assert.rejects(denied.health(), { code: "agent_bridge_authentication_failed" });
});

test("workspace artifact export is bounded, integrity labeled, and rejects hidden or escaping files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "teamaibox-workspace-export-"));
  try {
    await writeFile(join(workspace, "report.md"), "verified report\n");
    await mkdir(join(workspace, ".secret"));
    await writeFile(join(workspace, ".secret", "token"), "must-not-export");
    await symlink("/etc/hosts", join(workspace, "escape.txt"));
    const value = await readWorkspaceArtifact({ workspace, path: join(workspace, "report.md") });
    assert.equal(value.filename, "report.md");
    assert.equal(value.mimeType, "text/markdown");
    assert.equal(value.content.toString("utf8"), "verified report\n");
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
    const large = Buffer.alloc(9 * 1024 * 1024, 42);
    await writeFile(join(workspace, "large.bin"), large);
    const exported = await readWorkspaceArtifact({ workspace, path: join(workspace, "large.bin") });
    assert.equal(exported.content.equals(large), true, "Workspace exports are not capped at 8 MiB");
    exported.content.fill(0); large.fill(0);
    await assert.rejects(readWorkspaceArtifact({ workspace, path: join(workspace, ".secret", "token") }), { code: "agent_workspace_artifact_denied" });
    await assert.rejects(readWorkspaceArtifact({ workspace, path: join(workspace, "escape.txt") }), { code: "agent_workspace_artifact_denied" });
    await assert.rejects(readWorkspaceArtifact({ workspace, path: "/etc/hosts" }), { code: "agent_workspace_artifact_invalid" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
