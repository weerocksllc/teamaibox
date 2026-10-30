import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translationLanguages, translationLanguageName, translationLanguageSummary, populateTranslationLanguages } from '../src/public/translation-languages.mjs';
import { supportedLocaleCodes } from '../../../packages/ui-system/src/locale-registry.mjs';
import { readFile } from 'node:fs/promises';

const officialCodes = 'ar en es de fr it ja nl pl pt ru tr zh bg bn cs da el fa fi hi hu id ko nb ro sk sv th uk vi am az bo he hr hy is jv ka kk km ky lo mvf mr ms my ne ps si sw ta te tg tl ug ur uz yue'.split(' ');

function select(value = '') {
  return { value, options: [], ownerDocument: { createElement: () => ({ value: '', textContent: '' }) }, replaceChildren(...options) { this.options = options; this.value = options[0]?.value ?? ''; } };
}

test('catalog matches all 60 published model languages, independently of UI locales', () => {
  assert.equal(translationLanguages.length, 60);
  assert.equal(new Set(translationLanguages.map(item => item.code)).size, 60);
  assert.deepEqual(translationLanguages.map(item => item.code === 'zh-CN' ? 'zh' : item.code).sort(), officialCodes.sort());
  for (const item of translationLanguages) {
    assert.match(item.code, /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/);
    assert.ok(item.nativeName && item.englishName);
  }
  assert.ok(translationLanguages.some(item => item.code === 'sw') && !supportedLocaleCodes.includes('sw'));
});

test('source has auto plus 60 languages; target has 60 and defaults to English', () => {
  const source = select(), target = select();
  populateTranslationLanguages(source, target, { locale: 'zh-CN', autoLabel: '自动检测' });
  assert.equal(source.options.length, 61);
  assert.equal(target.options.length, 60);
  assert.equal(source.value, ''); assert.equal(target.value, 'en');
  assert.equal(source.options[0].textContent, '自动检测');
  assert.deepEqual(source.options.slice(1), target.options);
});

test('all interface locales give readable names and keep selected translation languages', () => {
  const source = select('yue'), target = select('mvf');
  for (const locale of supportedLocaleCodes) {
    populateTranslationLanguages(source, target, { locale });
    assert.equal(source.value, 'yue'); assert.equal(target.value, 'mvf');
    assert.equal(target.options.length, 60);
    assert.ok(translationLanguageSummary(locale).includes(new Intl.NumberFormat(locale).format(60)));
    for (const item of translationLanguages) assert.notEqual(translationLanguageName(item.code, locale), item.code);
  }
  assert.equal(translationLanguageName('mvf', 'zh-CN'), '内蒙古蒙古语');
  assert.equal(translationLanguageName('no', 'en'), translationLanguageName('nb', 'en'));
  assert.equal(translationLanguageName('mn_cn', 'en'), 'Inner Mongolian');
});

test('one shared selector pair is outside text/file/drive panels; request fields stay unchanged', async () => {
  const html = await readFile(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.equal((html.match(/id="source-language"/g) ?? []).length, 1);
  assert.equal((html.match(/id="target-language"/g) ?? []).length, 1);
  assert.match(html, /<\/section>\s*<div class="language-row">/);
  assert.match(app, /target_language:\$\("#target-language"\)\.value/);
  assert.match(app, /body\.source_language=\$\("#source-language"\)\.value/);
  assert.match(app, /populateTranslationLanguages\(/);
  assert.doesNotMatch(app.match(/function sourceMode\(mode\)\{[^\n]*/)?.[0] ?? '', /populateTranslationLanguages|language.*\.value/);
});
