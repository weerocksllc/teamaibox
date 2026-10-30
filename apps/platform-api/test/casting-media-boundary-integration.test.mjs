import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { createPlatformApiServer } from '../server/platform-api.mjs';
import { createCastingMediaBoundary, castingMediaSignallingConfigured } from '../server/casting-media-boundary.mjs';
import { CastingHttpApi } from '../src/casting/casting-http-api.mjs';
import { LocalAuthentication } from '../src/identity/auth-service.mjs';
import { MemoryIdentityRepository } from '../src/identity/memory-repository.mjs';
import { PasswordHasher } from '../src/identity/password.mjs';
import { IdentityPreferencesService } from '../src/identity/preferences-service.mjs';
import { readSessionCookie } from '../src/identity/http-session.mjs';

// Real loopback HTTP/Upgrade and actual LocalAuthentication login sessions.
// Synthetic media/runtime and private SFU stand-in: NOT browser/RTP acceptance.
const ORIGIN='https://casting.test', PASSWORD='integration-only horse battery staple';
const SESSION='10000000-0000-4000-8000-000000000001',GRANT='20000000-0000-4000-8000-000000000001';
const TOKEN='synthetic.jwt.boundary-token';
class Peer extends Duplex { _read(){} _write(_chunk,_encoding,done){done();} }
const pause=()=>new Promise(resolve=>setImmediate(resolve));
function http(server,path,{method='GET',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,method,
      headers:{'x-forwarded-proto':'https',...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,
        headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString()||'null')}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
function ws(server,path,cookie,{origin=ORIGIN,secure=true}={}) {
  return new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,headers:{
      ...(secure?{'x-forwarded-proto':'https'}:{}),cookie,origin,Upgrade:'websocket',Connection:'Upgrade',
      'Sec-WebSocket-Version':'13','Sec-WebSocket-Key':Buffer.alloc(16,3).toString('base64')}},res=>{
      res.resume();resolve({status:res.statusCode});
    });req.on('upgrade',(res,socket,head)=>resolve({status:res.statusCode,socket,head}));
    req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('test upgrade timed out')));req.end();
  });
}
async function fixture(t,{enabled=true}={}) {
  const repository=new MemoryIdentityRepository();
  const authentication=await LocalAuthentication.create({repository,
    hasher:new PasswordHasher({memory:8192,passes:2,parallelism:2,tagLength:32})});
  await authentication.bootstrapOwner({loginName:'owner',displayName:'Owner',password:PASSWORD});
  const calls=[],logs=[],peers=[];
  const service=Object.fromEntries(['startSession','currentSession','getSession','updateAudience','stopSession',
    'forceStop','health','createInvitation','listInvitations','acceptInvitation','declineInvitation','join','leave',
    'listViewers','removeViewer'].map(name=>[name,async()=>null]));
  let viewer;
  service.createMediaConnection=async({context})=>{viewer=context.identityId;calls.push('issue');return{
    sessionId:SESSION,viewerIdentityId:viewer,grantId:GRANT,url:'wss://private-sfu',accessToken:TOKEN,
    expiresAt:new Date(Date.now()+30_000).toISOString(),muted:true};};
  service.authorizeMediaConnection=async()=>({authorized:true,sessionId:SESSION,viewerIdentityId:viewer,
    grantId:GRANT,expiresAt:new Date(Date.now()+60_000).toISOString()});
  service.reauthorizeConnectedMedia=async()=>({authorized:true,sessionId:SESSION,viewerIdentityId:viewer,
    grantId:GRANT,expiresAt:new Date(Date.now()+60_000).toISOString()});
  service.confirmMediaConnection=async()=>{calls.push('confirmed');return{admitted:true};};
  const runtime={async consumeViewerConnection(){calls.push('consume');return{sessionId:SESSION,
    viewerIdentityId:viewer,grantId:GRANT,participantIdentity:'cast-'+'a'.repeat(32)};},
    async disconnectViewer(){calls.push('remove');}};
  const boundary=enabled?createCastingMediaBoundary({service,runtime,publicOrigin:ORIGIN,
    authenticateRequest:req=>authentication.authenticateSession({sessionToken:readSessionCookie(req.headers.cookie||'')}),
    assertSecureRequest:req=>{if(req.headers['x-forwarded-proto']!=='https')throw Error('TLS required');},
    upstream:{async connect(){calls.push('upstream');const socket=new Peer();peers.push(socket);return{socket,head:Buffer.alloc(0)};},close(){}}}):null;
  const server=createPlatformApiServer({authentication,preferences:new IdentityPreferencesService({repository}),
    publicOrigin:ORIGIN,logger:{info(...v){logs.push(v);},warn(...v){logs.push(v);},error(...v){logs.push(v);}},
    castingApi:new CastingHttpApi({service,mediaAdmission:boundary?.admission}),castingMediaGateway:boundary?.gateway});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await boundary?.close();peers.forEach(p=>p.destroy());server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const login=async()=>{
    const result=await http(server,'/api/auth/sign-in',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},
      body:{loginName:'owner',password:PASSWORD}});assert.equal(result.status,200);
    return{csrf:result.body.csrfToken,cookie:result.headers['set-cookie'].map(c=>c.split(';',1)[0]).join('; ')};
  };
  const issue=signed=>http(server,`/api/v1/casting/sessions/${SESSION}/media-connection`,{method:'POST',
    headers:{cookie:signed.cookie,origin:ORIGIN,'x-csrf-token':signed.csrf,'content-type':'application/json'},
    body:{browser_instance_id:'browser-instance-0001',media_credential:'m'.repeat(43)}});
  return{server,boundary,calls,logs,login,issue};
}

test('Platform HTTP and WSS bind a real login, reject forwarding/replay, and remove on logout',async t=>{
  const f=await fixture(t),owner=await f.login(),secondLogin=await f.login();
  const issued=await f.issue(owner);assert.equal(issued.status,200);
  const path=new URL(issued.body.url).pathname+'/rtc?access_token='+TOKEN+'&sdk=js';
  for(const cookie of ['',secondLogin.cookie])assert.equal((await ws(f.server,path,cookie)).status,403);
  assert.ok(!f.calls.includes('consume'));
  const joined=await ws(f.server,path,owner.cookie);assert.equal(joined.status,101);
  assert.equal((await ws(f.server,path,owner.cookie)).status,403);
  assert.equal(f.calls.filter(v=>v==='consume').length,1);
  assert.equal(f.calls.filter(v=>v==='confirmed').length,1);
  const signedOut=await http(f.server,'/api/auth/sign-out',{method:'POST',headers:{cookie:owner.cookie,
    origin:ORIGIN,'x-csrf-token':owner.csrf,'content-type':'application/json'},body:{}});
  assert.equal(signedOut.status,200);
  await assert.rejects(f.boundary.admission.reauthorize({request:{headers:{cookie:owner.cookie}},
    connectionId:new URL(issued.body.url).pathname.split('/').at(-1)}));
  assert.ok(f.calls.includes('remove'));joined.socket.destroy();await pause();
  assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
});

test('absent ingress denies media token issuance and unknown upgrades; plain requests do not log handles',async t=>{
  const f=await fixture(t,{enabled:false}),signed=await f.login();
  assert.equal((await f.issue(signed)).status,503);assert.ok(!f.calls.includes('issue'));
  const path='/api/v1/casting/media/'+'h'.repeat(43)+'/rtc?access_token='+TOKEN;
  assert.equal((await ws(f.server,path,signed.cookie)).status,403);
  assert.equal((await http(f.server,path)).status,404);
  assert.ok(!JSON.stringify(f.logs).includes('h'.repeat(43)));
  assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
});

test('media issue retains same-origin CSRF and the gateway requires HTTPS/origin',async t=>{
  const f=await fixture(t),signed=await f.login();
  assert.equal((await f.issue({...signed,csrf:'wrong'})).status,401);
  const issued=await f.issue(signed);const path=new URL(issued.body.url).pathname+'/rtc?access_token='+TOKEN;
  assert.equal((await ws(f.server,path,signed.cookie,{origin:'https://wrong.test'})).status,403);
  assert.equal((await ws(f.server,path,signed.cookie,{secure:false})).status,403);
  assert.ok(!f.calls.includes('consume'));
});

test('partial private signalling configuration fails before service allocation',()=>{
  assert.equal(castingMediaSignallingConfigured({}),false);
  assert.throws(()=>castingMediaSignallingConfigured({PLATFORM_CASTING_SIGNALLING_ORIGIN:'https://127.0.0.1:17881'}));
});
