import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalRecovery } from '../server/protected-office-generation-recovery.mjs';
import { runtimeMaintenanceRunner, validateRuntimeMaintenance } from '../server/protected-office-runtime-maintenance.mjs';
const hash = x => `sha256:${createHash('sha256').update(canonicalRecovery(x)).digest('hex')}`;
const id = n => `00000000-0000-5000-8000-${String(n).padStart(12,'0')}`;
const sha = n => `sha256:${String(n).repeat(64)}`;
function fixture() {
  const authorities = Array.from({length:6}, (_,i) => ({slot:`slot-${i}`, workerId:id(i+1), modelProfileId:id(i+11), leaseId:id(30), fencingToken:100, nodeGeneration:4}));
  const predecessor = {schemaVersion:2, runnerId:'capture', runId:'old-capture', evidenceDigest:sha(1), target:{nodeId:id(90),nodeGeneration:4,protectedWorkerAuthorities:authorities},set:{desiredStateRevision:138,maintenanceGeneration:1}};
  const capture = structuredClone(predecessor); capture.schemaVersion=3; capture.set.desiredStateRevision=139;
  Object.assign(capture.target.protectedWorkerAuthorities[2], {modelProfileId:id(80),leaseId:id(31),fencingToken:101});
  const targets = authorities.map((a,i) => {
    const previousTarget = {workerId:a.workerId,modelProfileId:a.modelProfileId,requiredImageId:sha(2),requiredConfigDigest:sha(3),requiredStartSpecDigest:sha(4),requiredImageDigest:`registry.local/ocr@${sha(5)}`};
    const desiredTarget=structuredClone(previousTarget);
    if(i===2) Object.assign(desiredTarget,{modelProfileId:id(80),requiredImageId:sha(6)});
    return {previousTarget,desiredTarget,desiredWorker:{workerId:a.workerId,modelProfileId:desiredTarget.modelProfileId,image:desiredTarget.requiredImageDigest}};
  });
  const receipt={schemaVersion:1,runnerId:runtimeMaintenanceRunner,runId:'runtime-maintenance-test-a1',status:'passed',nodeId:id(90),nodeGeneration:4,desiredStateRevision:139,maintenanceGeneration:1,originalHistoryPreserved:true,credentialsRetained:false,userContentRetained:false,
    predecessorCapture:{path:'evidence/validation/old.json',runnerId:predecessor.runnerId,runId:predecessor.runId,evidenceDigest:predecessor.evidenceDigest},
    transition:{phase:'complete',nextOperationIndex:0,planDigest:sha(7),payload:{transactionId:id(31),setId:'office.baseline',desiredStateRevision:139,maintenanceGeneration:1,journalRevision:101,workerIds:authorities.map(a=>a.workerId),allowedOperations:['protected-set.transition'],operationOrder:['protected.inspect','protected.stage','protected.verify','protected.commit'],targets}},
    workers: authorities.map((a,i)=>({before:structuredClone(a),after:structuredClone(capture.target.protectedWorkerAuthorities[i]),beforeContainerId:String(i+1).repeat(64),containerId:String(i===2?9:i+1).repeat(64),imageId:targets[i].desiredTarget.requiredImageId,configurationDigest:sha(3),startSpecDigest:sha(4),healthy:true}))};
  const stamp=()=>{delete receipt.evidenceDigest;receipt.evidenceDigest=hash(receipt);return {path:'evidence/validation/receipt.json',runnerId:receipt.runnerId,runId:receipt.runId,evidenceDigest:receipt.evidenceDigest};};
  return {receipt,capture,predecessor,stamp};
}
test('runtime maintenance preserves five authorities and advances only replaced Worker',()=>{
  const f=fixture(); assert.equal(validateRuntimeMaintenance(f.receipt,f.stamp(),f.capture,f.predecessor),f.receipt);
});
for(const [name, mutate] of [
  ['old revision',f=>f.receipt.desiredStateRevision=138],
  ['node epoch change',f=>f.capture.target.nodeGeneration=5],
  ['unfinished Agent transition',f=>f.receipt.transition.phase='staging'],
  ['stale OCR authority',f=>f.capture.target.protectedWorkerAuthorities[2].leaseId=id(30)],
  ['unreported other Worker restart',f=>f.receipt.workers[0].containerId='a'.repeat(64)],
  ['missing member',f=>f.receipt.transition.payload.targets.pop()],
  ['wrong predecessor',f=>f.receipt.predecessorCapture.evidenceDigest=sha(9)],
]) test(`rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>validateRuntimeMaintenance(f.receipt,f.stamp(),f.capture,f.predecessor),/drifted/);});
