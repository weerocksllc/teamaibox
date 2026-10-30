import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamicSandboxController,dynamicSandboxIdentity} from '../src/dynamic-sandbox-controller.mjs';
const OWNER='00000000-0000-4000-8000-000000000011',OTHER='00000000-0000-4000-8000-000000000012';
function fixture() {
 const items=new Map(),states=new Map(),calls=[];let active=true,busy=false,now=1000;
 const controller=new DynamicSandboxController({clock:()=>now,idleMilliseconds:100,
  identities:{active:async()=>active,busy:async()=>busy},
  storage:{async prepare(id){if(!items.has(id.ownerIdentityId))items.set(id.ownerIdentityId,{...id,token:'a'.repeat(48),lastUsedAt:now});return items.get(id.ownerIdentityId);},
   async touch(id,time){items.get(id.ownerIdentityId).lastUsedAt=time;},async list(){return [...items.values()];},async credentials(id){calls.push(['credentials',id.key]);}},
  runtime:{async inspect(id){return states.get(id.ownerIdentityId);},assertOwned(id,v){assert.equal(v.ownerIdentityId,id.ownerIdentityId);},
   async admit(id){calls.push(['admit',id.key]);},async start(id){calls.push(['start',id.key]);const s={ownerIdentityId:id.ownerIdentityId,running:true};states.set(id.ownerIdentityId,s);return s;},
   async healthy(){},async stop(id,v){calls.push(['stop',id.key]);v.running=false;}}
 });return {controller,items,states,calls,setActive:v=>active=v,setBusy:v=>busy=v,setTime:v=>now=v};
}
test('each member gets a distinct stable identity; invalid owner is rejected',()=>{
 assert.notEqual(dynamicSandboxIdentity(OWNER).key,dynamicSandboxIdentity(OTHER).key);
 assert.deepEqual(dynamicSandboxIdentity(OWNER),dynamicSandboxIdentity(OWNER));
 assert.throws(()=>dynamicSandboxIdentity('../../root'));
});
test('simultaneous first requests start just one owned sandbox',async()=>{
 const f=fixture();const result=await Promise.all([f.controller.ensure(OWNER),f.controller.ensure(OWNER)]);
 assert.equal(f.calls.filter(v=>v[0]==='start').length,1);assert.equal(result[0].token,result[1].token);
});
test('new members are not limited to a deployment-time allowlist',async()=>{
 const f=fixture();await f.controller.ensure(OWNER);await f.controller.ensure(OTHER);assert.equal(f.states.size,2);
});
test('disabled identity cannot provision or use a retained workspace',async()=>{
 const f=fixture();f.setActive(false);await assert.rejects(f.controller.ensure(OWNER),/inactive/);assert.equal(f.items.size,0);
});
test('idle stops compute, keeps workspace, restarts same identity',async()=>{
 const f=fixture();await f.controller.ensure(OWNER);const saved=f.items.get(OWNER);f.setTime(1200);await f.controller.reconcile();
 assert.equal(f.states.get(OWNER).running,false);assert.equal(f.items.get(OWNER),saved);
 await f.controller.ensure(OWNER);assert.equal(f.states.get(OWNER).running,true);assert.equal(f.items.get(OWNER),saved);
});
test('active work cannot be stopped by idle sweep',async()=>{
 const f=fixture();await f.controller.ensure(OWNER);f.setTime(1200);f.setBusy(true);await f.controller.reconcile();assert.equal(f.states.get(OWNER).running,true);
});
test('account disable stops even active compute without deleting workspace',async()=>{
 const f=fixture();await f.controller.ensure(OWNER);f.setActive(false);f.setBusy(true);await f.controller.reconcile();assert.equal(f.states.get(OWNER).running,false);assert.equal(f.items.size,1);
});
test('a name collision must never stop or reuse another owner container',async()=>{
 const f=fixture();f.states.set(OWNER,{ownerIdentityId:OTHER,running:true});await assert.rejects(f.controller.ensure(OWNER));assert.equal(f.calls.length,0);
});
