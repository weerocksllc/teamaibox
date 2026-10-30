import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv,createHmac,randomUUID} from 'node:crypto';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {ManagedDesktopBackends,guacamoleConnectionToken} from '../src/virtual-computers/managed-desktop-backend.mjs';

const key=Buffer.alloc(16,7);
function decode(data){const decipher=createDecipheriv('aes-128-cbc',key,Buffer.alloc(16));const raw=Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]);
  assert.deepEqual(raw.subarray(0,32),createHmac('sha256',key).update(raw.subarray(32)).digest());return JSON.parse(raw.subarray(32));}
const computer=()=>({id:randomUUID(),ownerId:randomUUID(),nodeId:randomUUID(),volumeId:randomUUID(),firmwareId:randomUUID(),tpmId:randomUUID(),
  poolId:'computer-test',state:'running',generation:1,resources:{vcpus:2,memoryBytes:4*1024**3,diskBytes:64*1024**3},
  profile:{id:'windows11',runtimeImage:'sha256:'+'a'.repeat(64)},runId:null,run:{id:randomUUID(),containerId:'b'.repeat(64),runtimeImage:'sha256:'+'a'.repeat(64),generation:1}});
test('Guacamole token is connection delegation without Windows username or password',()=>{
  const payload={username:'platform-owner',expires:Date.now()+60000,connections:{owned:{protocol:'rdp',parameters:{port:'1234'}}}};
  assert.deepEqual(decode(guacamoleConnectionToken(key,payload)),payload);
  assert.deepEqual(key,Buffer.alloc(16,7));
});
test('desktop backend relays real TCP through selected node, and closing desktop removes listener without guest action',async t=>{
  const echo=createServer(socket=>socket.pipe(socket));echo.listen(0,'127.0.0.1');await once(echo,'listening');t.after(()=>echo.close());
  const calls=[],tokens=[];
  const backend=new ManagedDesktopBackends({guacamoleOrigin:'http://127.0.0.1:18474/guacamole/',jsonSecret:key,
    nodeAgentRouter:{async connectComputerDesktop(args){calls.push(args);const stream=connect(echo.address().port,'127.0.0.1');await once(stream,'connect');stream.pause();return stream;}},
    async fetcher(url,options){assert.equal(url.href,'http://127.0.0.1:18474/guacamole/api/tokens');assert.equal(options.redirect,'error');
      tokens.push(decode(options.body.get('data')));return Response.json({authToken:'delegated',dataSource:'json'});}});
  t.after(()=>backend.close());
  for(const kind of ['rdp','console']){
    const c=computer();c.runId=c.run.id;const signal=new AbortController();
    const session=await backend.forComputer({computer:c,kind,signal:signal.signal});
    assert.deepEqual(await session.issueSession({signal:signal.signal}),{authToken:'delegated',dataSource:'json',connectionId:c.id});
    const token=tokens.at(-1),config=token.connections[c.id];assert.equal(config.protocol,kind==='rdp'?'rdp':'vnc');
    assert.equal(config.parameters.hostname,'127.0.0.1');assert.equal(config.parameters.password,undefined);assert.equal(config.parameters.username,undefined);
    assert.equal(config.parameters.security,kind==='rdp'?'any':undefined);
    const socket=connect(Number(config.parameters.port),'127.0.0.1');await once(socket,'connect');
    const data=once(socket,'data');socket.write(Buffer.from([0,255,3,0]));assert.deepEqual((await data)[0],Buffer.from([0,255,3,0]));
    assert.equal(calls.at(-1).payload.run.id,c.run.id);assert.equal(calls.at(-1).nodeId,c.nodeId);assert.equal(calls.at(-1).kind,kind);
    let audioSocket,audioClosed,audioPort;
    if(kind==='console'){
      assert.equal(config.parameters['enable-audio'],'true');
      assert.match(config.parameters['audio-servername'],/^tcp:127\.0\.0\.1:\d+$/);
      audioPort=Number(config.parameters['audio-servername'].split(':').at(-1));
      assert.notEqual(audioPort,Number(config.parameters.port));
      audioSocket=connect(audioPort,'127.0.0.1');await once(audioSocket,'connect');
      const pcm=once(audioSocket,'data');audioSocket.write(Buffer.from([0,128,255,127]));assert.deepEqual((await pcm)[0],Buffer.from([0,128,255,127]));
      assert.equal(calls.at(-1).kind,'audio');assert.equal(calls.at(-1).payload.run.id,c.run.id);
      audioClosed=once(audioSocket,'close');
    }
    const closed=once(socket,'close');signal.abort();await closed;assert.equal(calls.at(-1).signal.aborted,true);
    if(audioClosed){await audioClosed;const retry=connect(audioPort,'127.0.0.1');retry.on('error',()=>{});await assert.rejects(once(retry,'connect'));retry.destroy();}
    const retry=connect(Number(config.parameters.port),'127.0.0.1');retry.on('error',()=>{});await assert.rejects(once(retry,'connect'));retry.destroy();
  }
});
test('desktop backend refuses arbitrary endpoints, stale runs and cancellation',async()=>{
  const input={nodeAgentRouter:{connectComputerDesktop(){assert.fail();}},jsonSecret:key};
  for(const origin of ['http://10.64.0.23/guacamole/','https://evil/guacamole/','http://a:b@127.0.0.1/guacamole/','http://127.0.0.1/other'])
    assert.throws(()=>new ManagedDesktopBackends({...input,guacamoleOrigin:origin}));
  const backend=new ManagedDesktopBackends({...input,guacamoleOrigin:'http://127.0.0.1/guacamole/'});
  try{
    await assert.rejects(backend.forComputer({computer:computer(),signal:new AbortController().signal}));
    const c=computer();c.runId=c.run.id;const controller=new AbortController();controller.abort();
    await assert.rejects(backend.forComputer({computer:c,signal:controller.signal}));
    const during=new AbortController(),pending=backend.forComputer({computer:c,signal:during.signal});during.abort();
    await assert.rejects(pending);
  }finally{backend.close();}
});
