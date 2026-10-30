import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {PostgresPhoneMediaRoutes,ManagedNodePhoneMediaBridge} from "../src/virtual-phones/managed-node-phone-media-bridge.mjs";
import {PHONE_SPEC} from "../src/virtual-phones/contracts.mjs";
import {phoneMediaGrant} from "../../../services/scheduler/src/android-phone-media-command.mjs";
import {ManagedNodeAgentRouter} from '../../../services/scheduler/src/managed-node-agent-router.mjs';

function fixture(){
  const node={nodeId:randomUUID(),nodeGeneration:2,poolId:"phones-luks",imageDigest:`sha256:${"a".repeat(64)}`,maximumPhones:2};
  const grant={id:randomUUID(),phoneId:randomUUID(),ownerId:randomUUID(),runId:randomUUID(),sessionId:randomUUID(),generation:3,kind:"control"};
  const row={id:grant.phoneId,owner_id:grant.ownerId,run_id:grant.runId,generation:"3",volume_id:randomUUID(),reservation_id:randomUUID(),
    pool_id:node.poolId,node_id:node.nodeId,node_generation:"2",image_digest:node.imageDigest,base_build_id:PHONE_SPEC.buildId,spec_id:PHONE_SPEC.id,
    storage_bytes:String(PHONE_SPEC.storageBytes),memory_bytes:String(PHONE_SPEC.memoryBytes),cpu_millis:PHONE_SPEC.cpuMillis,state:"running",run_state:"running"};
  const calls=[],database={async query(sql,values){calls.push({sql,values});return {rows:[row]};}};
  return {node,grant,row,calls,routes:new PostgresPhoneMediaRoutes({database,approvedNodes:[node]})};
}
test("phone media routes are exact persisted bindings, never browser targets",async()=>{
  const f=fixture(),calls=[],bridge=new ManagedNodePhoneMediaBridge({routes:f.routes,nodeAgentRouter:{async executePhoneMedia(input){calls.push(input);return {...phoneMediaGrant(input.payload),...(input.action==="close"?{peerClosed:true}:{peerOpen:true,leaseExpiresAt:input.payload.leaseExpiresAt})};}}});
  const expiry=Date.now()+4500;
  assert.equal((await bridge.open({grant:{...f.grant,url:"https://attacker.invalid"},leaseExpiresAt:expiry})).leaseExpiresAt,expiry);
  await bridge.renew({grant:f.grant,leaseExpiresAt:Date.now()+4500});await bridge.close(f.grant);
  assert.deepEqual(calls.map(c=>c.action),["open","renew","close"]);assert.ok(!JSON.stringify(calls).includes("attacker"));
  assert.deepEqual(f.calls[0].values,[f.grant.phoneId,f.grant.ownerId,f.grant.runId,f.grant.generation]);
  assert.equal(calls[0].payload.volumeId,f.row.volume_id);assert.equal(calls[0].nodeId,f.node.nodeId);
});
test("changed node, disk, run, resources and state cannot open media",async()=>{
  for(const change of [{node_generation:1},{node_generation:NaN},{pool_id:"other-pool"},{image_digest:`sha256:${"b".repeat(64)}`},{run_id:randomUUID()},
    {generation:4},{owner_id:randomUUID()},{memory_bytes:"100"},{state:"stopping"},{run_state:"stopped"},{spec_id:"other"}]) {
    const f=fixture();Object.assign(f.row,change);await assert.rejects(f.routes.resolve(f.grant,"open"));
  }
});
test('media preserves the stored run while resolving current authority on the same registered node',async()=>{
 const f=fixture();let generation=3,calls=0;
 const router=new ManagedNodeAgentRouter({ localNodeId: f.node.nodeId,nodeRepository:{findNode:async()=>({nodeId:f.node.nodeId,nodeKey:'phone-test',generation,lifecycleState:'ready'})},
  connectorFactory:async()=>({startWorker(){},workerHealth(){},workerControl(){},stopWorker(){},
   async executePhoneMedia(input){calls++;return {...phoneMediaGrant(input.payload),peerOpen:true,leaseExpiresAt:input.payload.leaseExpiresAt};}})});
 const bridge=new ManagedNodePhoneMediaBridge({routes:f.routes,nodeAgentRouter:router});
 const open=()=>bridge.open({grant:f.grant,leaseExpiresAt:Date.now()+4000});
 await open();assert.equal(f.row.node_generation,'2'); // old run stays 2, command uses 3
 f.row.node_generation=4;
 await assert.rejects(open(),{code:'stale_node_generation'}); // future/stale record cannot guess a current generation
 assert.equal(calls,1);generation=4;
 await open();assert.equal(calls,2);
});
test("bridge refuses a WSS-only close or another phone acknowledgement",async()=>{
  const f=fixture(),bridge=new ManagedNodePhoneMediaBridge({routes:f.routes,nodeAgentRouter:{async executePhoneMedia(input){return {...phoneMediaGrant(input.payload),peerClosed:false};}}});
  await assert.rejects(bridge.close(f.grant));await assert.rejects(bridge.open({grant:f.grant,leaseExpiresAt:Date.now()+6000}));
});
