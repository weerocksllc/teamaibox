import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {ManagedNodeAgentRouter} from '../src/managed-node-agent-router.mjs';
import {phoneMediaGrant} from '../src/android-phone-media-command.mjs';
import {phoneCameraGrant} from '../src/android-phone-camera-command.mjs';

test('reconnected phone control, video, ADB, files and camera use fresh authority and the unchanged run',async()=>{
 const node={nodeId:randomUUID(),nodeKey:'auxiliary',generation:9,lifecycleState:'ready',certificateFingerprint:'sha256:'+'c'.repeat(64)};
 const grant=randomUUID(),p={phoneId:randomUUID(),ownerId:randomUUID(),volumeId:randomUUID(),poolId:'phones-luks',baseBuildId:'16102939',generation:2,
   operationId:grant,run:{id:randomUUID(),reservationId:randomUUID(),imageDigest:'sha256:'+'a'.repeat(64),memoryBytes:6*1024**3,cpuMillis:2000}};
 const routes=[],calls=[];let closes=0;
 const router=new ManagedNodeAgentRouter({ localNodeId: node.nodeId,nodeRepository:{async findNode(){return node;}},connectorFactory:async route=>{
  routes.push(route);return {startWorker(){},stopWorker(){},workerHealth(){},workerControl(){},close(){closes++;},
   async executePhoneCommand(v){calls.push(v);return {};},async transferPhoneFile(v){calls.push(v);return {};},
   async executePhoneMedia(v){calls.push(v);return {...phoneMediaGrant(v.payload),peerOpen:true,leaseExpiresAt:v.payload.leaseExpiresAt};},
   async executePhoneCamera(v){calls.push(v);return {...phoneCameraGrant(v.payload),state:'waiting',resourceScope:'phone-run',leaseExpiresAt:v.payload.leaseExpiresAt};},
   async connectPhoneSignal(v){calls.push(v);return {send(){},close(){}};},
   async connectPhoneADB(v){calls.push(v);return new EventEmitter();}};
 }});
 const base={nodeId:node.nodeId,nodeGeneration:7},media={...p,grantId:grant,sessionId:randomUUID(),kind:'control',leaseExpiresAt:Date.now()+4500};
 await router.executePhoneCommand({...base,action:'inspect',payload:p});
 await router.transferPhoneFile({...base,payload:p});
 await router.executePhoneMedia({...base,action:'renew',payload:media});
 const peer=await router.connectPhoneSignal({...base,payload:media,onClose(){}});peer.close();
 const adb=await router.connectPhoneADB({...base,payload:{...media,kind:'adb'}});adb.emit('close');
 await router.executePhoneCamera({...base,payload:{...p,grantId:grant,sessionId:randomUUID(),sourceId:randomUUID(),sourceKind:'image',action:'open',deadline:Date.now()+4000,leaseExpiresAt:Date.now()+4000}});
 assert.equal(routes.length,6);assert.equal(closes,6);
 for(const route of routes){assert.equal(route.nodeGeneration,9);assert.equal(route.nodeId,node.nodeId);assert.equal(route.expectedCertificateFingerprint,node.certificateFingerprint);}
 for(const call of calls){assert.equal(call.payload.run.id,p.run.id);assert.equal(call.payload.generation,2);}
 for(const state of ['offline','removed','disabled']){
  node.lifecycleState=state;await assert.rejects(router.executePhoneCommand({...base,action:'inspect',payload:p}),{code:'managed_node_not_ready'});
 }
 assert.equal(routes.length,6);
});
