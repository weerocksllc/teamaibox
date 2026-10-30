import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { precisionPreviewResponse } from '../tools/precision-preview-fixtures.mjs';

// Only newly modified presentation details. Every request stays on localhost;
// no real account, VM, file operation, recovery or Agent action is performed.
test('Precision remaining dialogs and exception details', {
  skip: !process.env.TEAMAIBOX_UI_PLAYWRIGHT, timeout: 90000,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_UI_PLAYWRIGHT));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6000);
  const output = process.env.TEAMAIBOX_UI_SCREENSHOTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [], external = [], writes = [], views = [];
  page.on('pageerror', e => errors.push(e.message));
  let auth = '', failure = false, casting = '';
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (url.hostname !== '127.0.0.1') { external.push(url.href); return route.abort(); }
    if (auth && path === '/runtime-config.js') return route.fulfill({ contentType: 'text/javascript', body: 'globalThis.__TEAM_AI_BOX_RUNTIME__={apiBase:"/api",mode:"production",transport:"https"};' });
    if (auth && path === '/api/auth/session') return route.fulfill({ status: auth === 'unavailable' ? 503 : 401, json: { error: { code: 'unavailable' } } });
    if (auth && path === '/api/setup/status') return route.fulfill({ json: { required: auth === 'setup', claimProtected: true, ownerRecoveryAvailable: true } });
    if (req.method() !== 'GET') {
      writes.push(path);
      if (auth && path === '/api/setup/owner') return route.fulfill({ json: { identity: {}, recoveryCodes: Array.from({ length: 8 }, (_, i) => `SAMPLE-NOT-VALID-${i + 1}`) } });
      if (auth && path === '/api/auth/owner-recovery/challenge') return route.fulfill({ json: { challenge: 'synthetic-not-valid', expiresAt: '2099-10-22T12:00:00Z' } });
      return route.fulfill({ status: 503, json: { error: { code: 'request_failed', message: 'UI-only synthetic failure' } } });
    }
    if (casting) {
      if (path === '/api/v1/session/bootstrap') return route.fulfill({ json: { actor: { identityId: '00000000-0000-4000-8000-000000000300' }, permissions: ['cast:use', 'cast:view', 'cast:share'] } });
      if (path === '/api/v1/casting/availability') return route.fulfill({ json: { schemaVersion: 1, object: 'cast.availability', mode: 'runtime', state: 'ready', receiverReady: true, sessionStartAllowed: true, receiverAdvertisementAllowed: true, outputs: { browser: { state: 'available', reasonCode: null } }, gates: [], limitations: { appleCertified: false, fairPlayDrmSupported: false, syntheticAcceptanceAllowed: false }, successor: { atomicCutoverRequired: true } } });
      if (path === '/api/v1/casting/sessions/current') return route.fulfill({ json: { id: '00000000-0000-4000-8000-000000000601', object: 'cast.session', state: 'pairing', stateRevision: 3, audienceRevision: 1, outputSinks: ['browser'], browserAudience: 'owner_only', expiresAt: '2099-10-22T12:00:00Z', createdAt: '2026-10-22T12:00:00Z', updatedAt: '2026-10-22T12:00:00Z', terminalAt: null, terminalReasonCode: null, sourceState: casting, sourceStateRevision: 1, viewerUserIds: [], viewerTeamId: null, receiver: { name: 'Team-AI-0000000000', pin: '1234', sourcePaired: false, sourceDeviceLabel: null }, outputHealth: { receiverHealthy: true, outputs: { browser: 'available' } } } });
      if (path.startsWith('/api/v1/casting/')) return route.fulfill({ json: { object: 'list', data: [] } });
    }
    if (path.endsWith('/events') && !path.includes('/audit/')) return route.fulfill({ contentType: 'text/event-stream', body: ': UI fixture\n\n' });
    if (path === '/api/v1/assistant/conversations/00000000-0000-4000-8000-000000000401') {
      const data = structuredClone(precisionPreviewResponse(path));
      data.messages[1].status = 'failed';
      data.messages[1].error = { code: 'request_failed', message: '上次回答未完成，已有内容已保留。', retryable: true };
      data.confirmations = [{ kind: 'agent_operation_confirmation', id: 'synthetic-confirmation', titleKey: 'assistant.confirmation.write', operationKind: 'write', scope: { path: '/workspace/团队协作计划.md' }, status: 'pending', expiresAt: '2099-10-22T12:00:00Z' }];
      return route.fulfill({ json: data });
    }
    if (failure && path === '/api/v1/admin/updates') return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
    return route.continue();
  });
  const goto = async path => { await page.goto(`http://127.0.0.1:4179${path}`); await page.locator('.app-frame').waitFor(); };
  const shot = async name => {
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    for (const f of page.frames()) {
      const m = await f.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(m.scroll <= m.width + 1, `${name}: overflow ${JSON.stringify(m)}`);
    }
    if (output) await page.screenshot({ path: `${output}/${name}.png` });
    views.push(name);
  };
  const mobile = async name => { await page.setViewportSize({ width: 390, height: 844 }); await shot(name); await page.setViewportSize({ width: 1280, height: 900 }); };
  const section = process.env.TEAMAIBOX_UI_SECTION;
  if (section === 'tools') {
    await goto('/apps/virtual-phones');
    const f = await page.locator('iframe').elementHandle().then(el => el.contentFrame());
    await f.locator('#create:not(:disabled)').waitFor();
    // Show existing dialog markup with synthetic labels; no camera, file or VM API.
    await f.evaluate(() => {
      for (const id of ['phone-camera-config', 'phone-camera-source-tabs', 'phone-camera-tab-image', 'phone-camera-tab-browser', 'phone-camera-tab-video', 'phone-camera-tab-usb']) document.getElementById(id).hidden = false;
      document.getElementById('phone-camera-unavailable').hidden = true;
      document.getElementById('phone-camera-hint').textContent = '为当前手机选择画面来源。切换来源不需要重启手机。';
      document.getElementById('phone-camera-consent').nextElementSibling.textContent = '允许将所选图片作为当前手机的摄像头画面。';
      document.getElementById('phone-camera-dialog').showModal();
    });
    await shot('phone-camera-image'); await mobile('phone-camera-image-mobile'); await page.keyboard.press('Escape');
    await f.evaluate(() => {
      document.getElementById('phone-file-status').textContent = '文件尚未传入，请稍后重试。所选文件已保留。';
      document.getElementById('phone-files-dialog').showModal();
    });
    await shot('phone-files-error'); await mobile('phone-files-error-mobile'); await page.keyboard.press('Escape');
  }
  if (section === 'casting') {
    for (casting of ['waiting', 'disconnected']) {
      await goto('/apps/wireless-casting');
      const f = await page.locator('iframe').elementHandle().then(el => el.contentFrame());
      await f.locator('#session-detail').waitFor();
      if (casting === 'disconnected') await f.locator('#source-feedback').waitFor();
      await shot(`casting-${casting}`); await mobile(`casting-${casting}-mobile`);
      await f.locator('#open-more').click(); await f.locator('#cast-more[open]').waitFor();
      await shot(`casting-${casting}-settings`);
    }
  }
  if (!section || section === 'native') {
    for (const app of ['virtual-phones', 'virtual-computers']) {
      await goto(`/apps/${app}`);
      const f = await page.locator('iframe').elementHandle().then(el => el.contentFrame());
      await f.locator('#create:not(:disabled)').click();
      await f.locator('#editor[open]').waitFor(); await f.locator('#name').fill('未提交的设计草稿');
      await shot(`${app}-create`); await mobile(`${app}-create-mobile`);
      await f.locator('#cancel').click(); await f.locator('#editor').waitFor({ state: 'hidden' });
      // Native close restores the actual opener; no create or shutdown request.
      assert.equal(await f.locator('#create').evaluate(el => el === document.activeElement), true);
    }
  }
  if (!section || section === 'assistant') {
    await goto('/apps/assistant');
    await page.locator('.assistant-confirmation').waitFor();
    await page.getByRole('button', { name: '查看并确认' }).click();
    const d = page.locator('dialog[open]'); await d.waitFor();
    assert.match(await d.innerText(), /团队协作计划.md/);
    await shot('assistant-confirmation'); await mobile('assistant-confirmation-mobile');
    await page.keyboard.press('Escape'); await d.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '查看并确认' }).evaluate(el => el === document.activeElement), true);
    await shot('assistant-failed-preserved');
  }
  if (!section || section === 'management') {
    await goto('/admin/audit');
    await page.locator('.audit-event summary').first().click();
    await page.locator('.audit-event[open]').waitFor(); await shot('audit-details'); await mobile('audit-details-mobile');
    await goto('/admin/updates');
    await page.locator('.maintenance-plan-card').first().click();
    const execute = page.locator('.maintenance-execute'); await execute.waitFor();
    assert.equal(await execute.locator('button').isDisabled(), true);
    await execute.scrollIntoViewIfNeeded(); await shot('update-confirmation'); await mobile('update-confirmation-mobile');
    failure = true; await page.reload(); await page.locator('.maintenance-empty.is-error').waitFor(); await shot('update-unavailable'); failure = false;
  }
  if (!section || section === 'auth') {
    auth = 'setup'; await page.goto('http://127.0.0.1:4179/'); await page.locator('#setup-token').waitFor();
    await shot('auth-setup'); await mobile('auth-setup-mobile');
    for (const [id, value] of Object.entries({ 'setup-token': 'SYNTHETIC-NOT-VALID-LOCAL-FIXTURE-ONLY', 'setup-login-name': 'ui-example', 'setup-display-name': '设计示例', 'setup-password': 'synthetic-not-real', 'setup-password-confirmation': 'synthetic-not-real' })) await page.locator(`#${id}`).fill(value);
    await page.locator('.auth-form [type=submit]').click();
    await page.locator('.setup-recovery__codes').waitFor(); await shot('auth-recovery-codes'); await mobile('auth-recovery-codes-mobile');
    auth = 'anonymous'; await page.reload(); await page.locator('.owner-recovery-entry').click();
    await page.locator('.owner-recovery').waitFor(); await shot('auth-owner-recovery'); await mobile('auth-owner-recovery-mobile');
    auth = 'unavailable'; await page.reload(); await page.locator('.auth-state[role=alert]').waitFor(); await shot('auth-unavailable');
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.ok(writes.every(path => ['/api/setup/owner', '/api/auth/owner-recovery/challenge'].includes(path)), JSON.stringify(writes));
  console.log(JSON.stringify({ views, syntheticWrites: writes, errors, external }));
});
