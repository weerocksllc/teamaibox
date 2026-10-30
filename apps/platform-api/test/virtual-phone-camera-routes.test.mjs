import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {PostgresPhoneCameraRoutes,ManagedNodePhoneCamera} from '../src/virtual-phones/managed-node-phone-camera.mjs';
import {phoneCameraGrant} from '../../../services/scheduler/src/android-phone-camera-command.mjs';
import {PostgresPhoneCameraRepository} from '../src/virtual-phones/postgres-phone-camera-repository.mjs';

function fixture(){
  const image='sha256:'+'a'.repeat(64),rom='camera-fixture-v1';
  const grant={id:randomUUID(),sourceId:randomUUID(),sourceKind:'image',phoneId:randomUUID(),ownerId:randomUUID(),runId:randomUUID(),generation:2,sessionId:randomUUID()};
  const node={nodeId:randomUUID(),nodeGeneration:3,poolId:'phone-pool',imageDigest:'sha256:'+'b'.repeat(64),maximumPhones:2,roms:[{romVersionId:rom,imageDigest:image}]};
  const row={id:grant.phoneId,owner_id:grant.ownerId,volume_id:randomUUID(),pool_id:node.poolId,base_build_id:'16102939',spec_id:'cuttlefish-arm64-office-v1',storage_bytes:16*1024**3,
    generation:2,node_id:node.nodeId,state:'running',rom_version_id:rom,runtime_image_digest:image,camera_capability:'verified',run_id:grant.runId,node_generation:3,
    image_digest:image,memory_bytes:6*1024**3,cpu_millis:2000,reservation_id:randomUUID(),run_state:'running'};
  let missing=false;const queries=[];
  const routes=new PostgresPhoneCameraRoutes({approvedNodes:[node],database:{async query(sql,values){queries.push(values);return {rows:missing?[]:[row]};}}});
  return {row,grant,node,routes,queries,missing(){missing=true;},selected:{nodeId:node.nodeId,imageDigest:image,romVersionId:rom,cameraCapability:'verified'}};
}
test('camera route binds exact installed ROM, current run, owner, resources and managed node',async()=>{
  const f=fixture();assert.deepEqual(f.routes.capabilities(f.selected),{image:true});
  for(const patch of [{romVersionId:'old-rom'},{imageDigest:'sha256:'+'c'.repeat(64)},{cameraCapability:'unavailable'},{nodeId:randomUUID()}])assert.deepEqual(f.routes.capabilities({...f.selected,...patch}),{image:false});
  const result=await f.routes.resolve(f.grant,'image');assert.equal(result.nodeId,f.node.nodeId);assert.equal(result.payload.run.memoryBytes,6*1024**3);
  assert.deepEqual(f.queries[0],[f.grant.phoneId,f.grant.ownerId,f.grant.runId,2]);
  for(const patch of [{owner_id:randomUUID()},{generation:3},{rom_version_id:'old-rom'},{runtime_image_digest:'sha256:'+'c'.repeat(64)},
    {image_digest:'sha256:'+'c'.repeat(64)},{camera_capability:'unavailable'},{memory_bytes:8*1024**3},{cpu_millis:4000},
    {state:'stopped'},{run_state:'stopped'},{node_generation:2},{pool_id:'other-pool'}]){
    const g=fixture();Object.assign(g.row,patch);await assert.rejects(g.routes.resolve(g.grant,'open'));
  }
  f.row.state=f.row.run_state='stopped';await f.routes.resolve(f.grant,'close');f.missing();await assert.rejects(f.routes.resolve(f.grant,'close'));
});

test('node-local camera routes use the new phone host adapter without redirecting to another box',async()=>{
 const f=fixture(),fixed='sha256:'+'c'.repeat(64);
 Object.assign(f.node.roms[0],{runtimeImageDigest:fixed,androidSystemDigest:'sha256:'+'d'.repeat(64),cameraSources:['image','browser','video','usb','udp']});
 f.row.image_digest=fixed;
 const routes=new PostgresPhoneCameraRoutes({approvedNodes:[f.node],database:{async query(){return {rows:[f.row]};}}});
 assert.equal((await routes.resolve(f.grant,'image')).nodeId,f.node.nodeId);
 assert.equal((await routes.resolve(f.grant,'image')).payload.run.imageDigest,fixed);
 assert.deepEqual(routes.capabilities({...f.selected,imageDigest:fixed,romImageDigest:f.row.runtime_image_digest}),
  {image:true,browser:true,video:true,usb:true,udp:true});
 assert.equal(routes.usbNode(f.node.nodeId).nodeId,f.node.nodeId);
 assert.throws(()=>routes.usbNode(randomUUID()),{code:'phone_node_unavailable'});
 f.row.node_id=randomUUID();
 await assert.rejects(routes.resolve(f.grant,'image'),{code:'phone_node_unavailable'});
});
test('camera bridge sends bounded metadata, preserves only public failures and checks actual acknowledgement',async()=>{
  const f=fixture(),calls=[];let fail=null,wrong=false;
  const bridge=new ManagedNodePhoneCamera({routes:f.routes,nodeAgentRouter:{async executePhoneCamera(input){calls.push(input);if(fail)throw Error(fail);
    const p=input.payload;return {...phoneCameraGrant(p),state:p.action==='image'?'receiving':p.action==='close'?'stopped':'waiting',resourceScope:'phone-run',
      ...(['open','renew'].includes(p.action)?{leaseExpiresAt:p.leaseExpiresAt}:p.action==='close'?{retainedFrameBytes:0}:{}),...(wrong?{ownerId:randomUUID()}:{})};}}});
  const signal=new AbortController().signal;
  await bridge.open({grant:f.grant,leaseExpiresAt:Date.now()+4000,signal});
  const chunks=(async function*(){yield Buffer.from('image');})();
  await bridge.image({grant:f.grant,metadata:{sizeBytes:5,sha256:'d'.repeat(64),objectId:randomUUID(),name:'private.png'},chunks,signal});
  assert.equal(calls[1].chunks,chunks);assert.equal(calls[1].signal,signal);assert.equal(calls[1].payload.action,'image');
  assert.equal(Object.hasOwn(calls[1].payload,'name'),false);assert.equal(Object.hasOwn(calls[1].payload,'objectId'),false);
  assert.ok(calls[1].payload.deadline-Date.now()<=14000);await bridge.close({grant:f.grant});
  for(const code of ['phone_camera_image_unsupported','phone_camera_image_too_large','phone_camera_source_stopped']){
    fail=code;await assert.rejects(bridge.close({grant:f.grant}),{code});
  }
  fail='phone_camera_not_ready';await assert.rejects(bridge.renew({grant:f.grant,leaseExpiresAt:Date.now()+4000}),
    {code:'phone_camera_runtime_unavailable',cameraDiagnosticCode:'phone_camera_not_ready',cameraAction:'renew'});
  fail='/private/path';await assert.rejects(bridge.close({grant:f.grant}),
    {code:'phone_camera_runtime_unavailable',cameraDiagnosticCode:'phone_camera_runtime_unavailable'});
  fail=null;wrong=true;await assert.rejects(bridge.close({grant:f.grant}),{code:'phone_camera_runtime_unavailable'});
  const abort=new AbortController();abort.abort();const before=calls.length;await assert.rejects(bridge.close({grant:f.grant,signal:abort.signal}));assert.equal(calls.length,before);
});

test('camera metadata and capabilities accept the same exact host repair as phone start/display',async()=>{
  const f=fixture(),fixed='sha256:'+'c'.repeat(64),original=f.row.image_digest;
  f.node.roms[0].cameraSources=['image','browser','video'];
  f.node.roms.push({romVersionId:'camera-fixed-v1',imageDigest:fixed,cameraSources:['image','browser','video']});
  const maintenance={phoneId:f.row.id,ownerId:f.row.owner_id,volumeId:f.row.volume_id,
    romVersionId:f.row.rom_version_id,fromImageDigest:original,toImageDigest:fixed,androidSystemDigest:'sha256:'+'d'.repeat(64)};
  f.node.runtimeMaintenance=[maintenance];f.row.image_digest=fixed;
  const db={async transaction(fn){return fn(db);},async query(text){
    if(text.includes('FROM iam.sessions'))return {rows:[{id:f.grant.sessionId}]};
    if(text.includes('FROM platform.phone_runs'))return {rows:[{id:f.grant.runId,node_id:f.node.nodeId,
      image_digest:f.row.image_digest,memory_bytes:f.row.memory_bytes,cpu_millis:f.row.cpu_millis}]};
    return {rows:[f.row]};
  }};
  const repository=new PostgresPhoneCameraRepository({database:db,approvedNodes:[f.node]});
  const selected=await repository.assertSelected({ownerId:f.grant.ownerId,phoneId:f.grant.phoneId,sessionId:f.grant.sessionId,generation:2});
  const routes=new PostgresPhoneCameraRoutes({database:{async query(){return {rows:[f.row]};}},approvedNodes:[f.node]});
  assert.equal(selected.imageDigest,fixed);assert.equal(selected.romImageDigest,original);
  assert.deepEqual(routes.capabilities(selected),{image:true,browser:true,video:true});
  assert.equal((await routes.resolve(f.grant,'image')).payload.run.imageDigest,fixed);
  for(const key of ['phoneId','ownerId','volumeId']){
    const wrong={...f.node,runtimeMaintenance:[{...maintenance,[key]:randomUUID()}]};
    await assert.rejects(new PostgresPhoneCameraRepository({database:db,approvedNodes:[wrong]}).assertSelected({ownerId:f.grant.ownerId,phoneId:f.grant.phoneId,sessionId:f.grant.sessionId,generation:2}),{code:'phone_stale_run'});
  }
  f.row.image_digest='sha256:'+'e'.repeat(64);
  await assert.rejects(repository.assertSelected({ownerId:f.grant.ownerId,phoneId:f.grant.phoneId,sessionId:f.grant.sessionId,generation:2}),{code:'phone_stale_run'});
  f.row.image_digest=original;
  assert.equal((await repository.assertSelected({ownerId:f.grant.ownerId,phoneId:f.grant.phoneId,sessionId:f.grant.sessionId,generation:2})).imageDigest,original);
});
