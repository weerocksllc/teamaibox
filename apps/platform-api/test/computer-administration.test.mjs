import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {policyUpdate,quotaUpdate,quotaQuery,publicPolicy} from '../src/virtual-computers/computer-administration.mjs';
import {VirtualComputerService} from '../src/virtual-computers/virtual-computer-service.mjs';
import {VirtualComputerHttpApi} from '../src/virtual-computers/virtual-computer-http-api.mjs';
test('administrator limits are optional, exact and do not permit installed runtime overrides',()=>{
  const p={enabled:true,maximum:{},storedPerUser:null,runningPerUser:null,expectedRevision:0};
  assert.deepEqual(policyUpdate(p),p);
  for(const extra of [{maximum:{vcpus:0}},{enabled:1},{expectedRevision:-1},{storedPerUser:1,runningPerUser:2},{runtimeUpdates:{}}]){
    assert.throws(()=>policyUpdate({...p,...extra}),{code:'computer_input_invalid'});
  }
  assert.throws(()=>quotaUpdate({storedPerUser:null,runningPerUser:NaN,expectedRevision:0}),{code:'computer_input_invalid'});
  assert.throws(()=>quotaQuery(new URLSearchParams('search=a&search=b')),{code:'computer_input_invalid'});
  assert.equal(publicPolicy({...p,runtimeUpdates:{secret:'not-public'}}).runtimeUpdates,undefined);
});
test('management endpoints require computer manage and never grant access to owner content',async()=>{
  const owner=randomUUID(),context={identityId:owner},calls=[];
  let permissions=['computer:use'];
  const repository=Object.fromEntries(['list','get','profiles','findRequest','getOperation','requestCreate','requestAction'].map(k=>[k,async()=>[]]));
  repository.setPolicy=async(...args)=>calls.push(args);repository.administrationQuotas=async()=>({data:[]});
  const service=new VirtualComputerService({repository,directory:{authorization:async()=>({permissions})},policyProvider:async()=>({enabled:true})});
  await assert.rejects(service.administration({context}),{code:'computer_permission_required'});
  await assert.rejects(service.importProfile({context,input:{}}),{code:'computer_permission_required'});
  await assert.rejects(service.publishProfile({context,profileId:'windows11',input:{}}),{code:'computer_permission_required'});
  permissions=['computer:manage'];assert.equal((await service.administration({context})).contentAccessGranted,false);
  await assert.rejects(service.list({context}),{code:'computer_permission_required'});
  const api=new VirtualComputerHttpApi({service});
  const input={enabled:false,maximum:{},storedPerUser:null,runningPerUser:null,expectedRevision:0};
  assert.equal((await api.handle({method:'PUT',pathname:'/api/v1/admin/virtual-computers/policy',context,body:input})).status,200);
  assert.deepEqual(calls,[[owner,input]]);
  assert.equal(api.matches('PUT','/api/v1/admin/virtual-computers/quotas/'+owner),true);
});
