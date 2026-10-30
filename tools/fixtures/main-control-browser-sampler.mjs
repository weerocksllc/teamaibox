/** Run only in cua_repl with its already selected real page and local fs API.
 * Read-only DOM observations, no fetch/CDP/page timers or media capture.
 * The persistent sampler runs independently of model/tool round-trip timing.
 */
export async function sampleBrowser(tab, fs, path, { seconds = 300, intervalMs = 2000, id } = {}) {
  if (!id || !Number.isFinite(seconds) || seconds <= 0 || seconds > 1800
      || !Number.isFinite(intervalMs) || intervalMs < 250 || intervalMs > 10000) {
    throw new TypeError('invalid_sampler_configuration');
  }
  await fs.writeFile(path, '', { flag: 'wx' });
  const end = Date.now() + seconds * 1000;
  let count = 0;
  while (Date.now() < end) {
    let row;
    try {
      const rows = await tab.playwright.frameLocator('iframe').locator('video').evaluateAll(videos => videos.map(v => ({
        at: new Date().toISOString(), width: v.videoWidth, height: v.videoHeight,
        time: v.currentTime, paused: v.paused, muted: v.muted, hidden: v.ownerDocument.hidden, readyState: v.readyState,
      })));
      row = rows.length === 1 ? { ...rows[0], id } : null;
    } catch { row = null; }
    // A missing player/read failure is retained as a failed observation, never
    // silently dropped to make playback coverage look continuous.
    row ??= { at: new Date().toISOString(), id, width: 0, height: 0, time: 0,
      paused: true, muted: true, hidden: false, readyState: 0 };
    await fs.appendFile(path, JSON.stringify(row) + '\n');
    count++;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return { path, observations: count };
}
