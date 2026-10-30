import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Bounded UI-only checks against explicitly local, synthetic fixtures. No real
// device, model, media, guest lifecycle, account or deployment is exercised.
test('Precision UI: page geometry, themes and live phone draft continuity', {
  skip: !process.env.TEAMAIBOX_UI_PLAYWRIGHT, timeout: 120000,
}, async t => {
  const origin = process.env.TEAMAIBOX_UI_PREVIEW_URL ?? 'http://127.0.0.1:4179';
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'only the isolated local fixture is allowed');
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_UI_PLAYWRIGHT));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errors = [], external = [], writes = [], measurements = [];
  page.on('pageerror', error => errors.push(error.message));
  const output = process.env.TEAMAIBOX_UI_SCREENSHOTS;
  if (output) await mkdir(output, { recursive: true });
  let theme = 'light';
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') { external.push(request.url()); return route.abort(); }
    if (url.pathname === '/runtime-config.js') {
      const response = await route.fetch();
      return route.fulfill({ response, body: (await response.text()).replace('preferredTheme:"light"', `preferredTheme:"${theme}"`) });
    }
    if (request.method() !== 'GET') {
      writes.push(url.pathname);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.continue();
  });
  const routes = [
    ['home', '/'], ['ocr', '/apps/ocr'], ['drawing', '/apps/drawing'], ['asr', '/apps/asr'],
    ['translation', '/apps/translation'], ['phones', '/apps/virtual-phones'], ['computers', '/apps/virtual-computers'],
    ['assistant', '/apps/assistant'], ['casting', '/apps/wireless-casting'],
    ['users', '/admin/users'], ['device', '/admin/device'],
    ['updates', '/admin/updates'], ['audit', '/admin/audit'],
  ];
  for (theme of ['light', 'dark']) {
    for (const [name, path] of routes) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(origin + path);
      await page.locator('.app-frame').waitFor();
      await page.waitForTimeout(200);
      if (name === 'assistant') {
        await page.locator('.assistant-workspace .assistant-result-pane').waitFor();
        assert.equal(await page.locator('.plugin-workspace iframe').count(), 0, 'assistant uses its existing workbench integration');
      }
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(60);
        for (const frame of page.frames()) {
          const value = await frame.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth, background: getComputedStyle(document.body).backgroundColor }));
          measurements.push({ name, theme, width, frame: frame === page.mainFrame() ? 'host' : 'plugin', ...value });
        }
        if (output) await page.screenshot({ path: `${output}/${name}-${theme}-${width}.png` });
      }
    }
  }
  // Exercise the existing preference UI while a native plugin form is open.
  // Its frame, draft, dialog and video element must survive; no VM is opened.
  theme = 'light';
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin + '/apps/virtual-phones');
  const frame = await page.locator('iframe').elementHandle().then(el => el.contentFrame());
  await frame.locator('#create:not(:disabled)').click();
  await frame.locator('#name').fill('保留我的输入');
  const video = await frame.locator('#phone-video').elementHandle();
  const frameStart = await frame.evaluate(() => performance.timeOrigin);
  await page.locator('.profile-trigger').click();
  await page.locator('.profile-popover').getByRole('button', { name: '深色', exact: true }).click();
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await frame.locator('#name').inputValue(), '保留我的输入');
  assert.equal(await frame.locator('#editor').evaluate(el => el.open), true);
  assert.equal(await frame.evaluate(() => performance.timeOrigin), frameStart);
  assert.equal(await video.evaluate(el => el.isConnected && getComputedStyle(el).objectFit === 'contain'), true);
  assert.equal(await frame.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(16, 25, 30)');
  await page.keyboard.press('Escape');
  await frame.locator('#cancel').click();
  assert.equal(await frame.locator('#create').evaluate(el => document.activeElement === el), true);
  if (output) await writeFile(`${output}/measurements.json`, JSON.stringify({ measurements, errors, external, writes }, null, 2));
  assert.deepEqual(measurements.filter(v => v.content > v.viewport + 1), [], 'no horizontal page overflow');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.ok(writes.every(path => /^\/api\/preferences\/(theme|locale)$/.test(path)), 'only appearance preferences may be written');
});
