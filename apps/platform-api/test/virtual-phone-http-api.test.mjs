import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPlatformApiServer } from "../server/platform-api.mjs";
import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { PasswordHasher } from "../src/identity/password.mjs";
import { IdentityPreferencesService } from "../src/identity/preferences-service.mjs";
import { VirtualPhoneHttpApi, matchesVirtualPhoneHttpRoute } from "../src/virtual-phones/virtual-phone-http-api.mjs";
import { VirtualPhoneService } from "../src/virtual-phones/virtual-phone-service.mjs";
import { grantedPermissions, principalFromRoleKeys } from "../../../packages/authorization/src/index.mjs";

const ORIGIN = "https://phone.test", PASSWORD = "correct horse battery staple", PHONE = randomUUID();
function request(server, { method = "GET", path = "/api/v1/virtual-phones", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port: server.address().port, method, path,
      headers:{...headers,...(body!==undefined?{"content-length":Buffer.byteLength(JSON.stringify(body))}:{})} }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    outgoing.on("error", reject); if (body !== undefined) outgoing.write(JSON.stringify(body)); outgoing.end();
  });
}
test("phone routing exposes only the specific member and management APIs", () => {
  for (const [method, path] of [["GET", ""], ["POST", ""], ["GET", "/availability"], ["GET", `/${PHONE}`],
    ["DELETE", `/${PHONE}`], ["PATCH", `/${PHONE}`], ["POST", `/${PHONE}/start`], ["POST", `/${PHONE}/stop`],
    ["POST", `/${PHONE}/restart`], ["POST", `/${PHONE}/connections`], ["DELETE", `/${PHONE}/connections/${PHONE}`],
    ["POST", `/${PHONE}/adb-grants`], ["DELETE", `/${PHONE}/adb-grants/${PHONE}`],
    ["GET", `/${PHONE}/files`], ["POST", `/${PHONE}/files`], ["POST", `/${PHONE}/installations`], ["POST", `/${PHONE}/file-exports`],
    ['GET',`/${PHONE}/camera`], ['POST',`/${PHONE}/camera`], ['DELETE',`/${PHONE}/camera`],
    ["GET", `/operations/${PHONE}`]]) assert.equal(matchesVirtualPhoneHttpRoute(method, `/api/v1/virtual-phones${path}`), true);
  for (const path of [`/${PHONE}/exec`, `/${PHONE}/docker`, "/../admin", "/bad-id", `/${PHONE}/start/extra`]) {
    assert.equal(matchesVirtualPhoneHttpRoute("POST", `/api/v1/virtual-phones${path}`), false);
  }
});
test("phone permissions are assigned to members, not automatically to operations administrators", () => {
  const granted = roles => grantedPermissions({ principal: principalFromRoleKeys({ id: randomUUID(), status: "active", identityKind: "local_user" }, roles) });
  assert.ok(granted(["member"]).includes("phone:use"));
  assert.ok(!granted(["guest"]).includes("phone:use"));
  assert.ok(granted(["system_admin"]).includes("phone:manage"));
  assert.ok(!granted(["system_admin"]).includes("phone:use"));
});
test('camera unavailable does not disclose a foreign phone and never uses the control-peer closer',async()=>{
  const service=Object.fromEntries(['availability','list','get','create','rename','action','getOperation','setQuota','administration'].map(k=>[k,async()=>({})]));
  const api=new VirtualPhoneHttpApi({service}),path=`/api/v1/virtual-phones/${PHONE}/camera`,context={identityId:randomUUID()};
  for(const method of ['GET','POST','DELETE']){
    service.get=async()=>{throw Object.assign(Error(),{code:'phone_not_found'});};
    await assert.rejects(api.handle({method,pathname:path,context}),{code:'phone_not_found'});
    service.get=async()=>({id:PHONE});
    await assert.rejects(api.handle({method,pathname:path,context}),{code:'phone_camera_unavailable'});
  }
  assert.equal(api.matches('PUT',path),false);assert.equal(api.matches('POST',path+'/exec'),false);
});
test("phone HTTP registration retains session, HTTPS origin/CSRF and sign-out boundaries", async t => {
  const identityRepository = new MemoryIdentityRepository();
  const authentication = await LocalAuthentication.create({ repository: identityRepository,
    hasher: new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 }) });
  await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password: PASSWORD });
  const calls = [];
  const service = Object.fromEntries(["availability", "list", "get", "create", "rename", "action", "getOperation", "setQuota", "administration", "setFeature", "administrationQuotas", "handleSignOut"]
    .map(name => [name, async input => { calls.push({ name, input }); return { id: PHONE, state: "queued" }; }]));
  service.list=async input=>{calls.push({name:'list',input});return {object:'list',data:[{id:PHONE,generation:1}],quota:{}};};
  const server = createPlatformApiServer({ authentication, preferences: new IdentityPreferencesService({ repository: identityRepository }),
    publicOrigin: ORIGIN, logger: { info() {}, warn() {}, error() {} }, virtualPhoneApi: new VirtualPhoneHttpApi({ service,
      accessService:{async issue(input){calls.push({name:"issueTicket",input});return {id:PHONE,token:"synthetic-ticket"};},
        async closeConnection(input){calls.push({name:"closeConnection",input});return {closed:true};}},
      fileService:Object.fromEntries(['upload','download','list'].map(name=>[name,async input=>{calls.push({name:'file-'+name,input});return {phoneId:PHONE};}])),
      cameraService:Object.fromEntries(['status','start','stop','listStates','browserOffer','keepBrowserAlive'].map(name=>[name,async input=>{calls.push({name:'camera-'+name,input});return name==='listStates'?[]:{phoneId:PHONE};}])) }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal((await request(server)).status, 426, "plaintext requests require HTTPS");
  assert.equal((await request(server, { headers: { "x-forwarded-proto": "https" } })).status, 401);
  assert.equal(calls.length, 0);
  const login = await request(server, { method: "POST", path: "/api/auth/sign-in", body: { loginName: "owner", password: PASSWORD },
    headers: { origin: ORIGIN, "x-forwarded-proto": "https", "content-type": "application/json" } });
  assert.equal(login.status, 200);
  const csrf = JSON.parse(login.text).csrfToken;
  const cookie = login.headers["set-cookie"].map(value => value.split(";", 1)[0]).join("; ");
  const headers = { origin: ORIGIN, "x-forwarded-proto": "https", "content-type": "application/json", cookie,
    "x-csrf-token": csrf, "idempotency-key": "phone-create-0001" };
  const csrfMissing = { ...headers }; delete csrfMissing["x-csrf-token"];
  const csrfRejected = await request(server, { method: "POST", headers: csrfMissing, body: { name: "new" } });
  assert.equal(csrfRejected.status, 401, csrfRejected.text);
  assert.equal(calls.length, 0);
  assert.equal((await request(server, { method: "POST", headers: { ...headers, origin: "https://other.test" }, body: { name: "new" } })).status, 403);
  const created = await request(server, { method: "POST", headers, body: { name: "new" } });
  assert.equal(created.status, 202, created.text); assert.equal(created.headers["cache-control"], "no-store");
  assert.equal(calls.at(-1).input.key, "phone-create-0001");
  assert.ok(calls.at(-1).input.context.identityId);
  assert.equal((await request(server, { headers })).status, 200);
  const featurePath = "/api/v1/admin/virtual-phones/feature";
  assert.equal((await request(server, { method: "PUT", path: featurePath, headers: csrfMissing, body: { enabled: false, expectedRevision: 0 } })).status, 401);
  assert.equal((await request(server, { method: "PUT", path: featurePath, headers, body: { enabled: false, expectedRevision: 0 } })).status, 200);
  assert.equal(calls.at(-1).name, "setFeature");
  assert.equal((await request(server, { path: "/api/v1/admin/virtual-phones/quotas?search=member", headers })).status, 200);
  assert.deepEqual(calls.at(-1).input.query, { search: "member" });
  assert.equal((await request(server, { path: "/api/v1/admin/virtual-phones/quotas?search=a&search=b", headers })).status, 400);
  const connectionPath=`/api/v1/virtual-phones/${PHONE}/connections`;
  const count=calls.length;
  assert.equal((await request(server,{method:"POST",path:connectionPath,headers:csrfMissing,body:{kind:"control"}})).status,401);
  assert.equal(calls.length,count);
  const ticket=await request(server,{method:"POST",path:connectionPath,headers,body:{kind:"control"}});
  assert.equal(ticket.status,201,ticket.text);assert.equal(ticket.headers["cache-control"],"no-store");
  assert.equal(calls.at(-1).name,"issueTicket");assert.equal(calls.at(-2).name,"get");
  assert.ok(calls.at(-1).input.context.sessionId);
  const close=await request(server,{method:"DELETE",path:connectionPath+"/"+PHONE,headers,body:{}});
  assert.equal(close.status,200,close.text);assert.equal(calls.at(-1).name,"closeConnection");
  const adbPath=`/api/v1/virtual-phones/${PHONE}/adb-grants`;
  assert.equal((await request(server,{method:'POST',path:adbPath,headers:csrfMissing,body:{ttlSeconds:900}})).status,401);
  for(const body of [{kind:'control'},{host:'127.0.0.1'},{ttlSeconds:900,ownerId:PHONE}]){
    assert.equal((await request(server,{method:'POST',path:adbPath,headers,body})).status,400);
  }
  assert.equal((await request(server,{method:'POST',path:adbPath,headers,body:{ttlSeconds:900}})).status,201);
  assert.equal(calls.at(-2).name,'get');assert.deepEqual(calls.at(-1).input.input,{kind:'adb',ttlSeconds:900});
  assert.equal((await request(server,{method:'DELETE',path:adbPath+'/'+PHONE,headers,body:{}})).status,200);
  assert.equal(calls.at(-1).name,'closeConnection');
  const filesPath=`/api/v1/virtual-phones/${PHONE}/files`,fileBody={expectedGeneration:1,file:{objectId:randomUUID()}};
  assert.equal((await request(server,{method:'POST',path:filesPath,headers:csrfMissing,body:fileBody})).status,401);
  assert.equal((await request(server,{method:'POST',path:filesPath,headers:{...headers,origin:'https://foreign.test'},body:fileBody})).status,403);
  assert.equal((await request(server,{method:'GET',path:filesPath+'?generation=1',headers})).status,200);
  assert.equal(calls.at(-2).name,'get');assert.equal(calls.at(-1).name,'file-list');assert.equal(calls.at(-1).input.generation,1);
  for(const query of ['','?generation=1&generation=2','?generation=1&path=/secret','?generation=-1']){
    assert.equal((await request(server,{path:filesPath+query,headers})).status,400);
  }
  for(const suffix of ['files','installations','file-exports']){
    const result=await request(server,{method:'POST',path:`/api/v1/virtual-phones/${PHONE}/${suffix}`,headers,body:fileBody});
    assert.equal(result.status,201,result.text);assert.equal(calls.at(-2).name,'get');
    assert.equal(calls.at(-1).name,suffix==='file-exports'?'file-download':'file-upload');
    assert.ok(calls.at(-1).input.signal instanceof AbortSignal,'client disconnect reaches transfer');
    if(suffix!=='file-exports')assert.equal(calls.at(-1).input.install,suffix==='installations');
  }
  const cameraPath=`/api/v1/virtual-phones/${PHONE}/camera`;
  for(const method of ['POST','DELETE']){
    const n=calls.length;
    assert.equal((await request(server,{method,path:cameraPath,headers:csrfMissing,body:{}})).status,401);
    assert.equal((await request(server,{method,path:cameraPath,headers:{...headers,origin:'https://foreign.test'},body:{}})).status,403);
    assert.equal(calls.length,n);
    const result=await request(server,{method,path:cameraPath,headers,body:{expectedGeneration:1}});
    assert.equal(result.status,method==='POST'?201:200,result.text);assert.equal(result.headers['cache-control'],'no-store');
    assert.equal(calls.at(-2).name,'get');assert.equal(calls.at(-1).name,method==='POST'?'camera-start':'camera-stop');
    assert.ok(calls.at(-1).input.context.sessionId);assert.ok(calls.at(-1).input.signal instanceof AbortSignal);
  }
  for(const query of ['', '?generation=1&generation=1','?generation=1&host=x','?generation=0','?generation=9007199254740992'])
    assert.equal((await request(server,{path:cameraPath+query,headers})).status,400);
  assert.equal((await request(server,{path:cameraPath+'?generation=1',headers})).status,200);
  assert.equal(calls.at(-1).name,'camera-status');assert.equal(calls.at(-1).input.generation,1);
  for(const action of ['offer','heartbeat']){
    const path=cameraPath+'/browser/'+action,body={expectedGeneration:1,sourceId:randomUUID(),...(action==='offer'?{offerSdp:'v=0\r\n'}:{})};
    const n=calls.length;
    assert.equal((await request(server,{method:'POST',path,headers:csrfMissing,body})).status,401);
    assert.equal((await request(server,{method:'POST',path,headers:{...headers,origin:'https://foreign.test'},body})).status,403);
    assert.equal(calls.length,n);
    const result=await request(server,{method:'POST',path,headers:{...headers,'x-forwarded-for':'::ffff:10.64.0.8'},body});
    assert.equal(result.status,200,result.text);assert.equal(result.headers['cache-control'],'no-store');
    assert.equal(calls.at(-1).name,action==='offer'?'camera-browserOffer':'camera-keepBrowserAlive');
    assert.ok(calls.at(-1).input.context.sessionId);assert.ok(calls.at(-1).input.signal instanceof AbortSignal);
    if(action==='offer')assert.deepEqual(calls.at(-1).input.allowedAddresses,['10.64.0.8']);
  }
  for(const peer of ['127.0.0.1','8.8.8.8','camera.local','10.64.0.8, 10.0.0.1'])
    assert.equal((await request(server,{method:'POST',path:cameraPath+'/browser/offer',headers:{...headers,'x-forwarded-for':peer},body:{}})).status,409);
  const signedOut = await request(server, { method: "POST", path: "/api/auth/sign-out", headers, body: {} });
  assert.equal(signedOut.status, 200);
  assert.equal(calls.at(-1).name, "handleSignOut");
  assert.ok(calls.at(-1).input.context.sessionId);
  assert.equal((await request(server, { headers })).status, 401);
});
test("administrative pause is persistent and never grants managers phone content access or enables an uninstalled runtime", async () => {
  const manager = randomUUID(), member = randomUUID(); let policy = null; const calls = [];
  const repository = { requestCreate() {}, completeOperation() {}, async featurePolicy() { return policy; },
    async setFeaturePolicy(actorId, value) { calls.push(actorId); if (value.expectedRevision !== (policy?.revision ?? 0)) throw Object.assign(new Error(), { code: "phone_state_conflict" }); policy = { enabled: value.enabled, revision: (policy?.revision ?? 0) + 1 }; },
    async administrationQuotas(query) { calls.push(query); return { data: [], nextCursor: null }; },
    async get() { return { id: PHONE }; }, async findRequest() { return null; },
    async requestAction(value) { calls.push(value.action); return { id: randomUUID(), phoneId: PHONE, action: value.action, state: "queued" }; } };
  const directory = { async authorization(id) { return { permissions: id === manager ? ["phone:manage"] : ["phone:use"] }; } };
  const runtime = Object.fromEntries(["provision", "start", "stop", "deleteData", "revokeAccess"].map(key => [key, async () => {}]));
  const capacity = { async placement() {}, async acquireRun() {}, async releaseRun() {}, async status() { return []; } };
  const settings = { repository, directory, capacity, runtime, policy: { enabled: true } }, service = new VirtualPhoneService(settings);
  await assert.rejects(service.setFeature({ context: { identityId: member }, input: { enabled: false, expectedRevision: 0 } }), { code: "phone_permission_required" });
  const admin = await service.setFeature({ context: { identityId: manager }, input: { enabled: false, expectedRevision: 0 } });
  assert.equal(admin.contentAccessGranted, false); assert.equal(admin.policy.enabled, false);
  const successor = new VirtualPhoneService(settings);
  assert.equal((await successor.availability({ context: { identityId: member } })).enabled, false);
  for (const action of ["start", "restart"]) await assert.rejects(successor.action({ context: { identityId: member }, phoneId: PHONE, action, input: { expectedRevision: 1 }, key: "disabled-action-1" }), { code: "phone_disabled" });
  for (const action of ["stop", "delete"]) assert.equal((await successor.action({ context: { identityId: member }, phoneId: PHONE, action,
    input: { expectedRevision: 1, ...(action === "delete" ? { confirmDelete: true } : {}) }, key: "permitted-action-1" })).state, "queued");
  await assert.rejects(successor.get({ context: { identityId: manager }, phoneId: PHONE }), { code: "phone_permission_required" });
  await assert.rejects(successor.administrationQuotas({ context: { identityId: member } }), { code: "phone_permission_required" });
  await successor.administrationQuotas({ context: { identityId: manager }, query: { search: "member" } });
  assert.deepEqual(calls.at(-1), { search: "member", after: null });
  await assert.rejects(successor.administrationQuotas({ context: { identityId: manager }, query: { endpoint: "http://example.test" } }), { code: "phone_input_invalid" });
  const notInstalled = new VirtualPhoneService({ repository, directory });
  await assert.rejects(notInstalled.setFeature({ context: { identityId: manager }, input: { enabled: true, expectedRevision: 1 } }), { code: "phone_runtime_unavailable" });
  assert.equal((await notInstalled.administration({ context: { identityId: manager } })).deploymentReady, false);
});
test("current authorization, not caller-supplied permissions, protects phone data and quota writes", async () => {
  const member = randomUUID(), manager = randomUUID(), disabled = randomUUID();
  const calls = [];
  const repository = { requestCreate() {}, completeOperation() {},
    async list(ownerId) { calls.push(ownerId); return []; }, async quota() { return { stored: 0, running: 0 }; },
    async setQuota(ownerId, input) { calls.push({ ownerId, input }); return input; } };
  const directory = { async authorization(id) { return id === disabled ? null : { permissions: id === member ? ["phone:use"] : ["phone:manage"] }; } };
  const service = new VirtualPhoneService({ repository, directory });
  assert.equal((await service.availability({ context: { identityId: member } })).reasonCode, "phone_disabled");
  for (const identityId of [manager, disabled]) await assert.rejects(service.list({ context: { identityId, permissions: ["phone:use"] } }), { code: "phone_permission_required" });
  await assert.rejects(service.setQuota({ context: { identityId: member, permissions: ["phone:manage"] }, ownerId: member,
    input: { storedPerUser: 2, runningPerUser: 2 } }), { code: "phone_permission_required" });
  assert.deepEqual(calls, []);
  await service.setQuota({ context: { identityId: manager }, ownerId: member, input: { storedPerUser: 1, runningPerUser: 1 } });
  assert.equal(calls[0].ownerId, member);
});
