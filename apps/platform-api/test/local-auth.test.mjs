import assert from "node:assert/strict";
import { test } from "node:test";

import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import {
  clearCsrfCookie,
  clearSessionCookie,
  csrfCookie,
  csrfCookieName,
  readCsrfCookie,
  readSessionCookie,
  sessionCookie,
  sessionCookieName,
} from "../src/identity/http-session.mjs";
import {
  PasswordHasher,
  PasswordPolicyError,
  validatePasswordPolicy,
} from "../src/identity/password.mjs";

const ownerPassword = "correct horse battery staple";
const replacementPassword = "an entirely different recovery phrase";

function testHasher() {
  return new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 });
}

async function fixture(policy = {}) {
  const repository = new MemoryIdentityRepository();
  const audit = [];
  let current = new Date("2026-08-10T00:00:00.000Z");
  const authentication = await LocalAuthentication.create({
    repository,
    hasher: testHasher(),
    audit: async (event) => audit.push(event),
    clock: () => new Date(current),
    policy,
    recoveryAuthority: {
      verify: async ({ challenge, proof }) => challenge === "local-browser-challenge" && proof === "local-console-proof",
    },
  });
  return {
    authentication,
    repository,
    audit,
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
  };
}

test("enforces a length-and-blocklist password policy without composition rules", () => {
  assert.equal(validatePasswordPolicy("这是一个足够长的团队设备口令短语 2026"), "这是一个足够长的团队设备口令短语 2026");
  assert.equal(validatePasswordPolicy("a passphrase made only of lowercase words"), "a passphrase made only of lowercase words");
  assert.throws(() => validatePasswordPolicy("too short"), (error) => error instanceof PasswordPolicyError && error.code === "password_too_short");
  assert.throws(() => validatePasswordPolicy("passwordpassword"), (error) => error.code === "password_blocklisted");
  assert.throws(
    () => validatePasswordPolicy("the-owner-login", { loginName: "the-owner-login" }),
    (error) => error.code === "password_blocklisted",
  );
});

test("hashes with bounded Argon2id parameters and verifies in constant-result form", async () => {
  const hasher = testHasher();
  const encoded = await hasher.hash(ownerPassword);
  assert.match(encoded, /^\$argon2id\$v=19\$m=8192,t=2,p=2\$/);
  assert.equal(encoded.includes(ownerPassword), false);
  assert.equal(await hasher.verify(ownerPassword, encoded), true);
  assert.equal(await hasher.verify("wrong but sufficiently long phrase", encoded), false);
  assert.equal(await hasher.verify(ownerPassword, "$argon2id$v=19$m=999999999,t=2,p=2$bad$bad"), false);
});

test("bootstraps exactly one owner and returns recovery codes only once", async () => {
  const { authentication, audit } = await fixture();
  const result = await authentication.bootstrapOwner({
    loginName: "Owner",
    displayName: "设备所有者",
    password: ownerPassword,
  });
  assert.equal(result.identity.loginName, "owner");
  assert.deepEqual(result.identity.roles, ["owner"]);
  assert.equal(result.recoveryCodes.length, 8);
  assert.equal(new Set(result.recoveryCodes).size, 8);
  await assert.rejects(
    authentication.bootstrapOwner({ loginName: "other", displayName: "Other", password: replacementPassword }),
    (error) => error.code === "bootstrap_complete",
  );
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(ownerPassword), false);
  assert.equal(result.recoveryCodes.some((code) => serialized.includes(code)), false);
});

test("creates revocable sessions and requires CSRF for state-changing requests", async () => {
  const { authentication, audit } = await fixture();
  await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password: ownerPassword });
  const signedIn = await authentication.signIn({
    loginName: "OWNER",
    password: ownerPassword,
    networkIdentifier: "lan-client-a",
    userAgent: "Test Browser",
  });
  const session = await authentication.authenticateSession({
    sessionToken: signedIn.sessionToken,
    csrfToken: signedIn.csrfToken,
    requireCsrf: true,
  });
  assert.equal(session.identity.id, signedIn.identity.id);
  assert.equal(session.identityId, signedIn.identity.id);
  assert.deepEqual(session.roles, ["owner"]);
  assert.ok(session.permissions.includes("identity:manage"));
  assert.ok(session.permissions.includes("queue:manage"));
  await assert.rejects(
    authentication.authenticateSession({
      sessionToken: signedIn.sessionToken,
      csrfToken: "A".repeat(43),
      requireCsrf: true,
    }),
    (error) => error.code === "csrf_failed",
  );
  await authentication.signOut(signedIn.sessionToken);
  await assert.rejects(
    authentication.authenticateSession({ sessionToken: signedIn.sessionToken }),
    (error) => error.code === "invalid_session",
  );
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(signedIn.sessionToken), false);
  assert.equal(serialized.includes(signedIn.csrfToken), false);
});

test("uses a host-only secure session cookie and rejects ambiguous duplicates", () => {
  const token = "A".repeat(43);
  const cookie = sessionCookie(token, "2026-08-10T12:00:00.000Z");
  assert.ok(cookie.startsWith(sessionCookieName + "="));
  assert.match(cookie, /Path=\/;/);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict; Priority=High$/);
  assert.equal(/Domain=/i.test(cookie), false);
  assert.equal(readSessionCookie("ordinary=1; " + sessionCookieName + "=" + token), token);
  assert.equal(readSessionCookie(sessionCookieName + "=" + token + "; " + sessionCookieName + "=" + token), null);
  assert.match(clearSessionCookie(), /Max-Age=0/);
  const csrf = csrfCookie(token, "2026-08-10T12:00:00.000Z");
  assert.ok(csrf.startsWith(csrfCookieName + "="));
  assert.match(csrf, /Secure; SameSite=Strict; Priority=High$/);
  assert.equal(/HttpOnly/i.test(csrf), false);
  assert.equal(readCsrfCookie(csrfCookieName + "=" + token), token);
  assert.equal(readCsrfCookie(csrfCookieName + "=" + token + "; " + csrfCookieName + "=" + token), null);
  assert.match(clearCsrfCookie(), /Max-Age=0/);
});

test("locks an account and throttles abusive network sources", async () => {
  const { authentication, advance } = await fixture({
    accountFailureLimit: 3,
    accountLockMs: 60_000,
    networkFailureLimit: 4,
    networkBlockMs: 60_000,
  });
  await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password: ownerPassword });
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      authentication.signIn({ loginName: "owner", password: "wrong password", networkIdentifier: "lan-client-b" }),
      (error) => error.code === "invalid_credentials",
    );
  }
  await assert.rejects(
    authentication.signIn({ loginName: "owner", password: ownerPassword, networkIdentifier: "lan-client-b" }),
    (error) => error.code === "invalid_credentials",
  );
  await assert.rejects(
    authentication.signIn({ loginName: "owner", password: ownerPassword, networkIdentifier: "lan-client-b" }),
    (error) => error.code === "authentication_throttled",
  );
  advance(60_001);
  const signedIn = await authentication.signIn({ loginName: "owner", password: ownerPassword, networkIdentifier: "lan-client-b" });
  assert.equal(signedIn.identity.loginName, "owner");
});

test("disables accounts, revokes sessions, and protects the final active owner", async () => {
  const { authentication, repository } = await fixture();
  const owner = await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password: ownerPassword });
  const memberHash = await testHasher().hash("member account has a long passphrase", { loginName: "member", displayName: "Member" });
  const member = await repository.insertIdentity({
    loginName: "member",
    normalizedLoginName: "member",
    displayName: "Member",
    passwordHash: memberHash,
  });
  const memberSession = await authentication.signIn({
    loginName: "member",
    password: "member account has a long passphrase",
    networkIdentifier: "lan-client-c",
  });
  const context = { identityId: owner.identity.id, permissions: ["identity:manage"], roles: ["owner"] };
  await authentication.disableAccount(member.id, context);
  await assert.rejects(
    authentication.authenticateSession({ sessionToken: memberSession.sessionToken }),
    (error) => error.code === "invalid_session",
  );
  await assert.rejects(
    authentication.disableAccount(owner.identity.id, context),
    (error) => error.code === "last_owner",
  );
});

test("recovers an existing owner only with local proof and a one-time code", async () => {
  const { authentication } = await fixture();
  const bootstrapped = await authentication.bootstrapOwner({
    loginName: "owner",
    displayName: "Owner",
    password: ownerPassword,
  });
  const oldSession = await authentication.signIn({
    loginName: "owner",
    password: ownerPassword,
    networkIdentifier: "lan-client-d",
  });
  const recoveryCode = bootstrapped.recoveryCodes[0];
  await assert.rejects(
    authentication.recoverOwner({
      recoveryCode,
      newPassword: replacementPassword,
      localRecoveryChallenge: "local-browser-challenge",
      localRecoveryProof: "remote-browser-only",
    }),
    (error) => error.code === "recovery_failed",
  );
  const recovered = await authentication.recoverOwner({
    recoveryCode,
    newPassword: replacementPassword,
    localRecoveryChallenge: "local-browser-challenge",
    localRecoveryProof: "local-console-proof",
  });
  assert.equal(recovered.recoveryCodes.length, 8);
  await assert.rejects(
    authentication.authenticateSession({ sessionToken: oldSession.sessionToken }),
    (error) => error.code === "invalid_session",
  );
  await assert.rejects(
    authentication.recoverOwner({
      recoveryCode,
      newPassword: "yet another sufficiently long owner phrase",
      localRecoveryChallenge: "local-browser-challenge",
      localRecoveryProof: "local-console-proof",
    }),
    (error) => error.code === "recovery_failed",
  );
  const signedIn = await authentication.signIn({
    loginName: "owner",
    password: replacementPassword,
    networkIdentifier: "lan-client-d",
  });
  assert.equal(signedIn.identity.loginName, "owner");
});
