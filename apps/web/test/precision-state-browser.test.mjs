import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

// New UI states only. All responses and mutations are synthetic and local.
// This never creates accounts, generates media, starts guests or changes a box.
test('Precision results, failure feedback and editing details', {
  skip: !process.env.TEAMAIBOX_UI_PLAYWRIGHT, timeout: 120000,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_UI_PLAYWRIGHT));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6000);
  const errors = [], external = [], actions = [], views = [];
  page.on('pageerror', e => errors.push(e.message));
  const output = process.env.TEAMAIBOX_UI_SCREENSHOTS;
  if (output) await mkdir(output, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000901';
  let app = '', status = 'succeeded';
  const results = {
    drawing: { schema: 'teamaibox.ai.image-result.v1', job_id: id, prompt: '界面示例：团队发布资料', outputs: [{ encrypted: true, preview_path: `/api/v1/objects/references/${id}/content`, download_path: `/api/v1/objects/references/${id}/content?download=1` }], reproducibility: { size: '1024x1024', seed: 42, steps: 20 }, provenance: { profile_key: '设计示例' } },
    ocr: { schema: 'teamaibox.ai.ocr-result.v1', text: '产品发布会议纪要\n\n一、交付材料\n陈玫负责整理客户演示材料，林默负责更新使用说明。\n\n二、时间安排\n本周五前完成核对，确认后发送给项目负责人。', pages: [{ page_number: 1, blocks: [{ id: '01', block_type: 'text', text: '一、交付材料', confidence: .98 }, { id: '02', block_type: 'table', content_format: 'html', confidence: null, structure: { html: '<table><tr><th>负责人</th><th>行动项</th></tr><tr><td>陈玫</td><td>客户演示材料</td></tr></table>' } }] }], extensions: { provenance: { model_key: '设计示例' } } },
    asr: { schema: 'teamaibox.ai.asr-result.v1', text: '我们先确认本周的交付安排。', language: { code: 'zh' }, duration_seconds: 64, speaker_information: { supported: true, speaker_count: 2 }, segments: [{ id: '1', start_seconds: 0, end_seconds: 8, speaker: '说话人 1', text: '我们先确认本周的交付安排。演示材料与使用说明都需要在周五前完成。' }, { id: '2', start_seconds: 8, end_seconds: 16, speaker: '说话人 2', text: '好的，我会整理客户问题，并更新相关说明。' }], provenance: { profile_key: '设计示例' } },
    translation: { schema: 'teamaibox.ai.translation-result.v1', text: 'The release materials will be ready by Friday. Please confirm the action items with your team.', source_language: 'zh', target_language: 'en', input_kind: 'text', segments: [{ id: '1', start_ms: null, end_ms: null, source_text: '发布材料将在周五前准备好，请与团队确认行动项。', translated_text: 'The release materials will be ready by Friday. Please confirm the action items with your team.' }], workflow: { stages: [{ capability: 'translation', status: 'succeeded' }], intermediates: [] }, provenance: { completed_at: '2026-10-22T03:00:00Z' } },
  };
  await page.addInitScript(({ id }) => {
    if (location.protocol !== 'http:') return; // OCR table uses an opaque, sandboxed srcdoc.
    for (const key of ['teamaibox.drawing.current-job.v1', 'teamaibox.translation.active-job.v1', ...['ocr', 'asr'].map(x => `teamaibox:official.${x}:active-job`)]) sessionStorage.setItem(key, id);
  }, { id });
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname !== '127.0.0.1') { external.push(url.href); return route.abort(); }
    if (req.method() !== 'GET') { actions.push(url.pathname); return route.fulfill({ status: 503, json: { error: { code: 'request_failed', message: '暂时无法保存，输入内容已保留。' } } }); }
    if (url.pathname === `/api/v1/jobs/${id}`) return route.fulfill({ json: { id, status, result: results[app], error: status === 'failed' ? { message: '任务未完成，请检查输入后重试。原文件不受影响。' } : null } });
    if (url.pathname === `/api/v1/objects/references/${id}/content`) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="#edf5f3"/><circle cx="760" cy="250" r="210" fill="#8adbc8"/><path d="M0 600L400 260L800 768H0" fill="#087f78"/><text x="80" y="140" font-family="sans-serif" font-size="54" fill="#17292b">Precision Workspace</text><text x="80" y="208" font-family="sans-serif" font-size="28" fill="#17292b">Synthetic UI result · no model execution</text></svg>' });
    if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic\n\n' });
    return route.continue();
  });
  const goto = async path => { await page.goto(`http://127.0.0.1:4179${path}`); await page.locator('.app-frame').waitFor(); };
  const capture = async name => {
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    for (const frame of page.frames().filter(f => !f.url().startsWith('about:'))) {
      const metrics = await frame.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(metrics.scroll <= metrics.width + 1, `${name}: horizontal overflow ${JSON.stringify(metrics)}`);
    }
    if (output) await page.screenshot({ path: `${output}/${name}.png` });
    views.push(name);
  };
  const theme = async value => {
    await page.locator('.profile-trigger').click();
    await page.locator('.profile-popover').getByRole('button', { name: value === 'dark' ? '深色' : '浅色', exact: true }).click();
    await page.keyboard.press('Escape');
  };
  if (!process.env.TEAMAIBOX_UI_SECTION || ['results', 'layout-corrections'].includes(process.env.TEAMAIBOX_UI_SECTION)) {
    const applications = ['drawing', 'ocr', 'asr', 'translation'];
    for (app of applications.slice(Math.max(0, applications.indexOf(process.env.TEAMAIBOX_UI_RESUME)))) {
      status = 'succeeded'; await goto(`/apps/${app}`);
      const frame = await page.locator('iframe').elementHandle().then(e => e.contentFrame());
      await frame.locator(app === 'drawing' ? '#gallery img' : app === 'ocr' ? '#result' : app === 'asr' ? '#transcript' : '#translation-result').waitFor();
      const details = frame.locator('.ui-result-details');
      assert.equal(await details.evaluate(el => el.open), false);
      await capture(`${app}-result-light`);
      // Recapture only the result layouts whose CSS changed, not accepted flows.
      if (process.env.TEAMAIBOX_UI_SECTION === 'layout-corrections') continue;
      await details.locator('summary').click();
      await capture(`${app}-details-light`);
      if (app === 'ocr') { await frame.locator('[data-view="layout"]').click(); await frame.locator('.table-preview').waitFor(); await capture('ocr-table-light'); await frame.locator('[data-view="text"]').click(); }
      const editor = frame.locator(app === 'ocr' ? '#corrected-text' : app === 'asr' ? '.segment textarea' : '#translated-text').first();
      if (app !== 'drawing') await editor.fill('界面编辑草稿 · 不提交');
      await theme('dark');
      if (app !== 'drawing') assert.equal(await editor.inputValue(), '界面编辑草稿 · 不提交');
      await capture(`${app}-result-dark`);
      await page.setViewportSize({ width: 390, height: 844 }); await capture(`${app}-result-mobile`);
      await page.setViewportSize({ width: 1280, height: 900 });
      status = 'failed'; await page.reload();
      await page.frameLocator('iframe').locator(app === 'drawing' ? '#result-error' : '#job-error').waitFor();
      await capture(`${app}-failed`);
      await theme('light');
    }
  }
  if (!process.env.TEAMAIBOX_UI_SECTION || process.env.TEAMAIBOX_UI_SECTION === 'editors') {
    for (const [route, button] of [['users', '创建成员'], ['phones', '调整额度'], ['computers', '调整额度'], ['providers', '添加服务'], ['plugins', '导入插件'], ['storage', '注册存储池'], ['sources', '添加软件源']]) {
      await goto(`/admin/${route}`);
      const opener = page.getByRole('button', { name: button, exact: route !== 'phones' }).first();
      await opener.click();
      const dialog = page.locator('dialog[open]'); await dialog.waitFor();
      assert.equal(await dialog.evaluate(el => el.matches(':modal')), true);
      const input = dialog.locator('input:not([type=checkbox]):not([type=radio])').first();
      if (await input.count()) await input.fill(await input.getAttribute('type') === 'number' ? '3' : 'ui-draft');
      await capture(`${route}-editor`);
      await page.setViewportSize({ width: 390, height: 844 }); await capture(`${route}-editor-mobile`);
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert.equal(await opener.evaluate(el => el === document.activeElement), true);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await goto('/admin/users'); await page.getByRole('button', { name: '创建成员', exact: true }).click();
    let dialog = page.locator('dialog[open]');
    await dialog.locator('[name=loginName]').fill('ui-only');
    await dialog.locator('[name=displayName]').fill('设计草稿');
    await dialog.locator('[name=password]').fill('Synthetic-not-a-real-secret');
    await dialog.locator('[type=submit]').click();
    await dialog.locator('.precision-editor__feedback').waitFor();
    assert.equal(await dialog.locator('[name=displayName]').inputValue(), '设计草稿');
    await capture('users-save-failed'); await page.keyboard.press('Escape');
    await goto('/admin/computers'); await page.getByRole('button', { name: '调整额度', exact: true }).first().click();
    dialog = page.locator('dialog[open]'); await dialog.locator('input').first().fill('3');
    await dialog.locator('[type=submit]').click(); await dialog.locator('.precision-editor__feedback').waitFor();
    assert.equal(await dialog.locator('input').first().inputValue(), '3');
    await capture('computers-save-failed'); await page.keyboard.press('Escape');
    for (const route of ['roles', 'team']) {
      await goto(`/admin/${route}`);
      await page.locator(route === 'roles' ? '.role-matrix button:not(:disabled)' : '.team-admin__member-list .danger-button:not(:disabled)').last().click();
      dialog = page.locator('dialog[open]'); await dialog.waitFor(); await capture(`${route}-confirm`); await page.keyboard.press('Escape');
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ views, isolatedAttemptedActions: actions, errors, external }));
});
