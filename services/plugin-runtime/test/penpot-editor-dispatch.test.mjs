import assert from "node:assert/strict";
import test from "node:test";
import { PenpotEditorDispatches } from "../src/penpot-editor-dispatch.mjs";

function fixture() {
  let now = 1000;
  const binding = { identityId: "user-fixture", platformSessionId: "session-fixture", profileId: "profile-fixture",
    connectionId: "connection-fixture", generation: 1, fileId: "file-fixture", pageId: "page-fixture", expiresAt: 16000 };
  let current = { ...binding };
  const records = new Map(), authentication = Symbol();
  const service = new PenpotEditorDispatches({ clock: () => now,
    proofs: { async recheck(target) {
      assert.deepEqual(target, binding);
      if (JSON.stringify(current) !== JSON.stringify(binding)) throw Error("Target changed");
      return { ...current };
    } },
    repository: {
      async insert(row) { records.set(row.ticketHash, structuredClone(row)); },
      async consume(input) {
        const row = records.get(input.ticketHash);
        if (!row || row.requestHash !== input.requestHash || row.expiresAt <= input.now
          || ["identityId", "platformSessionId", "profileId"].some(key => row.binding[key] !== input[key])) return null;
        records.delete(input.ticketHash); return row;
      },
    },
    authenticateEditor: async auth => auth === authentication ? binding : null,
  });
  const request = { id: "native-task-fixture", task: "executeCode", params: { code: "return penpot.currentPage.id" } };
  return { binding, records, request, service, authentication,
    switchTarget: () => { current.generation++; }, expire: () => { now += 10000; } };
}

test("editor receipt binds exact task, current native user and single delivery", async () => {
  const f = fixture(), ticket = await f.service.issue(f);
  assert.equal(JSON.stringify([...f.records.values()]).includes(ticket), false);
  await assert.rejects(f.service.consume({ editorAuthentication: Symbol(), request: f.request, ticket }));
  await assert.rejects(f.service.consume({ editorAuthentication: f.authentication,
    request: { ...f.request, params: { code: "penpot.createRectangle()" } }, ticket }));
  const results = await Promise.allSettled([0, 1].map(() => f.service.consume({ editorAuthentication: f.authentication, request: f.request, ticket })));
  assert.equal(results.filter(v => v.status === "fulfilled").length, 1);
  assert.equal(results.find(v => v.status === "fulfilled").value.fileId, f.binding.fileId);
});

test("switched target and expired browser delivery refuse execution", async () => {
  for (const change of ["switchTarget", "expire"]) {
    const f = fixture(), ticket = await f.service.issue(f);
    f[change]();
    await assert.rejects(f.service.consume({ editorAuthentication: f.authentication, request: f.request, ticket }));
  }
});

test("unresolved result is disclosed and confirmed only for the authorized original design", async () => {
  const reviewId="12e4c1d0-6c7e-4a00-a4c1-d831e5ef8b4f";
  const target={fileId:"file-fixture",pageId:"page-fixture",teamId:"team-fixture",projectId:"project-fixture"};
  const original={identityId:"user-fixture",profileId:"profile-fixture"};
  let canRead=true,uncertain=false,confirmed=0;
  const service=new PenpotEditorDispatches({
    proofs:{recheck:async()=>{}},
    repository:{
      insert:async()=>{},consume:async()=>{},
      pending:async identityId=>identityId===original.identityId
        ? {reviewId,binding:{...original,...target},workspace:{projectId:target.projectId},uncertain}:null,
      reviewed:async()=>{confirmed++;return true;},
    },
    authenticateEditor:async auth=>auth,
    nativePermissions:{check:async()=>({canRead,teamId:target.teamId})},
  });
  const review=(auth=original)=>service.recovery(auth);
  const confirm=(override={})=>service.reviewed({editorAuthentication:original,reviewId,...target,...override});
  assert.deepEqual(await review(),{reviewId,state:"pending",target});
  await assert.rejects(confirm(),{status:403});
  uncertain=true;
  assert.deepEqual(await review(),{reviewId,state:"uncertain",target});
  assert.equal(await review({...original,identityId:"unrelated"}),null);
  assert.equal((await review({...original,profileId:"different-native-profile"})).target,null);
  await assert.rejects(review(null),{status:403});
  await assert.rejects(confirm({fileId:"other-file"}),{status:403});
  await assert.rejects(confirm({pageId:"other-page"}),{status:403});
  canRead=false;
  assert.equal((await review()).target,null);
  await assert.rejects(confirm(),{status:403});
  assert.equal(confirmed,0);
  canRead=true;
  assert.deepEqual(await confirm(),{reviewed:true});
  assert.equal(confirmed,1);
});
