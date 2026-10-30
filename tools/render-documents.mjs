import fs from 'node:fs/promises';
import path from 'node:path';
import { root, manifest, languages, localizedPath, sourceBody, blocks, hash, localizeLinks, navigation } from './document-localization.mjs';

const check = process.argv.includes('--check');
const catalogs = new Map();
for (const locale of languages) {
  catalogs.set(locale.code, JSON.parse(await fs.readFile(path.join(root, `docs/document-locales/${locale.code}.json`), 'utf8')));
}
let count = 0;
const outputs = [];
for (const doc of manifest.documents) {
  const body = sourceBody(await fs.readFile(path.join(root, doc.path), 'utf8'), doc.path);
  for (const locale of languages) {
    const translated = blocks(body).map(block => {
      if (!block.translate || locale.code === doc.sourceLocale) return block.text;
      const text = catalogs.get(locale.code).messages[hash(block.text)];
      if (!text?.trim()) throw new Error(`${doc.path} (${locale.code}): missing translation ${hash(block.text)}`);
      return block.text.match(/^\s*/)[0] + text.trim() + block.text.match(/\s*$/)[0];
    }).join('');
    const content = localizeLinks(translated, doc.path, locale.code);
    const output = navigation(doc, locale.code) + content;
    const target = path.join(root, localizedPath(doc.path, locale.code));
    if (check) {
      if (await fs.readFile(target, 'utf8') !== output) throw new Error(`${target} is out of date`);
    } else outputs.push({target, output});
    count++;
  }
}
// Resolve every language before replacing any rendered page.
for (const {target, output} of outputs) await fs.writeFile(target, output);
console.log(`${check ? 'Verified' : 'Rendered'} ${count} document editions across ${languages.length} languages.`);
