import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newComputer,beginComputerOperation,completeComputerOperation,createInput,actionInput,publicComputer} from '../src/virtual-computers/lifecycle.mjs';

export const profile={id:'windows11-arm64-test',name:'Windows 11',version:'test',edition:'Pro',
  runtimeImage:'sha256:'+'a'.repeat(64),mediaDigest:'sha256:'+'b'.repeat(64),firmwareDigest:'sha256:'+'c'.repeat(64),
  driverDigest:'sha256:'+'d'.repeat(64),minimum:{vcpus:2,memoryGiB:4,diskGiB:64},tpm:true,secureBoot:true,remoteDesktop:true,
  rights:{activationRequired:true,redistributionAllowed:false}};
const fresh=()=>newComputer({ownerId:randomUUID(),nodeId:randomUUID(),poolId:'test-pool',profile,
  input:{name:'我的电脑',profileId:profile.id,resources:{vcpus:4,memoryGiB:8,diskGiB:128}},policy:{}});
const proof=(op,extra={})=>({...op.command,operationId:op.id,...extra});
const provision=()=>{
  const {computer,operation}=beginComputerOperation(fresh(),'create');
  return completeComputerOperation(computer,operation,proof(operation,{provisioned:true,encryption:'luks2'}));
};
function running(){
  const c=provision(), {computer,operation}=beginComputerOperation(c,'start',{expectedRevision:c.revision});
  return completeComputerOperation(computer,operation,proof(operation,{running:true,runId:computer.run.id,
    runtimeImage:profile.runtimeImage,containerId:'e'.repeat(64)}));
}
test('profile, disk, firmware and TPM remain pinned throughout shutdown and a new run',()=>{
  const c=running(), stopped=beginComputerOperation(c,'shutdown',{expectedRevision:c.revision});
  const result=completeComputerOperation(stopped.computer,stopped.operation,proof(stopped.operation,{
    stopped:true,cleanShutdown:true,runId:c.run.id,containerId:c.run.containerId}));
  assert.equal(result.run,null);
  const next=beginComputerOperation(result,'start',{expectedRevision:result.revision});
  for(const key of ['id','nodeId','volumeId','firmwareId','tpmId','profile','resources']) assert.deepEqual(next.computer[key],c[key]);
  assert.notEqual(next.computer.run.id,c.run.id);assert.equal(next.computer.generation,c.generation+1);
});
test('installed runtime maintenance changes only a stopped next run, never guest contents or history',()=>{
  const c=provision(),before=structuredClone(c),update={from:profile.runtimeImage,to:'sha256:'+'f'.repeat(64)};
  const next=beginComputerOperation(c,'start',{expectedRevision:c.revision},{runtimeUpdate:update});
  assert.deepEqual(c,before);
  for(const key of ['id','ownerId','nodeId','volumeId','firmwareId','tpmId','resources'])assert.deepEqual(next.computer[key],c[key]);
  assert.deepEqual(next.computer.profile,{...c.profile,runtimeImage:update.to});
  assert.equal(next.operation.command.profile.runtimeImage,update.to);
  assert.equal(next.computer.run.runtimeImage,update.to);
  assert.throws(()=>beginComputerOperation(running(),'start',{expectedRevision:4},{runtimeUpdate:update}));
  assert.throws(()=>beginComputerOperation(c,'start',{expectedRevision:c.revision},{runtimeUpdate:{...update,from:'sha256:'+'0'.repeat(64)}}),{code:'computer_profile_unavailable'});
  assert.throws(()=>actionInput('start',{expectedRevision:c.revision,runtimeUpdate:update}),{code:'computer_input_invalid'});
});
test('runtime maintenance accepts every explicitly published predecessor and rejects unknown images',()=>{
  const intermediate='sha256:'+'e'.repeat(64),target='sha256:'+'f'.repeat(64);
  const update={from:[profile.runtimeImage,intermediate],to:target};
  for(const source of update.from){
    const c={...provision(),profile:{...profile,runtimeImage:source}};
    const next=beginComputerOperation(c,'start',{expectedRevision:c.revision},{runtimeUpdate:update});
    assert.equal(next.computer.profile.runtimeImage,target);
  }
  const c=provision();c.profile.runtimeImage='sha256:'+'0'.repeat(64);
  assert.throws(()=>beginComputerOperation(c,'start',{expectedRevision:c.revision},{runtimeUpdate:update}),{code:'computer_profile_unavailable'});
});
test('delete requires an explicit confirmation and a confirmed stopped guest',()=>{
  const c=running();assert.throws(()=>beginComputerOperation(c,'delete',{expectedRevision:c.revision,confirmDelete:true}),{code:'computer_stop_required'});
  const stopped=provision();assert.throws(()=>beginComputerOperation(stopped,'delete',{expectedRevision:stopped.revision}),{code:'computer_input_invalid'});
  const op=beginComputerOperation(stopped,'delete',{expectedRevision:stopped.revision,confirmDelete:true});
  assert.throws(()=>completeComputerOperation(op.computer,op.operation,proof(op.operation,{dataDeleted:false})),{code:'computer_result_mismatch'});
  assert.equal(completeComputerOperation(op.computer,op.operation,proof(op.operation,{dataDeleted:true})).state,'deleted');
});
test('a socket closure or forced kill is not proof of graceful shutdown',()=>{
  const c=running(),op=beginComputerOperation(c,'shutdown',{expectedRevision:c.revision});
  for(const extra of [{},{stopped:true},{stopped:true,cleanShutdown:false,runId:c.run.id,containerId:c.run.containerId}]) {
    assert.throws(()=>completeComputerOperation(op.computer,op.operation,proof(op.operation,extra)),{code:'computer_result_mismatch'});
    assert.equal(op.computer.run.id,c.run.id);
  }
});
test('late results from an old run, disk or owner cannot change current state',()=>{
  const c=provision(),op=beginComputerOperation(c,'start',{expectedRevision:c.revision});
  const good=proof(op.operation,{running:true,runId:op.computer.run.id,runtimeImage:profile.runtimeImage,containerId:'e'.repeat(64)});
  for(const key of ['computerId','ownerId','nodeId','volumeId','firmwareId','tpmId','operationId','runId','runtimeImage']) {
    assert.throws(()=>completeComputerOperation(op.computer,op.operation,{...good,[key]:randomUUID()}),{code:'computer_result_mismatch'},key);
  }
});
test('requests cannot supply node paths, guest credentials or replace a system on an existing computer',()=>{
  assert.throws(()=>createInput({name:'pc',profileId:'win',resources:{vcpus:2,memoryGiB:4,diskGiB:64},password:'hidden'}),{code:'computer_input_invalid'});
  assert.throws(()=>actionInput('start',{expectedRevision:1,profileId:'another'}),{code:'computer_input_invalid'});
  assert.throws(()=>actionInput('delete',{expectedRevision:1,confirmDelete:'true'}),{code:'computer_input_invalid'});
});
test('stored metadata is not aliased to the mutable imported profile or caller objects',()=>{
  const c=fresh(),o=beginComputerOperation(c,'create');o.computer.profile.name='changed';
  assert.equal(c.profile.name,'Windows 11');assert.equal(o.operation.command.profile.name,'Windows 11');
});
test('stale clicks cannot start or delete a different revision',()=>{
  const c=provision();assert.throws(()=>beginComputerOperation(c,'start',{expectedRevision:c.revision-1}),{code:'computer_state_conflict'});
});
test('member data does not expose host identifiers or implementation jargon',()=>{
  const value=publicComputer(running());assert.equal(value.system.name,'Windows 11');
  for(const key of ['nodeId','volumeId','firmwareId','tpmId','run','runtimeImage','ownerId']) assert.equal(value[key],undefined);
  assert.equal(value.closePageStopsComputer,false);
});
test('explicit no-effect capacity rejection permits retry; uncertain errors keep the original run',()=>{
  const c=provision(),pending=beginComputerOperation(c,'start',{expectedRevision:c.revision});
  const rejected=proof(pending.operation,{rejected:true,noSideEffects:true,errorCode:'computer_capacity_unavailable'});
  assert.throws(()=>completeComputerOperation(pending.computer,pending.operation,{...rejected,noSideEffects:false}),{code:'computer_result_mismatch'});
  const stopped=completeComputerOperation(pending.computer,pending.operation,rejected);
  assert.equal(stopped.state,'stopped');assert.equal(stopped.run,null);assert.equal(stopped.volumeId,c.volumeId);
  const retry=beginComputerOperation(stopped,'start',{expectedRevision:stopped.revision});
  assert.notEqual(retry.computer.run.id,pending.computer.run.id);
});
