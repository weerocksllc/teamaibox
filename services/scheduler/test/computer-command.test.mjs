import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {once} from 'node:events';
import {validateComputerCommand,validateComputerCommandResult} from '../src/computer-command.mjs';
import {ManagedNodeAgentRouter} from '../src/managed-node-agent-router.mjs';
import {ProtectedNodeAgentClient} from '../src/protected-node-agent-client.mjs';
const payload=()=>({computerId:randomUUID(),ownerId:randomUUID(),nodeId:randomUUID(),volumeId:randomUUID(),firmwareId:randomUUID(),operationId:randomUUID(),
  poolId:'windows-test',tpmId:randomUUID(),profileId:'windows11-pro',runtimeImage:'sha256:'+'a'.repeat(64),generation:1,
  resources:{vcpus:4,memoryBytes:8*1024**3,diskBytes:128*1024**3},
  run:{id:randomUUID(),generation:1,containerId:null,runtimeImage:'sha256:'+'a'.repeat(64)}});
const proof=p=>({...Object.fromEntries(['computerId','ownerId','nodeId','volumeId','firmwareId','operationId','tpmId','generation'].map(k=>[k,p[k]])),
  running:true,runId:p.run.id,containerId:'b'.repeat(64),runtimeImage:p.runtimeImage});
test('node command contains server-selected identities and resources, not arbitrary paths or credentials',()=>{
  const p=payload();assert.deepEqual(validateComputerCommand('start',p),p);
  for(const key of ['password','path','argv','image','port','connectionId'])assert.throws(()=>validateComputerCommand('start',{...p,[key]:'injected'}));
  assert.throws(()=>validateComputerCommand('reset',p));
  assert.throws(()=>validateComputerCommand('shutdown',p));
  for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateComputerCommand('start',{...p,resources:{...p.resources,memoryBytes:value}}));
});
test('a response for a different run or storage identity never completes the operation',()=>{
  const p=payload(),r=proof(p);assert.deepEqual(validateComputerCommandResult('start',p,r),r);
  for(const key of ['operationId','computerId','ownerId','nodeId','volumeId','firmwareId','tpmId','runId','runtimeImage'])
    assert.throws(()=>validateComputerCommandResult('start',p,{...r,[key]:randomUUID()}),{code:'node_agent_protocol_mismatch'});
  assert.throws(()=>validateComputerCommandResult('start',p,{...r,password:'leak'}));
});
test('same computer survives node reconnection using fresh authenticated transport, not a replacement disk or run',async()=>{
  const p=payload(),calls=[],connections=[];let generation=1;
  const nodeRepository={findNode:async()=>({nodeId:p.nodeId,nodeKey:'aux-23',generation,lifecycleState:'ready',certificateFingerprint:'current-pin'})};
  const router=new ManagedNodeAgentRouter({ localNodeId: p.nodeId,nodeRepository,connectorFactory:async route=>{
    connections.push(route);
    return {startWorker(){},workerHealth(){},workerControl(){},stopWorker(){},close(){},executeComputerCommand:async args=>{calls.push(args);return proof(args.payload);}};
  }});
  await router.executeComputerCommand({nodeId:p.nodeId,action:'start',payload:p,correlationId:'test',timeoutMilliseconds:30000});
  generation=2;
  await router.executeComputerCommand({nodeId:p.nodeId,action:'start',payload:p,correlationId:'test',timeoutMilliseconds:30000});
  assert.deepEqual(connections.map(c=>c.nodeGeneration),[1,2]);assert.deepEqual(calls[0].payload,calls[1].payload);
  await assert.rejects(router.executeComputerCommand({nodeId:randomUUID(),action:'start',payload:p}),{code:'computer_node_mismatch'});
});
test('an authenticated node without computer support is unavailable, not treated as an Android runtime',async()=>{
  const p=payload();
  const router=new ManagedNodeAgentRouter({ localNodeId: p.nodeId,nodeRepository:{findNode:async()=>({nodeId:p.nodeId,generation:1,nodeKey:'aux',lifecycleState:'ready'})},
    connectorFactory:async()=>({startWorker(){},workerHealth(){},workerControl(){},stopWorker(){}})});
  await assert.rejects(router.executeComputerCommand({nodeId:p.nodeId,action:'start',payload:p}),{code:'computer_runtime_unavailable'});
});

test('desktop resolves current node generation and holds the client until stream closes',async()=>{
  const p=payload();p.run.containerId='b'.repeat(64);const connections=[],calls=[];let generation=4,closed=0;
  const router=new ManagedNodeAgentRouter({ localNodeId: p.nodeId,nodeRepository:{findNode:async()=>({nodeId:p.nodeId,generation,nodeKey:'aux',lifecycleState:'ready'})},
    connectorFactory:async route=>{connections.push(route);return {startWorker(){},workerHealth(){},workerControl(){},stopWorker(){},close(){closed++;},
      async connectComputerDesktop(args){calls.push(args);return new PassThrough();}};}});
  for(const kind of ['rdp','console','audio']){
    const stream=await router.connectComputerDesktop({nodeId:p.nodeId,payload:p,kind,signal:new AbortController().signal});
    assert.equal(closed,calls.length-1);const done=once(stream,'close');stream.destroy();await done;generation++;
  }
  assert.equal(closed,3);assert.deepEqual(connections.map(c=>c.nodeGeneration),[4,5,6]);assert.deepEqual(calls[0].payload,calls[1].payload);
  await assert.rejects(router.connectComputerDesktop({nodeId:p.nodeId,payload:p,kind:'arbitrary-port'}));assert.equal(calls.length,3);
});

test('desktop client signs the same exact guest command for console and audio',async()=>{
  const p=payload();p.run.containerId='b'.repeat(64);const signed=[],opened=[];
  const client=new ProtectedNodeAgentClient({nodeId:p.nodeId,nodeGeneration:1,
    transport:{async postCommand(){throw Error('unexpected');},async openComputerDesktop(args){opened.push(args);return args.kind;}},
    commandSigner:{async sign(value){signed.push(value);return {keyId:'test',nonce:'test',signature:'test'};}},
    workerSpecFactory:{async buildStartPayload(){return {};}}});
  for(const kind of ['console','audio'])assert.equal(await client.connectComputerDesktop({payload:p,correlationId:'monitor-audio-test',signal:new AbortController().signal,kind}),kind);
  for(let i=0;i<opened.length;i++){
    assert.equal(opened[i].body,signed[i].body);assert.deepEqual(JSON.parse(opened[i].body).payload,p);
  }
  await assert.rejects(client.connectComputerDesktop({payload:p,kind:'4714'}));assert.equal(opened.length,2);
});
