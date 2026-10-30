import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { createOpenCodeAdapter, supportedOpenCodeAdapters } from "../services/agent-bridge/src/opencode-adapter-registry.mjs";

const phase = process.argv[2];
assert.ok(new Set(["create", "recover"]).has(phase), "real OpenCode smoke phase is invalid");

const passwordPath = "/run/teamaibox/secrets/opencode-password";
const sessionPath = "/workspace/.teamaibox/compatibility-session-id";
const passwordProvider = async () => {
  const raw = await readFile(passwordPath);
  try {
    return { username: "opencode", password: raw.toString("utf8") };
  } finally {
    raw.fill(0);
  }
};
const adapter = createOpenCodeAdapter({
  version: "1.18.16",
  artifactDigest: "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41",
  origin: "http://127.0.0.1:4096",
  credentialProvider: passwordProvider,
  timeoutMs: 30_000,
});

let health;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    health = await adapter.health();
    break;
  } catch (error) {
    if (attempt === 29) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

assert.deepEqual(supportedOpenCodeAdapters(), [{
  adapterKey: "opencode.http.v1.18",
  version: "1.18.16",
  artifactDigest: "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41",
}]);
assert.deepEqual(health, {
  healthy: true,
  version: "1.18.16",
  adapterKey: "opencode.http.v1.18",
});

let sessionId;
if (phase === "create") {
  const eventIterator = adapter.events({ directory: "/workspace" })[Symbol.asyncIterator]();
  const connected = await eventIterator.next();
  assert.equal(connected.done, false);
  assert.equal(connected.value.type, "server.connected");
  assert.equal(connected.value.connectionOrdinal, 1);
  await eventIterator.return();

  const session = await adapter.createSession({ directory: "/workspace", title: "Team AI Box compatibility smoke" });
  assert.match(session.id, /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
  sessionId = session.id;
  await writeFile(sessionPath, `${sessionId}\n`, { mode: 0o600, flag: "wx" });
} else {
  sessionId = (await readFile(sessionPath, "utf8")).trim();
}

const session = await adapter.getSession({ directory: "/workspace", sessionId });
assert.equal(session.id, sessionId);
const statuses = await adapter.sessionStatus({ directory: "/workspace" });
assert.ok(statuses && typeof statuses === "object" && !Array.isArray(statuses));
assert.ok(Array.isArray(await adapter.listMessages({ directory: "/workspace", sessionId })));
assert.ok(Array.isArray(await adapter.diff({ directory: "/workspace", sessionId })));
assert.ok(Array.isArray(await adapter.listQuestions({ directory: "/workspace" })));
assert.ok(Array.isArray(await adapter.listToolConfirmations({ directory: "/workspace" })));

const wrongCredentialAdapter = createOpenCodeAdapter({
  version: "1.18.16",
  artifactDigest: "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41",
  origin: "http://127.0.0.1:4096",
  credentialProvider: async () => ({ username: "opencode", password: "x".repeat(64) }),
});
await assert.rejects(() => wrongCredentialAdapter.health(), { code: "opencode_authentication_failed" });

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  phase,
  healthVersionMatched: true,
  loopbackSidecarConnected: true,
  basicAuthenticationEnforced: true,
  sessionCreated: phase === "create",
  sessionRecovered: phase === "recover",
  sessionStatusRead: true,
  messagesRead: true,
  diffRead: true,
  questionsRead: true,
  confirmationsRead: true,
  credentialsRetained: false,
  contentRetained: false,
}) + "\n");
