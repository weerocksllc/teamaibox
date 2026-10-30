import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {ComputerDesktopAccess} from '../src/virtual-computers/desktop-access.mjs';
import {instruction} from '../src/virtual-computers/monitor-control.mjs';

test('real multi-user tunnels enforce invitations, handoff, reclaim, shared mode and immediate revoke',async t=>{
 const id=randomUUID(),owner=randomUUID(),guest=randomUUID(),viewer=randomUUID(),runId=randomUUID();
 const grants=new Map([[guest,'control'],[viewer,'view']]),contexts=new Map([owner,guest,viewer].map(identityId=>[identityId,{identityId,sessionId:randomUUID()}]));
 const denied=()=>{throw Object.assign(Error('Denied'),{code:'computer_not_found',status:404});};
 const sharing={async resolve({context,computerId}){if(id!==computerId||context.identityId!==owner&&!grants.has(context.identityId))denied();return {id,ownerId:owner,state:'running',runId,monitorRole:context.identityId===owner?'owner':grants.get(context.identityId),actorName:context.identityId};},
  async update(context,computerId,body){if(context.identityId!==owner)denied();if(body.permission===null)grants.delete(body.identityId);else grants.set(body.identityId,body.permission);return {data:[]};}};
 const upstreamServer=createServer(),upstreams=new WebSocketServer({server:upstreamServer}),frames=[];
 upstreams.on('connection',ws=>ws.on('message',bytes=>{frames.push(bytes.toString());ws.send(bytes.toString());}));
 upstreamServer.listen(0,'127.0.0.1');await once(upstreamServer,'listening');
 const api=new ComputerDesktopAccess({sharing,resolveOwnedComputer:async({context})=>context.identityId===owner?{id,ownerId:owner,state:'running',runId}:denied(),
  provider:{async connect(){const ws=new WebSocket(`ws://127.0.0.1:${upstreamServer.address().port}`);await once(ws,'open');ws.pause();return ws;}}});
 const server=createServer();server.on('upgrade',(req,socket,head)=>{
  const context=contexts.get(req.headers['x-test-identity']);api.attachUpgrade(req,socket,head,{context,authenticate:async()=>context}).catch(()=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{api.close();for(const c of upstreams.clients)c.terminate();upstreams.close();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstreamServer.close(r))]);});
 const request=(user,route,body,method='POST')=>api.handle({method,pathname:`/api/v1/virtual-computers/${id}/${route}`,context:contexts.get(user),body});
 const open=async user=>{const ticket=(await request(user,'desktop-sessions',{mode:'console'})).body;
  const q=new URLSearchParams({token:ticket.authToken,GUAC_DATA_SOURCE:'json',GUAC_ID:id,GUAC_TYPE:'c',GUAC_WIDTH:'1024',GUAC_HEIGHT:'768',GUAC_DPI:'96',GUAC_TIMEZONE:'UTC'});
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/v1/virtual-computers/${id}/desktop-tunnel?${q}`,'guacamole',{headers:{'x-test-identity':user}});await once(ws,'open');return {ws,viewerId:ticket.viewerId,user};};
 const a=await open(owner),b=await open(owner),g=await open(guest),v=await open(viewer);
 const action=(page,action,extra={})=>request(page.user,'monitor-control',{viewerId:page.viewerId,action,...extra});
 const send=async(page,key,expected)=>{const promise=new Promise(resolve=>{const listener=bytes=>{if(bytes.toString().includes(instruction('sync',key))){page.ws.off('message',listener);resolve(bytes.toString());}};page.ws.on('message',listener);});page.ws.send(instruction('key',key,1)+instruction('sync',key));assert.equal(await promise,(expected?instruction('key',key,1):'')+instruction('sync',key));};
 await send(a,65,true);await send(b,66,false);await send(g,67,false);await send(v,68,false);
 await assert.rejects(action(v,'claim'));await assert.rejects(request(viewer,'desktop-sessions',{mode:'desktop'}));
 const release=once(a.ws,'message');await action(a,'handoff',{targetViewerId:g.viewerId});assert.equal((await release)[0].toString(),instruction('key',65,0));await send(g,69,true);
 await action(b,'reclaim');await send(g,70,false);await send(b,71,true);
 await action(b,'shared');await send(a,72,true);await send(g,73,true);await send(v,74,false);
 const closed=once(g.ws,'close');await request(owner,'monitor-sharing',{identityId:guest,permission:null});await closed;
 for(let n=0;n<20&&!frames.some(f=>f.includes(instruction('key',73,0)));n++)await new Promise(r=>setTimeout(r,10));
 assert.ok(frames.some(f=>f.includes(instruction('key',73,0))),'Revoke flushes held key');
 await assert.rejects(open(guest));await send(a,75,true);await send(v,76,false);
 assert.equal((await request(owner,'monitor-presence',null,'GET')).body.participants.length,3);
});
