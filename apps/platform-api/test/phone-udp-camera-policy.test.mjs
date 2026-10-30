import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {udpCameraPolicyInput,udpCameraSelection,lockUdpCameraPermission} from '../src/virtual-phones/phone-udp-camera-policy.mjs';
import {PhoneUdpCameraService} from '../src/virtual-phones/phone-udp-camera-service.mjs';

const policy=()=>({name:'办公区视频',enabled:true,listenAddress:'10.64.0.19',listenPort:35000,allowedSources:['10.64.0.0/24'],ownerIds:[randomUUID()],expectedRevision:0});
test('network policy requires explicit listener, sender and users, not arbitrary list quotas',()=>{
  const p=policy();assert.deepEqual(udpCameraPolicyInput(p),p);
  const allowedSources=Array.from({length:12},(_,i)=>`10.${i}.0.0/16`),ownerIds=Array.from({length:300},randomUUID);
  assert.equal(udpCameraPolicyInput({...p,allowedSources,ownerIds}).ownerIds.length,300);
  assert.equal(udpCameraPolicyInput({...p,allowedSources}).allowedSources.length,12);
  for(const delta of [{listenAddress:'0.0.0.0'},{listenAddress:'224.1.1.1'},{listenAddress:'host.local'},{listenAddress:'10.64.0.19/24'},
    {allowedSources:['0.0.0.0/0']},{allowedSources:['10.64.0.1/24']},{allowedSources:[]},{allowedSources:['10.64.0.0/24','10.64.0.0/24']},
    {listenPort:80},{listenPort:true},{ownerIds:['all']},{path:'/dev/video0'},{expectedRevision:-1}])assert.throws(()=>udpCameraPolicyInput({...p,...delta}));
});
test('member selection contains policy identity only, never a host interface or port',()=>{
  const s={kind:'udp',policyId:randomUUID(),policyRevision:2,continueWithoutViewer:true};assert.deepEqual(udpCameraSelection(s),s);
  for(const extra of [{nodeId:randomUUID()},{listenPort:35000},{listenAddress:'10.64.0.20'},{url:'udp://anything'},{policyRevision:0},{continueWithoutViewer:false}])assert.throws(()=>udpCameraSelection({...s,...extra}));
});
test('permission lock includes persisted node, exact owner and revision',async()=>{
  const nodeId=randomUUID(),ownerId=randomUUID(),source={policyId:randomUUID(),policyRevision:3};
  const db={async query(sql,args){assert.match(sql,/FOR SHARE OF p,u/);assert.deepEqual(args,[source.policyId,nodeId,3,ownerId]);return {rows:[]};}};
  await assert.rejects(lockUdpCameraPermission(db,{nodeId,ownerId,source}),{code:'phone_camera_udp_permission_required'});
});
test('member directory uses the phone node and does not disclose other authorized users',async()=>{
  const context={identityId:randomUUID(),sessionId:randomUUID()},nodeId=randomUUID(),phoneId=randomUUID(),runId=randomUUID();
  const row={...policy(),id:randomUUID(),nodeId,revision:3};let permissions=['phone:use'];let configured;
  const policyStore={async list(v){assert.equal(v.nodeId,nodeId);return [row];},async configure(v){configured=v;return v;}};
  const selected={phoneId,runId,nodeId,generation:2,ownerId:context.identityId,cameraCapability:'verified'};
  const service=new PhoneUdpCameraService({repository:{async assertSelected(v){assert.deepEqual(v,{ownerId:context.identityId,sessionId:context.sessionId,phoneId,generation:2});return selected;}},
    directory:{async authorization(){return {permissions};}},policy:policyStore,nodeAddresses:async()=>['10.64.0.19']});
  const listed=await service.sources({context,phoneId,generation:2});assert.equal(listed.data[0].externalInputEncrypted,false);
  assert.equal(Object.hasOwn(listed.data[0],'ownerIds'),false);assert.equal(Object.hasOwn(listed.data[0],'nodeId'),false);
  const source={kind:'udp',policyId:row.id,policyRevision:3,continueWithoutViewer:true};await service.select(selected,source);
  await assert.rejects(service.select(selected,{...source,policyRevision:2}),{code:'phone_camera_udp_permission_required'});
  await assert.rejects(service.configure({context,nodeId,policyId:row.id,input:policy()}),{code:'phone_permission_required'});
  permissions=['phone:manage'];await assert.rejects(service.sources({context,phoneId,generation:2}),{code:'phone_permission_required'});
  await assert.rejects(service.configure({context,nodeId,policyId:row.id,input:{...policy(),listenAddress:'10.64.0.20'}}),{code:'phone_camera_udp_unavailable'});
  await service.configure({context,nodeId,policyId:row.id,input:policy()});assert.equal(configured.actorId,context.identityId);
  await service.configure({context,nodeId,policyId:row.id,input:{...policy(),enabled:false,listenAddress:'10.64.0.20'}});
});
