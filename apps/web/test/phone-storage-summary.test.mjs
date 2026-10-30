import assert from 'node:assert/strict';
import test from 'node:test';
import {phoneStoragePools, storageGiB} from '../src/phones/phone-storage-summary.mjs';
const pool = {poolId:'phone-data',nodeId:'aux',lifecycleState:'active',encryptionMode:'luks2',encryptionStatus:'verified',
  dataClasses:['phone-data'],totalBytes:256*2**30,availableBytes:240*2**30,safetyReserveBytes:8*2**30,observedAt:'2026-09-14T15:00:00Z'};
test('capacity comes from the identified phone pool, not a fixed 64 GiB or another disk',()=>{
  const result=phoneStoragePools([pool,{...pool,nodeId:'other'},{...pool,dataClasses:['team-file']},{...pool,lifecycleState:'removed'}],'aux');
  assert.equal(result.length,1);assert.equal(result[0].totalBytes,256*2**30);
  assert.equal(storageGiB(result[0].totalBytes,'en'),'256 GiB');
  assert.equal(result[0].observedAt,pool.observedAt);
});
test('missing or invalid capacity never claims zero available space',()=>{
  for(const p of [{...pool,totalBytes:null},{...pool,availableBytes:300*2**30}]){
    const [r]=phoneStoragePools([p],'aux');assert.equal(r.totalBytes,null);assert.equal(r.availableBytes,null);
  }
  assert.equal(storageGiB(null,'en'),'—');assert.deepEqual(phoneStoragePools(null,'aux'),[]);
});
test('zero free bytes is real data, with reserve kept separate from unused bytes',()=>{
  const [r]=phoneStoragePools([{...pool,availableBytes:0}],'aux');
  assert.equal(r.availableBytes,0);assert.equal(r.reserveBytes,8*2**30);assert.equal(storageGiB(0,'en'),'0 GiB');
});
