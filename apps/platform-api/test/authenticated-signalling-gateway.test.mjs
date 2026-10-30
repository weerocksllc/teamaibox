import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { AuthenticatedCastingSignallingGateway,NodeMtlsCastingSignallingUpstream }
  from '../src/casting/authenticated-signalling-gateway.mjs';

const HANDLE='h'.repeat(43),TOKEN='synthetic.one-use.token';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Socket extends Duplex {
  writes=[];
  _read() {}
  _write(data,_encoding,done) { this.writes.push(Buffer.from(data));done(); }
  setTimeout() {}
}
function fixture() {
  const calls=[],timers=[];const peer=new Socket(),socket=new Socket();
  const admission={
    async admit(value){calls.push(['admit',value]);return {connectionId:HANDLE};},
    async reauthorize(value){calls.push(['reauthorize',value]);return {authorized:true};},
    async disconnect(value){calls.push(['disconnect',value]);},async close(){calls.push(['close']);},
  };
  const upstream={async connect(value){calls.push(['connect',value]);return {socket:peer,head:Buffer.from('server-head')};},
    close(){calls.push(['upstream-close']);}};
  const gateway=new AuthenticatedCastingSignallingGateway({admission,upstream,publicOrigin:'https://10.64.0.20',
    assertSecureRequest:async request=>{if(!request.secure)throw Error('not HTTPS');},
    setIntervalFactory:(fn,ms)=>{const timer={fn,ms,cleared:false,unref(){}};timers.push(timer);return timer;},
    clearIntervalFactory:timer=>{timer.cleared=true;}});
  const request={method:'GET',secure:true,url:`/api/v1/casting/media/${HANDLE}/rtc?access_token=${TOKEN}&sdk=js&protocol=16`,
    headers:{origin:'https://10.64.0.20',upgrade:'websocket','sec-websocket-version':'13',
      'sec-websocket-key':Buffer.alloc(16,1).toString('base64'),cookie:'synthetic-real-login-cookie'}};
  return {gateway,admission,upstream,calls,timers,peer,socket,request};
}

test('authenticated same-origin WSS only proxies exact allowed signalling',async()=>{
  const f=fixture();assert.equal(await f.gateway.attachUpgrade(f.request,f.socket,Buffer.from('client-head')),true);
  assert.match(f.socket.writes[0].toString(),/^HTTP\/1.1 101/);
  assert.equal(f.socket.writes[1].toString(),'server-head');
  assert.equal(f.peer.writes[0].toString(),'client-head');
  const connect=f.calls.find(c=>c[0]==='connect')[1];
  assert.deepEqual(connect,{accessToken:TOKEN,parameters:[['sdk','js'],['protocol','16']]});
  assert.ok(!JSON.stringify(connect).includes('cookie'));
  f.socket.push(Buffer.from('client-frame'));await tick();assert.equal(f.peer.writes.at(-1).toString(),'client-frame');
  f.peer.push(Buffer.from('server-frame'));await tick();assert.equal(f.socket.writes.at(-1).toString(),'server-frame');
  await f.gateway.close();assert.ok(f.socket.destroyed&&f.peer.destroyed);
});

test('other origins, plaintext, duplicate tokens and resume attempts never dial SFU',async()=>{
  for(const mutate of [r=>{r.headers.origin='https://attacker.invalid';},r=>{r.secure=false;},
    r=>{r.url+='&access_token=forwarded';},r=>{r.url+='&reconnect=1';},
    r=>{r.url+='&url=https://attacker.invalid';},r=>{r.headers['sec-websocket-key']='bad';}]) {
    const f=fixture();mutate(f.request);await f.gateway.attachUpgrade(f.request,f.socket);
    assert.equal(f.calls.filter(c=>c[0]==='admit'||c[0]==='connect').length,0);
    await f.gateway.close();f.peer.destroy();
  }
});

test('pinned SDK legacy handshake forwards bounded client_protocol without weakening admission',async()=>{
  const f=fixture();f.request.url+='&client_protocol=1&adaptive_stream=1&network=wifi';
  await f.gateway.attachUpgrade(f.request,f.socket);
  assert.match(f.socket.writes[0].toString(),/^HTTP\/1.1 101/);
  assert.ok(f.calls.some(c=>c[0]==='admit'));
  assert.deepEqual(f.calls.find(c=>c[0]==='connect')[1].parameters.slice(-3),
    [['client_protocol','1'],['adaptive_stream','1'],['network','wifi']]);
  await f.gateway.close();
  for(const suffix of ['&client_protocol=1&client_protocol=2','&client_protocol=redirect','&client_protocol=10000','&reconnect=1']) {
    const denied=fixture();denied.request.url+=suffix;
    await denied.gateway.attachUpgrade(denied.request,denied.socket);
    assert.equal(denied.calls.filter(c=>c[0]==='admit'||c[0]==='connect').length,0);
    await denied.gateway.close();denied.peer.destroy();
  }
});

test('denied login never dials upstream or responds with 101',async()=>{
  const f=fixture();f.admission.admit=async()=>{throw Error('private auth detail');};
  await f.gateway.attachUpgrade(f.request,f.socket);
  assert.equal(f.calls.filter(c=>c[0]==='connect').length,0);
  assert.ok(!Buffer.concat(f.socket.writes).toString().includes('101'));
  await f.gateway.close();f.peer.destroy();
});

test('revocation closes signalling and retries actual SFU removal after a transient failure',async()=>{
  const f=fixture();await f.gateway.attachUpgrade(f.request,f.socket);
  f.admission.reauthorize=async()=>{throw Error('revoked');};
  let removes=0;f.admission.disconnect=async()=>{if(++removes===1)throw Error('offline');};
  f.timers.find(t=>t.ms===5000).fn();await tick();await tick();
  assert.ok(f.socket.destroyed&&f.peer.destroyed);
  await f.gateway.retryCleanup();assert.ok(removes>=2);await f.gateway.close();
});

test('failure while dialing and authorization changes before 101 clean the admitted viewer',async()=>{
  for(const failing of ['connect','reauthorize']){
    const f=fixture();(failing==='connect'?f.upstream:f.admission)[failing]=async()=>{throw Error('private');};
    await f.gateway.attachUpgrade(f.request,f.socket);
    assert.ok(f.calls.some(c=>c[0]==='disconnect'));
    assert.ok(!Buffer.concat(f.socket.writes).toString().includes('101'));
    await f.gateway.close();f.peer.destroy();
  }
});

test('unrelated upgrades remain owned by the existing Platform handler',async()=>{
  const f=fixture();f.request.url='/ws/session';
  assert.equal(await f.gateway.attachUpgrade(f.request,f.socket),false);
  assert.equal(f.socket.destroyed,false);assert.deepEqual(f.calls,[]);
  await f.gateway.close();f.socket.destroy();f.peer.destroy();
});

test('private SFU hop requires verified TLS 1.3 and never forwards browser headers',async()=>{
  let captured;
  const upstream=new NodeMtlsCastingSignallingUpstream({origin:'https://127.0.0.1:17881',
    serverName:'trusted-media.teamaibox.internal',ca:Buffer.alloc(80,1),cert:Buffer.alloc(80,2),key:Buffer.alloc(80,3),
    requestFactory:(url,options)=>{
      captured={url,options};const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
      req.end=()=>queueMicrotask(()=>req.emit('upgrade',{statusCode:101,headers:{upgrade:'websocket',
        'sec-websocket-accept':createHash('sha1').update(options.headers['Sec-WebSocket-Key']+
          '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}},new Socket(),Buffer.alloc(0)));
      return req;
    }});
  const connected=await upstream.connect({accessToken:TOKEN,parameters:[['sdk','js']]});
  assert.equal(captured.url.origin,'https://127.0.0.1:17881');assert.equal(captured.url.pathname,'/rtc');
  assert.equal(captured.options.minVersion,'TLSv1.3');assert.equal(captured.options.rejectUnauthorized,true);
  assert.equal(captured.options.servername,'trusted-media.teamaibox.internal');
  assert.equal(Object.keys(captured.options.headers).length,4);
  connected.socket.destroy();upstream.close();
  await assert.rejects(upstream.connect({accessToken:TOKEN,parameters:[]}));
});

test('public or plaintext upstream and caller-selected token parameters fail closed',async()=>{
  const base={serverName:'trusted-media.teamaibox.internal',ca:Buffer.alloc(80),cert:Buffer.alloc(80),key:Buffer.alloc(80)};
  for(const origin of ['https://8.8.8.8','http://127.0.0.1','https://u:p@127.0.0.1','https://127.0.0.1/other']){
    assert.throws(()=>new NodeMtlsCastingSignallingUpstream({...base,origin}));
  }
  const upstream=new NodeMtlsCastingSignallingUpstream({...base,origin:'https://127.0.0.1:7880'});
  await assert.rejects(upstream.connect({accessToken:TOKEN,parameters:[['access_token','changed']]}));
  upstream.close();
});
