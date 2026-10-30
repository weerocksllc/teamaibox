import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

// Only newly changed presentation paths. All domain responses are synthetic;
// appearance writes/read receipts are intercepted, and nothing is submitted.
test('Precision: collaboration, assistant, public layers and remaining admin views', {
  skip: !process.env.TEAMAIBOX_UI_PLAYWRIGHT, timeout: 90000,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_UI_PLAYWRIGHT));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errors = [], external = [], attemptedWrites = [], measurements = [];
  page.on('pageerror', e => errors.push(e.message));
  const output = process.env.TEAMAIBOX_UI_SCREENSHOTS;
  if (output) await mkdir(output, { recursive: true });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') { external.push(request.url()); return route.abort(); }
    if (request.method() !== 'GET') { attemptedWrites.push(url.pathname); return route.fulfill({ json: {} }); }
    // SSE has no fixture messages and must not leave a pending route.fetch at teardown.
    if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': UI-only fixture\n\n' });
    const fixturePort = /^\/api\/v1\/(messaging|identities|session)/.test(url.pathname) ? 4183
      : /^\/api\/v1\/(files|objects)/.test(url.pathname) ? 4184 : null;
    if (fixturePort) return route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${fixturePort}${url.pathname}${url.search}` }) });
    return route.continue();
  });
  const goto = async path => { await page.goto('http://127.0.0.1:4179' + path); await page.locator('.app-frame').waitFor(); };
  const screenshot = async name => { if (output) await page.screenshot({ path: `${output}/${name}.png` }); };
  const geometry = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const frame of page.frames()) {
      const m = await frame.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
      if (m.content > m.viewport + 1) {
        await screenshot(`${name}-overflow`);
        console.log({ name, frame: frame.url(), elements: await frame.evaluate(() => [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, id: el.id, className: el.className })).slice(-12)) });
      }
      measurements.push({ name, ...m }); assert.ok(m.content <= m.viewport + 1, `${name}: horizontal overflow ${JSON.stringify(m)}`);
    }
  };
  const theme = async value => {
    await page.locator('.profile-trigger').click();
    await page.locator('.profile-popover').getByRole('button', { name: value === 'dark' ? '深色' : '浅色', exact: true }).click();
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, value);
    await page.keyboard.press('Escape');
  };

  // Resume the unfinished public-layer section without repeating completed views.
  if (process.env.TEAMAIBOX_UI_SECTION !== 'public') {
  await goto('/apps/assistant');
  await page.locator('.assistant-result-pane').waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  await page.locator('.assistant-compose-row textarea').fill('继续整理，不提交');
  const transcript = await page.locator('.assistant-transcript').innerText();
  await theme('dark');
  assert.equal(await page.locator('.assistant-compose-row textarea').inputValue(), '继续整理，不提交');
  assert.equal(await page.locator('.assistant-transcript').innerText(), transcript);
  await geometry('assistant'); await screenshot('assistant-dark');

  await goto('/apps/messaging');
  let frame = await page.locator('iframe').elementHandle().then(el => el.contentFrame());
  await frame.locator('#conversation-list button').first().click();
  await frame.locator('#message-input').fill('这是保留中的草稿，不发送。');
  await frame.locator('#message-list .message-row').first().waitFor();
  const conversation = await frame.locator('#chat-title').innerText();
  const frameStart = await frame.evaluate(() => performance.timeOrigin);
  await theme('dark');
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await frame.locator('#message-input').inputValue(), '这是保留中的草稿，不发送。');
  assert.equal(await frame.evaluate(() => performance.timeOrigin), frameStart);
  await geometry('messaging'); await screenshot('messaging-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.locator('#mobile-back').click();
  await frame.locator('#conversation-list button').first().click();
  assert.equal(await frame.locator('#chat-title').innerText(), conversation);
  assert.equal(await frame.locator('#message-input').inputValue(), '这是保留中的草稿，不发送。');
  await geometry('messaging-mobile'); await screenshot('messaging-mobile');

  await page.setViewportSize({ width: 1280, height: 900 });
  await goto('/apps/team-drive');
  frame = await page.locator('iframe').elementHandle().then(el => el.contentFrame());
  await frame.locator('.file-row').first().waitFor();
  await frame.locator('.file-row').last().click();
  await frame.locator('#details:not([hidden])').waitFor();
  await geometry('drive-details'); await screenshot('drive-details');
  await frame.locator('#close-details').click();
  await frame.locator('#details').waitFor({ state: 'hidden' });
  await frame.locator('#new-folder').click();
  const dialog = frame.locator('dialog[open]');
  await dialog.locator('input').first().fill('未提交的新文件夹');
  await theme('dark');
  assert.equal(await dialog.locator('input').first().inputValue(), '未提交的新文件夹');
  await page.setViewportSize({ width: 390, height: 844 });
  await geometry('drive-mobile-dialog'); await screenshot('drive-mobile-dialog');
  await dialog.press('Escape');

  // These domains were not covered by the first geometry check.
  await page.setViewportSize({ width: 1280, height: 900 });
  const admins = [['roles', '.role-admin'], ['team', '.team-admin'], ['phones', '.phone-admin-card'], ['computers', '.phone-admin-card'], ['models', '.model-card-panel'], ['queues', '.queue-policy'], ['providers', '.provider-grid'], ['plugins', '.plugin-admin'], ['storage', '.storage-pool-grid'], ['sources', '.source-center-grid'], ['encryption', '.encryption-panel']];
  for (const [route, selector] of admins) {
    await goto(`/admin/${route}`);
    await page.locator(selector).first().waitFor();
    await geometry(route); await screenshot(`admin-${route}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await geometry(`${route}-mobile`); await screenshot(`admin-${route}-mobile`);
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  }
  await goto('/');
  await page.locator('.global-search-trigger').click();
  await page.locator('#global-search').fill('手机');
  assert.equal(await page.locator('.search-result').count(), 1);
  await screenshot('search'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.global-search-trigger').evaluate(el => el === document.activeElement), true);
  await page.locator('.task-button').click();
  await page.locator('.drawer .task-row').first().waitFor();
  await screenshot('tasks'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.task-button').evaluate(el => el === document.activeElement), true);
  await page.locator('.profile-trigger').click(); await screenshot('account');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.ok(attemptedWrites.every(path => /^\/api\/preferences\//.test(path) || /\/messaging\/(.+\/read|presence)$/.test(path)), JSON.stringify(attemptedWrites));
  console.log(JSON.stringify({ scope: 'synthetic UI only', measurements: measurements.length, errors, external, attemptedWrites }));
});
