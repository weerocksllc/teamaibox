import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ComputerOperationWorker} from '../src/virtual-computers/computer-operation-worker.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(action='start'){
  const id=randomUUID(),ownerId=randomUUID(),nodeId=randomUUID(),runtimeImage='sha256:'+'a'.repeat(64);
  const op={id:randomUUID(),computerId:id,ownerId,action,generation:1,claimId:randomUUID(),command:{computerId:id,ownerId,nodeId,
    poolId:'windows-pool',volumeId:randomUUID(),firmwareId:randomUUID(),tpmId:randomUUID(),generation:1,
    profile:{id:'windows11-arm64',runtimeImage},resources:{vcpus:4,memoryBytes:8*1024**3,diskBytes:96*1024**3},
    run:{id:randomUUID(),generation:1,containerId:null,runtimeImage}}};
  const calls=[],runtime={execute:async({payload})=>({...Object.fromEntries(['computerId','ownerId','nodeId','volumeId','firmwareId','tpmId','generation'].map(k=>[k,payload[k]])),
    operationId:op.id,runId:payload.run.id,runtimeImage,running:true,containerId:'b'.repeat(64)})};
  const repository={claimNext:async()=>op,renew:async()=>true,
    complete:async(...args)=>{calls.push(['complete',...args]);return {state:'succeeded'};},
    retry:async(...args)=>{calls.push(['retry',...args]);return true;}};
  const releaseResources=async()=>{};
  return {op,calls,runtime,repository,releaseResources,leaseMs:90,pollMs:10};
}
test('durable queue worker executes exact persisted operation then commits confirmed result',async()=>{
  const f=fixture(),worker=new ComputerOperationWorker(f),r=await worker.runOnce();
  assert.equal(r.state,'succeeded');assert.equal(f.calls[0][1],f.op);
  assert.equal(f.calls[0][2].runId,f.op.command.run.id);
  assert.equal(f.calls[0][3].releaseResources,f.releaseResources);
});
test('no queued operation produces no node request',async()=>{
  const f=fixture();f.repository.claimNext=async()=>null;f.runtime.execute=async()=>assert.fail('unexpected node call');
  assert.deepEqual(await new ComputerOperationWorker(f).runOnce(),{processed:0});
});
test('transport errors and invalid run results retry the original operation without releasing capacity',async()=>{
  for(const mode of ['transport','wrong-run']){
    const f=fixture(),original=f.runtime.execute;
    f.runtime.execute=async input=>{if(mode==='transport')throw Error('secret-password=must-not-persist');return {...await original(input),runId:randomUUID()};};
    const result=await new ComputerOperationWorker(f).runOnce();
    assert.equal(result.state,'retrying');assert.deepEqual(f.calls,[['retry',f.op]]);
    assert.equal(JSON.stringify(result).includes('secret-password'),false);
  }
});
test('a long-running request renews its claim and a second local poll does not dispatch twice',async()=>{
  const f=fixture(),entered=deferred(),finish=deferred(),renewed=deferred(),original=f.runtime.execute;
  let executions=0;
  f.repository.renew=async()=>{renewed.resolve();return true;};
  f.runtime.execute=async input=>{executions++;entered.resolve();await finish.promise;return original(input);};
  const worker=new ComputerOperationWorker(f),a=worker.runOnce();await entered.promise;
  const b=worker.runOnce();assert.equal(a,b);await renewed.promise;finish.resolve();
  assert.equal((await a).state,'succeeded');assert.equal(executions,1);
});
test('loss of a claim aborts waiting; a late node reply cannot commit or release resources',async()=>{
  const f=fixture(),finish=deferred(),original=f.runtime.execute;let signal;
  f.repository.renew=async()=>false;
  f.runtime.execute=async input=>{signal=input.signal;await finish.promise;return original(input);};
  const worker=new ComputerOperationWorker(f);
  assert.equal((await worker.runOnce()).state,'retrying');assert.equal(signal.aborted,true);
  finish.resolve();await Promise.resolve();assert.deepEqual(f.calls,[]);
});
test('stopping the API worker preserves the guest and does not wait for an unresponsive transport',async()=>{
  const f=fixture(),entered=deferred();
  f.runtime.execute=async({signal})=>{entered.resolve(signal);return new Promise(()=>{});};
  const worker=new ComputerOperationWorker(f),running=worker.runOnce(),signal=await entered.promise;
  await worker.stop();assert.equal(signal.aborted,true);assert.equal((await running).state,'retrying');assert.deepEqual(f.calls,[]);
});
test('shutdown while a database claim is pending never dispatches a new node operation',async()=>{
  const f=fixture(),claim=deferred();f.repository.claimNext=()=>claim.promise;f.runtime.execute=()=>assert.fail('dispatched after stopping');
  const worker=new ComputerOperationWorker(f),running=worker.runOnce(),stopped=worker.stop();
  claim.resolve(f.op);await stopped;assert.equal((await running).state,'retrying');assert.deepEqual(f.calls,[]);
});
