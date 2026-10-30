import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleBrowser } from '../fixtures/main-control-browser-sampler.mjs';

function fixture(values, fail = false) {
  const writes = [];
  const fs = { async writeFile(path, text, options) { assert.equal(options.flag, 'wx'); writes.push(text); },
    async appendFile(path, text) { writes.push(text); } };
  const tab = { playwright: { frameLocator() { return { locator() { return { async evaluateAll() {
    if (fail) throw Error('read failed'); return values;
  } }; } }; } } };
  return { writes, fs, tab };
}

test('records a real DOM-shaped observation without changing dimensions', async () => {
  const f=fixture([{at:'2026-10-11T00:00:00Z',width:720,height:1280,time:10,paused:false,muted:false,hidden:false,readyState:4}]);
  await sampleBrowser(f.tab,f.fs,'output',{seconds:.01,intervalMs:250,id:'one'});
  const row=JSON.parse(f.writes[1]);assert.equal(row.width,720);assert.equal(row.id,'one');
});
test('retains missing player and read errors as failures', async () => {
  for (const f of [fixture([]),fixture([],true)]) {
    await sampleBrowser(f.tab,f.fs,'output',{seconds:.01,intervalMs:250,id:'one'});
    const row=JSON.parse(f.writes[1]);assert.equal(row.readyState,0);assert.equal(row.width,0);assert.equal(row.paused,true);
  }
});
test('does not overwrite an earlier observation file', async () => {
  const f=fixture([]);f.fs.writeFile=async()=>{throw Error('EEXIST');};
  await assert.rejects(sampleBrowser(f.tab,f.fs,'output',{seconds:1,id:'one'}),/EEXIST/);assert.deepEqual(f.writes,[]);
});
test('rejects unbounded configuration', async () => {
  const f=fixture([]);
  for (const options of [{seconds:Infinity,id:'one'},{seconds:1900,id:'one'},{seconds:1},{seconds:1,intervalMs:5,id:'one'}])
    await assert.rejects(sampleBrowser(f.tab,f.fs,'output',options),/invalid_sampler_configuration/);
});
