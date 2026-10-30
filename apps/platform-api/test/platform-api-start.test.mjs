import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startPlatformApi } from "../server/platform-api.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { AgentModelCredentialAuthority } from "../../../services/compute-gateway/src/agent-model-credential.mjs";

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("restarts an already bootstrapped durable identity boundary without the one-time secret file", async (t) => {
  const repository = new MemoryIdentityRepository();
  await repository.bootstrapOwner({
    loginName: "owner",
    normalizedLoginName: "owner",
    displayName: "Owner",
    passwordHash: "$argon2id$v=19$m=8192,t=2,p=2$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g",
    recoveryCodeHashes: [],
    now: new Date("2026-08-12T00:00:00.000Z"),
  });
  const port = await unusedPort();
  const server = await startPlatformApi({
    PLATFORM_API_HOST: "127.0.0.1",
    PLATFORM_API_PORT: String(port),
    PLATFORM_API_PUBLIC_ORIGIN: "https://spark.test",
  }, { identityRepository: repository });
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
  assert.equal(response.status, 200);
});

test("does not load a setup token after headless bootstrap completed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bootstrapPath = join(directory, "bootstrap.json");
  await writeFile(bootstrapPath, JSON.stringify({
    loginName: "owner",
    displayName: "Owner",
    password: "a long bootstrap passphrase 2026",
  }), { mode: 0o600 });
  const port = await unusedPort();
  const repository = new MemoryIdentityRepository();
  const server = await startPlatformApi({
    PLATFORM_API_HOST: "127.0.0.1",
    PLATFORM_API_PORT: String(port),
    PLATFORM_API_PUBLIC_ORIGIN: "https://spark.test",
    PLATFORM_API_BOOTSTRAP_FILE: bootstrapPath,
    PLATFORM_API_SETUP_TOKEN_FILE: join(directory, "intentionally-absent"),
  }, { identityRepository: repository });
  t.after(() => server.close());

  assert.deepEqual(await repository.bootstrapState(), {
    complete: true,
    ownerIdentityId: (await repository.findByNormalizedLogin("owner")).id,
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
});

test("loads paired Agent credential files and preserves the signed user context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-agent-credential-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const keyPath = join(directory, "agent-model-signing-key");
  const aliasesPath = join(directory, "agent-model-aliases.json");
  await writeFile(keyPath, key.toString("base64url") + "\n", { mode: 0o400 });
  await writeFile(aliasesPath, JSON.stringify({ schemaVersion: 1, aliases: { "agent.default": "local/agent-only" } }), { mode: 0o444 });
  const issuer = new AgentModelCredentialAuthority({ signingKey: key });
  const credential = await issuer.issue({
    subject: "018f6f18-24d7-7c21-9b62-8c017419958a",
    sandboxId: "018f6f18-24d7-7c21-9b62-8c017419958b",
    audience: "compute.openai",
    scopes: ["openai:chat.completions"],
    modelAliases: ["agent.default"],
    expiresAt: new Date(Date.now() + 300_000),
    singleSandbox: true,
  });
  const calls = [];
  const computeApi = {
    matches() { return true; },
    async handle(input) {
      calls.push(input);
      return { kind: "json", status: 200, body: { object: "chat.completion", model: "local/agent-only", choices: [] } };
    },
  };
  const port = await unusedPort();
  const server = await startPlatformApi({
    PLATFORM_API_HOST: "127.0.0.1",
    PLATFORM_API_PORT: String(port),
    PLATFORM_API_PUBLIC_ORIGIN: "https://spark.test",
    PLATFORM_AGENT_MODEL_SIGNING_KEY_FILE: keyPath,
    PLATFORM_AGENT_MODEL_ALIAS_MAP_FILE: aliasesPath,
  }, { identityRepository: new MemoryIdentityRepository(), computeApi });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ model: "local/agent-only", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls[0].context.identityId, "018f6f18-24d7-7c21-9b62-8c017419958a");
  assert.equal(calls[0].context.sandboxId, "018f6f18-24d7-7c21-9b62-8c017419958b");
  assert.deepEqual(calls[0].context.modelAliases, ["local/agent-only"]);
  issuer.close();
  key.fill(0);
});

test("fails closed when only one Agent credential file is configured", async () => {
  await assert.rejects(startPlatformApi({
    PLATFORM_API_HOST: "127.0.0.1",
    PLATFORM_API_PORT: String(await unusedPort()),
    PLATFORM_API_PUBLIC_ORIGIN: "https://spark.test",
    PLATFORM_AGENT_MODEL_SIGNING_KEY_FILE: "/tmp/missing-agent-key",
  }, { identityRepository: new MemoryIdentityRepository() }), /must be configured together/);
});
