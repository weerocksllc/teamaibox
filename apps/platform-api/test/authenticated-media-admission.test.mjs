import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthenticatedCastingMediaAdmission } from "../src/casting/authenticated-media-admission.mjs";

const SESSION = '10000000-0000-4000-8000-000000000001';
const VIEWER = '20000000-0000-4000-8000-000000000001';
const LOGIN = '30000000-0000-4000-8000-000000000001';
const GRANT = '40000000-0000-4000-8000-000000000001';
const PUBLIC_ORIGIN = 'https://appliance.example.test';
const token = 'a'.repeat(16)+'.'+'b'.repeat(32)+'.'+'c'.repeat(43);
function fixture() {
  let now = Date.parse('2026-09-07T00:00:00Z'); let index = 0;
  const context = { identityId: VIEWER, sessionId: LOGIN, permissions: ['cast:view'] };
  const current = { authorized: true, sessionId: SESSION, viewerIdentityId: VIEWER,
    grantId: GRANT, expiresAt: new Date(now+600_000).toISOString() };
  const calls = [];
  const service = {
    async createMediaConnection() { return { sessionId:SESSION,viewerIdentityId:VIEWER,grantId:GRANT,
      url:'wss://private-sfu', accessToken:token,expiresAt:new Date(now+30_000).toISOString(),muted:true }; },
    async authorizeMediaConnection(value) { calls.push(['authorize',value]); return current; },
    async reauthorizeConnectedMedia(value) { calls.push(['reauthorize',value]); return current; },
    async confirmMediaConnection(value) { calls.push(['confirmed',value]); return {admitted:true}; },
  };
  const runtime = {
    async consumeViewerConnection(value) { calls.push(['consume',value]); return {...current,participantIdentity:'cast-'+'a'.repeat(32)}; },
    async disconnectViewer(value) { calls.push(['disconnect',value]); },
  };
  const admission = new AuthenticatedCastingMediaAdmission({service,runtime,publicOrigin:PUBLIC_ORIGIN,
    authenticateRequest:async request=>request.authenticatedContext, clock:()=>now,
    nonce:()=>String(++index).padStart(43,'A') });
  const issue = ()=>admission.issue({context,sessionId:SESSION,browserInstanceId:'browser-instance-0001',mediaCredential:'m'.repeat(43)});
  const request = { authenticatedContext:context };
  return {admission,context,current,calls,service,runtime,issue,request,advance:ms=>{now+=ms;}};
}

test('real-login-session binding rejects forwarded JWT without consuming owner admission',async()=>{
  const f=fixture();const issued=await f.issue();const handle=issued.url.split('/').at(-1);
  assert.equal(new URL(issued.url).origin,PUBLIC_ORIGIN.replace('https:','wss:'));
  assert.ok(new URL(issued.url).pathname.startsWith('/api/v1/casting/media/'));
  for (const authenticatedContext of [undefined,{...f.context,sessionId:GRANT},
    {...f.context,identityId:GRANT},{...f.context,permissions:[]}]) {
    await assert.rejects(f.admission.admit({request:{authenticatedContext},handle,accessToken:token}));
  }
  assert.equal(f.calls.filter(c=>c[0]==='consume').length,0);
  await f.admission.admit({request:f.request,handle,accessToken:token});
  await assert.rejects(f.admission.admit({request:f.request,handle,accessToken:token}));
  assert.equal(f.calls.filter(c=>c[0]==='consume').length,1);
});

test('permission or audience change denies before SFU join and cleans owned admission',async()=>{
  const f=fixture(); const issued=await f.issue();f.current.authorized=false;
  await assert.rejects(f.admission.admit({request:f.request,handle:issued.url.split('/').at(-1),accessToken:token}));
  assert.equal(f.calls.filter(c=>c[0]==='consume').length,0);
  assert.equal(f.calls.filter(c=>c[0]==='disconnect').length,1);
});

test('closing one ingress removes only its own browser connection',async()=>{
  const f=fixture(),issued=await f.issue(),handle=issued.url.split('/').at(-1);
  try {
    await f.admission.admit({request:f.request,handle,accessToken:token});
    await f.admission.disconnect(handle);
    const removed=f.calls.filter(c=>c[0]==='disconnect');
    assert.equal(removed.length,1);
    assert.equal(removed[0][1].browserInstanceId,'browser-instance-0001');
    assert.equal(f.admission.status().connectionCount,0);
  } finally {await f.admission.close();}
});

test('only an actually admitted connection stops protecting an unused entry',async()=>{
  const f=fixture(),issued=await f.issue(),handle=issued.url.split('/').at(-1);
  assert.equal(f.calls.filter(c=>c[0]==='confirmed').length,0);
  await f.admission.admit({request:f.request,handle,accessToken:token});
  assert.equal(f.calls.filter(c=>c[0]==='confirmed').length,1);
  assert.equal(f.calls.find(c=>c[0]==='confirmed')[1].browserInstanceId,'browser-instance-0001');
  await f.admission.close();
  const denied=fixture(),entry=await denied.issue();denied.service.confirmMediaConnection=async()=>({admitted:false});
  await assert.rejects(denied.admission.admit({request:denied.request,handle:entry.url.split('/').at(-1),accessToken:token}));
  assert.equal(denied.admission.status().connectionCount,0);
  await denied.admission.close();
});

test('connected authorization outlives join TTL but logout removes actual SFU viewer',async()=>{
  const f=fixture(); const issued=await f.issue();const handle=issued.url.split('/').at(-1);
  await f.admission.admit({request:f.request,handle,accessToken:token});f.advance(31_000);
  assert.deepEqual(await f.admission.reauthorize({request:f.request,connectionId:handle}),{authorized:true});
  assert.equal(f.calls.filter(c=>c[0]==='authorize').length,2);
  assert.deepEqual(f.calls.find(c=>c[0]==='reauthorize')[1],{sessionId:SESSION,viewerIdentityId:VIEWER,grantId:GRANT});
  f.request.authenticatedContext=null;
  await assert.rejects(f.admission.reauthorize({request:f.request,connectionId:handle}));
  assert.equal(f.calls.filter(c=>c[0]==='disconnect').length,1);
  assert.equal(f.admission.status().connectionCount,0);
});

test('connected checks cannot adopt a replacement grant or ignore permission failures',async()=>{
  for (const change of [f=>{f.current.grantId=SESSION;},f=>{f.current.authorized=false;}]) {
    const f=fixture(),issued=await f.issue(),handle=issued.url.split('/').at(-1);
    await f.admission.admit({request:f.request,handle,accessToken:token});
    f.advance(360_000);change(f);
    await assert.rejects(f.admission.reauthorize({request:f.request,connectionId:handle}));
    assert.equal(f.admission.status().connectionCount,0);
    assert.equal(f.calls.filter(c=>c[0]==='disconnect').length,1);
  }
});

test('losing cast:view reconciles the persisted viewer grant before closing signalling',async()=>{
  const f=fixture(),issued=await f.issue(),handle=issued.url.split('/').at(-1);
  await f.admission.admit({request:f.request,handle,accessToken:token});
  f.request.authenticatedContext={...f.context,permissions:['cast:manage']};
  let grantRevoked=false;
  f.service.reauthorizeConnectedMedia=async()=>{
    grantRevoked=true;
    throw Error('viewer permission revoked');
  };
  await assert.rejects(f.admission.reauthorize({request:f.request,connectionId:handle}));
  assert.equal(grantRevoked,true,'not just an SFU disconnect: revoke the stored viewer grant');
  assert.equal(f.calls.filter(c=>c[0]==='disconnect').length,1);
  assert.equal(f.admission.status().connectionCount,0);
});

test('expired unused admission and mismatched token fail closed',async()=>{
  const f=fixture(); const issued=await f.issue();const handle=issued.url.split('/').at(-1);
  await assert.rejects(f.admission.admit({request:f.request,handle,accessToken:token+'x'}));
  assert.equal(f.admission.status().pendingCount,1);f.advance(30_000);
  await assert.rejects(f.admission.admit({request:f.request,handle,accessToken:token}));
  assert.equal(f.admission.status().pendingCount,0);
});

test('uncertain consume/cleanup retains ownership for retry without leaking details',async()=>{
  const f=fixture(); const issued=await f.issue();const handle=issued.url.split('/').at(-1);
  f.runtime.consumeViewerConnection=async()=>{throw Error('private token '+token);};
  const disconnect=f.runtime.disconnectViewer;
  f.runtime.disconnectViewer=async()=>{throw Error('private transport secret');};
  await assert.rejects(f.admission.admit({request:f.request,handle,accessToken:token}),error=>
    error.code==='cast_media_authorization_denied'&&!error.message.includes(token));
  assert.equal(f.admission.status().cleanupPendingCount,1);
  await assert.rejects(f.admission.close());
  f.runtime.disconnectViewer=disconnect;await f.admission.close();
  assert.equal(f.admission.status().connectionCount,0);
});

test('a failed admission with no returned gateway handle is included in cleanup sweeps',async()=>{
  const f=fixture(),issued=await f.issue(),handle=issued.url.split('/').at(-1);
  const remove=f.runtime.disconnectViewer;
  f.runtime.consumeViewerConnection=async()=>{throw Error('private failure');};
  f.runtime.disconnectViewer=async()=>{throw Error('temporary failure');};
  await assert.rejects(f.admission.admit({request:f.request,handle,accessToken:token}));
  assert.equal(f.admission.status().cleanupPendingCount,1);
  f.runtime.disconnectViewer=remove;await f.admission.retryCleanup();
  assert.equal(f.admission.status().connectionCount,0);await f.admission.close();
});

test('pending capacity includes concurrent issuance and exposes only counters',async()=>{
  const f=fixture(); const release=[];
  const original=f.service.createMediaConnection;
  f.service.createMediaConnection=async()=>{await new Promise(resolve=>release.push(resolve));return original();};
  const jobs=[];
  for(let i=0;i<32;i++) jobs.push(f.issue().catch(()=>null));
  await assert.rejects(f.issue());
  assert.deepEqual(f.admission.status(),{pendingCount:32,connectionCount:0,cleanupPendingCount:0,closed:false});
  await f.admission.close();release.forEach(resolve=>resolve());
  assert.deepEqual(await Promise.all(jobs),Array(32).fill(null));
  assert.equal(f.admission.status().pendingCount,0);
});

test('close racing a private consume preserves ownership until final removal',async()=>{
  const f=fixture();const issued=await f.issue();const handle=issued.url.split('/').at(-1);
  let release;const original=f.runtime.consumeViewerConnection;
  const consuming=new Promise(resolve=>{release=resolve;});
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  f.runtime.consumeViewerConnection=async value=>{entered();await consuming;return original(value);};
  const joining=f.admission.admit({request:f.request,handle,accessToken:token});
  const failed=assert.rejects(joining);await started;
  await assert.rejects(f.admission.close());
  assert.equal(f.admission.status().cleanupPendingCount,1);
  release();await failed;await f.admission.close();
  assert.equal(f.admission.status().connectionCount,0);
  assert.equal(f.calls.filter(c=>c[0]==='disconnect').length,2);
});

test('invalid grant expiry is rejected even when its comparison yields NaN',async()=>{
  const f=fixture();const issued=await f.issue();f.current.expiresAt='invalid';
  await assert.rejects(f.admission.admit({request:f.request,handle:issued.url.split('/').at(-1),accessToken:token}));
  assert.equal(f.calls.filter(c=>c[0]==='consume').length,0);
});
