import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {commit, observations} from './factory_office_ready.mjs';
import {MemoryProtectedOfficeSetRepository} from '../services/scheduler/src/memory-protected-office-set-repository.mjs';
import {ProtectedOfficeSetCoordinator} from '../services/scheduler/src/protected-office-set-coordinator.mjs';

function fixture() {
  const installationId = randomUUID(), nodeId = randomUUID(), stamp = new Date().toISOString();
  const profiles = Array.from({length: 6}, (_, i) => ({workerId: randomUUID(), modelProfileId: randomUUID(),
    imageDigest: 'sha256:' + 'a'.repeat(64), configurationDigest: 'sha256:' + 'b'.repeat(64),
    placementClass: 'protected-resident', maintenanceGeneration: 1,
    declaredResidentBytes: (i === 0 ? 14 : 10) * 2 ** 30, stageOrder: i + 1, dependsOnWorkerIds: []}));
  const workers = profiles.map((p, i) => ({...p, healthy: true, state: 'running',
    residentBytes: 2 ** 30, containerId: String(i + 1).repeat(64), startedAt: stamp}));
  return {schemaVersion: 1, installationId, nodeId, setId: 'factory-office-' + installationId,
    profiles, workers, coreHealthy: true, observedAt: stamp,
    memorySnapshot: {observedAt: stamp, host: {observedAt: stamp, totalBytes: 128 * 2 ** 30, availableBytes: 116 * 2 ** 30},
      workers: workers.map(w => ({workerId: w.workerId, cgroup: {currentBytes: w.residentBytes}})), activeReservations: []}};
}

test('fresh install commits already observed workers and repeat reuses the set', async () => {
  const input = fixture(), calls = [], repository = new MemoryProtectedOfficeSetRepository();
  const options = {repository, Coordinator: ProtectedOfficeSetCoordinator,
    database: {async query(sql, values) { calls.push({sql, values}); }}};
  const first = await commit(input, options);
  assert.equal(first.status, 'ready');
  assert.equal(first.modelsStarted, false);
  const second = await commit(input, options);
  assert.equal(second.reused, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].values[0].length, 6);
});

test('expired, mismatched, failed or incomplete observations never register readiness', () => {
  for (const change of [v => {v.observedAt = '2026-01-01T00:00:00Z';},
    v => {v.workers[0].healthy = false;}, v => {v.workers[0].containerId = 'fake';},
    v => {v.workers[0].residentBytes = 0;}, v => {v.workers[0].imageDigest = 'sha256:' + 'c'.repeat(64);},
    v => {v.workers[0].residentBytes = v.profiles[0].declaredResidentBytes + 1;},
    v => {v.coreHealthy = false;}]) {
    const input = fixture(); change(input);
    assert.throws(() => observations(input));
  }
});

test('reclaimable cache remains charged in the full host admission snapshot', async () => {
  const input = fixture();
  input.memorySnapshot.workers[0].cgroup.currentBytes = 16 * 2 ** 30;
  input.workers[0].residentBytes = 13 * 2 ** 30;
  const before = structuredClone(input.memorySnapshot);
  const result = await commit(input, {repository: new MemoryProtectedOfficeSetRepository(),
    Coordinator: ProtectedOfficeSetCoordinator, database: {async query() {}}});
  assert.equal(result.status, 'ready');
  assert.deepEqual(input.memorySnapshot, before);
});

test('insufficient actual memory does not update profile state', async () => {
  const input = fixture(); input.memorySnapshot.host.availableBytes = 2 ** 30;
  let updates = 0;
  await assert.rejects(commit(input, {repository: new MemoryProtectedOfficeSetRepository(),
    Coordinator: ProtectedOfficeSetCoordinator, database: {async query() {updates++;}}}));
  assert.equal(updates, 0);
});
