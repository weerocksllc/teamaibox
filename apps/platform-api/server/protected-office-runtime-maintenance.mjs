// A runtime update advances the protected-set revision, not the node epoch.
// Keep the previous boot receipt intact and bind the *completed* Agent
// transaction before accepting new Worker authorities on a Platform restart.
import { createHash } from 'node:crypto';
import { canonicalRecovery } from './protected-office-generation-recovery.mjs';

const sha = value => `sha256:${createHash('sha256').update(canonicalRecovery(value)).digest('hex')}`;
const same = (a, b) => canonicalRecovery(a) === canonicalRecovery(b);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const cid = /^[a-f0-9]{64}$/;
export const runtimeMaintenanceRunner = 'teamaibox.protected-office-runtime-maintenance.v1';

export function validateRuntimeMaintenance(receipt, binding, capture, predecessor) {
  const fail = () => { throw new TypeError('protected office runtime maintenance receipt drifted'); };
  if (!receipt || !binding || !capture || !predecessor) fail();
  const unsigned = structuredClone(receipt); delete unsigned.evidenceDigest;
  const payload = receipt.transition?.payload;
  if (receipt.schemaVersion !== 1 || receipt.runnerId !== runtimeMaintenanceRunner
      || receipt.runnerId !== binding.runnerId || receipt.runId !== binding.runId
      || receipt.status !== 'passed' || sha(unsigned) !== receipt.evidenceDigest
      || receipt.evidenceDigest !== binding.evidenceDigest
      || receipt.nodeId !== capture.target.nodeId || receipt.nodeGeneration !== capture.target.nodeGeneration
      || receipt.nodeId !== predecessor.target.nodeId || receipt.nodeGeneration !== predecessor.target.nodeGeneration
      || !same(receipt.predecessorCapture, {
        ...receipt.predecessorCapture, runnerId: predecessor.runnerId, runId: predecessor.runId,
        evidenceDigest: predecessor.evidenceDigest,
      })
      || !Number.isSafeInteger(receipt.desiredStateRevision)
      || receipt.desiredStateRevision <= predecessor.set.desiredStateRevision
      || receipt.desiredStateRevision !== capture.set.desiredStateRevision
      || receipt.maintenanceGeneration !== capture.set.maintenanceGeneration
      || receipt.maintenanceGeneration < predecessor.set.maintenanceGeneration
      || receipt.credentialsRetained !== false || receipt.userContentRetained !== false
      || receipt.originalHistoryPreserved !== true
      || receipt.transition?.phase !== 'complete' || receipt.transition?.nextOperationIndex !== 0
      || !digest.test(receipt.transition?.planDigest ?? '')
      || !uuid.test(payload?.transactionId ?? '') || payload?.setId !== 'office.baseline'
      || payload?.desiredStateRevision !== receipt.desiredStateRevision
      || payload?.maintenanceGeneration !== receipt.maintenanceGeneration
      || !Number.isSafeInteger(payload?.journalRevision) || payload.journalRevision < 1
      || !same(payload.allowedOperations, ['protected-set.transition'])
      || !same(payload.operationOrder, ['protected.inspect', 'protected.stage', 'protected.verify', 'protected.commit'])
      || !Array.isArray(payload.targets) || payload.targets.length !== 6
      || !Array.isArray(receipt.workers) || receipt.workers.length !== 6
      || predecessor.target.protectedWorkerAuthorities.length !== 6
      || capture.target.protectedWorkerAuthorities.length !== 6
      || new Set(payload.workerIds).size !== 6) fail();
  for (const [index, after] of capture.target.protectedWorkerAuthorities.entries()) {
    const before = predecessor.target.protectedWorkerAuthorities[index];
    const worker = receipt.workers[index];
    const target = payload.targets[index];
    if (!before || !worker || !target || before.slot !== after.slot || before.workerId !== after.workerId
        || payload.workerIds[index] !== after.workerId || !same(worker.before, before) || !same(worker.after, after)
        || target.previousTarget.workerId !== before.workerId || target.previousTarget.modelProfileId !== before.modelProfileId
        || target.desiredTarget.workerId !== after.workerId || target.desiredTarget.modelProfileId !== after.modelProfileId
        || target.desiredWorker.workerId !== after.workerId || target.desiredWorker.modelProfileId !== after.modelProfileId
        || target.desiredWorker.image !== target.desiredTarget.requiredImageDigest
        || !cid.test(worker.beforeContainerId ?? '') || !cid.test(worker.containerId ?? '')
        || worker.imageId !== target.desiredTarget.requiredImageId || !digest.test(worker.imageId ?? '')
        || worker.configurationDigest !== target.desiredTarget.requiredConfigDigest
        || worker.startSpecDigest !== target.desiredTarget.requiredStartSpecDigest
        || worker.healthy !== true) fail();
    const unchanged = same(target.previousTarget, target.desiredTarget);
    if (unchanged) {
      if (!same(before, after) || worker.beforeContainerId !== worker.containerId) fail();
    } else if (after.leaseId !== payload.transactionId || after.fencingToken !== payload.journalRevision
        || worker.beforeContainerId === worker.containerId) fail();
  }
  return receipt;
}
