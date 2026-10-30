import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import {gzipSync} from 'node:zlib';

import { createOpenCodeAdapter, supportedOpenCodeAdapters } from "../src/opencode-adapter-registry.mjs";
import { OpenCodeV118Adapter } from "../src/opencode-adapter-v1-18.mjs";

const DIGEST = "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41";
const AUTHORIZATION = `Basic ${Buffer.from(`teamaibox:${"p".repeat(48)}`).toString("base64")}`;

test('real OpenCode gzip response does not fail decoded-length validation',async t=>{
  const messages=[{info:{id:'msg_reply'},parts:[{type:'text',text:'Agent 通信正常。'.repeat(1000)}]}];
  const bytes=gzipSync(Buffer.from(JSON.stringify(messages)));
  const server=http.createServer((req,res)=>{
    assert.equal(req.headers.authorization,AUTHORIZATION);
    res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip','content-length':bytes.length});res.end(bytes);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  assert.deepEqual(await adapter('http://127.0.0.1:'+server.address().port).listMessages({directory:'/workspace/user-1',sessionId:'ses_123'}),messages);
});

test("prompt text is not limited by the former 64000 character adapter cap", async (context) => {
  const upstream = await startUpstream();context.after(upstream.close);
  const text = "办公资料".repeat(100000);
  const parts = [{ type: "text", text }, ...Array.from({ length: 70 }, (_, i) => ({ type: "text", text: `附件说明 ${i}` }))];
  const result = await adapter(upstream.origin).prompt({ directory: "/workspace/user-1", sessionId: "ses_123",
    messageId: "msg_large", model: { providerId: "teamaibox", modelId: "approved.agent" }, parts });
  assert.equal(result.info.id, "msg_reply");
  const received = upstream.requests.find((request) => request.path === "/session/ses_123/message").body.parts;
  assert.equal(received.length, 71);
  assert.equal(received[0].text === text, true, "UTF-8 prompt must survive HTTP chunk boundaries without truncation");
});

function json(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString("utf8");
  return value ? JSON.parse(value) : null;
}

async function startUpstream() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://upstream.invalid");
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
      directory: request.headers["x-opencode-directory"] ?? null,
      body: await body(request),
    });
    if (request.headers.authorization !== AUTHORIZATION) return json(response, { secret: "must-not-leak" }, 401);
    if (request.method === "GET" && url.pathname === "/global/health") return json(response, { healthy: true, version: "1.18.16" });
    if (request.headers["x-opencode-directory"] !== "/workspace/user-1") return json(response, { error: "directory" }, 400);
    if (request.method === "POST" && url.pathname === "/session") return json(response, { id: "ses_123", title: requests.at(-1).body.title });
    if (request.method === "GET" && url.pathname === "/session/status") return json(response, { ses_123: { type: "idle" } });
    if (request.method === "GET" && url.pathname === "/session/ses_123") return json(response, { id: "ses_123", title: "Bridge test" });
    if (request.method === "POST" && url.pathname === "/session/ses_123/message") {
      return json(response, { info: { id: "msg_reply", role: "assistant" }, parts: [{ id: "prt_text", type: "text", text: "done" }] });
    }
    if (request.method === "GET" && url.pathname === "/session/ses_123/message") {
      return json(response, [{
        info: { id: "msg_reply" },
        parts: [
          { id: "prt_file", type: "file", mime: "text/plain", filename: "report.txt", url: "file:///workspace/user-1/report.txt" },
          { id: "prt_tool", type: "tool", state: { status: "completed", attachments: [
            { id: "prt_attachment", type: "file", mime: "image/png", filename: "chart.png", url: "file:///workspace/user-1/chart.png" },
          ] } },
        ],
      }]);
    }
    if (request.method === "POST" && url.pathname === "/session/ses_123/abort") return json(response, true);
    if (request.method === "GET" && url.pathname === "/session/ses_123/diff") return json(response, [{ file: "README.md", additions: 2, deletions: 0 }]);
    if (request.method === "GET" && url.pathname === "/question") return json(response, [{ id: "que_123", sessionID: "ses_123", questions: [] }]);
    if (request.method === "POST" && url.pathname === "/question/que_123/reply") return json(response, true);
    if (request.method === "POST" && url.pathname === "/question/que_123/reject") return json(response, true);
    if (request.method === "GET" && url.pathname === "/permission") return json(response, [{ id: "per_123", sessionID: "ses_123", permission: "bash" }]);
    if (request.method === "POST" && url.pathname === "/permission/per_123/reply") return json(response, true);
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("id: evt_1\ndata: {\"type\":\"session.updated\",\"properties\":{\"id\":\"ses_123\"}}\n\n");
      response.end("id: evt_2\ndata: {\"type\":\"session.idle\",\"properties\":{\"id\":\"ses_123\"}}\n\n");
      return;
    }
    return json(response, { error: "missing" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

function adapter(origin) {
  return createOpenCodeAdapter({
    version: "1.18.16",
    artifactDigest: DIGEST,
    origin,
    credentialProvider: async () => ({ username: "teamaibox", password: "p".repeat(48) }),
  });
}

test("pinned adapter calls only networked opencode serve and preserves event order", async (context) => {
  const upstream = await startUpstream();
  context.after(upstream.close);
  const client = adapter(upstream.origin);
  assert.deepEqual(await client.health(), { healthy: true, version: "1.18.16", adapterKey: "opencode.http.v1.18" });
  assert.equal((await client.createSession({ directory: "/workspace/user-1", title: "Bridge test" })).id, "ses_123");
  assert.equal((await client.getSession({ directory: "/workspace/user-1", sessionId: "ses_123" })).id, "ses_123");
  assert.equal((await client.sessionStatus({ directory: "/workspace/user-1" })).ses_123.type, "idle");
  const prompted = await client.prompt({
    directory: "/workspace/user-1",
    sessionId: "ses_123",
    messageId: "msg_123",
    model: { providerId: "teamaibox", modelId: "approved.agent" },
    parts: [{ type: "text", text: "Create the report" }],
  });
  assert.equal(prompted.info.id, "msg_reply");
  assert.equal((await client.listMessages({ directory: "/workspace/user-1", sessionId: "ses_123" })).length, 1);
  assert.equal(await client.interrupt({ directory: "/workspace/user-1", sessionId: "ses_123" }), true);
  assert.equal((await client.diff({ directory: "/workspace/user-1", sessionId: "ses_123", messageId: "msg_123" }))[0].file, "README.md");
  assert.equal((await client.listQuestions({ directory: "/workspace/user-1" }))[0].id, "que_123");
  assert.equal(await client.replyQuestion({ directory: "/workspace/user-1", requestId: "que_123", answers: [["Yes"]] }), true);
  assert.equal(await client.rejectQuestion({ directory: "/workspace/user-1", requestId: "que_123" }), true);
  assert.equal((await client.listToolConfirmations({ directory: "/workspace/user-1" }))[0].id, "per_123");
  assert.equal(await client.replyToolConfirmation({ directory: "/workspace/user-1", requestId: "per_123", reply: "once" }), true);
  const events = [];
  for await (const event of client.events({ directory: "/workspace/user-1" })) events.push(event);
  assert.deepEqual(events.map((event) => [event.connectionOrdinal, event.upstreamEventId, event.type]), [
    [1, "evt_1", "session.updated"], [2, "evt_2", "session.idle"],
  ]);
  assert.ok(upstream.requests.every((request) => request.authorization === AUTHORIZATION));
  assert.ok(upstream.requests.filter((request) => request.path !== "/global/health").every((request) => request.directory === "/workspace/user-1"));
  assert.deepEqual(upstream.requests.find((request) => request.method === "POST" && request.path === "/session/ses_123/message").body, {
    messageID: "msg_123",
    model: { providerID: "teamaibox", modelID: "approved.agent" },
    parts: [{ type: "text", text: "Create the report" }],
  });
});

test("artifact discovery remains internal metadata for later protected-object ingestion", async (context) => {
  const upstream = await startUpstream();
  context.after(upstream.close);
  const artifacts = await adapter(upstream.origin).listArtifacts({ directory: "/workspace/user-1", sessionId: "ses_123" });
  assert.deepEqual(artifacts.map(({ filename, mime }) => ({ filename, mime })), [
    { filename: "report.txt", mime: "text/plain" }, { filename: "chart.png", mime: "image/png" },
  ]);
  assert.ok(artifacts.every((artifact) => artifact.sourceLocator.startsWith("file:///workspace/user-1/")));
});

test("ending an event subscription cancels the upstream SSE reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
    },
    cancel() { cancelled = true; },
  });
  const client = new OpenCodeV118Adapter({
    origin: "http://127.0.0.1:4096",
    credentialProvider: async () => ({ username: "teamaibox", password: "p".repeat(48) }),
    fetchImplementation: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  const iterator = client.events({ directory: "/workspace/user-1" })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "server.connected");
  await iterator.return();
  assert.equal(cancelled, true);
});

test("version, protocol, credential, input, and upstream errors fail closed without leaking bodies", async () => {
  assert.deepEqual(supportedOpenCodeAdapters(), [{ adapterKey: "opencode.http.v1.18", version: "1.18.16", artifactDigest: DIGEST }]);
  assert.throws(() => createOpenCodeAdapter({ version: "1.18.17", artifactDigest: DIGEST }), { code: "opencode_version_unsupported" });
  const incompatible = new OpenCodeV118Adapter({
    origin: "http://127.0.0.1:4096",
    credentialProvider: async () => ({ username: "teamaibox", password: "p".repeat(48) }),
    fetchImplementation: async () => new Response(JSON.stringify({ healthy: true, version: "1.18.17" }), { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(incompatible.health(), { code: "opencode_protocol_incompatible" });
  const rejected = new OpenCodeV118Adapter({
    origin: "http://127.0.0.1:4096",
    credentialProvider: async () => ({ username: "teamaibox", password: "p".repeat(48) }),
    fetchImplementation: async () => new Response(JSON.stringify({ password: "upstream-secret" }), { status: 500, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(rejected.health(), (error) => error.code === "opencode_unavailable" && !error.message.includes("upstream-secret"));
  await assert.rejects(incompatible.createSession({ directory: "/workspace/../host" }), { code: "opencode_workspace_invalid" });
  await assert.rejects(incompatible.prompt({
    directory: "/workspace/user-1", sessionId: "ses_123", messageId: "msg_123",
    model: { providerId: "teamaibox", modelId: "approved.agent" }, parts: [{ type: "agent", name: "unapproved" }],
  }), { code: "opencode_prompt_invalid" });
});
