import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { startSerialRefresh } from '../src/activity/serial-refresh.mjs';
import { reconcileOpenApplication } from '../src/catalog/workbench-catalog.mjs';

test('a successful unavailable catalog refreshes to available without a reload', async () => {
  const timers = new Map(), results = []; let id = 0, requests = 0;
  const stop = startSerialRefresh({
    schedule: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    unschedule: key => timers.delete(key),
    request: async () => ({ applications: [{ launchable: ++requests > 1 }] }),
    onValue: value => results.push(value.applications[0].launchable), onError: assert.fail,
  });
  for (let i=0;i<5;i++) await Promise.resolve();
  const [key, timer] = [...timers].find(([,value]) => value.delay === 15000);
  timers.delete(key); await timer.fn(); stop();
  assert.deepEqual(results, [false, true]);
  assert.equal(timers.size, 0);
});

test('health refresh keeps an open phone or desktop mounted but revocation closes it', () => {
  for (const pluginKey of ['official.virtual-phones', 'official.virtual-computers']) {
    const current = { pluginKey, runtime: { authorized:true, lifecycleState:'enabled', launchable:true } };
    const recovering = { ...current, runtime: { ...current.runtime, launchable:false } };
    assert.equal(reconcileOpenApplication(current, recovering, pluginKey), current);
    assert.equal(reconcileOpenApplication(current, { ...current }, pluginKey), current);
    assert.equal(reconcileOpenApplication(null, recovering, pluginKey), null);
    assert.equal(reconcileOpenApplication(current, undefined, pluginKey), null);
    assert.equal(reconcileOpenApplication(current, { ...recovering, runtime:{ ...recovering.runtime, authorized:false } }, pluginKey), null);
    assert.equal(reconcileOpenApplication(current, { ...recovering, runtime:{ ...recovering.runtime, lifecycleState:'disabled' } }, pluginKey), null);
  }
});

test('catalog refresh is connected to abortable loading and stable workspace reconciliation', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const client = await readFile(new URL('../src/catalog/application-catalog-client.ts', import.meta.url), 'utf8');
  assert.match(app, /return startSerialRefresh\(\{\s*request: \(signal: AbortSignal\) => loadApplicationCatalog\(\{ signal \}\)/);
  assert.match(app, /setActiveApp\(\(current\) => reconcileOpenApplication\(current, target, requestedApplicationPluginKey\)\)/);
  assert.match(client, /fetch\("\/api\/v1\/applications", \{[\s\S]*?\n    signal,/);
});
