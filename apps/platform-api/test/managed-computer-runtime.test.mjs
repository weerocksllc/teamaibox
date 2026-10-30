import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ManagedComputerRuntime} from '../src/virtual-computers/managed-computer-runtime.mjs';
import {computerCommand} from '../../../services/scheduler/src/computer-command.mjs';

function fixture(action='start') {
  const calls=[],computer={id:randomUUID(),ownerId:randomUUID(),nodeId:randomUUID(),poolId:'windows-pool',
    volumeId:randomUUID(),firmwareId:randomUUID(),tpmId:randomUUID(),generation:action==='create'?0:1,
    profile:{id:'windows11-arm64',runtimeImage:'sha256:'+'a'.repeat(64)},
    resources:{vcpus:4,memoryBytes:8*1024**3,diskBytes:128*1024**3},
    state:{start:'starting',create:'creating',shutdown:'stopping',delete:'deleting'}[action],run:null};
  if(['start','shutdown'].includes(action))computer.run={id:randomUUID(),generation:1,runtimeImage:computer.profile.runtimeImage,
    containerId:action==='shutdown'?'b'.repeat(64):null};
  const {id,state,...command}=computer;
  const operation={id:randomUUID(),computerId:id,ownerId:computer.ownerId,generation:computer.generation,action,command:{computerId:id,...command}};
  const payload=computerCommand(operation),identity=Object.fromEntries(['computerId','ownerId','nodeId','volumeId','firmwareId','tpmId','operationId','generation'].map(k=>[k,payload[k]]));
  const result={...identity,...({create:{provisioned:true,encryption:'luks2'},delete:{dataDeleted:true},
    start:{running:true,containerId:'b'.repeat(64),runId:computer.run?.id,runtimeImage:computer.profile.runtimeImage},
    shutdown:{stopped:true,cleanShutdown:true,containerId:computer.run?.containerId,runId:computer.run?.id,runtimeImage:computer.profile.runtimeImage}}[action])};
  const reservation={id:computer.run?.id,computer_id:computer.id,owner_id:computer.ownerId,node_id:computer.nodeId,
    generation:computer.generation,state:'active',memory_bytes:String(10*1024**3),cpu_ids:[10,11,12,13]};
  const repository={get:async(owner,id)=>{calls.push(['get',owner,id]);return structuredClone(computer);}},
    capacity={acquireRun:async value=>{calls.push(['reserve',value]);return structuredClone(reservation);}},
    nodeRouter={executeComputerCommand:async value=>{calls.push(['dispatch',value]);return result;}};
  const make=()=>new ManagedComputerRuntime({repository,capacity,nodeRouter,timeoutMilliseconds:30000});
  return {computer,operation,payload,result,calls,repository,capacity,nodeRouter,reservation,make};
}
test('startup reserves shared resources before dispatch using exact persisted identities',async()=>{
  const f=fixture();assert.deepEqual(await f.make().execute(f),f.result);
  assert.deepEqual(f.calls.map(c=>c[0]),['get','reserve','dispatch']);
  assert.deepEqual(f.calls[2][1],{nodeId:f.computer.nodeId,action:'start',payload:{...f.payload,
    allocation:{memoryBytes:10*1024**3,cpuIds:[10,11,12,13]}},correlationId:f.operation.id,timeoutMilliseconds:30000});
});
test('missing, foreign, released or malformed reservation cannot reach the auxiliary box',async()=>{
  for(const key of ['id','computer_id','owner_id','node_id','generation','state','memory_bytes','cpu_ids']){
    const f=fixture();f.reservation[key]=key==='cpu_ids'?[1,1,2,3]:'wrong';
    await assert.rejects(f.make().execute(f));assert.equal(f.calls.some(c=>c[0]==='dispatch'),false);
  }
});
test('create, clean shutdown and deletion do not allocate another runtime or release locally',async()=>{
  for(const action of ['create','shutdown','delete']){
    const f=fixture(action);assert.deepEqual(await f.make().execute(f),f.result);
    assert.deepEqual(f.calls.map(c=>c[0]),['get','dispatch']);
  }
});
test('stale operation or changed owner/disk/profile/run cannot dispatch',async()=>{
  for(const key of ['id','ownerId','nodeId','volumeId','firmwareId','tpmId','profile','resources','generation','run','state']){
    const f=fixture();f.computer[key]=key==='generation'?2:key==='profile'?{...f.computer.profile,runtimeImage:'sha256:'+'c'.repeat(64)}:'changed';
    await assert.rejects(f.make().execute(f),/computer_operation_mismatch/);
    assert.deepEqual(f.calls.map(c=>c[0]),['get']);
  }
  const f=fixture();f.payload.volumeId=randomUUID();await assert.rejects(f.make().execute(f),/computer_operation_mismatch/);assert.equal(f.calls.length,0);
});
test('capacity/transport failures never become successful rejection or free uncertain reservations',async()=>{
  for(const step of ['reserve','dispatch']){
    const f=fixture(),error=Error('unavailable');
    if(step==='reserve')f.capacity.acquireRun=async()=>{throw error;};
    else f.nodeRouter.executeComputerCommand=async()=>{throw error;};
    await assert.rejects(f.make().execute(f),e=>e===error);
    assert.equal(f.calls.some(c=>c[0]==='release'),false);
  }
});
test('node rejection must carry no-effect proof; mismatched response remains uncertain',async()=>{
  const f=fixture();f.nodeRouter.executeComputerCommand=async()=>({...f.result,runId:randomUUID()});
  await assert.rejects(f.make().execute(f),{code:'node_agent_protocol_mismatch'});
});
test('proven never-allocated capacity refusal finishes without dispatch',async()=>{
  const f=fixture();Object.assign(f.reservation,{state:'rejected',noSideEffects:true,errorCode:'computer_capacity_unavailable'});
  const result=await f.make().execute(f);
  assert.equal(result.rejected,true);assert.equal(result.noSideEffects,true);assert.equal(result.errorCode,'computer_capacity_unavailable');
  assert.deepEqual(f.calls.map(c=>c[0]),['get','reserve']);
});
test('foreign or unproven capacity refusal remains uncertain',async()=>{
  for(const field of ['id','computer_id','owner_id','node_id','generation','noSideEffects','errorCode']) {
    const f=fixture();Object.assign(f.reservation,{state:'rejected',noSideEffects:true,errorCode:'computer_capacity_unavailable'});
    f.reservation[field]=field==='noSideEffects'?false:'wrong';
    await assert.rejects(f.make().execute(f),/computer_reservation_mismatch/);
    assert.equal(f.calls.some(c=>c[0]==='dispatch'),false);
  }
});
test('claim lost before or during admission prevents a new dispatch',async()=>{
  for(const during of [false,true]){
    const f=fixture(),controller=new AbortController();
    if(during)f.capacity.acquireRun=async()=>controller.abort();else controller.abort();
    await assert.rejects(f.make().execute({...f,signal:controller.signal}),{name:'AbortError'});
    assert.equal(f.calls.some(c=>c[0]==='dispatch'),false);
  }
});
test('late response after claim loss cannot be committed by this adapter',async()=>{
  const f=fixture(),controller=new AbortController();
  f.nodeRouter.executeComputerCommand=async()=>{controller.abort();return f.result;};
  await assert.rejects(f.make().execute({...f,signal:controller.signal}),{name:'AbortError'});
});
test('retry dispatch keeps the same operation/run while transport can resolve a new node connection',async()=>{
  const f=fixture(),runtime=f.make();await runtime.execute(f);await runtime.execute(f);
  const commands=f.calls.filter(c=>c[0]==='dispatch').map(c=>c[1]);assert.deepEqual(commands[0],commands[1]);
});
