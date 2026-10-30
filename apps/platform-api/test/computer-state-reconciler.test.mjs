import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ComputerStateReconciler} from '../src/virtual-computers/computer-state-reconciler.mjs';
const computer=()=>({id:randomUUID(),ownerId:randomUUID(),nodeId:randomUUID(),volumeId:randomUUID(),firmwareId:randomUUID(),tpmId:randomUUID(),
  poolId:'computer-pool',generation:1,profile:{id:'windows11',runtimeImage:'sha256:'+'a'.repeat(64)},resources:{vcpus:2,memoryBytes:8*2**30,diskBytes:64*2**30},
  run:{id:randomUUID(),generation:1,containerId:'b'.repeat(64),runtimeImage:'sha256:'+'a'.repeat(64)}});
const reply=p=>({...Object.fromEntries(['computerId','ownerId','nodeId','volumeId','firmwareId','tpmId','operationId','generation'].map(k=>[k,p[k]])),
  runId:p.run.id,runtimeImage:p.runtimeImage,containerId:p.run.containerId,stopped:true,cleanShutdown:false});
test('reconciliation checks the exact installed run without issuing shutdown or recreating it',async()=>{
  const c=computer(),observed=[],calls=[];
  const r=new ComputerStateReconciler({repository:{reconciliationCandidates:async()=>[c],observeRun:async(...args)=>observed.push(args)},
    nodeRouter:{executeComputerCommand:async args=>{calls.push(args);return reply(args.payload);}}});
  await r.runOnce();assert.equal(calls[0].action,'inspect');assert.equal(observed[0][0],c);assert.equal(observed[0][1].stopped,true);
  assert.equal(observed[0][1].cleanShutdown,false);assert.equal(calls.length,1);
});
test('network failure, missing container identity and mismatched replies never become stopped evidence',async()=>{
  const c=computer();let mode='network',result;
  const r=new ComputerStateReconciler({repository:{reconciliationCandidates:async()=>[c],observeRun:async(_,value)=>{result=value;}},
    nodeRouter:{executeComputerCommand:async({payload})=>{
      if(mode==='network')throw Error('disconnected');
      return {...reply(payload),containerId:mode==='missing'?undefined:'c'.repeat(64)};
    }}});
  for(mode of ['network','missing','foreign']){await r.runOnce();assert.equal(result,null);}
});
test('stopping the observer ignores late network results, does not release or stop a guest',async()=>{
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});const values=[];
  const r=new ComputerStateReconciler({repository:{reconciliationCandidates:async()=>[computer()],observeRun:async(...args)=>values.push(args)},
    nodeRouter:{executeComputerCommand:args=>{entered();return new Promise(resolve=>{release=()=>resolve(reply(args.payload));});}}});
  const pending=r.runOnce();await waiting;const stopped=r.stop();release();await Promise.all([pending,stopped]);assert.deepEqual(values,[]);
});
