import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {PhoneUsbCameraService} from '../src/virtual-phones/phone-usb-camera-service.mjs';
import {usbCameraSelection,usbCameraPolicyInput} from '../src/virtual-phones/phone-usb-camera-policy.mjs';
import {cameraStartInput} from '../src/virtual-phones/phone-camera-contracts.mjs';

function fixture(){
  const context={identityId:randomUUID(),sessionId:randomUUID()},phoneId=randomUUID(),nodeId=randomUUID(),runId=randomUUID();
  const selected={ownerId:context.identityId,sessionId:context.sessionId,phoneId,nodeId,runId,generation:3,cameraCapability:'verified'};
  const device={deviceId:randomUUID(),attachmentId:'a'.repeat(64),name:'FHD USB camera',formats:['MJPG','YUYV','H264'],hostPath:'/dev/video0',serial:'private-device-serial'};
  let permissions=['phone:use'],allowed=[device.deviceId],live={nodeId,runId,generation:3,data:[device]},called=0;
  const repository={async assertSelected(v){
    if(v.ownerId!==selected.ownerId||v.phoneId!==phoneId)throw Object.assign(Error(),{code:'phone_not_found'});
    if(v.sessionId!==selected.sessionId)throw Object.assign(Error(),{code:'phone_grant_invalid'});
    if(v.generation!==3)throw Object.assign(Error(),{code:'phone_stale_run'});return {...selected};}};
  const policy={async listAllowed(v){assert.equal(v.nodeId,nodeId);assert.equal(v.ownerId,selected.ownerId);return allowed;},
    async listPolicies(){return [{deviceId:device.deviceId,enabled:true,revision:1,ownerIds:[selected.ownerId]}];},
    async configure(v){called++;return v;}};
  const runtime={async usbDevices(v){called++;assert.equal(v.nodeId,nodeId);assert.equal(v.runId,runId);return live;},
    async usbNodeDevices(v){called++;assert.equal(v.nodeId,nodeId);return live;}};
  const directory={async authorization(){return {permissions};}};
  const service=new PhoneUsbCameraService({repository,directory,policy,runtime});
  return {context,phoneId,nodeId,selected,device,service,policy,runtime,directory,
    permissions:v=>permissions=v,allow:v=>allowed=v,live:v=>live=v,calls:()=>called,
    list:()=>service.devices({context,phoneId,generation:3}),source:()=>({kind:'usb',deviceId:device.deviceId,attachmentId:device.attachmentId,continueWithoutViewer:true})};
}
test('USB source accepts explicit device/attachment only; no node, path, URL or implicit capture',()=>{
  const f=fixture(),s=f.source();assert.deepEqual(usbCameraSelection(s),s);
  for(const extra of [{nodeId:f.nodeId},{path:'/dev/video0'},{host:'10.64.0.20'},{url:'https://node'},{ownerId:randomUUID()},
    {attachmentId:''},{attachmentId:'A'.repeat(64)},{attachmentId:null},{continueWithoutViewer:false},{deviceId:null}])assert.throws(()=>usbCameraSelection({...s,...extra}));
  const one=cameraStartInput({expectedGeneration:3,requestId:randomUUID(),source:s});
  const two=cameraStartInput({expectedGeneration:3,requestId:one.sourceId,source:{...s,attachmentId:'b'.repeat(64)}});
  assert.notEqual(one.fingerprint,two.fingerprint,'replug selection is a different request');
});
test('USB inventory derives node/run from phone; strips path/serial and unsupported formats',async()=>{
  const f=fixture(),result=await f.list();
  assert.deepEqual(result,{object:'list',phoneId:f.phoneId,runId:f.selected.runId,generation:3,data:[{
    deviceId:f.device.deviceId,attachmentId:f.device.attachmentId,name:f.device.name,formats:['MJPG','YUYV']}]});
  assert.equal(JSON.stringify(result).includes(f.nodeId),false);
  assert.equal(JSON.stringify(result).includes('private-device-serial'),false);
  await f.service.select(f.selected,f.source());
});
test('camera lists and explicit owner assignments are not capped at 64 or 256',async()=>{
  const f=fixture(),data=Array.from({length:130},()=>({...f.device,deviceId:randomUUID(),name:'摄像头'.repeat(100)}));
  f.live({...f.selected,data});f.allow(data.map(d=>d.deviceId));
  assert.equal((await f.list()).data.length,130);
  const ownerIds=Array.from({length:300},randomUUID);
  assert.equal(usbCameraPolicyInput({enabled:true,ownerIds,expectedRevision:0}).ownerIds.length,300);
  assert.throws(()=>usbCameraPolicyInput({enabled:true,ownerIds:[...ownerIds,ownerIds[0]],expectedRevision:0}));
});
test('unknown user/device, revoked allowlist, manager-only and old phone selection cannot enumerate or capture',async()=>{
  const f=fixture();f.allow([]);assert.deepEqual((await f.list()).data,[]);assert.equal(f.calls(),0);
  await assert.rejects(f.service.select(f.selected,f.source()),{code:'phone_camera_usb_permission_required'});
  f.permissions(['phone:manage']);await assert.rejects(f.list(),{code:'phone_permission_required'});assert.equal(f.calls(),0);
  f.permissions(['phone:use']);
  for(const change of [{phoneId:randomUUID()},{generation:2},{context:{...f.context,identityId:randomUUID()}},{context:{...f.context,sessionId:randomUUID()}}])
    await assert.rejects(f.service.devices({context:f.context,phoneId:f.phoneId,generation:3,...change}));
});
test('foreign node, stale run, changed attachment and metadata-only devices never become selected',async()=>{
  for(const mismatch of [{nodeId:randomUUID()},{runId:randomUUID()},{generation:4},{data:[]},
    {data:[{deviceId:randomUUID(),attachmentId:'b'.repeat(64),name:'another',formats:['MJPG']}]},
    {data:[{deviceId:randomUUID(),attachmentId:'a'.repeat(64),name:'metadata',formats:['META']}]},
    {data:[{deviceId:randomUUID(),attachmentId:'a'.repeat(64),name:'bad',formats:['/dev/video0']}]}]){
    const f=fixture();f.live({nodeId:f.nodeId,runId:f.selected.runId,generation:3,data:[f.device],...mismatch});
    await assert.rejects(f.service.select(f.selected,f.source()));
  }
  const f=fixture();f.live({nodeId:f.nodeId,runId:f.selected.runId,generation:3,data:[{...f.device,attachmentId:'b'.repeat(64)}]});
  await assert.rejects(f.service.select(f.selected,f.source()),{code:'phone_camera_usb_device_changed'});
});
test('USB policy requires explicit user list and revision; enabling detached device is rejected but revocation works',async()=>{
  const f=fixture(),input={enabled:true,ownerIds:[f.context.identityId],expectedRevision:0};
  for(const change of [{ownerIds:'all'},{enabled:1},{ownerIds:[f.context.identityId,f.context.identityId]},{expectedRevision:-1},{nodeId:f.nodeId},{path:'/dev/video0'}])assert.throws(()=>usbCameraPolicyInput({...input,...change}));
  await assert.rejects(f.service.configure({context:f.context,nodeId:f.nodeId,deviceId:f.device.deviceId,input}),{code:'phone_permission_required'});
  f.permissions(['phone:manage']);const v=await f.service.configure({context:f.context,nodeId:f.nodeId,deviceId:f.device.deviceId,input});
  assert.equal(v.actorId,f.context.identityId);assert.deepEqual(v.input,input);
  f.live({nodeId:f.nodeId,data:[]});await assert.rejects(f.service.configure({context:f.context,nodeId:f.nodeId,deviceId:f.device.deviceId,input}),{code:'phone_camera_usb_device_changed'});
  assert.equal((await f.service.administration({context:f.context,nodeId:f.nodeId})).data[0].connected,false);
  await f.service.configure({context:f.context,nodeId:f.nodeId,deviceId:f.device.deviceId,input:{...input,enabled:false}});
});
