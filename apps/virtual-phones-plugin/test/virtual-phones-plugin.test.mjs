import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createVirtualPhonesPluginServer } from "../src/server.mjs";
import { createPhoneApi, phoneActions, normalizePhone } from "../src/public/phone-client.mjs";

const PHONE = "00000000-0000-4000-8000-000000000101";
test('retired records offer an honest removal action, never pretend physical data was deleted',async()=>{
 assert.deepEqual(phoneActions({state:'unavailable',cleanupMode:'retired-record',runningCharged:false},true),['rename','remove-record']);
 assert.ok(!phoneActions({state:'unavailable',cleanupMode:'retired-record',runningCharged:true},true).includes('remove-record'));
 const calls=[],api=createPhoneApi({cookie:()=> '__Host-teamaibox-csrf=test-only',fetchImpl:async(path,options)=>{calls.push({path,...options});return Response.json({id:PHONE,recordRemoved:true,dataDeleted:false})}});
 const result=await api.mutate({action:'remove-record',phoneId:PHONE,body:{expectedRevision:1,confirmDelete:true},key:'cleanup-test-key'});
 assert.equal(result.dataDeleted,false);assert.equal(calls[0].method,'POST');assert.ok(calls[0].path.endsWith('/remove-record'));
});
test('long phone names remain usable in the client and creation form',async()=>{
  const name='办公手机📱'.repeat(1000);
  assert.equal(normalizePhone({object:'virtual_phone',id:PHONE,name,state:'stopped',revision:1,runningCharged:false}).name,name);
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/<input[^>]*id="name"[^>]*maxlength=/);
});
test("phone plugin serves local namespaced assets without a catalog or mutation dependency", async () => {
  const server = createVirtualPhonesPluginServer();
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
    assert.deepEqual(await (await fetch(base+"/health/ready")).json(), { status:"ready",pluginId:"official.virtual-phones",version:pkg.version });
    for (const path of ["", "/app.js", "/app.css", "/phone-client.mjs", "/phone-media.mjs", "/phone-workspace.mjs", "/phone-workspace.css", "/phone-debug.mjs", "/phone-debug.css", "/phone-adb-cli.mjs", "/phone-adb-NOTICE.txt", "/preferences-v1.mjs"]) assert.equal((await fetch(base+"/plugins/official.virtual-phones"+path)).status,200);
    assert.equal((await fetch(base+"/plugins/official.virtual-phones",{method:"POST"})).status,405);
    for (const path of ["/package.json", "/plugins/official.virtual-phones/%00/secrets", "/plugins/official.virtual-phones/../server.mjs"]) assert.equal((await fetch(base+path)).status,404);
    const source = await (await fetch(base+"/plugins/official.virtual-phones/app.js")).text();
    assert.doesNotMatch(source, /innerHTML|localStorage|\/api\/v1\/applications|https:\/\/cdn/);
    assert.match(source, /state\.pending = request/);
    assert.match(source, /confirmDelete:/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test("phone client carries secure session/CSRF and reuses an explicit mutation key", async () => {
  const calls = [];
  const api = createPhoneApi({ cookie:()=>"__Host-teamaibox-csrf=test-csrf", fetchImpl:async (path,options)=>{
    calls.push({path,...options}); return Response.json({ object:"virtual_phone.operation",id:PHONE,phoneId:PHONE });
  } });
  const request = {action:"delete",phoneId:PHONE,body:{expectedRevision:7,confirmDelete:true},key:"same-request-key"};
  await api.mutate(request); await api.mutate(request);
  assert.equal(calls[0].method,"DELETE"); assert.equal(calls[0].credentials,"same-origin");
  assert.equal(calls[0].headers["x-csrf-token"],"test-csrf");
  assert.deepEqual(calls[0].headers,calls[1].headers); assert.equal(calls[0].body,calls[1].body);
  await assert.rejects(createPhoneApi({cookie:()=>"",fetchImpl:()=>assert.fail("unauthenticated mutation")}).mutate(request),{code:"invalid_session"});
  await assert.rejects(api.mutate({...request,phoneId:"../../etc"}),{code:"phone_response_invalid"});
});
test("phone list rejects malformed data and authentication failure, not a fixed response size", async () => {
  const quota = {stored:0,running:0,storedPerUser:2,runningPerUser:2};
  assert.deepEqual(await createPhoneApi({fetchImpl:async()=>Response.json({object:"list",data:[],quota})}).list(),{data:[],quota});
  for (const data of [{object:"list",data:[{}],quota},{object:"list",data:[],quota:{}}]) {
    await assert.rejects(createPhoneApi({fetchImpl:async()=>Response.json(data)}).list(),{code:"phone_response_invalid"});
  }
  await assert.rejects(createPhoneApi({fetchImpl:async()=>Response.json({data:"x".repeat(1048577)})}).list(),{code:"phone_response_invalid"});
  await assert.rejects(createPhoneApi({fetchImpl:async()=>Response.json({error:{code:"invalid_session"}},{status:401})}).list(),{code:"invalid_session"});
});
test('valid phone lists above one MiB are not silently hidden by the browser client',async()=>{
  const data=Array.from({length:7000},(_,i)=>({object:'virtual_phone',id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,
    name:'已保存的工作手机',state:'stopped',revision:1,runningCharged:false,generation:0}));
  const quota={stored:data.length,running:0,storedPerUser:null,runningPerUser:null};
  const payload={object:'list',data,quota};assert.ok(Buffer.byteLength(JSON.stringify(payload))>1048576);
  const result=await createPhoneApi({fetchImpl:async()=>Response.json(payload)}).list();
  assert.equal(result.data.length,data.length);assert.equal(result.data.at(-1).id,data.at(-1).id);
});
test("lifecycle controls do not offer conflicting actions and do not hide charged uncertain runs", () => {
  assert.deepEqual(phoneActions({state:"starting"},true),[]);
  assert.deepEqual(phoneActions({state:"unavailable",runningCharged:true},false),["stop","rename","delete"]);
  assert.deepEqual(phoneActions({state:"stopped",runningCharged:false},false),["rename","delete"]);
  assert.deepEqual(phoneActions({state:"running",runningCharged:true},true),["stop","restart","rename","delete"]);
  const value = normalizePhone({object:"virtual_phone",id:PHONE,name:"<img onerror=alert(1)>",state:"stopped",revision:1,runningCharged:false,ownerId:PHONE});
  assert.equal(value.ownerId,undefined); assert.equal(value.name,"<img onerror=alert(1)>","names render with textContent, not HTML");
});
test("release template requests member use, never management or direct devices", async () => {
  const value = JSON.parse(await readFile(new URL("../manifest.release-template.json",import.meta.url),"utf8"));
  assert.deepEqual(value.permissions.platformApiScopes,["phone:use"]); assert.deepEqual(value.permissions.devices,[]);
  assert.equal(value.ui.icon,"smartphone"); assert.equal(value.ui.category,"professional-tool");
  assert.match(value.images[0].variants[0].reference,/^__RELEASE_PIPELINE_MUST_SET/);
});

test('debug client checks selected phone, kind, expiry and sends only explicit scope',async()=>{
  const ticket={object:'virtual_phone.connection_ticket',phoneId:PHONE,id:PHONE,kind:'adb',token:'d'.repeat(43),
    expiresAt:new Date(Date.now()+900000).toISOString(),connectionExpiresAt:new Date(Date.now()+60000).toISOString()},calls=[];
  let response=ticket;
  const api=createPhoneApi({cookie:()=> '__Host-teamaibox-csrf=test-only',fetchImpl:async(path,options)=>{calls.push({path,...options});return Response.json(response);}});
  assert.deepEqual(await api.enableDebug(PHONE),ticket);assert.equal(calls[0].path,`/api/v1/virtual-phones/${PHONE}/adb-grants`);
  assert.deepEqual(JSON.parse(calls[0].body),{ttlSeconds:900});assert.equal(calls[0].headers['x-csrf-token'],'test-only');
  for(const patch of [{kind:'control'},{phoneId:'foreign'},{token:'bad'},{expiresAt:new Date(Date.now()+1000000).toISOString()},
    {connectionExpiresAt:new Date(Date.now()-1000).toISOString()}]){
    response={...ticket,...patch};await assert.rejects(api.enableDebug(PHONE),{code:'phone_response_invalid'});
  }
  response={closed:true};await api.disableDebug(PHONE,PHONE);assert.equal(calls.at(-1).method,'DELETE');
});
