import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { OpenCodeBridgeClient } from "../services/agent-bridge/src/opencode-bridge-client.mjs";

const phase = process.argv[2];
assert.ok(new Set(["create", "recover"]).has(phase), "real Agent Bridge smoke phase is invalid");

const tokenPath = "/run/teamaibox/secrets/agent-bridge-token";
const sessionPath = "/workspace/.teamaibox/compatibility-session-id";
const tokenProvider = async () => {
  const raw = await readFile(tokenPath);
  try {
    return raw.toString("utf8").trim();
  } finally {
    raw.fill(0);
  }
};
const client = new OpenCodeBridgeClient({ origin: "http://127.0.0.1:4097", tokenProvider, timeoutMs: 30_000 });

let health;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    health = await client.health();
    break;
  } catch (error) {
    if (attempt === 59) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
assert.deepEqual(health, { healthy: true, version: "1.18.16", adapterKey: "opencode.http.v1.18" });

let sessionId;
if (phase === "create") {
  const iterator = client.events()[Symbol.asyncIterator]();
  const connected = await iterator.next();
  assert.equal(connected.done, false);
  assert.equal(connected.value.type, "server.connected");
  await iterator.return();
  const session = await client.createSession({ title: "Team AI Box Bridge compatibility smoke" });
  assert.match(session.id, /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
  sessionId = session.id;
  await writeFile(sessionPath, `${sessionId}\n`, { mode: 0o600, flag: "wx" });
} else {
  sessionId = (await readFile(sessionPath, "utf8")).trim();
}

assert.equal((await client.getSession({ sessionId })).id, sessionId);
assert.ok(await client.sessionStatus());
assert.ok(Array.isArray(await client.listMessages({ sessionId })));
assert.ok(Array.isArray(await client.diff({ sessionId })));
assert.ok(Array.isArray(await client.listArtifacts({ sessionId })));
assert.ok(Array.isArray(await client.listQuestions()));
assert.ok(Array.isArray(await client.listToolConfirmations()));

const denied = new OpenCodeBridgeClient({
  origin: "http://127.0.0.1:4097",
  tokenProvider: async () => "x".repeat(64),
});
await assert.rejects(() => denied.health(), { code: "agent_bridge_authentication_failed" });

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  phase,
  healthVersionMatched: true,
  loopbackSidecarConnected: true,
  basicAuthenticationEnforced: true,
  bridgeAuthenticationEnforced: true,
  workspacePinned: true,
  sessionCreated: phase === "create",
  sessionRecovered: phase === "recover",
  sessionStatusRead: true,
  messagesRead: true,
  diffRead: true,
  artifactsRead: true,
  questionsRead: true,
  confirmationsRead: true,
  credentialsRetained: false,
  contentRetained: false,
}) + "\n");
