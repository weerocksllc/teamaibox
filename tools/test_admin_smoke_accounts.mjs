import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

import { clearSmokeAccounts, cleanupFailure, readSmokeAccounts, temporaryAccountLifecycle, temporarySmokeAccount } from "./admin-smoke-accounts.mjs";

const credential = () => ({ loginName: `operator-${randomBytes(8).toString("hex")}`, password: randomBytes(32).toString("base64url") });
const stdin = value => Readable.from([Buffer.from(JSON.stringify(value))]);

test("protected stdin requires explicit distinct target credentials", async () => {
  const accounts = { owner: credential(), member: credential(), target: credential() };
  assert.deepEqual(await readSmokeAccounts(stdin(accounts), { targetRequired: true }), accounts);
  await assert.rejects(readSmokeAccounts(stdin({ owner: accounts.owner, member: accounts.member }), { targetRequired: true }), /target credentials/);
  await assert.rejects(readSmokeAccounts(stdin({ ...accounts, target: accounts.owner }), { targetRequired: true }), /distinct/);
  assert.deepEqual(Object.keys(await readSmokeAccounts(stdin(accounts))), ["owner", "member"]);
  clearSmokeAccounts(accounts);
  assert.ok(Object.values(accounts).every(value => value.password === ""));
});

test("stdin input is bounded and parse errors do not disclose input", async () => {
  const privateValue = randomBytes(32).toString("base64url");
  await assert.rejects(readSmokeAccounts(Readable.from([`{${privateValue}`])), error => !error.message.includes(privateValue));
  await assert.rejects(readSmokeAccounts(Readable.from([Buffer.alloc(65_537, 65)])), /Protected stdin/);
  const values = { owner: credential(), member: credential() };
  values.member.loginName += '"';
  await assert.rejects(readSmokeAccounts(stdin(values)), /Protected stdin/);
});

test("temporary names and both passwords are independent random values", () => {
  const accounts = Array.from({ length: 64 }, temporarySmokeAccount);
  assert.equal(new Set(accounts.map(value => value.loginName)).size, accounts.length);
  assert.equal(new Set(accounts.flatMap(value => [value.initialPassword, value.replacementPassword])).size, accounts.length * 2);
  for (const value of accounts) {
    assert.match(value.loginName, /^smoke-[a-f0-9]{48}$/);
    assert.match(value.initialPassword, /^[A-Za-z0-9_-]{64}$/);
    assert.match(value.replacementPassword, /^[A-Za-z0-9_-]{64}$/);
  }
});

function fixture({ existing = false, fail = null } = {}) {
  const account = temporarySmokeAccount(), owner = credential(), id = randomUUID(), requests = [];
  let present = existing, status = "active", lookups = 0, logins = 0;
  const identity = () => ({ id, loginName: account.loginName, identityKind: "local_user", status });
  const json = value => ({ status: 200, bytes: Buffer.from(JSON.stringify(value)) });
  const lifecycle = temporaryAccountLifecycle({
    origin: "https://smoke.invalid/", account, owner,
    async signIn(origin, loginName, password) {
      logins += 1;
      assert.equal(origin, "https://smoke.invalid/");
      assert.equal(loginName, owner.loginName); assert.equal(password, owner.password);
      if (fail === "authentication" && logins > 1) return { status: 401 };
      return { status: 200, session: { cookie: randomBytes(24).toString("hex"), csrf: randomBytes(24).toString("hex") } };
    },
    async request(origin, path, options) {
      requests.push({ path, options });
      if (path.includes("?")) {
        lookups += 1;
        assert.equal(new URL(path, origin).searchParams.get("q"), account.loginName);
        const data = present ? [identity()] : [];
        if (fail === "ambiguous" && lookups > 1) data.push(identity());
        if (fail === "confirmation" && lookups > 2) data[0].status = "active";
        return json({ data, hasMore: fail === "pagination" && lookups > 1 });
      }
      assert.equal(path, `/api/v1/admin/users/${id}/disable`);
      assert.equal(options.method, "POST"); assert.deepEqual(options.body, {});
      if (fail === "disable") return { status: 503 };
      if (fail === "transport") throw new Error(account.replacementPassword);
      status = "disabled";
      return json(identity());
    },
  });
  return { lifecycle, requests, account, create() { present = true; }, status: () => status, logins: () => logins };
}

test("no account is mutated before creation and a collision fails closed", async () => {
  const idle = fixture();
  assert.deepEqual(await idle.lifecycle.cleanup(), { status: "passed", temporaryAccount: "not-created" });
  assert.equal(idle.requests.length, 0);
  assert.throws(() => idle.lifecycle.markCreationAttempted(), /preflight/);
  const collision = fixture({ existing: true });
  await assert.rejects(collision.lifecycle.prepare(), /refusing to reuse/);
  assert.equal((await collision.lifecycle.cleanup()).temporaryAccount, "not-created");
  assert.equal(collision.status(), "active");
});

test("cleanup reauthenticates, disables and independently confirms the exact temporary account", async () => {
  const f = fixture();
  await f.lifecycle.prepare(); f.lifecycle.markCreationAttempted(); f.create();
  assert.deepEqual(await f.lifecycle.cleanup(), { status: "passed", temporaryAccount: "disabled" });
  assert.equal(f.status(), "disabled"); assert.equal(f.logins(), 2);
  assert.equal(f.requests.filter(value => value.path.endsWith("/disable")).length, 1);
  assert.equal(f.requests.length, 4);
});

for (const fail of ["authentication", "disable", "transport", "confirmation", "ambiguous", "pagination"]) {
  test(`cleanup ${fail} failure is visible and does not leak account material`, async () => {
    const f = fixture({ fail });
    await f.lifecycle.prepare(); f.lifecycle.markCreationAttempted(); f.create();
    await assert.rejects(f.lifecycle.cleanup(), error => /not confirmed/.test(error.message)
      && !error.message.includes(f.account.replacementPassword) && !error.message.includes(f.account.loginName));
  });
}

test("an interrupted creation is unknown, not silently reported as cleaned", async () => {
  const f = fixture(); await f.lifecycle.prepare(); f.lifecycle.markCreationAttempted();
  await assert.rejects(f.lifecycle.cleanup(), /not confirmed/);
});

test("cleanup failure remains the primary failure while preserving the preceding failure", () => {
  const prior = { type: "BrowserSmokeError", message: "Browser operation failed" };
  const failure = cleanupFailure(prior);
  assert.equal(failure.type, "TemporaryAccountCleanupError");
  assert.deepEqual(failure.precedingFailure, prior);
  assert.match(failure.message, /not confirmed/);
});

test("browser entrypoints require supplied targets and retain no static account assumptions", async () => {
  for (const kind of ["roles", "team"]) {
    const source = await readFile(new URL(`./run_admin_${kind}_browser_smoke.mjs`, import.meta.url), "utf8");
    assert.match(source, /targetRequired: true/);
    assert.match(source, /apiSignIn\(options\.origin, accounts\.target\.loginName, accounts\.target\.password\)/);
    assert.doesNotMatch(source, /\bTEST_(LOGIN|PASSWORD)\b/);
    assert.match(source, /clearSmokeAccounts\(accounts\)/);
  }
  const users = await readFile(new URL("./run_admin_users_browser_smoke.mjs", import.meta.url), "utf8");
  assert.match(users, /temporarySmokeAccount\(\)/);
  assert.match(users, /finally \{[\s\S]*await lifecycle\.cleanup\(\)/);
  assert.match(users, /failure = cleanupFailure\(failure\)/);
  assert.match(users, /screenshots, cleanup, console:/);
  assert.doesNotMatch(users, /retainedAccountVisible|const suffix =|const initialPassword =/);
});
