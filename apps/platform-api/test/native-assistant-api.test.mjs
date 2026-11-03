import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createPlatformApiServer } from '../server/platform-api.mjs';
import { NativeAssistantApi } from '../src/assistant/native-assistant-api.mjs';
import { LocalAuthentication } from '../src/identity/auth-service.mjs';
import { MemoryIdentityRepository } from '../src/identity/memory-repository.mjs';
import { PasswordHasher } from '../src/identity/password.mjs';
import { IdentityPreferencesService } from '../src/identity/preferences-service.mjs';

const origin = 'https://appliance.test';
function request(server, path, {method='GET', headers={}, body}={}) {
  return new Promise((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port:server.address().port,path,method,headers:{'x-forwarded-proto':'https',...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(body);
  });
}
async function fixture(t) {
  const repository=new MemoryIdentityRepository();
  const authentication=await LocalAuthentication.create({repository,hasher:new PasswordHasher({memory:8192,passes:2,parallelism:2,tagLength:32})});
  const password=randomBytes(24).toString('base64url');
  await authentication.bootstrapOwner({loginName:'synthetic-owner',displayName:'Synthetic',password});
  const calls=[];
  const nativeAssistantApi=new NativeAssistantApi({routes:{async resolve(ownerIdentityId){return {ownerIdentityId,native:{async request(method,path,options){calls.push({ownerIdentityId,method,path,options});return Response.json({id:'ses_synthetic',parts:[{type:'text',text:'native'}]});}}};}}});
  const server=createPlatformApiServer({authentication,preferences:new IdentityPreferencesService({repository}),publicOrigin:origin,nativeAssistantApi,
    logger:{warn(){},error(){},info(){}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const signIn=await request(server,'/api/auth/sign-in',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({loginName:'synthetic-owner',password})});
  assert.equal(signIn.status,200);
  return {server,calls,headers:{cookie:signIn.headers['set-cookie'].map(v=>v.split(';')[0]).join('; '),origin,'x-csrf-token':JSON.parse(signIn.text).csrfToken,'content-type':'application/json'}};
}
test('native HTTP uses the authenticated owner and supports same-origin GET without Origin',async t=>{
  const f=await fixture(t);
  const res=await request(f.server,'/api/v1/assistant/native/session',{headers:{cookie:f.headers.cookie}});
  assert.equal(res.status,200);assert.equal(JSON.parse(res.text).id,'ses_synthetic');
  assert.match(f.calls[0].ownerIdentityId,/^[a-f0-9-]{36}$/);assert.equal(f.calls[0].path,'/session');
});
test('native mutations retain original body and require browser authentication, CSRF and same origin',async t=>{
  const f=await fixture(t), path='/api/v1/assistant/native/session/ses_synthetic/prompt_async';
  const body=JSON.stringify({parts:[{type:'text',text:'synthetic message'}]});
  for (const headers of [{}, {...f.headers,'x-csrf-token':''}, {...f.headers,origin:'https://other.test'}]) {
    const res=await request(f.server,path,{method:'POST',headers,body});assert.ok([400,401,403].includes(res.status),res.text);
  }
  assert.equal(f.calls.length,0);
  const res=await request(f.server,path,{method:'POST',headers:f.headers,body});
  assert.equal(res.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.body,body);
});
test('cross-origin reads and prohibited native control routes never reach the instance',async t=>{
  const f=await fixture(t);
  assert.equal((await request(f.server,'/api/v1/assistant/native/session',{headers:{...f.headers,origin:'https://other.test'}})).status,403);
  assert.equal((await request(f.server,'/api/v1/assistant/native/global/upgrade',{method:'POST',headers:f.headers,body:'{}'})).status,404);
  assert.equal(f.calls.length,0);
});
test('bodyless native actions preserve their contract without bypassing CSRF or JSON validation',async t=>{
  const f=await fixture(t),path='/api/v1/assistant/native/pty/pty_synthetic/connect-token';
  const headers={...f.headers};delete headers['content-type'];
  assert.equal((await request(f.server,path,{method:'POST',headers})).status,200);
  assert.equal(f.calls[0].options.body,undefined);
  assert.equal((await request(f.server,path,{method:'POST',headers:{...headers,'x-csrf-token':''}})).status,401);
  assert.equal((await request(f.server,path,{method:'POST',headers:{...headers,'content-length':'2'},body:'{}'})).status,415);
  assert.equal(f.calls.length,1);
});
test('wrong owner route is rejected before forwarding',async()=>{
  const api=new NativeAssistantApi({routes:{resolve:async()=>({ownerIdentityId:'other',native:{request(){throw Error('must not forward');}}})}});
  const {EventEmitter}=await import('node:events');
  const request=Object.assign(new EventEmitter(),{url:'/api/v1/assistant/native/session',method:'GET',headers:{}});
  const context={identityId:'synthetic-owner',permissions:['ai:invoke']};
  await assert.rejects(api.handle({request,response:new EventEmitter(),context,authenticate:async()=>context}),{code:'access_denied'});
  api.close();
});

test('native terminal resolves the authenticated owner and sign-out aborts its live channel',async()=>{
  const {EventEmitter}=await import('node:events');
  let entered,closed=false;
  const ready=new Promise(resolve=>entered=resolve);
  const context={identityId:'synthetic-owner',permissions:['ai:invoke']};
  const api=new NativeAssistantApi({routes:{resolve:async owner=>({ownerIdentityId:owner,native:{
    async upgrade(target,_request,_socket,_head,{signal}){
      assert.equal(target,'/pty/pty_test/connect');entered();
      await new Promise(resolve=>signal.addEventListener('abort',()=>{closed=true;resolve();},{once:true}));
    },
  }})}});
  const socket=new EventEmitter();
  const running=api.attachUpgrade({request:{url:'/api/v1/assistant/native/pty/pty_test/connect'},socket,head:Buffer.alloc(0),context,authenticate:async()=>context});
  await ready;api.handleSignOut({context});await running;
  assert.equal(closed,true);api.close();
});

test('native terminal rejects another owner and cannot upgrade a non-terminal route',async()=>{
  const {EventEmitter}=await import('node:events');
  const context={identityId:'synthetic-owner',permissions:['ai:invoke']};
  const api=new NativeAssistantApi({routes:{resolve:async()=>({ownerIdentityId:'other',native:{upgrade(){assert.fail('must not forward');}}})}});
  for(const path of ['/pty/pty_test/connect','/event']){
    await assert.rejects(api.attachUpgrade({request:{url:'/api/v1/assistant/native'+path},socket:new EventEmitter(),head:Buffer.alloc(0),context,authenticate:async()=>context}),{code:'access_denied'});
  }
  api.close();
});
