import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { OpenCodeBridgeClient } from "../services/agent-bridge/src/opencode-bridge-client.mjs";

async function main() {
const tokenProvider = async () => {
  const raw = await readFile("/run/teamaibox/secrets/agent-bridge-token");
  try { return raw.toString("utf8").trim(); } finally { raw.fill(0); }
};
const client = new OpenCodeBridgeClient({ origin: "http://127.0.0.1:4097", tokenProvider, timeoutMs: 30_000 });
const queueRecovery = process.env.TEAMAIBOX_QUEUE_RECOVERY === "1";
if (process.env.TEAMAIBOX_QUEUE_RECOVERY !== undefined && !queueRecovery) throw new Error("recovery_mode_invalid");
const proofPath = queueRecovery ? "/workspace/agent-queue-proof.txt" : "/workspace/agent-proof.txt";
const proofContent = queueRecovery ? "TEAM_AI_BOX_QUEUED_AGENT=passed\n" : "TEAM_AI_BOX_REAL_AGENT=passed\n";
const deadline = Date.now() + 60_000;
while (true) {
  try { assert.equal((await client.health()).version, "1.18.16"); break; }
  catch (error) {
    if (Date.now() >= deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const sessionId = (await readFile("/workspace/.teamaibox/compatibility-session-id", "utf8")).trim();
assert.equal((await client.getSession({ sessionId })).id, sessionId);
const messages = await client.listMessages({ sessionId });
const parts = messages.flatMap((message) => Array.isArray(message.parts) ? message.parts : []);
const completedTool = parts.find((part) => part?.type === "tool" && part.state?.status === "completed");
assert.ok(completedTool);
assert.ok(String(completedTool.state?.metadata?.filepath ?? "").endsWith(proofPath));
assert.ok(parts.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim()));
const proof = await readFile(proofPath);
const expectedDigest = `sha256:${createHash("sha256").update(proofContent).digest("hex")}`;
try { assert.equal(`sha256:${createHash("sha256").update(proof).digest("hex")}`, expectedDigest); }
finally { proof.fill(0); }
const diff = await client.diff({ sessionId });
assert.ok(Array.isArray(diff));
const diffContainedTarget = diff.some((item) => String(item.file ?? item.path ?? "").includes(proofPath.split("/").at(-1)));
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  sessionRecovered: true,
  messagesRecovered: true,
  completedToolRecovered: true,
  toolFilePathRecovered: true,
  textResultRecovered: true,
  workspaceFileRecovered: true,
  workspaceFileSha256: expectedDigest,
  diffEndpointRecovered: true,
  diffContainedTarget,
  credentialsRetained: false,
  contentRetained: false,
}) + "\n");
}

main().catch((error) => {
  const frame = /opencode-prompt-recover-smoke\.mjs:(\d+):\d+/.exec(String(error?.stack ?? ""))?.[1] ?? null;
  process.stderr.write(JSON.stringify({ safeFailure: {
    name: typeof error?.name === "string" ? error.name.slice(0, 80) : "Error",
    code: typeof error?.code === "string" ? error.code.slice(0, 80) : null,
    frame,
  } }) + "\n");
  process.exitCode = 1;
});
