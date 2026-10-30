import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {PhoneAccessService} from "../src/virtual-phones/phone-access-service.mjs";

// Unit fixtures only. Real SQL concurrency is tested separately; this does
// not pretend that an actual Cuttlefish WebRTC peer has been revoked.
function fixture() {
  const context={identityId:randomUUID(),sessionId:randomUUID()},phoneId=randomUUID(),runId=randomUUID();
  const grants=[],events=[];let allowed=true,login=true,closeWorks=true;
  const reject=()=>{throw Object.assign(Error("invalid"),{code:"phone_grant_invalid"});};
  const repo={
    async assertLogin(){if(!login)reject();},
    async issue(input){if(grants.some(g=>g.phoneId===input.phoneId&&g.kind===input.kind&&g.state!=="revoked"))throw Object.assign(Error("in use"),{code:input.kind==="control"?"phone_connection_in_use":"phone_operation_conflict"});const g={...input,id:randomUUID(),runId,generation:1,state:"issued",createdAt:new Date(),expiresAt:new Date(Date.now()+60_000),authorized:true};grants.push(g);events.push("issued");return g;},
    async consume(input){const g=grants.find(g=>g.id===input.grantId&&g.state==="issued"&&g.tokenHash.equals(input.tokenHash));if(!g)reject();g.state="connected";return g;},
    async beginRevocation({phoneId,sessionId,grantId,kind}){return grants.filter(g=>g.phoneId===phoneId&&(!sessionId||g.sessionId===sessionId)&&(!grantId||g.id===grantId)&&(!kind||g.kind===kind)&&g.state!=="revoked").map(g=>{g.state="revoking";g.authorized=false;return g;});},
    async confirmRevoked(g){grants.find(x=>x.id===g.id).state="revoked";events.push("revoked");},
    async active(){return grants.filter(g=>g.state!=="revoked");},
    async getActive(id){return grants.find(g=>g.id===id&&g.state!=="revoked")??null;}
  };
  const bridge={maximumLeaseMilliseconds:5000,
    async open({grant,leaseExpiresAt}){events.push("opened");return {...grant,leaseExpiresAt,peerOpen:true};},
    async renew({grant,leaseExpiresAt}){events.push("renewed");return {...grant,leaseExpiresAt,peerOpen:true};},
    async close(grant){events.push("closed");if(!closeWorks)throw Error("bridge unavailable");return {...grant,peerClosed:true};}};
  const directory={async authorization(){return {permissions:allowed?["phone:use"]:["phone:manage"]};}};
  return {service:new PhoneAccessService({repository:repo,directory,peerBridge:bridge}),context,phoneId,grants,events,bridge,repo,directory,
    disable:()=>{allowed=false;},logout:()=>{login=false;},failClose:()=>{closeWorks=false;}};
}

test("ADB CLI consumes only the Web-issued debug ticket and keeps its login binding",async()=>{
  const f=fixture();
  const control=await f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"control"}});
  await assert.rejects(f.service.consumeDebug({phoneId:f.phoneId,grantId:control.id,token:control.token}));
  const ticket=await f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"adb",ttlSeconds:60}});
  const args={phoneId:f.phoneId,grantId:ticket.id,token:ticket.token};
  await assert.rejects(f.service.consumeDebug({...args,phoneId:randomUUID()}));
  await assert.rejects(f.service.consumeDebug({...args,token:"B".repeat(43)}));
  const grant=await f.service.consumeDebug(args);assert.equal(grant.sessionId,f.context.sessionId);assert.equal(grant.kind,"adb");
  await assert.rejects(f.service.consumeDebug(args));
  f.logout();await assert.rejects(f.service.assertConnected({context:f.context,grant}));
  await f.service.disconnect(grant);assert.equal(grant.state,"revoked");
});

test("phone control tickets are secret once, owner/login checked, and refresh closes old peer first",async()=>{
  const f=fixture(),args={context:f.context,phoneId:f.phoneId,input:{kind:"control"}};
  const ticket=await f.service.issue(args);
  assert.match(ticket.token,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(f.grants).includes(ticket.token));
  const consume={context:f.context,phoneId:f.phoneId,grantId:ticket.id,kind:"control",token:ticket.token};
  await f.service.consume(consume);await assert.rejects(f.service.consume(consume));
  await f.service.issue({...args,input:{kind:"control",takeover:true}});
  assert.deepEqual(f.events,["issued","opened","closed","revoked","issued"]);
  f.logout();const before=[...f.events];await assert.rejects(f.service.issue(args));assert.deepEqual(f.events,before);
});

test("failed physical peer close keeps revoking and prevents replacement",async()=>{
  const f=fixture(),args={context:f.context,phoneId:f.phoneId,input:{kind:"control"}};
  await f.service.issue(args);f.failClose();await assert.rejects(f.service.issue({...args,input:{kind:"control",takeover:true}}));
  assert.equal(f.grants.length,1);assert.equal(f.grants[0].state,"revoking");
});

test("two pages cannot kick each other off through automatic reconnect, even with the same login",async()=>{
  for(const sameLogin of [true,false]){
    const f=fixture(),args={context:f.context,phoneId:f.phoneId,input:{kind:"control"}};
    const ticket=await f.service.issue(args);
    const first=await f.service.consume({...args,grantId:ticket.id,token:ticket.token,kind:"control"});
    const other={...args,context:{...f.context,sessionId:sameLogin?f.context.sessionId:randomUUID()}};
    for(let i=0;i<12;i++)await assert.rejects(f.service.issue(other),{code:"phone_connection_in_use"});
    await f.service.assertConnected({context:f.context,grant:first});
    assert.deepEqual(f.events,["issued","opened"]);
    const replacement=await f.service.issue({...other,input:{kind:"control",takeover:true}});
    const second=await f.service.consume({...other,grantId:replacement.id,token:replacement.token,kind:"control"});
    for(let i=0;i<12;i++)await assert.rejects(f.service.issue(args),{code:"phone_connection_in_use"});
    await f.service.disconnect(first); // Late cleanup must not close the replacement.
    await f.service.assertConnected({context:other.context,grant:second});
    assert.deepEqual(f.events,["issued","opened","closed","revoked","issued","opened"]);
  }
});

test("control takeover must be an explicit boolean and remains owner authorized",async()=>{
  const f=fixture(),args={context:f.context,phoneId:f.phoneId};
  for(const input of [{kind:"control",takeover:"true"},{kind:"control",takeover:1},{kind:"adb",takeover:true}])
    await assert.rejects(f.service.issue({...args,input}),{code:"phone_input_invalid"});
  assert.equal(f.events.length,0);
  f.disable();await assert.rejects(f.service.issue({...args,input:{kind:"control",takeover:true}}),{code:"phone_permission_required"});
});

test("only-use permission opens content; manager-only and missing expiring bridge cannot",async()=>{
  const f=fixture();f.disable();await assert.rejects(f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"control"}}),{code:"phone_permission_required"});
  assert.throws(()=>new PhoneAccessService({repository:f.repo,directory:f.directory,peerBridge:{...f.bridge,maximumLeaseMilliseconds:60_000}}));
  assert.throws(()=>new PhoneAccessService({repository:f.repo,directory:f.directory}));
});

test("revocation closes actual peer contract; WSS-only and foreign peer acknowledgement rejected",async()=>{
  for(const mode of ["foreign","wss-only"]) {
    const f=fixture();await f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"control"}});
    f.bridge.close=async grant=>({...grant,runId:mode==="foreign"?randomUUID():grant.runId,peerClosed:mode!=="wss-only",signallingClosed:true});
    await assert.rejects(f.service.revokePhoneAccess({ownerId:f.context.identityId,phoneId:f.phoneId}));
    assert.equal(f.grants[0].state,"revoking");
  }
});

test("connected peers renew short leases and revoked permissions end them",async()=>{
  const f=fixture(),ticket=await f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"control"}});
  await f.service.consume({context:f.context,phoneId:f.phoneId,grantId:ticket.id,token:ticket.token,kind:"control"});
  await f.service.reconcile();assert.ok(f.events.includes("renewed"));f.disable();await f.service.reconcile();
  assert.equal(f.grants[0].state,"revoked");assert.equal(f.events.at(-2),"closed");
});

test("ambiguous peer activation is revoked, never reused as a successful connection",async()=>{
  const f=fixture(),ticket=await f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"control"}});
  f.bridge.open=async()=>{throw Error("lost open reply");};
  await assert.rejects(f.service.consume({context:f.context,phoneId:f.phoneId,grantId:ticket.id,token:ticket.token,kind:"control"}));
  assert.equal(f.grants[0].state,"revoked");assert.deepEqual(f.events,["issued","closed","revoked"]);
});

test("gateway disconnect still revokes its consumed peer after logout, never another grant",async()=>{
  const f=fixture(),ticket=await f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"control"}});
  const g=await f.service.consume({context:f.context,phoneId:f.phoneId,grantId:ticket.id,token:ticket.token,kind:"control"});
  await f.service.assertConnected({context:f.context,grant:g});
  await assert.rejects(f.service.assertConnected({context:{...f.context,sessionId:randomUUID()},grant:g}));
  await f.service.disconnect({...g,runId:randomUUID()});assert.equal(f.grants[0].state,"connected");
  f.logout();await assert.rejects(f.service.assertConnected({context:f.context,grant:g}));
  await f.service.disconnect(g);assert.equal(f.grants[0].state,"revoked");
});

test("a restarted Platform closes abandoned connected grants instead of renewing them indefinitely",async()=>{
  const f=fixture(),ticket=await f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"control"}});
  await f.service.consume({context:f.context,phoneId:f.phoneId,grantId:ticket.id,token:ticket.token,kind:"control"});
  const restarted=new PhoneAccessService({repository:f.repo,directory:f.directory,peerBridge:f.bridge});
  await restarted.reconcile();assert.equal(f.grants[0].state,"revoked");assert.ok(!f.events.includes("renewed"));
});

test("a reconciliation tick cannot revoke or prematurely renew an in-flight open",async()=>{
  const f=fixture(),ticket=await f.service.issue({context:f.context,phoneId:f.phoneId,input:{kind:"control"}});
  let complete,entered;const waiting=new Promise(resolve=>{entered=resolve;});
  f.bridge.open=async({grant,leaseExpiresAt})=>{entered();await new Promise(resolve=>{complete=resolve;});return {...grant,leaseExpiresAt,peerOpen:true};};
  const pending=f.service.consume({context:f.context,phoneId:f.phoneId,grantId:ticket.id,token:ticket.token,kind:"control"});
  await waiting;await f.service.reconcile();assert.equal(f.grants[0].state,"connected");assert.deepEqual(f.events,["issued"]);
  complete();const grant=await pending;await f.service.assertConnected({context:f.context,grant});
  await f.service.reconcile();assert.equal(f.events.at(-1),"renewed");
});
