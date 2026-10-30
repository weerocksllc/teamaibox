import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import {
  loadAssistantAgentBridgeRoutes,
  OpenCodeAssistantAgentRunner,
} from "../src/assistant/opencode-agent-runner.mjs";

const OWNER = "00000000-0000-4000-8000-000000000101";
const CONVERSATION = "00000000-0000-4000-8000-000000000102";
const RUN = "00000000-0000-4000-8000-000000000103";
const BINDING = "00000000-0000-4000-8000-000000000104";
const PROMPT = "00000000-0000-4000-8000-000000000105";
const CONNECTION = "00000000-0000-4000-8000-000000000106";
const SANDBOX_KEY = "sandbox.16fcf70839634f753e124cbc83e9234b";

function sessionFixture({ existing = false } = {}) {
  const calls = [];
  let bound = existing ? {
    id: BINDING,
    opencodeSessionId: "ses_existing",
    sandboxKey: SANDBOX_KEY,
  } : null;
  return {
    calls,
    service: {
      async getBinding() {
        calls.push("getBinding");
        if (!bound) throw new PlatformError("agent_binding_not_found", "missing", { status: 404 });
        return bound;
      },
      async bindConversation(value) {
        calls.push(["bindConversation", structuredClone(value)]);
        bound = { id: BINDING, ...structuredClone(value) };
        return bound;
      },
      async admitPrompt(_owner, _conversation, value) {
        calls.push(["admitPrompt", structuredClone(value)]);
        return { id: PROMPT, opencodeMessageId: "msg_runner_001" };
      },
      async markSubmitting(id) { calls.push(["markSubmitting", id]); },
      async markAccepted(id) { calls.push(["markAccepted", id]); },
      async markRunning(id) { calls.push(["markRunning", id]); },
      async completePrompt(id, value) { calls.push(["completePrompt", id, structuredClone(value)]); },
      async appendEvent(id, value) { calls.push(["appendEvent", id, structuredClone(value)]); },
    },
  };
}

function bridgeFixture({ existing = false, permission = "write", patterns = ["/workspace/proof.txt"] } = {}) {
  const calls = [];
  let replied;
  let releaseReply;
  const replyObserved = new Promise((resolve) => { releaseReply = resolve; });
  return {
    calls,
    client: {
      async createSession() { calls.push("createSession"); return { id: "ses_created" }; },
      async getSession({ sessionId }) { calls.push(["getSession", sessionId]); return { id: sessionId }; },
      async *events() {
        yield {
          type: "permission.asked",
          upstreamEventId: "event-1",
          event: {
            type: "permission.asked",
            properties: {
              id: "perm_write_001", sessionID: existing ? "ses_existing" : "ses_created",
              permission, patterns, text: "must-not-be-retained",
            },
          },
        };
        await replyObserved;
      },
      async replyToolConfirmation(value) { calls.push(["reply", structuredClone(value)]); replied = value.reply; releaseReply(); return true; },
      async prompt(value) {
        calls.push(["prompt", structuredClone(value)]);
        while (!replied) await new Promise((resolve) => setImmediate(resolve));
        return {
          info: { tokens: { input: 11, output: 7 } },
          parts: [
            { id: "prt_tool_001", type: "tool", tool: "write", state: { status: "completed", metadata: { filepath: "/workspace/proof.txt" } } },
            { id: "prt_text_001", type: "text", text: "已完成。" },
          ],
        };
      },
      async listMessages() {
        calls.push("listMessages");
        return [{
          info: { id: "msg_assistant_001", role: "assistant", parentID: "msg_runner_001" },
          parts: [
            { id: "prt_tool_001", type: "tool", tool: "write", state: { status: "completed", metadata: { filepath: "/workspace/proof.txt" } } },
          ],
        }];
      },
      async readWorkspaceFile() { throw new Error("artifact store not configured"); },
      async interrupt(value) { calls.push(["interrupt", structuredClone(value)]); return true; },
    },
  };
}

test("runs a real Agent bridge prompt with a one-shot user confirmation and durable session facts", async () => {
  const sessions = sessionFixture();
  const bridge = bridgeFixture();
  const outputs = [];
  const confirmations = [];
  const runner = new OpenCodeAssistantAgentRunner({
    sessionService: sessions.service,
    bridgeRoutes: { resolve(owner) { assert.equal(owner, OWNER); return { sandboxKey: SANDBOX_KEY, client: bridge.client }; } },
    idFactory: () => CONNECTION,
  });
  await runner.run({
    ownerIdentityId: OWNER,
    run: { id: RUN, conversationId: CONVERSATION },
    history: [{ role: "user", content: "创建 proof.txt" }],
    signal: new AbortController().signal,
    emit: async (value) => outputs.push(structuredClone(value)),
    requestConfirmation: async (value) => { confirmations.push(structuredClone(value)); return "approved"; },
  });

  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0].scope, { permission: "write", patterns: ["/workspace/proof.txt"] });
  assert.equal(bridge.calls.find((item) => Array.isArray(item) && item[0] === "reply")[1].reply, "once");
  assert.deepEqual(outputs.map((item) => item.type), ["tool.started", "tool.completed", "text_delta", "usage.updated"]);
  assert.ok(sessions.calls.some((item) => Array.isArray(item) && item[0] === "bindConversation"));
  assert.ok(sessions.calls.some((item) => Array.isArray(item) && item[0] === "appendEvent"));
  assert.equal(JSON.stringify(sessions.calls).includes("must-not-be-retained"), false);
  assert.deepEqual(sessions.calls.at(-1), ["completePrompt", PROMPT, { status: "completed", code: "agent_completed" }]);
  assert.deepEqual(bridge.calls.find(item => item[0] === "prompt")[1].parts,
    [{ type: "text", text: "创建 proof.txt" }], "do not advertise downloads without an artifact store");
});

test("confirmation and durable permission facts retain every scope without truncation", async () => {
  const sessions = sessionFixture();
  const permission = "custom.permission." + "x".repeat(80);
  const patterns = Array.from({ length: 37 }, (_, i) => `/workspace/${i}/${"scope".repeat(300)}`);
  const bridge = bridgeFixture({ permission, patterns });
  const runner = new OpenCodeAssistantAgentRunner({
    sessionService: sessions.service,
    bridgeRoutes: { resolve() { return { sandboxKey: SANDBOX_KEY, client: bridge.client }; } },
    idFactory: () => CONNECTION,
  });
  await runner.run({
    ownerIdentityId: OWNER, run: { id: RUN, conversationId: CONVERSATION },
    history: [{ role: "user", content: "Review the complete scope" }],
    signal: new AbortController().signal, emit: async () => {},
    requestConfirmation: async value => {
      assert.deepEqual(value.scope, { permission, patterns });
      return "denied";
    },
  });
  assert.equal(bridge.calls.find(item => Array.isArray(item) && item[0] === "reply")[1].reply, "reject");
  const stored = sessions.calls.filter(item => Array.isArray(item) && item[0] === "appendEvent");
  assert.ok(stored.some(item => JSON.stringify(item).includes(patterns.at(-1))));
  assert.equal(JSON.stringify(stored).includes("must-not-be-retained"), false);
});

test("exports a completed Agent workspace file into the protected object handoff", async () => {
  const sessions = sessionFixture();
  const bridge = bridgeFixture();
  bridge.client.readWorkspaceFile = async ({ path }) => {
    assert.equal(path, "/workspace/proof.txt");
    return {
      content: Buffer.from("protected agent result\n"), filename: "proof.txt",
      mimeType: "text/plain", sha256: "f".repeat(64),
    };
  };
  const calls = [];
  const runner = new OpenCodeAssistantAgentRunner({
    sessionService: sessions.service,
    bridgeRoutes: { resolve() { return { sandboxKey: SANDBOX_KEY, client: bridge.client }; } },
    artifactStore: {
      async storeOutput(input) {
        calls.push(["store", { ...input, content: Buffer.from(input.content) }]);
        return { objectId: "00000000-0000-4000-8000-000000000201", version: 1 };
      },
      async issue(input) {
        calls.push(["issue", structuredClone(input)]);
        return { referenceId: "00000000-0000-4000-8000-000000000202" };
      },
    },
    idFactory: () => CONNECTION,
  });
  const outputs = [];
  await runner.run({
    ownerIdentityId: OWNER, run: { id: RUN, conversationId: CONVERSATION },
    history: [{ role: "user", content: "创建 proof.txt" }],
    signal: new AbortController().signal,
    emit: async (value) => outputs.push(structuredClone(value)),
    requestConfirmation: async () => "approved",
  });
  assert.deepEqual(outputs.find((item) => item.type === "artifact.created")?.artifact, {
    referenceId: "00000000-0000-4000-8000-000000000202",
    label: "proof.txt", mimeType: "text/plain", sizeBytes: 23,
  });
  assert.equal(calls[0][0], "store");
  assert.equal(calls[0][1].objectKey, `assistant/runs/${RUN}/proof.txt`);
  assert.equal(calls[1][1].audience, "assistant.artifact");
  const sentParts = bridge.calls.find(item => item[0] === "prompt")[1].parts;
  const storedParts = sessions.calls.find(item => item[0] === "admitPrompt")[1].parts;
  assert.deepEqual(sentParts, storedParts);
  assert.equal(sentParts.length, 2);
  assert.equal(sentParts[1].text, "创建 proof.txt");
  assert.match(sentParts[0].text, /downloadable file card/);
  assert.match(sentParts[0].text, /not a browser download URL/);
  assert.match(sentParts[0].text, /Do not claim a file was created if the tool failed or was denied/);
});

test("failed artifact export cannot emit a download or a successful run", async () => {
  const sessions = sessionFixture();
  const bridge = bridgeFixture();
  bridge.client.readWorkspaceFile = async () => {
    throw new PlatformError("agent_artifact_export_failed", "Export failed", { status: 502 });
  };
  const outputs = [];
  const runner = new OpenCodeAssistantAgentRunner({
    sessionService: sessions.service,
    bridgeRoutes: { resolve() { return { sandboxKey: SANDBOX_KEY, client: bridge.client }; } },
    artifactStore: {
      async storeOutput() { assert.fail("must not store an unread file"); },
      async issue() { assert.fail("must not issue a reference for a missing file"); },
    },
    idFactory: () => CONNECTION,
  });
  await assert.rejects(() => runner.run({
    ownerIdentityId: OWNER, run: { id: RUN, conversationId: CONVERSATION },
    history: [{ role: "user", content: "创建 proof.txt" }],
    signal: new AbortController().signal,
    emit: async value => outputs.push(value), requestConfirmation: async () => "approved",
  }), { code: "agent_artifact_export_failed" });
  assert.equal(outputs.some(item => item.type === "artifact.created"), false);
  assert.ok(sessions.calls.some(item => item[0] === "completePrompt" && item[2].status === "failed"));
});

test("reuses the owner-bound OpenCode session and denies a rejected confirmation", async () => {
  const sessions = sessionFixture({ existing: true });
  const bridge = bridgeFixture({ existing: true });
  const runner = new OpenCodeAssistantAgentRunner({
    sessionService: sessions.service,
    bridgeRoutes: { resolve() { return { sandboxKey: SANDBOX_KEY, client: bridge.client }; } },
    idFactory: () => CONNECTION,
  });
  await runner.run({
    ownerIdentityId: OWNER,
    run: { id: RUN, conversationId: CONVERSATION },
    history: [{ role: "user", content: "尝试写文件" }],
    signal: new AbortController().signal,
    emit: async () => {},
    requestConfirmation: async () => "denied",
  });
  assert.equal(bridge.calls.includes("createSession"), false);
  assert.equal(bridge.calls.find((item) => Array.isArray(item) && item[0] === "reply")[1].reply, "reject");
});

test("cancelling an Agent run interrupts the exact OpenCode session", async () => {
  const sessions = sessionFixture({ existing: true });
  const calls = [];
  const controller = new AbortController();
  const client = {
    async getSession() { return { id: "ses_existing" }; },
    async *events({ signal }) { while (!signal.aborted) await new Promise((resolve) => setImmediate(resolve)); },
    async prompt({ signal }) {
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      throw signal.reason ?? new Error("aborted");
    },
    async interrupt(value) { calls.push(structuredClone(value)); return true; },
    async createSession() { throw new Error("unexpected"); },
    async replyToolConfirmation() { throw new Error("unexpected"); },
  };
  const runner = new OpenCodeAssistantAgentRunner({
    sessionService: sessions.service,
    bridgeRoutes: { resolve() { return { sandboxKey: SANDBOX_KEY, client }; } },
    idFactory: () => CONNECTION,
  });
  await assert.rejects(() => runner.run({
    ownerIdentityId: OWNER,
    run: { id: RUN, conversationId: CONVERSATION },
    history: [{ role: "user", content: "长任务" }],
    signal: controller.signal,
    emit: async () => {},
    requestConfirmation: async () => "approved",
  }));
  assert.deepEqual(calls, [{ sessionId: "ses_existing" }]);
  assert.ok(sessions.calls.some((item) => Array.isArray(item) && item[0] === "completePrompt" && item[2].status === "cancelled"));
});

test("maps an expired model credential to a retryable actionable Agent failure", async () => {
  const sessions = sessionFixture({ existing: true });
  const client = {
    async getSession() { return { id: "ses_existing" }; },
    async *events() {},
    async prompt() { return { info: { id: "msg_failed" }, parts: [] }; },
    async listMessages() {
      return [{
        info: {
          id: "msg_failed", role: "assistant", parentID: "msg_runner_001",
          error: { name: "APIError", data: { statusCode: 401, isRetryable: false } },
        },
        parts: [],
      }];
    },
    async interrupt() { return true; },
    async createSession() { throw new Error("unexpected"); },
    async replyToolConfirmation() { throw new Error("unexpected"); },
  };
  const runner = new OpenCodeAssistantAgentRunner({
    sessionService: sessions.service,
    bridgeRoutes: { resolve() { return { sandboxKey: SANDBOX_KEY, client }; } },
    idFactory: () => CONNECTION,
  });
  await assert.rejects(() => runner.run({
    ownerIdentityId: OWNER,
    run: { id: RUN, conversationId: CONVERSATION },
    history: [{ role: "user", content: "创建 proof.txt" }],
    signal: new AbortController().signal,
    emit: async () => {},
    requestConfirmation: async () => "approved",
  }), (error) => error.code === "agent_model_credential_rejected" && error.status === 503 && error.retryable === true);
  assert.ok(sessions.calls.some((item) => Array.isArray(item) && item[0] === "completePrompt"
    && item[2].status === "failed" && item[2].code === "agent_model_credential_rejected" && item[2].retryable === true));
});

test("loads only exact owner-bound internal Bridge routes without retaining tokens in configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-agent-routes-"));
  try {
    const tokenFile = join(directory, "bridge-token");
    const routesFile = join(directory, "routes.json");
    await writeFile(tokenFile, "a".repeat(48) + "\n", { mode: 0o400 });
    await writeFile(routesFile, JSON.stringify({
      schemaVersion: 1,
      routes: [{ ownerIdentityId: OWNER, sandboxKey: SANDBOX_KEY, origin: "http://agent-owner:4097", tokenFile }],
    }));
    const routes = await loadAssistantAgentBridgeRoutes(routesFile);
    assert.equal(routes.ownerCount, 1);
    assert.equal(routes.resolve(OWNER).sandboxKey, SANDBOX_KEY);
    assert.throws(() => routes.resolve("00000000-0000-4000-8000-000000000999"), { code: "agent_sandbox_unavailable" });
    assert.equal(JSON.stringify(routes).includes("a".repeat(32)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blank installations accept no static owner routes only with a dynamic provisioner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-agent-factory-"));
  try {
    const filename = join(directory, "routes.json");
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, routes: [] }));
    await assert.rejects(() => loadAssistantAgentBridgeRoutes(filename), /invalid/);
    const calls = [];
    const result = await loadAssistantAgentBridgeRoutes(filename, { provisioner: {
      resolve(owner) { calls.push(owner); return { ownerIdentityId: owner }; },
    } });
    assert.equal(result.ownerCount, 0);
    assert.equal(result.resolve(OWNER).ownerIdentityId, OWNER);
    assert.deepEqual(calls, [OWNER]);
    assert.throws(() => result.resolve("invalid-owner"), { code: "agent_sandbox_unavailable" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects owner routes whose sandbox identity or origin is not exact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-agent-routes-invalid-"));
  try {
    const tokenFile = join(directory, "bridge-token");
    const routesFile = join(directory, "routes.json");
    await writeFile(tokenFile, "a".repeat(48) + "\n");
    await writeFile(routesFile, JSON.stringify({
      schemaVersion: 1,
      routes: [{ ownerIdentityId: OWNER, sandboxKey: "sandbox.wrong", origin: "https://public.example", tokenFile }],
    }));
    await assert.rejects(() => loadAssistantAgentBridgeRoutes(routesFile), /invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
