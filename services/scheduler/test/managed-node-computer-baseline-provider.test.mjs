import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ManagedNodeComputerBaselineProvider} from '../src/managed-node-computer-baseline-provider.mjs';
test('computer baseline uses signed observations without reconstructing advance commitments',async()=>{
  const nodeId=randomUUID(),guest=randomUUID();
  const computer={nodeId,nodeGeneration:4,poolId:'windows-pool',encryption:'luks2',workers:[{workerId:guest,cgroup:{currentBytes:123},stale:false}]};
  const nodeAgentRouter={readComputerBaseline:async()=>structuredClone(computer),readPhoneBaseline:async()=>{throw Error('unrelated phone lookup');}};
  const provider=new ManagedNodeComputerBaselineProvider({nodeAgentRouter});
  const b=await provider.read({nodeId,nodeGeneration:4,poolId:'windows-pool'});
  assert.deepEqual(b.workers.map(w=>w.workerId),[guest]);assert.equal(computer.workers.length,1);
  b.workers[0].cgroup.currentBytes=0;assert.equal(computer.workers[0].cgroup.currentBytes,123);
  await assert.rejects(provider.read({nodeId,nodeGeneration:5,poolId:'windows-pool'}),{code:'computer_capacity_unavailable'});
  await assert.rejects(provider.read({nodeId,nodeGeneration:4,poolId:'other-pool'}),{code:'computer_capacity_unavailable'});
});
