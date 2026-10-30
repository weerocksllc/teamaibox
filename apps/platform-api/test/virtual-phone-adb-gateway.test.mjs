import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {createServer as tcpServer,connect} from "node:net";
import {once} from "node:events";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import WebSocket from "ws";
import {PhoneAdbGateway} from "../src/virtual-phones/phone-adb-gateway.mjs";

const ORIGIN="https://phone.test",TOKEN="X".repeat(43);
async function until(predicate) {for(let i=0;i<200;i++){if(predicate())return;await delay(10);}assert.fail("condition timeout");}
async function fixture(t) {
  const grant={id:randomUUID(),phoneId:randomUUID(),runId:randomUUID(),ownerId:randomUUID(),sessionId:randomUUID(),generation:1,kind:"adb"};
  const events=[],sockets=new Set();let used=false,allowed=true;
  const android=tcpServer(socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));socket.pipe(socket);});
  await new Promise(resolve=>android.listen(0,"127.0.0.1",resolve));
  const access={async consumeDebug(input){
    assert.equal(input.phoneId,grant.phoneId);assert.equal(input.grantId,grant.id);
    if(used || input.token!==TOKEN)throw Error("denied");used=true;events.push("consume");return grant;
  },async assertConnected({context}) {assert.equal(context.identityId,grant.ownerId);assert.equal(context.sessionId,grant.sessionId);if(!allowed)throw Error("denied");},
  async disconnect(value) {assert.equal(value,grant);events.push("revoke");}};
  const gateway=new PhoneAdbGateway({accessService:access,publicOrigin:ORIGIN,upstream:{async connect({grant:bound,signal}) {
    assert.equal(bound,grant);events.push("node-connect");
    const socket=connect({host:"127.0.0.1",port:android.address().port,signal});socket.on("error",()=>{});await once(socket,"connect");socket.pause();return socket;
  }}});
  const server=createServer((r,s)=>s.writeHead(404).end());
  server.on("upgrade",(r,s,h)=>void gateway.attachUpgrade(r,s,h).then(handled=>{if(!handled)s.destroy();}));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await gateway.close();for(const socket of sockets)socket.destroy();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>android.close(r))]);});
  return {events,deny:()=>{allowed=false;},async open({origin,query=""}={}) {
    const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/v1/virtual-phones/${grant.phoneId}/connections/${grant.id}/adb${query}`,{...(origin?{origin}:{}),perMessageDeflate:false});
    const messages=[];ws.on("error",()=>{});ws.on("message",(bytes,binary)=>messages.push({bytes:Buffer.from(bytes),binary}));
    await once(ws,"open");return {ws,messages};
  }};
}

test("CLI ticket relays real binary sockets, with no login cookie or arbitrary target",async t=>{
  const f=await fixture(t),{ws,messages}=await f.open();
  assert.deepEqual(f.events,[]);ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));
  await until(()=>messages.length===1);assert.deepEqual(JSON.parse(messages[0].bytes),{type:"phone.adb.ready"});
  const data=Buffer.from(Array.from({length:65536},(_,i)=>i%256));
  ws.send(data);await until(()=>messages.slice(1).reduce((sum,m)=>sum+m.bytes.length,0)===data.length);
  assert.deepEqual(Buffer.concat(messages.slice(1).map(m=>m.bytes)),data);assert.ok(messages.slice(1).every(m=>m.binary));
  const closed=once(ws,"close");ws.close();await closed;await until(()=>f.events.includes("revoke"));
});

test("origin, query credentials, replay, text commands and oversized frames are rejected",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.open({origin:"https://foreign.test"}));await assert.rejects(f.open({query:`?token=${TOKEN}`}));
  const {ws,messages}=await f.open();ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await until(()=>messages.length);
  const closed=once(ws,"close");ws.send("shell host-command");await closed;await until(()=>f.events.includes("revoke"));
  const again=await f.open(),gone=once(again.ws,"close");again.ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await gone;
  assert.equal(f.events.filter(x=>x==="node-connect").length,1);
  const g=await fixture(t),large=await g.open();large.ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await until(()=>large.messages.length);
  const overflow=once(large.ws,"close");large.ws.send(Buffer.alloc(65537));await overflow;
});

test("logout cuts the live debug tunnel and revokes its peer",async t=>{
  const f=await fixture(t),{ws,messages}=await f.open();ws.send(JSON.stringify({type:"phone.authenticate",token:TOKEN}));await until(()=>messages.length);
  const closed=once(ws,"close"),started=Date.now();f.deny();await closed;await until(()=>f.events.includes("revoke"));
  assert.ok(Date.now()-started<5000);
});
