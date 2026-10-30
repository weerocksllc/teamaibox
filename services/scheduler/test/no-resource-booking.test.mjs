import assert from 'node:assert/strict';
import test from 'node:test';
import {LeaseManager} from '../src/lease-manager.mjs';
import {MemoryLeaseRepository} from '../src/memory-lease-repository.mjs';
import {SessionCastingRuntime} from '../../../apps/platform-api/src/casting/session-casting-runtime.mjs';

const resources = {cpuMillis:6000,unifiedMemoryBytes:4096,acceleratorUnits:0,
  codecSessions:2,storageBytes:0,networkBitsPerSecond:100};
const at = new Date('2026-01-01T00:00:00Z');

test('job identity leases do not deny a new job against advance resource totals', async () => {
  const repository = new MemoryLeaseRepository({
    nodes:[{nodeId:'synthetic-node',lifecycleState:'ready',generation:1,
      capacity:Object.fromEntries(Object.keys(resources).map(k=>[k,0]))}],
    jobs:['one','two'].map(jobId=>({jobId,status:'queued',currentAttemptId:null,cancelRequestedAt:null})),
  });
  const manager = new LeaseManager({repository});
  for (const jobId of ['one','two']) {
    const lease = await manager.acquire({acquisitionKey:jobId,jobId,nodeId:'synthetic-node',nodeGeneration:1,
      modelProfileId:'synthetic-profile',reservation:resources,now:at});
    assert.equal(lease.state,'active');
  }
  await assert.rejects(manager.acquire({acquisitionKey:'duplicate',jobId:'one',nodeId:'synthetic-node',
    nodeGeneration:1,modelProfileId:'synthetic-profile',reservation:resources,now:at}),{code:'active_job_lease_exists'});
});

test('casting delegates native operations without a resource allocator and still serializes stop', async () => {
  const events = [];
  let finish;
  const started = new Promise(resolve=>{finish=resolve;});
  const runtime = Object.fromEntries(['health','readiness','issueViewerConnection','disconnectViewer']
    .map(name=>[name,async input=>input]));
  runtime.startReceiver = async () => {events.push('start');await started;events.push('started');};
  runtime.stopReceiver = async () => {events.push('stop');};
  runtime.updateReceiver = async () => {};
  const wrapper = new SessionCastingRuntime({runtime,nodeIdentity:{nodeId:'00000000-0000-4000-8000-000000000001',nodeGeneration:1}});
  const input = {sessionId:'00000000-0000-4000-8000-000000000002',outputSinks:['browser']};
  const start = wrapper.startReceiver(input);
  const stop = wrapper.stopReceiver(input);
  await Promise.resolve();await Promise.resolve();
  finish();await Promise.all([start,stop]);
  assert.deepEqual(events,['start','started','stop']);
  assert.equal((await wrapper.readiness()).nodeGeneration,1);
  await assert.rejects(wrapper.startReceiver({...input,outputSinks:['hdmi']}),{code:'cast_output_invalid'});
});
