import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {canonicalRecovery, authorityReconciliationRunner, recoveredModelAuthority, validateProtectedOfficeGenerationRecovery as validate} from '../server/protected-office-generation-recovery.mjs';
const sha = n => `sha256:${String(n).repeat(64)}`;
const id = n => `00000000-0000-5000-8000-${String(n).padStart(12,'0')}`;
const hash = v => `sha256:${createHash('sha256').update(canonicalRecovery(v)).digest('hex')}`;
function fixture() {
  const before = Array.from({length:6}, (_,i) => ({slot:`slot-${i}`,workerId:id(i+1),modelProfileId:id(i+11),leaseId:id(30),fencingToken:100,nodeGeneration:5}));
  const predecessor = {runnerId:'capture',runId:'old-capture',evidenceDigest:sha(1),target:{nodeId:id(90),nodeGeneration:5,protectedWorkerAuthorities:before},set:{desiredStateRevision:149,maintenanceGeneration:1}};
  const capture = structuredClone(predecessor);
  capture.target.nodeGeneration=8;
  for (const a of capture.target.protectedWorkerAuthorities) Object.assign(a,{leaseId:id(31),fencingToken:101,nodeGeneration:8});
  const targets=before.map(a=>{
    const previousTarget={workerId:a.workerId,modelProfileId:a.modelProfileId,requiredImageId:sha(2),requiredImageDigest:`registry.local/model@${sha(3)}`,requiredConfigDigest:sha(4),requiredStartSpecDigest:sha(5),requiredLabels:{'com.teamaibox.node-generation':'5'}};
    const desiredTarget=structuredClone(previousTarget);desiredTarget.requiredLabels['com.teamaibox.node-generation']='8';
    return {previousTarget,desiredTarget,desiredWorker:{workerId:a.workerId,modelProfileId:a.modelProfileId,image:desiredTarget.requiredImageDigest}};
  });
  const receipt={schemaVersion:2,runnerId:authorityReconciliationRunner,runId:'authority-reconciliation-test-a1',status:'passed',nodeId:id(90),previousGeneration:5,nodeGeneration:8,transactionId:id(31),fencingToken:101,desiredStateRevision:149,maintenanceGeneration:1,terminalPhase:'complete',originalHistoryPreserved:true,credentialsRetained:false,userContentRetained:false,journalDigest:sha(6),beforeInventoryDigest:sha(7),afterInventoryDigest:sha(8),predecessorCapture:{path:'evidence/validation/old.json',runnerId:predecessor.runnerId,runId:predecessor.runId,evidenceDigest:predecessor.evidenceDigest},
    transition:{nodeId:id(90),nodeGeneration:8,phase:'complete',nextOperation:0,payload:{setId:'office.baseline',transactionId:id(31),journalRevision:101,desiredStateRevision:149,maintenanceGeneration:1,workerIds:before.map(a=>a.workerId),allowedOperations:['protected-set.transition'],operationOrder:['protected.inspect','protected.stage','protected.verify','protected.commit'],targets}},
    workers:before.map((a,i)=>({before:structuredClone(a),workerId:a.workerId,modelProfileId:a.modelProfileId,leaseId:id(31),fencingToken:101,previousContainerId:String(i+1).repeat(64),containerId:String(i+2).repeat(64),imageId:sha(2),configurationDigest:sha(4),startSpecDigest:sha(5),healthy:true,modelAndRuntimeUnchanged:true}))};
  const stamp=()=>{delete receipt.evidenceDigest;receipt.evidenceDigest=hash(receipt);return {runnerId:receipt.runnerId,runId:receipt.runId,evidenceDigest:receipt.evidenceDigest};};
  return {receipt,capture,predecessor,stamp};
}
test('actual 5 to 8 reconciliation requires completed exact six-model transition and predecessor',()=>{
  const f=fixture();assert.equal(validate(f.receipt,f.stamp(),f.capture,f.predecessor),f.receipt);
});
for(const [name,mutate] of [
  ['legacy cannot skip',f=>{f.receipt.schemaVersion=1;f.receipt.runnerId='teamaibox.main-box-generation-recovery.v1';}],
  ['missing predecessor',f=>f.predecessor=null],
  ['wrong predecessor',f=>f.receipt.predecessorCapture.evidenceDigest=sha(9)],
  ['unfinished native transaction',f=>f.receipt.transition.phase='staging'],
  ['wrong transaction',f=>f.receipt.transition.payload.transactionId=id(32)],
  ['desired model set changed',f=>f.receipt.desiredStateRevision=150],
  ['non-increasing fence',f=>f.receipt.fencingToken=100],
  ['mixed source generation',f=>f.receipt.transition.payload.targets[0].previousTarget.requiredLabels['com.teamaibox.node-generation']='6'],
  ['model change',f=>f.receipt.transition.payload.targets[0].desiredTarget.requiredImageId=sha(9)],
  ['unchanged container',f=>f.receipt.workers[0].containerId=f.receipt.workers[0].previousContainerId],
  ['old authority',f=>f.receipt.workers[0].before.fencingToken=99],
  ['fault injection',f=>f.receipt.transition.payload.faultInjection={fault:'stop'}],
  ['reordered targets',f=>f.receipt.transition.payload.targets.reverse()],
]) test(`rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>validate(f.receipt,f.stamp(),f.capture,f.predecessor));});

function partialCutoverFixture() {
  const f=fixture(); const previous=structuredClone(f.receipt);
  previous.evidenceDigest=hash(previous);
  const projection=recoveredModelAuthority(f.predecessor,previous);
  f.receipt.previousRecovery={path:'evidence/validation/partial-model-recovery.json',runnerId:previous.runnerId,runId:previous.runId,evidenceDigest:previous.evidenceDigest};
  f.receipt.previousGeneration=8;f.receipt.nodeGeneration=9;
  f.receipt.fencingToken=102;f.receipt.transactionId=id(32);
  f.receipt.transition.nodeGeneration=9;
  Object.assign(f.receipt.transition.payload,{transactionId:id(32),journalRevision:102});
  f.receipt.transition.payload.targets.forEach((t,i)=>{
    t.previousTarget=structuredClone(previous.transition.payload.targets[i].desiredTarget);
    t.desiredTarget.requiredLabels['com.teamaibox.node-generation']='9';
  });
  f.receipt.workers.forEach((w,i)=>Object.assign(w,{before:projection.target.protectedWorkerAuthorities[i],previousContainerId:previous.workers[i].containerId,containerId:String(i+3).repeat(64),leaseId:id(32),fencingToken:102}));
  f.capture=recoveredModelAuthority(f.predecessor,f.receipt);
  return {...f,previous};
}
test('continues only a separately completed model transaction after failed control cutover',()=>{
  const f=partialCutoverFixture();assert.equal(validate(f.receipt,f.stamp(),f.capture,f.predecessor,f.previous),f.receipt);
});
for (const [name,mutate] of [
  ['missing component',f=>f.previous=null],
  ['unfinished component',f=>{f.previous.transition.phase='staging';delete f.previous.evidenceDigest;f.previous.evidenceDigest=hash(f.previous);f.receipt.previousRecovery.evidenceDigest=f.previous.evidenceDigest;}],
  ['different actual prior container',f=>f.receipt.workers[0].previousContainerId='9'.repeat(64)],
  ['different component model',f=>f.receipt.transition.payload.targets[0].previousTarget.requiredImageId=sha(9)],
]) test(`partial cutover rejects ${name}`,()=>{const f=partialCutoverFixture();mutate(f);assert.throws(()=>validate(f.receipt,f.stamp(),f.capture,f.predecessor,f.previous));});
