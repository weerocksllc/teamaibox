import test from 'node:test';
import assert from 'node:assert/strict';
import {validateComputerResources,planComputerPlacement,computerDiskLimitBytes} from '../src/virtual-computer-capacity.mjs';
const GiB=1024**3;
const profile={minimum:{vcpus:2,memoryGiB:4,diskGiB:64}};
const policy={qemuOverheadBytes:2*GiB,gatewayOverheadBytes:GiB,
  storageOverheadBytes:2*GiB,maximumSampleAgeMs:10000};
const node={id:'appliance',role:'appliance-core',online:true,architecture:'arm64',kvm:true,sampledAt:1000,
  memoryAvailableBytes:34*GiB,pendingMemoryBytes:0,freeStorageBytes:500*GiB,pendingStorageBytes:0,
  freeCpuCount:8,pendingCpuCount:0,memoryPressure:false,swapOutActive:false,availableCpuGroups:[[0,1,2,3],[4,5,6,7]]};
const resources=validateComputerResources({vcpus:4,memoryGiB:8,diskGiB:128},{profile,policy});
const plan=nodes=>planComputerPlacement({resources,nodes,policy,now:2000});
test('resource choice is not bound to 8 GiB or 96 GiB lab values',()=>{
  assert.equal(validateComputerResources({vcpus:8,memoryGiB:24,diskGiB:512},{profile,policy}).diskBytes,512*GiB);
  assert.throws(()=>validateComputerResources({vcpus:2,memoryGiB:3,diskGiB:64},{profile,policy}));
  assert.throws(()=>validateComputerResources({vcpus:4,memoryGiB:24,diskGiB:128},{profile,policy:{maximum:{memoryGiB:16}}}));
});
test('placement records the guest runtime configuration without shared headroom deductions',()=>{
  const result=plan([node]);assert.equal(result.selected.nodeId,'appliance');
  assert.equal(result.selected.runtimeMemoryBytes,11*GiB);assert.equal('remainingMemoryBytes' in result.selected,false);
  assert.deepEqual(result.selected.cpuIds,[0,1,2,3]);
  assert.equal(result.selected.diskLimitBytes,130*GiB);
});
test('per-guest disk limits include metadata overhead and are not shared reservations',()=>{
  assert.equal(computerDiskLimitBytes({diskBytes:4096},{storageOverheadBytes:1}),5120);
  assert.throws(()=>computerDiskLimitBytes(resources,{}));
  assert.throws(()=>computerDiskLimitBytes({diskBytes:Number.MAX_SAFE_INTEGER},policy));
  assert.equal(plan([{...node,freeStorageBytes:0}]).selected.nodeId,'appliance');
});
test('other guests logical CPU and RAM settings cannot consume a shared booking pool',()=>{
  const result=plan([{...node,pendingMemoryBytes:1024*GiB,pendingCpuCount:999,memoryAvailableBytes:0,freeCpuCount:0}]);
  assert.equal(result.selected.nodeId,'appliance');
});
test('starting an existing computer does not reserve its sparse disk again',()=>{
  assert.equal(plan([{...node,freeStorageBytes:0,pendingStorageBytes:999*GiB}]).selected.nodeId,'appliance');
});
test('plans only one appliance and rejects stale hardware observations, not pressure alone',()=>{
  assert.throws(()=>plan([{...node,id:'other'},node]),{code:'computer_resources_invalid'});
  assert.equal(plan([{...node,swapOutActive:true,memoryPressure:true}]).selected.nodeId,'appliance');
  assert.equal(plan([{...node,sampledAt:999999}]).selected,null);
  assert.equal(planComputerPlacement({resources,nodes:[node],policy,now:20000}).selected,null);
});
test('does not combine heterogeneous CPU groups to fit an incompatible guest',()=>{
  assert.equal(plan([{...node,availableCpuGroups:[[0,1],[2,3]]}]).selected,null);
});
