import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VirtualPhoneHttpApi,matchesVirtualPhoneHttpRoute} from '../src/virtual-phones/virtual-phone-http-api.mjs';

test('USB HTTP owner check precedes directory; admin policy stays separate and node/path overrides are rejected',async()=>{
  const context={identityId:randomUUID(),sessionId:randomUUID()},phoneId=randomUUID(),nodeId=randomUUID(),deviceId=randomUUID(),events=[];
  const service=Object.fromEntries(['availability','list','get','create','rename','action','getOperation','setQuota','administration'].map(k=>[k,async()=>({})]));
  let own=true,admin=false;
  service.get=async v=>{events.push('owner');assert.equal(v.phoneId,phoneId);if(!own)throw Object.assign(Error(),{code:'phone_not_found'});};
  service.administration=async()=>{events.push('admin');if(!admin)throw Object.assign(Error(),{code:'phone_permission_required'});};
  const cameraService={status(){},start(){},stop(){},listStates(){},
    async usbDevices(v){events.push('devices');assert.deepEqual(v,{context,phoneId,generation:2});return {data:[]};},
    async usbAdministration(v){events.push('policies');assert.deepEqual(v,{context,nodeId});return {data:[]};},
    async configureUsbCamera(v){events.push('configure');assert.equal(v.nodeId,nodeId);assert.equal(v.deviceId,deviceId);return {enabled:false};}};
  const api=new VirtualPhoneHttpApi({service,cameraService,localNodeId:nodeId}),path=`/api/v1/virtual-phones/${phoneId}/camera/usb-devices`;
  assert.equal(matchesVirtualPhoneHttpRoute('GET',path),true);assert.equal(matchesVirtualPhoneHttpRoute('POST',path),false);
  const handle=extra=>api.handle({context,method:'GET',pathname:path,query:new URLSearchParams('generation=2'),...extra});
  const reply=await handle();assert.equal(reply.headers['cache-control'],'no-store');assert.deepEqual(events,['owner','devices']);
  own=false;await assert.rejects(handle(),{code:'phone_not_found'});assert.equal(events.at(-1),'owner');own=true;
  for(const query of [`generation=2&nodeId=${nodeId}`,'generation=2&path=/dev/video0','generation=2&generation=2','generation=0'])
    await assert.rejects(handle({query:new URLSearchParams(query)}),{code:'phone_input_invalid'});
  const adminPath=`/api/v1/admin/virtual-phones/nodes/${nodeId}/usb-cameras`;
  await assert.rejects(handle({pathname:adminPath,query:{}}),{code:'phone_permission_required'});assert.equal(events.at(-1),'admin');
  admin=true;await handle({pathname:adminPath,query:{}});assert.equal(events.at(-1),'policies');
  await assert.rejects(handle({pathname:adminPath,query:{host:'10.64.0.20'}}),{code:'phone_input_invalid'});
  await handle({method:'PUT',pathname:adminPath+'/'+deviceId,body:{enabled:false,ownerIds:[],expectedRevision:1},query:{}});assert.equal(events.at(-1),'configure');
  const foreignPath=adminPath.replace(nodeId,randomUUID());
  await assert.rejects(handle({pathname:foreignPath,query:{}}),{code:'phone_node_unavailable'});
  await assert.rejects(handle({method:'PUT',pathname:foreignPath+'/'+randomUUID(),query:{},body:{enabled:false}}),{code:'phone_node_unavailable'});
  assert.equal(events.at(-1),'admin');
  await assert.rejects(handle({context:null}),{code:'invalid_session'});
});
