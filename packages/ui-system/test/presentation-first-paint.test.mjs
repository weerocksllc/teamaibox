import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applyProductLabels } from '../src/product-localization.mjs';
import { localeDefinitions } from '../src/locale-registry.mjs';

const apps = ['messaging','team-drive','drawing','ocr','asr','translation','wireless-casting','virtual-phones','virtual-computers'];
function documentFixture(app) {
  const messages = [];
  const label = { dataset: { uiCopy: 'Cancel', uiCopyZh: '取消' }, textContent: '取消' };
  const doc = { documentElement: { lang: 'zh-CN', dir: 'ltr', dataset: {} }, body: { dataset: { uiApp: app } },
    querySelectorAll(selector) { return selector === '[data-ui-copy]' ? [label] : []; },
    defaultView: { location: { origin: 'https://box.invalid' }, parent: { postMessage(message, origin) { messages.push({message, origin}); } } } };
  return { doc, label, messages };
}
test('all nine application surfaces publish only after synchronous localization, for every UI language', async () => {
  for (const app of apps) for (const {code, direction} of localeDefinitions) {
    const {doc, messages} = documentFixture(app);
    applyProductLabels(doc, code);
    assert.equal(doc.documentElement.lang, code);
    assert.equal(doc.documentElement.dir, direction);
    assert.equal(messages.length, 0, 'must not reveal unfinished labels');
    assert.equal(doc.documentElement.dataset.uiPresentedLocale, undefined);
    await Promise.resolve();
    assert.equal(doc.documentElement.dataset.uiPresentedLocale, code);
    assert.deepEqual(messages, [{message: {type:'teamaibox.plugin-presentation-ready/v1',pluginId:`official.${app}`,locale:code},origin:'https://box.invalid'}]);
  }
});
test('a newer locale suppresses a stale first-paint notification; standalone pages do not post', async () => {
  const {doc,messages} = documentFixture('virtual-computers');
  applyProductLabels(doc,'en'); applyProductLabels(doc,'ja'); await Promise.resolve();
  assert.deepEqual(messages.map(x=>x.message.locale),['ja']);
  doc.defaultView.parent=doc.defaultView;
  applyProductLabels(doc,'ar'); await Promise.resolve();
  assert.equal(messages.length,1); assert.equal(doc.documentElement.dataset.uiPresentedLocale,'ar');
});
test('every bundled index declares its UI identity and initial localization hook', async () => {
  for (const app of apps) {
    const root = new URL(`../../../apps/${app}-plugin/src/public/`,import.meta.url);
    const html = await readFile(new URL('index.html',root),'utf8');
    assert.ok(html.includes(`data-ui-app="${app}"`), app);
    const js = await readFile(new URL(app==='virtual-computers'?'computers.mjs':'app.js',root),'utf8');
    assert.ok(js.includes('applyProductLabels(document,'), app);
  }
});
test('host hides untranslated frames without unmounting, and exposes a retry on load failure', async () => {
  const source=await readFile(new URL('../../../apps/web/src/applications/DynamicApplicationWorkspace.tsx',import.meta.url),'utf8');
  const css=await readFile(new URL('../../../apps/web/src/styles.css',import.meta.url),'utf8');
  assert.match(source,/event\.source !== frame\.current\?\.contentWindow/);
  assert.match(source,/event\.data\?\.locale === compatibility\.effective\.locale/);
  assert.match(source,/data-presentation=\{presentationReady \? "ready" : "loading"\}/);
  assert.match(source,/initialSource = useRef/);
  assert.match(source,/applications\.retry/);
  assert.match(css,/frame\[data-presentation="loading"\] \{ visibility: hidden; \}/);
  const computer=await readFile(new URL('../../../apps/virtual-computers-plugin/src/public/computers.mjs',import.meta.url),'utf8');
  assert.match(computer,/normalizeProductLocale\(new URLSearchParams\(location.search\)\.get\('locale'\)/);
});
