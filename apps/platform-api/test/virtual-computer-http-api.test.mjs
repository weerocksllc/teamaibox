import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {VirtualComputerHttpApi} from '../src/virtual-computers/virtual-computer-http-api.mjs';
import {VirtualComputerService} from '../src/virtual-computers/virtual-computer-service.mjs';
import {createPlatformApiServer} from '../server/platform-api.mjs';
import {LocalAuthentication} from '../src/identity/auth-service.mjs';
import {MemoryIdentityRepository} from '../src/identity/memory-repository.mjs';
import {PasswordHasher} from '../src/identity/password.mjs';
import {IdentityPreferencesService} from '../src/identity/preferences-service.mjs';
import {grantedPermissions,principalFromRoleKeys} from '../../../packages/authorization/src/index.mjs';

const ROOT='/api/v1/virtual-computers',ORIGIN='https://computers.test',id=randomUUID(),owner=randomUUID();
const context={identityId:owner,sessionId:randomUUID()};
const operations=['availability','list','get','getOperation','create','action'];
const serviceFixture=()=>Object.fromEntries(operations.map(k=>[k,async()=>({id})]));
function fixture(options={}) {
  const repository=Object.fromEntries(['list','get','profiles','findRequest','getOperation','requestCreate','requestAction'].map(k=>[k,async()=>null]));
  repository.list=async()=>[];repository.profiles=async()=>[];
  const directory={authorization:async()=>({permissions:['computer:use']})};
  const policyProvider=async()=>({enabled:true});
  const value={repository,directory,policyProvider,...options};
  return {...value,service:new VirtualComputerService(value)};
}
test('computer routes are separate from Android and do not accept arbitrary node commands',()=>{
  const api=new VirtualComputerHttpApi({service:serviceFixture()});
  for(const [method,path] of [['GET',ROOT],['POST',ROOT],['GET',ROOT+'/availability'],['GET',ROOT+'/'+id],['DELETE',ROOT+'/'+id],
    ['POST',ROOT+'/'+id+'/start'],['POST',ROOT+'/'+id+'/shutdown'],['GET',ROOT+'/operations/'+id]]) assert.equal(api.matches(method,path),true);
  for(const path of ['/api/v1/virtual-phones',ROOT+'/'+id+'/shell',ROOT+'/'+id+'/reset',ROOT+'/'+id+'/docker',ROOT+'/'+id+'/desktop-sessions'])assert.equal(api.matches('POST',path),false);
});
test('ordinary members receive computer-use; managing resources does not grant guest-content access',()=>{
  const permissions=role=>grantedPermissions({principal:principalFromRoleKeys({id:owner,status:'active',identityKind:'local_user'},[role])});
  assert.ok(permissions('member').includes('computer:use'));
  assert.ok(!permissions('guest').includes('computer:use'));
  assert.ok(permissions('system_admin').includes('computer:manage'));
  assert.ok(!permissions('system_admin').includes('computer:use'));
});
test('missing runtime remains unavailable, with no invented user limits',async()=>{
  const f=fixture(),value=await f.service.availability({context});
  assert.equal(value.enabled,false);assert.equal(value.closePageStopsComputer,false);
  assert.deepEqual(value.limits,{maximum:{},storedPerUser:null,runningPerUser:null});
});
test('lost create response returns original operation even if placement later goes offline',async()=>{
  const f=fixture(),op={id:randomUUID(),computerId:id,ownerId:owner,action:'create',state:'executing',command:{secret:'not public'}};
  f.repository.findRequest=async()=>op;
  const result=await f.service.create({context,input:{name:'PC',profileId:'windows11',resources:{vcpus:2,memoryGiB:4,diskGiB:64}},key:'same-request'});
  assert.equal(result.id,op.id);assert.equal(result.command,undefined);assert.equal(result.ownerId,undefined);
});
test('foreign computer is not exposed by runtime availability checks',async()=>{
  const f=fixture();f.repository.get=async()=>{throw Object.assign(Error(),{code:'computer_not_found'});};
  await assert.rejects(f.service.action({context,computerId:id,action:'start',input:{expectedRevision:1},key:'start-request'}),{code:'computer_not_found'});
});
test('authentication and current membership are checked on every request',async()=>{
  const f=fixture();await assert.rejects(f.service.list({context:null}),{code:'invalid_session'});
  f.directory.authorization=async()=>({permissions:['computer:manage']});
  await assert.rejects(f.service.list({context}),{code:'computer_permission_required'});
});
function request(server,{method='GET',path=ROOT,headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const data=body===undefined?null:JSON.stringify(body);
    const req=httpRequest({host:'127.0.0.1',port:server.address().port,method,path,headers:{...headers,...(data?{'content-length':Buffer.byteLength(data)}:{})}},response=>{
      const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });req.on('error',reject);req.end(data);
  });
}
test('real HTTP dispatch reuses platform session, HTTPS, origin and CSRF without a second login system',async t=>{
  const identities=new MemoryIdentityRepository();
  const authentication=await LocalAuthentication.create({repository:identities,hasher:new PasswordHasher({memory:8192,passes:2,parallelism:2,tagLength:32})});
  await authentication.bootstrapOwner({loginName:'owner',displayName:'Owner',password:'test-only-password-long'});
  const service=serviceFixture(),calls=[];
  service.create=async args=>{calls.push(args);return {id,state:'queued'};};
  const server=createPlatformApiServer({authentication,preferences:new IdentityPreferencesService({repository:identities}),publicOrigin:ORIGIN,
    logger:{info(){},warn(){},error(){}},virtualComputerApi:new VirtualComputerHttpApi({service})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  assert.equal((await request(server)).status,426);
  assert.equal((await request(server,{headers:{'x-forwarded-proto':'https'}})).status,401);
  const login=await request(server,{method:'POST',path:'/api/auth/sign-in',headers:{origin:ORIGIN,'x-forwarded-proto':'https','content-type':'application/json'},
    body:{loginName:'owner',password:'test-only-password-long'}});
  assert.equal(login.status,200);
  const headers={origin:ORIGIN,'x-forwarded-proto':'https','content-type':'application/json',
    cookie:login.headers['set-cookie'].map(v=>v.split(';',1)[0]).join('; '),'x-csrf-token':login.body.csrfToken,'idempotency-key':'create-key'};
  const absent={...headers};delete absent['x-csrf-token'];
  assert.equal((await request(server,{method:'POST',headers:absent,body:{}})).status,401);
  assert.equal((await request(server,{method:'POST',headers:{...headers,origin:'https://foreign.test'},body:{}})).status,403);
  assert.equal(calls.length,0);
  const response=await request(server,{method:'POST',headers,body:{name:'My computer'}});
  assert.equal(response.status,202);assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(calls[0].key,'create-key');assert.ok(calls[0].context.identityId);
  assert.equal((await request(server,{path:ROOT+'?host=other-node',headers})).status,400);
  const management=[];
  service.setPolicy=async args=>{management.push(args);return {enabled:false};};
  const adminPath='/api/v1/admin/virtual-computers/policy';
  assert.equal((await request(server,{method:'PUT',path:adminPath,headers:absent,body:{}})).status,401);
  assert.equal((await request(server,{method:'PUT',path:adminPath,headers:{...headers,origin:'https://foreign.test'},body:{}})).status,403);
  assert.equal(management.length,0);
  assert.equal((await request(server,{method:'PUT',path:adminPath,headers,body:{enabled:false}})).status,200);
  assert.equal(management.length,1);
  service.importProfile=async args=>{management.push(args);return {createEnabled:false};};
  service.publishProfile=async args=>{management.push(args);return {createEnabled:true};};
  for(const path of ['/api/v1/admin/virtual-computers/systems','/api/v1/admin/virtual-computers/systems/windows11']){
    assert.equal((await request(server,{method:'PUT',path,headers:absent,body:{}})).status,401);
    assert.equal((await request(server,{method:'PUT',path,headers,body:{}})).status,200);
  }
  assert.equal(management.at(-1).profileId,'windows11');
});
