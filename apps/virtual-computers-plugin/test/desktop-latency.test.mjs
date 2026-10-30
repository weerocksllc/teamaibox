import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatencyProbe, marker } from '../src/public/desktop-latency.mjs';
function fixture() {
  let clock = 0, pixel = marker('1'), callback, result;
  const probe = createLatencyProbe({ now: () => clock, readPixel: () => pixel,
    requestFrame: fn => { callback = fn; }, report: r => { result = r; } });
  return { probe, tick(ms, next) { clock += ms; if (next) pixel = next; callback?.(); },
    result: () => result, pixel: value => { pixel = value; } };
}
test('matches the requested guest marker, not merely the next video update', () => {
  const f = fixture(); f.probe.setEnabled(true); f.probe.key('2');
  f.tick(12, marker('3')); assert.deepEqual(f.result().samplesMs, []);
  f.tick(20, marker('2')); assert.deepEqual(f.result().samplesMs, [32]);
});
test('ordinary content and unchanged marker do not produce measurements', () => {
  const f = fixture(); f.probe.setEnabled(true); f.probe.key('1'); f.tick(10);
  f.pixel([0,0,0]); f.probe.key('2'); f.tick(10, marker('2'));
  assert.deepEqual(f.result().samplesMs, []);
});
test('timeouts are explicit, not successful samples', () => {
  const f = fixture(); f.probe.setEnabled(true); f.probe.key('2'); f.tick(3000);
  assert.equal(f.result().timeouts, 1); assert.deepEqual(f.result().samplesMs, []);
});
test('disabled and held keys cannot schedule samples', () => {
  const f = fixture(); f.probe.key('2'); f.probe.setEnabled(true); f.probe.key('2', true);
  f.tick(20, marker('2')); assert.deepEqual(f.result().samplesMs, []);
});
test('stopping cancels an in-flight measurement', () => {
  const f = fixture(); f.probe.setEnabled(true); f.probe.key('2'); f.probe.setEnabled(false);
  f.tick(20, marker('2')); assert.deepEqual(f.result().samplesMs, []);
});
