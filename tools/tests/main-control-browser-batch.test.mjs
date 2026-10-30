import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleBatch} from '../fixtures/main-control-browser-batch.mjs';

test('awaited batch calls the active reader and writes an exclusive readiness marker',async()=>{
  const writes=[],rows=[];const fs={async writeFile(p,b,o){writes.push([p,b,o]);},async appendFile(p,b){rows.push(JSON.parse(b));}};
  const result=await sampleBatch(async()=>({at:'2026-10-14T05:00:00Z',width:752,height:1080,time:1,paused:false,muted:false,hidden:false,readyState:4}),
    fs,'batch',{seconds:.01,intervalMs:250,id:'real-tab',readyPath:'ready'});
  assert.equal(result.observations,1);assert.equal(rows[0].width,752);assert.equal(writes[0][2].flag,'wx');
  assert.equal(writes[1][0],'ready');assert.equal(writes[1][2].flag,'wx');
});
test('failed reads are retained and cannot trigger readiness',async()=>{
  const writes=[],rows=[];const fs={async writeFile(p,b,o){writes.push(p);},async appendFile(p,b){rows.push(JSON.parse(b));}};
  await sampleBatch(async()=>{throw Error('no active CUA context');},fs,'batch',{seconds:.01,intervalMs:250,id:'real-tab',readyPath:'ready'});
  assert.deepEqual(writes,['batch']);assert.equal(rows[0].readyState,0);assert.equal(rows[0].paused,true);
});
test('a batch cannot block communication for more than 45 seconds',async()=>{
  await assert.rejects(sampleBatch(async()=>({}),{},'batch',{seconds:46,id:'real-tab'}),/invalid_batch/);
});
