import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createViewingResumeStoreV1 } from "../src/public/casting-viewing-resume-v1.mjs";
const actorIdentityId = "00000000-0000-4000-8000-000000000001";
const session = { id: "00000000-0000-4000-8000-000000000002", state: "pairing", perspective: "viewer",
  outputSinks: ["browser"], audienceRevision: 3, expiresAt: "2030-01-01T00:00:00Z", receiverPin: "1234" };
const invitation = { id: "00000000-0000-4000-8000-000000000003", expiresAt: "2029-01-01T00:00:00Z" };
function fixture() {
  const map = new Map();
  const storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  const store = createViewingResumeStoreV1(storage, () => Date.parse("2028-01-01"));
  return { map, storage, store, read: changes => store.read({ actorIdentityId, session, canView: true, ...changes }) };
}
test("refresh preserves prior explicit consent and viewing intent, not authorization", () => {
  const f = fixture(); f.store.save({ actorIdentityId, session, invitation, wantsViewing: true });
  const restored = createViewingResumeStoreV1(f.storage, () => Date.parse("2028-01-01"));
  assert.equal(restored.read({ actorIdentityId, session, canView: true }).wantsViewing, true);
  assert.equal(f.read().invitationId, invitation.id);
});
test("leave preserves manual rejoin consent without automatic viewing", () => {
  const f = fixture(); f.store.save({ actorIdentityId, session, invitation, wantsViewing: false });
  assert.equal(f.read().wantsViewing, false);
});
test("only a fixed nonsecret whitelist is written, even if input contains credentials", () => {
  const f = fixture(); f.store.save({ actorIdentityId, session: { ...session, mediaCredential: "secret" },
    invitation: { ...invitation, accessToken: "secret" }, wantsViewing: true });
  const value = [...f.map.values()][0]; assert.doesNotMatch(value, /secret|1234|receiverPin|mediaCredential|accessToken/);
  assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ["actorIdentityId", "audienceRevision", "expiresAt", "invitationId", "sessionId", "wantsViewing"].sort());
});
test("different actor, session, revision, permissions, terminal state and manager are rejected", () => {
  for (const changes of [{ actorIdentityId: invitation.id }, { canView: false },
    ...[{ id: invitation.id }, { audienceRevision: 4 }, { state: "stopped" }, { perspective: "manager" },
      { outputSinks: [] }, { perspective: "initiator" }].map(change => ({ session: { ...session, ...change } }))]) {
    const f = fixture(); f.store.save({ actorIdentityId, session, invitation, wantsViewing: true });
    assert.equal(f.read(changes), null); assert.equal(f.map.size, 0);
  }
});
test("expired, malformed and credential-bearing persisted records are removed", () => {
  for (const mutate of [v => ({ ...v, expiresAt: "2020-01-01" }), v => ({ ...v, invitationId: null }),
    v => ({ ...v, mediaCredential: "secret" }), v => ({ ...v, wantsViewing: "true" })]) {
    const f = fixture(); f.store.save({ actorIdentityId, session, invitation, wantsViewing: true });
    const [key, text] = [...f.map][0]; f.map.set(key, JSON.stringify(mutate(JSON.parse(text)))); assert.equal(f.read(), null);
  }
});
test("initiator resume has no invitation and unavailable storage never blocks viewing", () => {
  const f = fixture(), owner = { ...session, perspective: "initiator" };
  f.store.save({ actorIdentityId, session: owner, wantsViewing: true });
  assert.equal(f.read({ session: owner }).invitationId, null);
  const broken = createViewingResumeStoreV1({ getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } });
  assert.equal(broken.read({}), null);
  assert.doesNotThrow(() => broken.save({ actorIdentityId, session: owner, wantsViewing: true }));
});
test("resume runs once at bootstrap, never on polling or receipt of an invitation", async () => {
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const refresh = source.slice(source.indexOf("async function refresh()"), source.indexOf("function draft()"));
  assert.doesNotMatch(refresh, /joinViewing|resumeViewingOnce|api\.accept/);
  assert.match(source, /if \(resumeAttempted\) return/);
  assert.match(source, /await refresh\(\);\s+await resumeViewingOnce\(\)/);
  assert.match(source.slice(source.indexOf("async function leaveViewing()")), /rememberViewingPaused\(\);/);
});
test("unexpected transport loss retains viewing intent for fresh authorized page resume", async () => {
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const f = fixture(); f.store.save({ actorIdentityId, session, invitation, wantsViewing: true });
  let left = null, discarded = false;
  const context = vm.createContext({ mediaSessionId: session.id, state: {},
    rememberViewingPaused: () => f.store.save({ actorIdentityId, session, invitation, wantsViewing: false }),
    discardMediaGrant: () => { discarded = true; }, render: () => {},
    t: value => value, notify: value => assert.equal(value, 'viewingDisconnected'),
    api: { leave: async (id, browser) => { left = id; assert.equal(browser, "browser-instance-test-one"); } },
    browserInstanceId: "browser-instance-test-one", target: session.id });
  await vm.runInContext(source.slice(source.indexOf("async function handleUnexpectedMediaDisconnect("),
    source.indexOf("async function leaveViewing(")) + "\nhandleUnexpectedMediaDisconnect(target);", context);
  assert.equal(discarded, true); assert.equal(left, session.id);
  assert.equal(f.read().wantsViewing, true);
  assert.doesNotMatch([...f.map.values()][0], /mediaCredential|accessToken/);
});
