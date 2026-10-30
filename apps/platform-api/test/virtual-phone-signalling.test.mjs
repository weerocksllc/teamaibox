import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createServer,request} from "node:http";
import {once} from "node:events";
import {setTimeout as delay} from "node:timers/promises";
import {test} from "node:test";
import WebSocket from "ws";
import {PhoneSignallingGateway,PhoneSignalPolicy} from "../src/virtual-phones/phone-signalling-gateway.mjs";
import {createPlatformApiServer} from "../server/platform-api.mjs";
import {LocalAuthentication} from "../src/identity/auth-service.mjs";
import {MemoryIdentityRepository} from "../src/identity/memory-repository.mjs";
import {PasswordHasher} from "../src/identity/password.mjs";
import {IdentityPreferencesService} from "../src/identity/preferences-service.mjs";

const ORIGIN="https://phone.test",TOKEN="A".repeat(43),PHONE=randomUUID(),GRANT=randomUUID();
const PATH=`/api/v1/virtual-phones/${PHONE}/connections/${GRANT}/signal`;
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(10);}assert.fail("condition timeout");}
async function fixture(t,{context={identityId:randomUUID(),sessionId:randomUUID()},maximumConnections=4}={}) {
  const events=[],messages=[],record={id:GRANT,phoneId:PHONE,runId:randomUUID(),ownerId:context.identityId,sessionId:context.sessionId,generation:1,kind:"control"};
  let authorized=true,used=false,upstreamInput=null;
  const access={
    async consume(input){events.push("consume");assert.equal(input.phoneId,PHONE);assert.equal(input.grantId,GRANT);
      if(used || input.token!==TOKEN)throw Error("invalid");used=true;return record;},
    async assertConnected(){if(!authorized)throw Error("invalid");},
    async disconnect(value){assert.equal(value,record);events.push("revoke-peer");}
  };
  const upstream={async connect(input){upstreamInput=input;events.push("node-connect");
    return {send(value){messages.push(value);},close(){events.push("node-close");}};}};
  const gateway=new PhoneSignallingGateway({accessService:access,upstream,publicOrigin:ORIGIN,maximumConnections});
  const server=createServer((r,s)=>s.writeHead(404).end());
  server.on("upgrade",(req,socket,head)=>void gateway.attachUpgrade(req,socket,head,{context}).then(handled=>{if(!handled)socket.destroy();}));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await gateway.close();await new Promise(resolve=>server.close(resolve));});
  const open=async({path=PATH,origin=ORIGIN}={})=>{
    const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`,{origin,perMessageDeflate:false});
    ws.on("error",()=>{});const received=[];ws.on("message",v=>received.push(JSON.parse(v.toString())));
    await once(ws,"open");return {ws,received};
  };
  return {gateway,server,open,access,events,messages,record,deny:()=>{authorized=false;},device:value=>upstreamInput.onMessage(value),upstream:()=>upstreamInput};
}

test("Cuttlefish projection rejects other devices, lists and relay credentials",()=>{
  for(const message of [{message_type:"list"},{message_type:"connect",device_id:"other"},{message_type:"connect",device_id:`phone-${PHONE}`,url:"http://host"}]) {
    assert.throws(()=>new PhoneSignalPolicy(PHONE).client(message));
  }
  const policy=new PhoneSignalPolicy(PHONE);
  policy.client({message_type:"connect",device_id:`phone-${PHONE}`});
  assert.throws(()=>policy.client({message_type:"connect",device_id:`phone-${PHONE}`}));
  assert.throws(()=>policy.client({message_type:"forward",payload:{type:"request-offer",ice_servers:[{urls:"stun:external.test"}]}}));
  assert.deepEqual(policy.device({message_type:"device_info",path:"secret",devices:["other"]}),{message_type:"device_info"});
  assert.deepEqual(policy.device({message_type:"config",ice_servers:["external"]}),{message_type:"config",ice_servers:[]});
  policy.client({message_type:"forward",payload:{type:"request-offer",ice_servers:[]}});
  assert.throws(()=>policy.client({message_type:"forward",payload:{type:"adb",command:"shell"}}));
  assert.throws(()=>policy.device({message_type:"device_msg",payload:{type:"offer",sdp:"x".repeat(196609)}}));
});

test("real WebSocket first-frame ticket connects only selected phone and revokes peer on close",async t=>{
  const f=await fixture(t),{ws,received}=await f.open();assert.deepEqual(f.events,[]);
  ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await until(()=>received.length===1);
  assert.deepEqual(received[0],{type:"phone.signal.ready"});assert.deepEqual(f.events,["consume","node-connect"]);
  ws.send(JSON.stringify({message_type:"connect",device_id:`phone-${PHONE}`}));await until(()=>f.messages.length===1);
  f.device({message_type:"device_info",private_config:"not forwarded"});await until(()=>received.length===2);
  assert.deepEqual(received[1],{message_type:"device_info"});
  ws.send(JSON.stringify({message_type:"forward",payload:{type:"request-offer",ice_servers:[]}}));await until(()=>f.messages.length===2);
  f.device({message_type:"device_msg",payload:{type:"offer",sdp:"v=0\r\ns=synthetic-protocol-test\r\n"}});
  await until(()=>received.length===3);assert.equal(received[2].payload.type,"offer");
  const closed=once(ws,"close");ws.close();await closed;await until(()=>f.events.includes("revoke-peer"));
  assert.equal(f.upstream().signal.aborted,true);
});

test("unknown origin, URL secret, first-frame replay and cross-phone selection fail closed",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.open({origin:"https://attacker.test"}));await assert.rejects(f.open({path:PATH+"?token="+TOKEN}));
  assert.deepEqual(f.events,[]);
  const {ws,received}=await f.open();ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await until(()=>received.length);
  const closed=once(ws,"close");ws.send(JSON.stringify({message_type:"connect",device_id:"other"}));await closed;
  await until(()=>f.events.includes("revoke-peer"));
  const second=await f.open(),secondClose=once(second.ws,"close");second.ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await secondClose;
  assert.equal(f.events.filter(x=>x==="node-connect").length,1);
});

test("permission loss closes signalling and requests actual peer revocation within the lease window",async t=>{
  const f=await fixture(t),{ws,received}=await f.open();ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await until(()=>received.length);
  const closed=once(ws,"close");f.deny();await closed;await until(()=>f.events.includes("revoke-peer"));
});

test("dropped browser during pending authorization cannot leave a late-opened peer",async t=>{
  const f=await fixture(t);let release;const original=f.access.consume;
  f.access.consume=async input=>{await new Promise(r=>{release=r;});return original(input);};
  const {ws}=await f.open();ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await until(()=>release);
  const closed=once(ws,"close");ws.terminate();await closed;await delay(10);release();
  await until(()=>f.events.includes("revoke-peer"));assert.ok(!f.events.includes("node-connect"));
});

test("Platform phone upgrade uses existing HTTPS, origin and real login session checks",async t=>{
  const repository=new MemoryIdentityRepository(),authentication=await LocalAuthentication.create({repository,hasher:new PasswordHasher({memory:8192,passes:2,parallelism:2,tagLength:32})});
  await authentication.bootstrapOwner({loginName:"owner",displayName:"Owner",password:"test-only-synthetic-password"});
  const calls=[];
  const server=createPlatformApiServer({authentication,preferences:new IdentityPreferencesService({repository}),publicOrigin:ORIGIN,
    logger:{info(){},warn(){},error(){}},virtualPhoneMediaGateway:{async attachUpgrade(req,socket,head,{context}){calls.push(context);socket.destroy();return true;},async close(){}}});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const upgrade=async headers=>{
    const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}${PATH}`,{origin:ORIGIN,headers});ws.on("error",()=>{});
    try{await once(ws,"open");assert.fail("stub does not upgrade");}catch{}
  };
  await upgrade({});await upgrade({"x-forwarded-proto":"https"});assert.deepEqual(calls,[]);
  const cookie=await new Promise((resolve,reject)=>{
    const outgoing=request({host:"127.0.0.1",port:server.address().port,path:"/api/auth/sign-in",method:"POST",
      headers:{origin:ORIGIN,"x-forwarded-proto":"https","content-type":"application/json"}},r=>{
      r.resume();r.on("end",()=>{assert.equal(r.statusCode,200);resolve(r.headers["set-cookie"].map(x=>x.split(";",1)[0]).join("; "));});
    });outgoing.on("error",reject);outgoing.end(JSON.stringify({loginName:"owner",password:"test-only-synthetic-password"}));
  });
  await upgrade({cookie,"x-forwarded-proto":"https"});assert.equal(calls.length,1);assert.ok(calls[0].identityId);assert.ok(calls[0].sessionId);
});
