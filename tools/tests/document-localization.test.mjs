import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { root, languages, readmePath } from '../document-localization.mjs';
import { blocks, canonicalPath, localizeLinks, navigation, sourceBody } from '../document-localization.mjs';

test('nested and root links stay in the selected language', () => {
  assert.equal(localizeLinks('[Install](../../install/README.md) [Home](../../README.md#install)', 'docs/open-source/BUILDING.md', 'ja'),
    '[Install](../../install/README.ja.md) [Home](../../README.ja.md#install)');
  assert.equal(localizeLinks('[Package](PACKAGE-README.md)', 'install/README.md', 'en'), '[Package](PACKAGE-README.en.md)');
  assert.equal(localizeLinks('[Package](PACKAGE-README.md)', 'install/README.md', 'zh-CN'), '[Package](PACKAGE-README.md)');
});
test('URLs, assets and legal license originals are not rewritten', () => {
  const input = '[Web](https://example.com/README.md) [License](LICENSE) [Image](image.jpg) [Data](components.json)';
  assert.equal(localizeLinks(input, 'README.md', 'ja'), input);
});
test('unregistered downstream Markdown fails instead of falling back', () => {
  assert.throws(() => localizeLinks('[Missing](missing.md)', 'README.md', 'de'), /no translation contract/);
});
test('canonical reading is stable across repeated renders', () => {
  const doc = {path: 'install/README.md', sourceLocale: 'en'};
  const body = '# Install\n\n[Package](PACKAGE-README.md)\n';
  const rendered = navigation(doc, 'en') + localizeLinks(body, doc.path, 'en');
  assert.equal(sourceBody(rendered, doc.path), body);
  assert.equal(canonicalPath('install/README.ja.md'), doc.path);
});
test('paragraph splitter preserves shell examples and spacing exactly', () => {
  const source = '# Install\n\nText.\n\n   ```sh\n   echo "keep unchanged"\n   ```\n\nEnd.\n';
  const result = blocks(source);
  assert.equal(result.map(b => b.text).join(''), source);
  assert.equal(result.filter(b => !b.translate && b.text.includes('echo')).length, 1);
});
test('portable package navigation targets the same document in all languages', () => {
  const text = navigation({path: 'install/PACKAGE-README.md', sourceLocale: 'zh-CN', portable: true}, 'en');
  assert.ok(text.includes('/install/PACKAGE-README.ja.md'));
  assert.ok(text.includes('/install/PACKAGE-README.en.md'));
  assert.ok(text.includes('/blob/main/README.md'));
});

test('rendered README selectors retain every language destination while body links follow the reader', async () => {
  const expected=languages.map(l=>`[${l.name}](${readmePath(l.code)})`).join(' · ');
  for(const locale of languages){
    const text=await fs.readFile(path.join(root,readmePath(locale.code)), 'utf8');
    assert.ok(text.split('\n').includes(expected), locale.code);
    const suffix=locale.code==='en'?'':`.${locale.code}`;
    assert.ok(text.includes(`](install/SOURCE-INSTALL${suffix}.md)`),locale.code);
  }
});

test('DGX Spark descriptions cover every product language with qualified hardware claims', async () => {
  const copy=JSON.parse(await fs.readFile(path.join(root,'docs/readme-locales/dgx-spark.json'),'utf8'));
  assert.deepEqual(Object.keys(copy).sort(),languages.map(l=>l.code).sort());
  for(const {code} of languages){
    const t=copy[code];
    assert.deepEqual(Object.keys(t).sort(),Object.keys(copy.en).sort());
    for(const value of Object.values(t))assert.ok(typeof value==='string'&&value.trim(),code);
    for(const token of ['GB10','20','128','273 GB/s','FP4','1 PFLOP'])assert.ok(t.hardwareBody.includes(token),`${code}: ${token}`);
    assert.ok(t.independence.includes('Weerocks LLC'));
    const readme=await fs.readFile(path.join(root,readmePath(code)),'utf8');
    for(const key of ['hardwareBody','hardwareNote','independence'])assert.ok(readme.includes(t[key]),`${code}: ${key}`);
  }
});
