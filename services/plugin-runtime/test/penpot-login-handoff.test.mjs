import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { LocalAuthentication } from "../../../apps/platform-api/src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../../../apps/platform-api/src/identity/memory-repository.mjs";
import { PasswordHasher } from "../../../apps/platform-api/src/identity/password.mjs";
import { PenpotLoginHandoff } from "../src/penpot-login-handoff.mjs";

async function fixture() {
  let time = Date.now();
  const clock = () => new Date(time);
  const identities = new MemoryIdentityRepository();
  const hasher = new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 });
  const authentication = await LocalAuthentication.create({ repository: identities, hasher, clock });
  const users = [];
  for (let index = 0; index < 2; index++) {
    const loginName = `p${randomBytes(8).toString("hex")}`;
    const password = randomBytes(32).toString("base64url");
    const user = await identities.insertIdentity({ loginName, normalizedLoginName: loginName,
      displayName: "Design member", passwordHash: await hasher.hash(password) });
    const login = await authentication.signIn({ loginName, password, sourceAddress: "127.0.0.1" });
    const context = await authentication.authenticateSession(login);
    users.push({ ...login, identityId: user.id, sessionId: context.sessionId });
  }
  const records = new Map(), profiles = new Map();
  const repository = {
    async insert(record) { records.set(record.codeHash.toString("hex"), structuredClone(record)); },
    async consume({ codeHash, installationId, identityId, sessionId, now }) {
      const key = codeHash.toString("hex"), row = records.get(key);
      if (!row || row.installationId !== installationId || row.identityId !== identityId
        || row.sessionId !== sessionId || row.issuedAt > now || row.expiresAt <= now) return null;
      records.delete(key);
      return row;
    },
    async getOrCreateProfile(installation, user) {
      const key = `${installation}:${user}`;
      if (!profiles.has(key)) profiles.set(key, randomUUID());
      return profiles.get(key);
    },
  };
  let generation = 1;
  const backendKey = randomBytes(32).toString("base64url");
  const handoff = new PenpotLoginHandoff({ repository, authentication, clock,
    installationId: randomUUID(), backendKey, tokenPepper: randomBytes(32),
    authorizeDesign: async () => ({ pluginId: "official.penpot", allowed: true, version: "pilot", generation }),
    loadSession: async (identityId, sessionId) => {
      const user = users.find(value => value.identityId === identityId && value.sessionId === sessionId);
      if (!user) return null;
      try { return await authentication.authenticateSession(user); } catch { return null; }
    },
  });
  const redeem = (code, user = users[0], overrides = {}) => handoff.redeem({ code, backendKey,
    identityId: user.identityId, sessionId: user.sessionId, ...overrides });
  return { handoff, users, records, redeem, authentication,
    advance: value => { time += value; }, upgrade: () => { generation++; } };
}

test("handoff requires real platform CSRF; stores only a digest; one concurrent redemption wins", async () => {
  const f = await fixture();
  await assert.rejects(f.handoff.issue({ sessionToken: f.users[0].sessionToken }), { code: "invalid_session" });
  await assert.rejects(f.handoff.issue({ ...f.users[0], csrfToken: randomBytes(32).toString("base64url") }), { code: "csrf_failed" });
  const { code } = await f.handoff.issue(f.users[0]);
  assert.equal(JSON.stringify([...f.records.values()]).includes(code), false);
  const results = await Promise.allSettled([f.redeem(code), f.redeem(code)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
});

test("wrong service, user and session cannot redeem; stable native IDs remain separate", async () => {
  const f = await fixture();
  const { code } = await f.handoff.issue(f.users[0]);
  await assert.rejects(f.redeem(code, f.users[0], { backendKey: randomBytes(32).toString("base64url") }), { code: "penpot_handoff_denied" });
  await assert.rejects(f.redeem(code, f.users[1]), { code: "penpot_handoff_denied" });
  await assert.rejects(f.redeem(code, f.users[0], { sessionId: randomUUID() }), { code: "penpot_handoff_denied" });
  const first = await f.redeem(code);
  const again = await f.redeem((await f.handoff.issue(f.users[0])).code);
  const other = await f.redeem((await f.handoff.issue(f.users[1])).code, f.users[1]);
  assert.equal(first.profileId, again.profileId);
  assert.notEqual(first.profileId, other.profileId);
  assert.equal(first.contact, `${first.profileId}@design.invalid`);
  assert.equal("password" in first, false);
});

test("60 second expiry, platform logout and application replacement invalidate pending handoffs", async () => {
  const f = await fixture();
  const old = await f.handoff.issue(f.users[0]);
  f.advance(60_000);
  await assert.rejects(f.redeem(old.code), { code: "penpot_handoff_denied" });
  const upgraded = await f.handoff.issue(f.users[0]);
  f.upgrade();
  await assert.rejects(f.redeem(upgraded.code), { code: "penpot_handoff_denied" });
  const signedOut = await f.handoff.issue(f.users[0]);
  await f.authentication.signOut(f.users[0].sessionToken);
  await assert.rejects(f.redeem(signedOut.code), { code: "penpot_handoff_denied" });
});
