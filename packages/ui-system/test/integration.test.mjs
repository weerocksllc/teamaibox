import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { applicationPluginSharedAsset } from '../../application-plugin-runtime/src/static-server.mjs';

const root = new URL('../../../', import.meta.url);
const source = path => readFile(new URL(path, root), 'utf8');
const apps = ['asr', 'drawing', 'messaging', 'ocr', 'team-drive', 'translation', 'virtual-computers', 'virtual-phones', 'wireless-casting'];

test('all standalone application entry points load the same local UI stylesheet last', async () => {
  for (const app of apps) {
    const html = await source(`apps/${app}-plugin/src/public/index.html`);
    assert.match(html, new RegExp(`data-ui-app="${app}"`));
    const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(v => v[0]);
    assert.ok(styles.at(-1).includes(`/plugins/official.${app}/ui-system.css`), app);
  }
  const desktop = await source('apps/virtual-computers-plugin/src/public/desktop.html');
  assert.match(desktop, /data-ui-app="virtual-desktop"/);
  assert.match(desktop, /official\.virtual-computers\/ui-system\.css/);
});

test('shared stylesheet is a local static asset and preserves native hidden states', () => {
  const asset = applicationPluginSharedAsset('ui-system.css');
  assert.equal(asset.contentType, 'text/css; charset=utf-8');
  const css = asset.body.toString();
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /data-plugin-preference-revision/);
  assert.doesNotMatch(css, /@import\b|url\(\s*["']?https?:\/\//);
  assert.equal(applicationPluginSharedAsset('not-an-asset.css'), null);
});

test('plugin and web image recipes carry the newly required shared presentation files', async () => {
  for (const app of apps) {
    for (const file of [`apps/${app}-plugin/Dockerfile`, `deploy/appliance/${app}-plugin.Dockerfile`]) {
      assert.match(await source(file), /COPY[^\n]+packages\/ui-system\//, file);
    }
  }
  // The public installer builds this recipe; the historical private e2e
  // deployment harness is not part of the public source distribution.
  for (const file of ['deploy/images/web.Dockerfile']) {
    const dockerfile = await source(file);
    assert.ok(dockerfile.indexOf('packages/ui-system/package.json') < dockerfile.indexOf('install --frozen-lockfile'), file);
    assert.match(dockerfile, /COPY packages\/ui-system (?:\.\/)?packages\/ui-system/);
  }
});

test('React primitives are presentation-only, with caller-owned submission and values', async () => {
  const code = await source('packages/ui-system/src/components.tsx');
  assert.doesNotMatch(code, /\bfetch\s*\(|WebSocket|EventSource|setInterval|localStorage|sessionStorage/);
  assert.match(code, /disabled=\{disabled \|\| busy\}/);
  assert.match(code, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(code, /aria-invalid/);
  assert.match(code, /aria-describedby/);
});
