import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import test from 'node:test';
import {PhoneFileService} from '../src/virtual-phones/phone-file-service.mjs';

// Explicit domain fixtures: Android/file transport is exercised separately.
function fixture() {
  const owner=randomUUID(),phoneId=randomUUID(),sessionId=randomUUID(),nodeId=randomUUID();
  const context={identityId:owner,sessionId},data=Buffer.from('synthetic encrypted-object input'),sha256=createHash('sha256').update(data).digest('hex');
  const phone={id:phoneId,ownerId:owner,state:'running',generation:1},run={id:randomUUID(),phoneId,ownerId:owner,nodeId,nodeGeneration:1,generation:1,state:'running',imageDigest:'sha256:'+'1'.repeat(64)};
  const file={objectId:randomUUID(),objectVersion:1,name:'会议.txt',sizeBytes:data.length,sha256};
  let allowed=true,loggedIn=true;const calls=[];
  const objects={async withInput(args,consume){calls.push('object-read');assert.equal(args.ownerId,owner);assert.deepEqual(args.input,file);
    return consume({metadata:file,chunks:(async function*(){yield data;})()});},async storeOutput(args){calls.push('object-write');assert.equal(args.ownerId,owner);assert.equal(args.phoneId,phoneId);
    for await(const chunk of args.chunks)assert.deepEqual(chunk,data);
    return {objectId:randomUUID(),version:1,size:data.length,integrity:{digest:sha256}};}};
  const reply=()=>({phoneId,runId:run.id,generation:1});
  const runtime={maximumTransferMilliseconds:120000,
    async receive(args){calls.push(args.action);assert.equal(args.phone.ownerId,owner);assert.equal(args.run.id,run.id);assert.ok(args.deadline<=Date.now()+120000);
      for await(const chunk of args.chunks)assert.deepEqual(chunk,data);
      return {...reply(),stored:true,installed:true,name:file.name,sizeBytes:data.length,sha256};},
    async send(args){calls.push('guest-read');assert.equal(args.name,file.name);return {...reply(),...file,chunks:(async function*(){yield data;})()};},
    async list(){return {...reply(),files:[{name:file.name,sizeBytes:data.length}]};}};
  const service=new PhoneFileService({repository:{async get(user,id){if(user!==owner||id!==phoneId)throw Object.assign(Error('not found'),{code:'phone_not_found'});return {...phone};},async currentRun(){return {...run};}},
    directory:{async authorization(){return {permissions:allowed?['phone:use']:['phone:manage']};}},sessions:{async assertLogin(args){assert.deepEqual(args,{ownerId:owner,sessionId});if(!loggedIn)throw Object.assign(Error('expired'),{code:'phone_grant_invalid'});}},objectTransfer:objects,runtime});
  return {service,context,phoneId,phone,run,file,calls,runtime,objects,allowed:value=>allowed=value,loggedIn:value=>loggedIn=value};
}
test('file/APK operations bind the owner and current run, and never enable an ADB grant',async()=>{
  const f=fixture(),args={context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,file:f.file}};
  assert.equal((await f.service.upload(args)).name,f.file.name);
  assert.equal((await f.service.upload({...args,install:true})).installed,true);
  assert.equal((await f.service.list({context:f.context,phoneId:f.phoneId,generation:1})).directory,'Download/TeamAIBox');
  assert.equal((await f.service.download({...args,input:{expectedGeneration:1,name:f.file.name}})).sha256,f.file.sha256);
  assert.deepEqual(f.calls,['object-read','upload','object-read','install','guest-read','object-write']);
});
test('file deadlines fit the node ceiling despite a 500ms receiver clock lag',async()=>{
  const f=fixture(),original=f.runtime.list;
  f.runtime.list=async args=>{
    const receiverNow=Date.now()-500;
    assert.ok(args.deadline>receiverNow && args.deadline<=receiverNow+120000);
    assert.ok(args.deadline<=Date.now()+119000);
    return original(args);
  };
  await f.service.list({context:f.context,phoneId:f.phoneId,generation:1});
});
test('foreign owner, manager-only, expired login, stopped and stale generation are denied before object reads',async()=>{
  for(const reason of ['foreign','manage','login','stopped','generation']){
    const f=fixture(),context={...f.context};let generation=1;
    if(reason==='foreign')context.identityId=randomUUID();if(reason==='manage')f.allowed(false);if(reason==='login')f.loggedIn(false);
    if(reason==='stopped')f.phone.state='stopped';if(reason==='generation')generation=2;
    if(reason==='foreign')await assert.rejects(f.service.upload({context,phoneId:f.phoneId,input:{expectedGeneration:generation,file:f.file}}));
    else await assert.rejects(f.service.upload({context,phoneId:f.phoneId,input:{expectedGeneration:generation,file:f.file}}),{code:{manage:'phone_permission_required',login:'phone_grant_invalid',stopped:'phone_stale_run',generation:'phone_stale_run'}[reason]});
    assert.deepEqual(f.calls,[]);
  }
});
test('wrong Android acknowledgement or failed installation is never displayed as success',async()=>{
  for(const field of ['runId','sha256','installed','name']){
    const f=fixture(),original=f.runtime.receive;
    f.runtime.receive=async args=>({...await original(args),[field]:field==='installed'?false:'wrong'});
    await assert.rejects(f.service.upload({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,file:f.file},install:field==='installed'}),
      {code:field==='runId'?'phone_stale_run':field==='installed'?'phone_install_failed':'phone_object_invalid'});
  }
});
test('logout interrupts active transfer; concurrent operations conflict and the slot is freed',async()=>{
  const f=fixture();let entered;const ready=new Promise(resolve=>entered=resolve);
  f.runtime.receive=async({signal})=>{entered();return new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});};
  const args={context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,file:f.file}};
  const pending=f.service.upload(args);const rejected=assert.rejects(pending,{code:'phone_grant_invalid'});
  await ready;await assert.rejects(f.service.upload(args),{code:'phone_operation_conflict'});f.loggedIn(false);
  // Keep the test event loop alive while the unref'd production check runs.
  await Promise.all([rejected,new Promise(resolve=>setTimeout(resolve,1100))]);
  f.loggedIn(true);assert.equal((await f.service.list({context:f.context,phoneId:f.phoneId,generation:1})).data.length,1);
});
test('caller cancellation and a changed run during completion cannot produce a success',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.service.upload({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,file:f.file},signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(f.calls,[]);
  const original=f.runtime.receive;
  f.runtime.receive=async args=>{const value=await original(args);f.run.id=randomUUID();return value;};
  await assert.rejects(f.service.upload({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,file:f.file}}),{code:'phone_stale_run'});
});
