import assert from 'node:assert/strict';
import test from 'node:test';
import {ProtectedNodeAgentClient} from '../src/protected-node-agent-client.mjs';
import {ManagedNodeAgentRouter} from '../src/managed-node-agent-router.mjs';
const NODE='00000000-0000-4000-8000-000000000101',WORKER='00000000-0000-4000-8000-000000000201',LEASE='00000000-0000-4000-8000-000000000301';
const authority={nodeGeneration:5,leaseId:LEASE,fencingToken:9};
function fixture(options={}) {
 const sent=[];
 const client=new ProtectedNodeAgentClient({nodeId:NODE,nodeGeneration:6,allowRetainedRuntime:true,
  commandSigner:{async sign(){return {keyId:'key',nonce:'nonce',signature:'signature'};}},workerSpecFactory:{async buildStartPayload(){return {workerId:WORKER};}},
  transport:{async postCommand({body}){const e=JSON.parse(body);sent.push(e);return {...e,status:'succeeded',payload:{status:'running'}};}},...options});
 return {client,sent};
}
test('retained runtime access signs current generation while preserving lease and runtime identity',async()=>{
 const {client,sent}=fixture();
 await client.workerHealth({workerId:WORKER,authority,correlationId:'reconnect:health'});
 await client.workerControl({workerId:WORKER,authority,correlationId:'reconnect:control',request:{protocolVersion:1,workerId:WORKER,leaseId:LEASE,fencingToken:9,type:'worker.execute.request'}});
 for(const e of sent){assert.equal(e.nodeGeneration,6);assert.equal(e.payload.runtimeGeneration,5);assert.equal(e.leaseId,LEASE);assert.equal(e.fencingToken,9);}
});
test('retained runtime never authorizes stale stop/start or future/invalid identity',async()=>{
 const {client,sent}=fixture();
 await assert.rejects(client.stopWorker({workerId:WORKER,authority,gracePeriodSeconds:1,correlationId:'reconnect:stop'}),/authority/);
 await assert.rejects(client.startWorker({worker:{workerId:WORKER},authority,correlationId:'reconnect:start'}),/authority/);
 for(const nodeGeneration of [0,-1,7,5.1]) await assert.rejects(client.workerHealth({workerId:WORKER,authority:{...authority,nodeGeneration},correlationId:'reconnect:invalid'}),/authority/);
 assert.equal(sent.length,0);
});
test('plugin generation resolver is refreshed for each access, never goes backwards',async()=>{
 let current=6;const {client,sent}=fixture({nodeGeneration:5,resolveGeneration:async()=>current});
 await client.workerHealth({workerId:WORKER,authority,correlationId:'reconnect:first'});current=7;
 await client.workerHealth({workerId:WORKER,authority,correlationId:'reconnect:second'});current=4;
 await assert.rejects(client.workerHealth({workerId:WORKER,authority,correlationId:'reconnect:backwards'}),/authority/);
 assert.deepEqual(sent.map(x=>x.nodeGeneration),[6,7]);
});
test('router resolves current transport for retained access but preserves original runtime authority',async()=>{
 let route,request;const router=new ManagedNodeAgentRouter({ localNodeId: NODE,nodeRepository:{async findNode(){return {nodeId:NODE,nodeKey:'main',generation:6,lifecycleState:'ready',certificateFingerprint:'sha256:'+'a'.repeat(64)};}},
 connectorFactory:async r=>{route=r;return {startWorker(){},stopWorker(){},workerControl(){},workerHealth(p){request=p;return {};}};}});
 await router.workerHealth({workerId:WORKER,nodeId:NODE,authority,correlationId:'reconnect:router'});
 assert.equal(route.nodeGeneration,6);assert.equal(route.allowRetainedRuntime,true);assert.deepEqual(request.authority,authority);
 await assert.rejects(router.stopWorker({workerId:WORKER,nodeId:NODE,authority}),{code:'stale_node_generation'});
});
test('current application authority can retire an exact old UI while generic stale stop stays denied',async()=>{
 const {client,sent}=fixture({nodeGeneration:5,resolveGeneration:async()=>6});
 await client.stopApplication({workerId:WORKER,authority,gracePeriodSeconds:1,correlationId:'plugin:retire'});
 assert.equal(sent[0].nodeGeneration,6);assert.equal(sent[0].payload.runtimeGeneration,5);assert.equal(sent[0].payload.applicationOnly,true);
 await client.startWorker({worker:{workerId:WORKER},authority:{...authority,nodeGeneration:6},correlationId:'plugin:new-slot'});
 assert.equal(sent[1].nodeGeneration,6);assert.equal(sent[1].payload.runtimeGeneration,undefined);
 await assert.rejects(client.stopWorker({workerId:WORKER,authority,gracePeriodSeconds:1,correlationId:'plugin:generic-old-stop'}),/authority/);
});
