// Copy-only rendered review. Local synthetic GET fixtures; no appliance access.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
assert.ok(process.env.TEAMAIBOX_UI_PLAYWRIGHT, 'Set TEAMAIBOX_UI_PLAYWRIGHT to the installed Playwright module');
const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_UI_PLAYWRIGHT));

const output = process.env.TEAMAIBOX_COPY_OUTPUT;
assert.ok(output, 'Set TEAMAIBOX_COPY_OUTPUT to an evidence directory');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const observations = [], errors = [], blocked = [], writes = [];
let locale = 'zh-CN';
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.hostname !== '127.0.0.1') { blocked.push(url.href); return route.abort(); }
  if (req.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ status: 503, json: { error: { code: 'synthetic_write_blocked' } } }); }
  if (url.pathname === '/runtime-config.js') {
    const response = await route.fetch();
    return route.fulfill({ response, body: (await response.text()).replace('preferredLocale:"zh-CN"', `preferredLocale:"${locale}"`) });
  }
  return route.continue();
});
async function capture(name, screenshot = false) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (const frame of page.frames().filter(f => !f.url().startsWith('about:'))) {
    const m = await frame.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth,
      clippedButtons: [...document.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width && getComputedStyle(e).overflowX === 'hidden' && e.scrollWidth > e.clientWidth + 2).map(e => e.textContent.trim()) }));
    observations.push({ name, locale, ...m });
    if (m.content > m.width + 1) await page.screenshot({ path: `${output}/overflow-${name}-${locale}.png` });
    assert.ok(m.content <= m.width + 1, `${name}: horizontal overflow ${JSON.stringify(m)}`);
    assert.deepEqual(m.clippedButtons, [], `${name}: clipped button copy`);
  }
  if (screenshot) await page.screenshot({ path: `${output}/${name}-${locale}.png` });
}
async function visit(path, name, screenshot = false) {
  await page.goto('http://127.0.0.1:4193' + path);
  await page.locator('.app-frame').waitFor();
  if (await page.locator('iframe').count()) await page.frameLocator('iframe').locator('body').waitFor();
  await page.waitForTimeout(180);
  await capture(name, screenshot);
}
try {
  const paths = ['/', '/apps/assistant', ...['messaging','team-drive','drawing','ocr','asr','translation','virtual-phones','virtual-computers','wireless-casting'].map(x => '/apps/' + x), ...['overview','device','phones','computers','users','roles','team','models','queues','providers','plugins','sources','storage','encryption','backups','updates','audit'].map(x => '/admin/' + x)];
  for (locale of process.env.TEAMAIBOX_COPY_LOCALES?.split(',') || ['zh-CN', 'en']) {
    if (process.env.TEAMAIBOX_COPY_SECTION === 'shell-overlays') {
      await page.setViewportSize({ width: 1280, height: 900 });
      await visit('/?audit=ready', 'shell');
      await page.locator('.sidebar').getByRole('button', { name: locale === 'en' ? 'All applications' : '全部应用', exact: true }).click();
      await capture('application-directory', true);
      await page.locator('.task-button').click();
      await page.locator('#task-drawer-title').waitFor(); await capture('task-drawer', true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: locale === 'en' ? 'Notifications' : '通知', exact: true }).click();
      await page.locator('#notification-title').waitFor();
      await capture('notifications', true);
      await page.keyboard.press('Escape');
      continue;
    }
    if (process.env.TEAMAIBOX_COPY_SECTION === 'confirmations') {
      await page.setViewportSize({ width: 1280, height: 900 });
      await visit('/apps/messaging?audit=ready', 'messaging-cleanup');
      const frame = await page.locator('iframe').elementHandle().then(e => e.contentFrame());
      await frame.locator('.conversation-item').first().click();
      for (const name of (locale === 'en' ? ['Clear chat history', 'Delete chat', 'Delete this message'] : ['清空聊天记录', '删除聊天', '删除这条消息'])) {
        if (name === 'Delete this message' || name === '删除这条消息') await frame.locator('#close-details').click();
        else if (name === 'Clear chat history' || name === '清空聊天记录') await frame.locator('#open-details').click();
        await frame.getByRole('button', { name, exact: true }).first().click();
        await frame.locator('.cleanup-dialog[open]').waitFor();
        await capture('cleanup-' + name, true);
        await frame.locator('.cleanup-dialog').getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
      }
      continue;
    }
    for (const path of paths) {
      await page.setViewportSize({ width: 1280, height: 900 });
      const name = path.replaceAll('/', '-') || 'home';
      await visit(path + '?audit=ready', name, ['/apps/ocr','/admin/device'].includes(path));
      await page.setViewportSize({ width: 390, height: 844 }); await capture(name + '-narrow');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const app of ['drawing','ocr','asr','translation']) {
      await visit(`/apps/${app}?audit=result`, app + '-result', app === 'ocr');
      await visit(`/apps/${app}?audit=error`, app + '-error', app === 'translation');
    }
    await visit('/admin/users?audit=ready', 'user-editor');
    await page.getByRole('button', { name: locale === 'en' ? 'Create member' : '创建成员', exact: true }).click();
    await page.locator('dialog[open]').waitFor(); await capture('user-editor-open', true);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ renderedMeasurements: observations.length, pageErrors: errors, externalRequests: blocked, blockedSyntheticWrites: writes }));
} finally {
  await writeFile(`${output}/render-review.json`, JSON.stringify({ observations, errors, blocked, writes }, null, 2));
  await browser.close();
}
