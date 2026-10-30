import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, manifest, documents, languages, readmePath, localizedPath, canonicalPath, sourceBody, blocks, hash, navigation } from './document-localization.mjs';

for (const script of ['render-documents.mjs', 'render-readmes.mjs']) {
  const result = spawnSync(process.execPath, [path.join(root, 'tools', script), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  process.stdout.write(result.stdout);
}
assert.equal(documents.size, manifest.documents.length, 'Duplicate documentation manifest entries');
const sorted = values => [...values].sort();
const inlineCode = text => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
const fences = text => blocks(text).filter(b => /^\s*```/.test(b.text)).map(b => b.text);
const links = text => [...text.matchAll(/\]\(([^\s)]+)\)/g)].map(m => m[1]);
let checkedLinks = 0;
for (const locale of languages) {
  const readme=await fs.readFile(path.join(root,readmePath(locale.code)), 'utf8');
  const expectedSwitches=languages.map(l=>`[${l.name}](${readmePath(l.code)})`).join(' · ');
  assert.ok(readme.split('\n').includes(expectedSwitches), `${locale.code}: README language destinations are incorrect`);
  const catalog = JSON.parse(await fs.readFile(path.join(root, `docs/document-locales/${locale.code}.json`), 'utf8'));
  assert.equal(catalog.locale, locale.code);
  for (const doc of manifest.documents) {
    const original = sourceBody(await fs.readFile(path.join(root, doc.path), 'utf8'), doc.path);
    if (locale.code !== doc.sourceLocale) {
      for (const block of blocks(original).filter(b => b.translate)) {
        const translated = catalog.messages[hash(block.text)];
        assert.ok(translated?.trim(), `${doc.path} (${locale.code}): missing paragraph`);
        assert.deepEqual(sorted(inlineCode(translated)), sorted(inlineCode(block.text)), `${doc.path} (${locale.code}): code changed`);
        assert.deepEqual(sorted(links(translated)), sorted(links(block.text)), `${doc.path} (${locale.code}): translation changed a URL`);
        assert.equal((translated.match(/^#{1,6} /gm) || []).length, (block.text.match(/^#{1,6} /gm) || []).length,
          `${doc.path} (${locale.code}): heading structure changed`);
        assert.equal((translated.match(/\|/g) || []).length, (block.text.match(/\|/g) || []).length,
          `${doc.path} (${locale.code}): table structure changed`);
        assert.equal((translated.match(/^\s*(?:[-*+] |\d+\. )/gm) || []).length,
          (block.text.match(/^\s*(?:[-*+] |\d+\. )/gm) || []).length,
          `${doc.path} (${locale.code}): list structure changed in ${hash(block.text)}`);
      }
    }
    const target = localizedPath(doc.path, locale.code);
    const rendered = await fs.readFile(path.join(root, target), 'utf8');
    assert.ok(rendered.startsWith(navigation(doc, locale.code)), `${target}: language switch is missing or points at another document`);
    assert.deepEqual(fences(rendered), fences(original), `${target}: executable example changed`);
    assert.ok(!/ZXQ[PBR]\d+/.test(rendered), `${target}: unresolved translation placeholder`);
    if (!['zh-CN', 'zh-TW', 'ja'].includes(locale.code)) {
      assert.ok(!/[\u4e00-\u9fff]/u.test(sourceBody(rendered)), `${target}: untranslated Chinese text`);
    }
  }
  for (const file of [readmePath(locale.code), ...manifest.documents.map(d => localizedPath(d.path, locale.code))]) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    // Language selectors intentionally cross locales; content and home links must not.
    const prose = sourceBody(text).replace(/^\[English\].*$/m, '');
    for (const href of links(prose)) {
      if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
      const [destination, fragment] = href.split('#');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), destination));
      assert.ok(!resolved.startsWith('../'), `${file}: link escapes repository`);
      await fs.access(path.join(root, resolved));
      if (!destination.endsWith('.md')) continue;
      assert.equal(resolved, localizedPath(canonicalPath(resolved), locale.code), `${file}: cross-language content link ${href}`);
      if (fragment) {
        const targetText = await fs.readFile(path.join(root, resolved), 'utf8');
        assert.ok(targetText.includes(`id="${fragment}"`), `${file}: missing stable anchor ${href}`);
      }
      checkedLinks++;
    }
  }
}
console.log(`Checked ${checkedLinks} same-language document links, all switch targets, paragraph coverage, code examples and stable anchors.`);
