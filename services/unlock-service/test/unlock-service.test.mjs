import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PreUnlockAuditBuffer, UnlockChallengeStore, UnlockRateLimiter, UnlockService } from "../src/index.mjs";
import { SECURITY_HEADERS, UnlockHttpApi } from "../src/unlock-http-api.mjs";

function fixture({ accepted = true, maximumFailures = 5 } = {}) {
  let now = new Date("2026-08-11T12:00:00Z");
  const audit = [];
  let observedBytes;
  const adapter = {
    async status() { return { state: "locked", mode: "web_passphrase" }; },
    async unlockWithPassphrase(bytes) { observedBytes = bytes; return { unlocked: accepted }; },
  };
  const limiter = new UnlockRateLimiter({ clock: () => now, maximumFailures, windowMilliseconds: 60_000, blockMilliseconds: 30_000 });
  const service = new UnlockService({ adapter, rateLimiter: limiter, auditBuffer: { async append(value) { audit.push(value); } }, clock: () => now });
  return { service, audit, observed: () => observedBytes, advance(milliseconds) { now = new Date(now.getTime() + milliseconds); } };
}

test("correct LUKS passphrase factor authenticates one bounded unlock without retaining it", async () => {
  const value = fixture();
  const result = await value.service.unlock({ request: { passphrase: "correct horse battery staple" }, networkIdentifier: "192.0.2.10", requestId: "request-unlock-a1" });
  assert.deepEqual(result, { state: "unlocking", accepted: true });
  assert.ok(value.observed().every((byte) => byte === 0));
  assert.equal(JSON.stringify(value.audit).includes("correct horse"), false);
  assert.equal(value.audit[0].outcome, "accepted");
  assert.match(value.audit[0].networkDigest, /^sha256:[a-f0-9]{64}$/);
});

test("failed factors become generic denials and a bounded network lockout", async () => {
  const value = fixture({ accepted: false, maximumFailures: 2 });
  await assert.rejects(value.service.unlock({ request: { passphrase: "first" }, networkIdentifier: "192.0.2.11", requestId: "request-unlock-b1" }), { code: "unlock_denied", status: 401 });
  await assert.rejects(value.service.unlock({ request: { passphrase: "second" }, networkIdentifier: "192.0.2.11", requestId: "request-unlock-b2" }), { code: "unlock_rate_limited", status: 429 });
  await assert.rejects(value.service.unlock({ request: { passphrase: "third" }, networkIdentifier: "192.0.2.11", requestId: "request-unlock-b3" }), { code: "unlock_rate_limited", status: 429 });
  assert.deepEqual(value.audit.map((event) => event.outcome), ["denied", "denied", "limited"]);
  assert.equal(JSON.stringify(value.audit).includes("first"), false);
});

test("HTTPS origin and one-time network-bound challenge protect the Web unlock", async () => {
  const value = fixture();
  const api = new UnlockHttpApi({
    service: value.service, expectedOrigin: "https://unlock.box.test:8443",
    networkStatusProvider: { async status() { return { status: "available", interfaces: [] }; } },
    challengeStore: new UnlockChallengeStore(),
  });
  const insecure = await api.handle({ method: "GET", pathname: "/v1/status", networkIdentifier: "192.0.2.12", secure: false });
  assert.equal(insecure.status, 426);
  const challenge = await api.handle({ method: "POST", pathname: "/v1/challenge", headers: { origin: "https://unlock.box.test:8443" }, networkIdentifier: "192.0.2.12" });
  assert.equal(challenge.status, 201);
  assert.match(challenge.headers["set-cookie"], /Secure; HttpOnly; SameSite=Strict/);
  const id = /taib_unlock_challenge=([^;]+)/.exec(challenge.headers["set-cookie"])[1];
  const token = JSON.parse(challenge.body).csrfToken;
  const deniedNetwork = await api.handle({ method: "POST", pathname: "/v1/unlock", headers: { origin: "https://unlock.box.test:8443", cookie: `taib_unlock_challenge=${id}`, "x-unlock-csrf": token }, body: { passphrase: "valid" }, networkIdentifier: "192.0.2.13" });
  assert.equal(deniedNetwork.status, 403);
  const replay = await api.handle({ method: "POST", pathname: "/v1/unlock", headers: { origin: "https://unlock.box.test:8443", cookie: `taib_unlock_challenge=${id}`, "x-unlock-csrf": token }, body: { passphrase: "valid" }, networkIdentifier: "192.0.2.12" });
  assert.equal(replay.status, 403);
  assert.equal(SECURITY_HEADERS["strict-transport-security"], "max-age=31536000");
});

test("valid Web challenge is consumed once and returns only transition state", async () => {
  const value = fixture();
  const api = new UnlockHttpApi({ service: value.service, expectedOrigin: "https://unlock.box.test:8443", networkStatusProvider: { async status() { return { status: "available", interfaces: [] }; } } });
  const headers = { origin: "https://unlock.box.test:8443" };
  const challenge = await api.handle({ method: "POST", pathname: "/v1/challenge", headers, networkIdentifier: "192.0.2.14" });
  const id = /taib_unlock_challenge=([^;]+)/.exec(challenge.headers["set-cookie"])[1];
  const token = JSON.parse(challenge.body).csrfToken;
  const result = await api.handle({ method: "POST", pathname: "/v1/unlock", headers: { ...headers, cookie: `taib_unlock_challenge=${id}`, "x-unlock-csrf": token, "x-request-id": "request-unlock-c1" }, body: { passphrase: "valid" }, networkIdentifier: "192.0.2.14" });
  assert.equal(result.status, 202);
  assert.deepEqual(JSON.parse(result.body), { state: "unlocking", accepted: true });
  assert.equal(result.body.includes("valid"), false);
});

test("pre-unlock audit buffer is mode-restricted bounded and content-free", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taib-unlock-audit-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "pending.jsonl");
  const buffer = new PreUnlockAuditBuffer({ path, maximumBytes: 4096, testOnlyAllowCustomRoot: true });
  await Promise.all(Array.from({ length: 40 }, (_, index) => buffer.append({
    timestamp: new Date(1_786_446_000_000 + index), action: "unlock.passphrase",
    outcome: index % 2 ? "denied" : "limited", networkDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
    requestId: `request-audit-${String(index).padStart(4, "0")}`,
  })));
  const facts = await stat(path);
  const contents = await readFile(path, "utf8");
  assert.equal(facts.mode & 0o077, 0);
  assert.ok(facts.size <= 4096);
  assert.doesNotMatch(contents, /passphrase":"|192\.0\.2\.|password|secret/i);
  for (const line of contents.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
});
