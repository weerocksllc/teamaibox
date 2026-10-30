// A forward recovery receipt is separate from the original model qualification
// and migration. Neither historical evidence nor node epochs are rewritten.
import { createHash } from 'node:crypto';

export function canonicalRecovery(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRecovery).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalRecovery(value[k])}`).join(',')}}`;
}
const sha = value => `sha256:${createHash('sha256').update(canonicalRecovery(value)).digest('hex')}`;
const digest = /^sha256:[a-f0-9]{64}$/;
const container = /^[a-f0-9]{64}$/;

export const authorityReconciliationRunner = 'teamaibox.main-box-authority-reconciliation.v1';

// A completed model transaction may precede a failed control-container cutover.
// Project only model authority from its independent receipt; this is NOT a
// fabricated accepted runtime capture or a successful deployment assertion.
export function recoveredModelAuthority(predecessor, receipt) {
  return {...predecessor, target:{...predecessor.target,
    nodeGeneration:receipt.nodeGeneration,
    protectedWorkerAuthorities:receipt.workers.map((w,i)=>({
      slot:predecessor.target.protectedWorkerAuthorities[i]?.slot,
      workerId:w.workerId, modelProfileId:w.modelProfileId,
      leaseId:w.leaseId, fencingToken:w.fencingToken,nodeGeneration:receipt.nodeGeneration,
    }))}};
}

export function validateProtectedOfficeGenerationRecovery(receipt, binding, capture, predecessor = null, previousRecovery = null) {
  const fail = () => { throw new TypeError('protected office forward generation recovery drifted'); };
  if (!receipt || !binding || !capture) fail();
  const unsigned = structuredClone(receipt); delete unsigned.evidenceDigest;
  const reconciliation = receipt.schemaVersion === 2 && receipt.runnerId === authorityReconciliationRunner;
  const legacy = receipt.schemaVersion === 1 && receipt.runnerId === 'teamaibox.main-box-generation-recovery.v1';
  if ((!legacy && !reconciliation)
      || receipt.runnerId !== binding.runnerId || receipt.runId !== binding.runId
      || receipt.status !== 'passed' || receipt.evidenceDigest !== binding.evidenceDigest
      || sha(unsigned) !== receipt.evidenceDigest || receipt.nodeId !== capture.target.nodeId
      || !Number.isSafeInteger(receipt.previousGeneration) || receipt.previousGeneration < 1
      || (legacy ? receipt.nodeGeneration !== receipt.previousGeneration + 1
        : !Number.isSafeInteger(receipt.nodeGeneration) || receipt.nodeGeneration <= receipt.previousGeneration)
      || receipt.nodeGeneration !== capture.target.nodeGeneration
      || receipt.desiredStateRevision !== capture.set.desiredStateRevision
      || receipt.maintenanceGeneration !== capture.set.maintenanceGeneration
      || receipt.terminalPhase !== 'complete' || receipt.originalHistoryPreserved !== true
      || receipt.credentialsRetained !== false || receipt.userContentRetained !== false
      || !digest.test(receipt.journalDigest) || !digest.test(receipt.beforeInventoryDigest)
      || !digest.test(receipt.afterInventoryDigest) || !Array.isArray(receipt.workers)
      || receipt.workers.length !== 6 || new Set(receipt.workers.map(w => w.workerId)).size !== 6) fail();
  if (reconciliation) {
    let priorAuthority = predecessor;
    if (receipt.previousRecovery) {
      if (!previousRecovery || previousRecovery.previousRecovery || !predecessor) fail();
      const projection = recoveredModelAuthority(predecessor, previousRecovery);
      validateProtectedOfficeGenerationRecovery(previousRecovery, receipt.previousRecovery, projection, predecessor);
      priorAuthority = projection;
      if (receipt.workers.some((w,i)=> w.previousContainerId !== previousRecovery.workers[i]?.containerId
        || canonicalRecovery(receipt.transition?.payload?.targets?.[i]?.previousTarget)
          !== canonicalRecovery(previousRecovery.transition?.payload?.targets?.[i]?.desiredTarget))) fail();
    } else if (previousRecovery) fail();
    const p = receipt.transition?.payload;
    if (!predecessor || receipt.predecessorCapture?.evidenceDigest !== predecessor.evidenceDigest
        || receipt.predecessorCapture.runId !== predecessor.runId || receipt.predecessorCapture.runnerId !== predecessor.runnerId
        || predecessor.target?.nodeId !== receipt.nodeId || priorAuthority.target.nodeGeneration !== receipt.previousGeneration
        || receipt.desiredStateRevision !== predecessor.set?.desiredStateRevision
        || receipt.maintenanceGeneration !== predecessor.set.maintenanceGeneration
        || receipt.transition?.nodeId !== receipt.nodeId || receipt.transition.nodeGeneration !== receipt.nodeGeneration
        || receipt.transition.phase !== 'complete' || receipt.transition.nextOperation !== 0 || receipt.transition.failureCode
        || p?.setId !== 'office.baseline' || p.transactionId !== receipt.transactionId || p.journalRevision !== receipt.fencingToken
        || p.desiredStateRevision !== receipt.desiredStateRevision || p.maintenanceGeneration !== receipt.maintenanceGeneration
        || p.faultInjection || p.qualificationId || p.migrationPlanId
        || canonicalRecovery(p.allowedOperations) !== canonicalRecovery(['protected-set.transition'])
        || canonicalRecovery(p.operationOrder) !== canonicalRecovery(['protected.inspect','protected.stage','protected.verify','protected.commit'])
        || canonicalRecovery(p.workerIds) !== canonicalRecovery(receipt.workers.map(w => w.workerId))
        || p.targets?.length !== 6 || predecessor.target.protectedWorkerAuthorities?.length !== 6) fail();
    for (const [i, change] of p.targets.entries()) {
      const prior = change.previousTarget, desired = change.desiredTarget, worker = receipt.workers[i];
      if (!prior || !desired || change.legacyPreviousTarget || change.desiredCompanions?.length
          || prior.workerId !== worker.workerId || prior.modelProfileId !== worker.modelProfileId
          || prior.requiredLabels?.['com.teamaibox.node-generation'] !== String(receipt.previousGeneration)
          || desired.requiredLabels?.['com.teamaibox.node-generation'] !== String(receipt.nodeGeneration)
          || canonicalRecovery(worker.before) !== canonicalRecovery(priorAuthority.target.protectedWorkerAuthorities[i])
          || receipt.fencingToken <= worker.before?.fencingToken
          || desired.requiredImageId !== worker.imageId || desired.requiredConfigDigest !== worker.configurationDigest
          || desired.requiredStartSpecDigest !== worker.startSpecDigest
          || change.desiredWorker?.workerId !== worker.workerId || change.desiredWorker.modelProfileId !== worker.modelProfileId
          || change.desiredWorker.image !== desired.requiredImageDigest) fail();
      const normalized = structuredClone(prior);
      normalized.requiredLabels['com.teamaibox.node-generation'] = String(receipt.nodeGeneration);
      if (canonicalRecovery(normalized) !== canonicalRecovery(desired)) fail();
    }
  }
  for (const [index, authority] of capture.target.protectedWorkerAuthorities.entries()) {
    const worker = receipt.workers[index];
    if (!worker || worker.workerId !== authority.workerId || worker.modelProfileId !== authority.modelProfileId
        || worker.leaseId !== authority.leaseId || worker.leaseId !== receipt.transactionId
        || worker.fencingToken !== authority.fencingToken || worker.fencingToken !== receipt.fencingToken
        || !container.test(worker.previousContainerId) || !container.test(worker.containerId)
        || worker.previousContainerId === worker.containerId || !digest.test(worker.imageId)
        || !digest.test(worker.configurationDigest) || !digest.test(worker.startSpecDigest)
        || worker.healthy !== true || worker.modelAndRuntimeUnchanged !== true) fail();
  }
  return receipt;
}
