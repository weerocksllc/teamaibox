import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applicationPluginSharedAsset } from '../../application-plugin-runtime/src/static-server.mjs';

const root = new URL('../../../', import.meta.url);
const css = applicationPluginSharedAsset('ui-system.css').body.toString();

for (const app of ['ocr', 'asr', 'translation']) {
  test(`${app} keeps existing controls while separating scrolling and action regions`, async () => {
    const html = await readFile(new URL(`apps/${app}-plugin/src/public/index.html`, root), 'utf8');
    assert.match(html, /class="[^"]*focus-tool-shell/);
    assert.match(html, /class="workspace focus-tool-layout"/);
    assert.match(html, /class="[^"]*focus-tool-controls"/);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate handler IDs');
    for (const id of ['file','form-error','submit','empty','job','status','cancel','export']) assert.ok(ids.includes(id), id);
    const dockIndex = html.indexOf('<div class="focus-action-dock">');
    assert.ok(dockIndex > html.indexOf('class="focus-controls-scroll"'));
    assert.ok(html.indexOf('id="form-error"') < dockIndex, 'error does not displace the fixed action');
    assert.ok(html.indexOf('id="submit"') > dockIndex);
    assert.ok(html.indexOf('id="submit"') < html.indexOf('</aside>', dockIndex));
    assert.match(html, /id="submit"[^>]+type="button"/);
    assert.match(html, /data-source="(?:upload|text)"/);
    assert.match(html, /data-source="drive"/);
  });
}

test('ASR action visibility follows the existing batch/live view state', async () => {
  const html = await readFile(new URL('apps/asr-plugin/src/public/index.html', root), 'utf8');
  assert.match(html, /id="live-view"[^>]+hidden/);
  assert.match(html, /id="live-toggle"/);
  assert.match(html, /id="submit"[^>]+disabled aria-busy="false"/);
  assert.match(css, /\.focus-tool-controls:has\(#batch-controls\[hidden\]\) > \.focus-action-dock \{ display: none/);
});

test('tool layouts use semantic surfaces and have a natural-flow narrow-screen fallback', () => {
  assert.match(css, /\.focus-controls-scroll[^}]+overflow: auto/);
  assert.match(css, /\.focus-action-dock[^}]+flex: 0 0 auto/);
  assert.match(css, /@media \(max-width: 900px\), \(max-height: 540px\)/);
  assert.match(css, /\.focus-tool-shell \{ height: auto; min-height: 100dvh; overflow: visible/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('closed conversation details follow the same breakpoint as the two-column layout', () => {
  assert.match(css, /@media \(max-width: 1120px\)[\s\S]*?\.details-pane[^}]+visibility: hidden; pointer-events: none/);
  assert.match(css, /\.details-pane\.is-open \{[^}]+visibility: visible; pointer-events: auto/);
  assert.match(css, /:root\[dir=rtl\][^}]+\.details-pane:not\(\.is-open\)[^}]+translateX\(-105%\)/);
});
