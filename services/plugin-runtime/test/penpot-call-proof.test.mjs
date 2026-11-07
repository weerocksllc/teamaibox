import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PenpotCallProofs } from "../src/penpot-call-proof.mjs";

function fixture() {
  const user = randomUUID(), runtimeId = randomUUID();
  let now = 1_000_000;
  let target = { identityId: user, platformSessionId: randomUUID(), runtimeId, sessionID: "ses_native",
    connectionId: randomUUID(), generation: 1, profileId: randomUUID(), fileId: randomUUID(), pageId: randomUUID() };
  const runtimeAuthentication = Symbol(), mcpAuthentication = Symbol();
  const call = { server: "teamaibox-penpot", tool: "execute_code", sessionID: "ses_native", messageID: "msg_native", callID: "call_native" };
  const pending = new Set([JSON.stringify(call)]);
  const records = new Map();
  const proofs = new PenpotCallProofs({ clock: () => now,
    repository: {
      async insert(row) { records.set(row.proofHash, structuredClone(row)); },
      async consume({ proofHash, identityId, runtimeId, now }) {
        const row = records.get(proofHash);
        if (!row || row.binding.identityId !== identityId || row.binding.runtimeId !== runtimeId || row.expiresAt <= now) return null;
        records.delete(proofHash);
        return row;
      },
    },
    authority: {
      async verifyNativeCall(auth, value) { return auth === runtimeAuthentication && pending.has(JSON.stringify(value)) ? { identityId: user, runtimeId } : null; },
      async authenticateMcp(auth) { return auth === mcpAuthentication ? { identityId: user, runtimeId } : null; },
      async resolveCurrentBinding() { return target; },
    },
  });
  const prepare = overrides => proofs.prepare({ runtimeAuthentication, call, ...overrides });
  const issue = async (overrides={}) => {
    const target=Object.hasOwn(overrides,'target')?overrides.target:(await prepare(overrides)).target;
    return proofs.issue({ runtimeAuthentication, call, ...overrides, target });
  };
  const consume = (metadata, overrides) => proofs.consume({ mcpAuthentication, metadata, tool: "execute_code", ...overrides });
  return { proofs, prepare, issue, consume, records, call, pending, target,
    change: values => { target = target ? { ...target, ...values } : null; },
    revoke: () => { target = null; }, advance: ms => { now += ms; } };
}

test("proof is digest-only, single-use and bound to actual authenticated native call", async () => {
  const f = fixture();
  await assert.rejects(f.issue({ runtimeAuthentication: Symbol() }), { code: "penpot_call_denied" });
  await assert.rejects(f.issue({ call: { ...f.call, callID: "forged" } }), { code: "penpot_call_denied" });
  await assert.rejects(f.issue({ call: { ...f.call, sessionID: ["ses_native"] } }), { code: "penpot_call_denied" });
  const metadata = await f.issue();
  assert.equal(JSON.stringify([...f.records.values()]).includes(metadata.proof), false);
  const outcomes = await Promise.allSettled([f.consume(metadata), f.consume(metadata)]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(value => value.status === "rejected").length, 1);
  assert.equal(outcomes.find(value => value.status === "fulfilled").value.fileId, f.target.fileId);
});

test("other identities, forged metadata, tool changes and expired proofs are refused", async () => {
  const f = fixture();
  const metadata = await f.issue();
  await assert.rejects(f.consume(metadata, { mcpAuthentication: Symbol() }), { code: "penpot_call_denied" });
  await assert.rejects(f.consume(metadata, { tool: "export_shape" }), { code: "penpot_call_denied" });
  await assert.rejects(f.consume({ ...metadata, sessionID: "ses_forged" }), { code: "penpot_call_denied" });
  const expired = await f.issue();
  f.advance(15_000);
  await assert.rejects(f.consume(expired), { code: "penpot_call_denied" });
});

test("target changes and logout invalidate dispatch and later native task rechecks", async () => {
  for (const field of ["platformSessionId", "runtimeId", "sessionID", "connectionId", "generation", "profileId", "fileId", "pageId"]) {
    const f = fixture(), metadata = await f.issue();
    f.change({ [field]: field === "generation" ? 2 : randomUUID() });
    await assert.rejects(f.consume(metadata), { code: "penpot_call_denied" }, field);
  }
  const f = fixture();
  const accepted = await f.consume(await f.issue());
  f.revoke();
  await assert.rejects(f.proofs.recheck(accepted), { code: "penpot_call_denied" });
});

test("same user's old session cannot acquire the new design connection", async () => {
  const f = fixture();
  f.change({ sessionID: "ses_new", generation: 2 });
  await assert.rejects(f.issue(), { code: "penpot_call_denied" });
});

test("native approval cannot authorize a new target in the same session", async () => {
  const f=fixture(), {target}=await f.prepare();
  assert.equal(f.records.size,0,"preparing approval does not issue an executable proof");
  await assert.rejects(f.issue({target:undefined}),{code:"penpot_call_denied"});
  await assert.rejects(f.issue({target:"a".repeat(64)}),{code:"penpot_call_denied"});
  f.change({fileId:randomUUID(),pageId:randomUUID(),connectionId:randomUUID(),generation:2});
  await assert.rejects(f.issue({target}),{code:"penpot_call_denied"});
  assert.equal(f.records.size,0);
  const metadata=await f.issue();
  assert.equal(metadata.target,undefined);
  assert.equal((await f.consume(metadata)).generation,2);
});
