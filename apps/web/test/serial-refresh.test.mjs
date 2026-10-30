import assert from 'node:assert/strict';
import test from 'node:test';
import { startSerialRefresh } from '../src/activity/serial-refresh.mjs';

function clock() {
  const timers = new Map(); let id = 0;
  return { timers, schedule: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    unschedule: id => timers.delete(id),
    fire(delay) { const [key, timer] = [...timers].find(([, t]) => t.delay === delay); timers.delete(key); return timer.fn(); } };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('slow refresh cannot overlap; next interval starts after completion', async () => {
  const c = clock(), values = []; let complete, calls = 0;
  const stop = startSerialRefresh({ ...c, request: () => { calls++; return new Promise(r => complete = r); },
    onValue: value => values.push(value), onError: assert.fail });
  assert.equal(calls, 1);
  assert(![...c.timers.values()].some(t => t.delay === 15000));
  complete('first'); await flush();
  assert.deepEqual(values, ['first']); assert.equal(c.timers.size, 1);
  void c.fire(15000); assert.equal(calls, 2);
  stop(); complete('late'); await flush();
  assert.deepEqual(values, ['first']); assert.equal(c.timers.size, 0);
});

test('deadline aborts fetch, reports failure and allows the next refresh', async () => {
  const c = clock(), errors = []; let signal;
  const stop = startSerialRefresh({ ...c, request: current => { signal = current;
    return new Promise((_, reject) => current.addEventListener('abort', () => reject(Error('timeout')), { once: true })); },
    onValue: assert.fail, onError: error => errors.push(error.message) });
  c.fire(12000); await flush();
  assert(signal.aborted); assert.deepEqual(errors, ['timeout']);
  assert.equal(c.timers.size, 1); assert.equal([...c.timers.values()][0].delay, 15000);
  stop(); assert.equal(c.timers.size, 0);
});

test('unmount aborts in-flight work without an error update or another request', async () => {
  const c = clock(); let signal;
  const stop = startSerialRefresh({ ...c, request: current => { signal = current;
    return new Promise((_, reject) => current.addEventListener('abort', () => reject(Error('disposed')))); },
    onValue: assert.fail, onError: assert.fail });
  stop(); await flush(); assert(signal.aborted); assert.equal(c.timers.size, 0);
});

test('a late resolution after a deadline is never displayed', async () => {
  const c = clock(); let complete;
  const stop = startSerialRefresh({ ...c, request: () => new Promise(r => complete = r), onValue: assert.fail, onError: assert.fail });
  c.fire(12000); assert.equal(c.timers.size, 0);
  complete('obsolete'); await flush(); assert.equal(c.timers.size, 1); stop();
});
