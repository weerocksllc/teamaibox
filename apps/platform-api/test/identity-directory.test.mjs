import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { IdentityDirectoryHttpApi } from "../src/identity/identity-directory-http-api.mjs";
import { IdentityDirectoryService } from "../src/identity/identity-directory-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c0174199501";
const MEMBER = "018f6f18-24d7-7c21-9b62-8c0174199502";

test("directory paginates every member beyond fifty and accepts a single Chinese character", async () => {
  const repository=new MemoryIdentityRepository(),ids=[];
  for(let i=0;i<123;i++){const id=randomUUID();ids.push(id);await repository.insertIdentity({id,loginName:`member-${i}`,normalizedLoginName:`member-${i}`,displayName:`周${i}`,passwordHash:"not-returned"});}
  // A hidden test identity must not shorten a page and hide real members after it.
  await repository.insertIdentity({id:randomUUID(),loginName:"catalog-hidden",normalizedLoginName:"catalog-hidden",displayName:"A",passwordHash:"not-returned"});
  const service=new IdentityDirectoryService({repository}),api=new IdentityDirectoryHttpApi({service});
  const context={identityId:OWNER,permissions:["team:view"]};let after=0;const found=[];
  for(;;){const page=await api.handle({method:"GET",pathname:"/api/v1/identities/directory",context,query:new URLSearchParams(`limit=50&after=${after}`)});
    found.push(...page.body.data);after=page.body.meta.nextOffset;if(after===null)break;}
  assert.deepEqual(found.map(v=>v.id).sort(),ids.sort());
  assert.equal((await service.byIds({context,identityIds:ids})).length,123);
  assert.equal((await service.search({context,query:"周",limit:50})).length,50);
});

test("identity directory returns only minimal active team member facts", async () => {
  const repository = new MemoryIdentityRepository();
  await repository.insertIdentity({ id: OWNER, loginName: "owner", normalizedLoginName: "owner", displayName: "Owner", passwordHash: "not-returned", roles: ["owner"] });
  await repository.insertIdentity({ id: MEMBER, loginName: "mei", normalizedLoginName: "mei", displayName: "Mei", passwordHash: "not-returned" });
  await repository.insertIdentity({ id: "018f6f18-24d7-7c21-9b62-8c0174199503", loginName: "catalog-fixture", normalizedLoginName: "catalog-fixture", displayName: "Fixture", passwordHash: "not-returned" });
  const api = new IdentityDirectoryHttpApi({ service: new IdentityDirectoryService({ repository }) });
  const context = { identityId: OWNER, identity: { displayName: "Owner" }, permissions: ["team:view"] };
  const found = await api.handle({ method: "GET", pathname: "/api/v1/identities/search", context, query: new URLSearchParams("q=me&limit=10") });
  assert.deepEqual(found.body.data, [{ id: MEMBER, username: "mei", displayName: "Mei" }]);
  assert.equal(JSON.stringify(found).includes("password"), false);
  const directory = await api.handle({ method: "GET", pathname: "/api/v1/identities/directory", context, query: new URLSearchParams("limit=20") });
  assert.deepEqual(directory.body.data, [
    { id: MEMBER, username: "mei", displayName: "Mei" },
    { id: OWNER, username: "owner", displayName: "Owner" },
  ]);
  assert.equal(directory.body.meta.actorIdentityId, OWNER);
  const bootstrap = await api.handle({ method: "GET", pathname: "/api/v1/session/bootstrap", context });
  assert.equal(bootstrap.body.actor.identityId, OWNER);
});

test("identity directory is permission scoped and validates identifiers", async () => {
  const repository = new MemoryIdentityRepository();
  const service = new IdentityDirectoryService({ repository });
  await assert.rejects(service.search({ context: { identityId: OWNER, permissions: [] }, query: "me", limit: 10 }), { code: "access_denied" });
  await assert.rejects(service.byIds({ context: { identityId: OWNER, permissions: ["team:view"] }, identityIds: ["bad"] }), { code: "identity_query_invalid" });
});
