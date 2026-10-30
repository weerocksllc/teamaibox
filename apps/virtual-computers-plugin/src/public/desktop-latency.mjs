// Explicit test mode only. Compare one synthetic marker pixel; retain no image.
export const marker = key => /^[1-8]$/.test(key)
  ? [32 * Number(key) - 1, 255 - 24 * Number(key), 64 + Number(key)] : null;
export const sameMarker = (pixel, expected) => Boolean(pixel && expected
  && expected.every((value, index) => Math.abs(pixel[index] - value) <= 2));

export function createLatencyProbe({ now, readPixel, requestFrame, report, timeoutMs = 3000 }) {
  let enabled = false, pending = null;
  const samples = [];
  let timedOut = 0;
  const publish = () => {
    const ordered = [...samples].sort((a, b) => a - b);
    report({ enabled, samplesMs: [...samples], timeouts: timedOut,
      p50Ms: ordered.length ? ordered[Math.floor((ordered.length - 1) * .5)] : null,
      p95Ms: ordered.length ? ordered[Math.ceil((ordered.length - 1) * .95)] : null,
      scope: 'browser-key-event-to-matching-guest-pixel-not-physical-display' });
  };
  function frame() {
    if (!enabled || !pending) return;
    if (sameMarker(readPixel(), pending.expected)) {
      samples.push(Math.round((now() - pending.start) * 10) / 10);
      if (samples.length > 120) samples.shift();
      pending = null; publish();
    } else if (now() - pending.start >= timeoutMs) {
      timedOut++; pending = null; publish();
    } else requestFrame(frame);
  }
  return {
    setEnabled(value) { enabled = value; pending = null; publish(); },
    key(key, repeat = false) {
      const expected = marker(key);
      if (!enabled || repeat || pending || !expected) return;
      const before = readPixel();
      // Require a known prior test frame, and a different requested marker.
      if (!Array.from({ length: 8 }, (_, i) => marker(String(i + 1))).some(p => sameMarker(before, p))
        || sameMarker(before, expected)) return;
      pending = { start: now(), expected }; requestFrame(frame);
    },
  };
}
