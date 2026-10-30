import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { OpenCodeBridgeClient } from "../services/agent-bridge/src/opencode-bridge-client.mjs";

async function main() {
const tokenProvider = async () => {
  const raw = await readFile("/run/teamaibox/secrets/agent-bridge-token");
  try { return raw.toString("utf8").trim(); } finally { raw.fill(0); }
};
const modelToken = async () => {
  const raw = await readFile("/run/secrets/teamaibox-model-token");
  try { return raw.toString("utf8").trim(); } finally { raw.fill(0); }
};
const client = new OpenCodeBridgeClient({ origin: "http://127.0.0.1:4097", tokenProvider, timeoutMs: 120_000 });
const deadline = Date.now() + 180_000;
while (true) {
  try { assert.equal((await client.health()).version, "1.18.16"); break; }
  catch (error) {
    if (Date.now() >= deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const session = await client.createSession({ title: "Real NVFP4 Agent prompt" });
await writeFile("/workspace/.teamaibox/compatibility-session-id", `${session.id}\n`, { mode: 0o600, flag: "wx" });
const controller = new AbortController();
const eventTypes = new Set();
let permissionAsked = false;
let permissionApproved = false;
let unexpectedPermissionRejectedCount = 0;
const consume = (async () => {
  for await (const item of client.events({ signal: controller.signal })) {
    eventTypes.add(item.type);
    const event = item.event;
    if (event?.type !== "permission.asked" || event.properties?.sessionID !== session.id) continue;
    permissionAsked = true;
    const request = event.properties;
    const patterns = Array.isArray(request.patterns) ? request.patterns.map(String) : [];
    const exact = new Set(["edit", "write"]).has(request.permission)
      && patterns.length > 0
      && patterns.every((value) => value.includes("agent-proof.txt") && !value.includes(".."));
    if (!exact || permissionApproved) {
      await client.replyToolConfirmation({ requestId: request.id, reply: "reject" });
      unexpectedPermissionRejectedCount += 1;
      continue;
    }
    await client.replyToolConfirmation({ requestId: request.id, reply: "once" });
    permissionApproved = true;
  }
})().catch((error) => {
  if (!controller.signal.aborted) throw error;
});

let promptResult;
try {
  promptResult = await client.prompt({
    sessionId: session.id,
    messageId: "msg_teamaibox_real_agent_001",
    model: { providerId: "teamaibox", modelId: "agent.default" },
    parts: [{
      type: "text",
      text: "Use the write or edit tool to create exactly one file named /workspace/agent-proof.txt whose exact content is TEAM_AI_BOX_REAL_AGENT=passed followed by one newline. Do not modify any other file. Then briefly report completion.",
    }],
  });
} finally {
  controller.abort("prompt_complete");
  await consume;
}

assert.ok(promptResult?.info?.id);
assert.equal(permissionAsked, true);
assert.equal(permissionApproved, true);
const proof = await readFile("/workspace/agent-proof.txt");
const expected = Buffer.from("TEAM_AI_BOX_REAL_AGENT=passed\n");
try { assert.deepEqual(proof, expected); } finally { proof.fill(0); expected.fill(0); }
const messages = await client.listMessages({ sessionId: session.id });
const parts = messages.flatMap((message) => Array.isArray(message.parts) ? message.parts : []);
const completedTool = parts.find((part) => part?.type === "tool" && part.state?.status === "completed");
assert.ok(completedTool);
assert.ok(String(completedTool.state?.metadata?.filepath ?? "").endsWith("/workspace/agent-proof.txt"));
assert.ok(parts.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim()));
const diff = await client.diff({ sessionId: session.id });
assert.ok(Array.isArray(diff));
const diffContainedTarget = diff.some((item) => String(item.file ?? item.path ?? "").includes("agent-proof.txt"));
const factsResponse = await fetch("http://compute-gateway:8080/facts", { headers: { authorization: `Bearer ${await modelToken()}` } });
assert.equal(factsResponse.status, 200);
const facts = await factsResponse.json();
assert.ok(facts.requestCount >= 1 && facts.streamRequestCount >= 1 && facts.toolRequestCount >= 1 && facts.modelMappedCount === facts.requestCount);

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  sessionCreated: true,
  realModelPromptCompleted: true,
  modelAlias: "agent.default",
  upstreamModelProfile: "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1",
  permissionAsked,
  permissionApprovedOnce: permissionApproved,
  unexpectedPermissionRejectedCount,
  allUnexpectedPermissionsRejected: true,
  workspaceFileCreated: true,
  workspaceFileSha256: `sha256:${createHash("sha256").update("TEAM_AI_BOX_REAL_AGENT=passed\n").digest("hex")}`,
  completedToolObserved: true,
  toolFilePathObserved: true,
  textResultObserved: true,
  diffEndpointRead: true,
  diffContainedTarget,
  eventTypes: [...eventTypes].sort(),
  modelRequestCount: facts.requestCount,
  streamingModelRequestCount: facts.streamRequestCount,
  toolSchemaRequestCount: facts.toolRequestCount,
  modelMappedCount: facts.modelMappedCount,
  queueUsed: false,
  productAcceptanceClaimed: false,
  credentialsRetained: false,
  promptContentRetained: false,
  modelOutputRetained: false,
}) + "\n");
}

main().catch((error) => {
  const frame = /opencode-prompt-real-smoke\.mjs:(\d+):\d+/.exec(String(error?.stack ?? ""))?.[1] ?? null;
  process.stderr.write(JSON.stringify({ safeFailure: {
    name: typeof error?.name === "string" ? error.name.slice(0, 80) : "Error",
    code: typeof error?.code === "string" ? error.code.slice(0, 80) : null,
    frame,
  } }) + "\n");
  process.exitCode = 1;
});
