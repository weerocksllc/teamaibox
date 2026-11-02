import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { applicationPluginSharedAsset } from '../../../packages/application-plugin-runtime/src/static-server.mjs';

const source = path => readFile(new URL(path, import.meta.url), 'utf8');

test('Focus layouts load after compatibility styles and use local semantic assets', async () => {
  const main = await source('../src/main.tsx');
  assert.ok(main.indexOf('./focus-workspace.css') > main.indexOf('./premium-workspace.css'));
  const css = await source('../src/focus-workspace.css');
  assert.doesNotMatch(css, /https?:\/\/|@import|url\(/);
  assert.match(css, /--sidebar-width: 224px/);
  assert.match(css, /max-width: 820px/);
  assert.match(css, /minmax\(0, 1fr\)/);
  assert.match(css, /\.global-search-trigger kbd \{ white-space: nowrap/);
  assert.ok((await stat(new URL('../public/brand/mascot.png', import.meta.url))).size > 0);
});

test('Assistant keeps native form, caller-owned controls and inline results', async () => {
  const ui = await source('../src/assistant/AssistantWorkspace.tsx');
  assert.match(ui, /<form className="assistant-workspace__composer" onSubmit=\{send\}/);
  assert.match(ui, /className="assistant-compose-input"[^>]+value=\{prompt\}/);
  assert.ok(ui.indexOf('className="assistant-compose-input"') < ui.indexOf('className="assistant-compose-row"'));
  assert.match(ui, /<Button type="submit" variant="primary"/);
  assert.match(ui, /message\.artifacts\.map/);
  assert.match(ui, /message\.sources\.map/);
  assert.doesNotMatch(ui, /assistant-result-pane/);
  const app = await source('../src/App.tsx');
  assert.match(app, /<AppearancePreferences locale=\{locale\} theme=\{themePreference\} onLocaleChange=\{changeLocale\} onThemeChange=\{changeTheme\}/);
});

test('Drawing keeps all handler IDs and pins the real submit outside parameter scrolling', async () => {
  const html = await source('../../drawing-plugin/src/public/index.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate controls or live regions');
  for (const id of ['drawing-form','prompt','intent-grid','route-disclosure','size','seed','format','count','steps','guidance','form-error','submit','empty-state','job-view','job-status','cancel-job','progress-bar','job-detail','result-error','gallery','metadata']) assert.ok(ids.includes(id), id);
  const dock = html.slice(html.indexOf('<div class="drawing-action-dock">'), html.indexOf('</form>'));
  assert.match(dock, /id="submit"[^>]+type="submit" disabled/);
  assert.doesNotMatch(dock, /id="(?:prompt|size|form-error)"/);
  const css = applicationPluginSharedAsset('ui-system.css').body.toString();
  assert.match(css, /\.drawing-controls-scroll[^}]+overflow: auto/);
  assert.match(css, /\.drawing-action-dock[^}]+flex: 0 0 auto/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  // Preview imagery and themed filters must never replace guest pixels.
  assert.doesNotMatch(css, /(?:#phone-video|#screen)[^{]*\{[^}]*(?:filter:|object-fit:\s*cover)/);
});
