import test from 'node:test';
import assert from 'node:assert/strict';
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
