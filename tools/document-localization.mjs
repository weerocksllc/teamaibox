import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { localeDefinitions } from '../packages/ui-system/src/locale-registry.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const languages = [...localeDefinitions].sort((a, b) => a.code === 'en' ? -1 : b.code === 'en' ? 1 : 0);
export const manifest = JSON.parse(await fs.readFile(path.join(root, 'docs/document-locales/manifest.json'), 'utf8'));
export const documents = new Map(manifest.documents.map(doc => [doc.path, doc]));
export const hash = text => createHash('sha256').update(text).digest('hex');
export const readmePath = locale => locale === 'en' ? 'README.md' : `README.${locale}.md`;
export function localizedPath(file, locale) {
  if (file === 'README.md') return readmePath(locale);
  const doc = documents.get(file);
  if (!doc) throw new Error(`Markdown destination has no translation contract: ${file}`);
  return locale === doc.sourceLocale ? file : file.replace(/\.md$/, `.${locale}.md`);
}
export function canonicalPath(file) {
  if (/^README(?:\.[\w-]+)?\.md$/.test(file)) return 'README.md';
  for (const doc of manifest.documents) {
    if (file === doc.path || languages.some(l => localizedPath(doc.path, l.code) === file)) return doc.path;
  }
  return file;
}
export function sourceBody(text, from) {
  const body = text.replace(/^<!-- doc-navigation:start -->[\s\S]*?<!-- doc-navigation:end -->\n\n/, '');
  if (!from) return body;
  return body.replace(/(\]\()([^\s)]+)(\))/g, (all, before, href, after) => {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) return all;
    const [target, fragment = ''] = href.split('#');
    if (!target.endsWith('.md')) return all;
    const canonical = canonicalPath(path.posix.normalize(path.posix.join(path.posix.dirname(from), target)));
    return `${before}${path.posix.relative(path.posix.dirname(from), canonical)}${fragment ? '#' + fragment : ''}${after}`;
  });
}
// Preserve whitespace, executable examples and paragraph order independently of prose.
export function blocks(text) {
  return text.split(/(^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*(?:\n|$)|\n\s*\n)/m)
    .filter(Boolean).map(value => ({ text: value, translate: Boolean(value.trim()) && !/^\s*```/.test(value) }));
}
export function localizeLinks(text, from, locale) {
  return text.replace(/(\]\()([^\s)]+)(\))/g, (all, before, href, after) => {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) return all;
    const [target, fragment = ''] = href.split('#');
    if (!target.endsWith('.md')) return all;
    const canonical = canonicalPath(path.posix.normalize(path.posix.join(path.posix.dirname(from), target)));
    const localized = localizedPath(canonical, locale);
    const relative = path.posix.relative(path.posix.dirname(from), localized);
    return `${before}${relative}${fragment ? '#' + fragment : ''}${after}`;
  });
}
export function navigation(doc, locale) {
  const file = localizedPath(doc.path, locale);
  // This source template is also copied into offline bundles. Absolute links avoid
  // dangling checkout-relative paths there; the installation instructions stay local.
  const link = target => doc.portable ? `https://github.com/weerocksllc/teamaibox/blob/main/${target}`
    : path.posix.relative(path.posix.dirname(file), target);
  const switches = languages.map(l => `[${l.name}](${link(localizedPath(doc.path, l.code))})`).join(' · ');
  return `<!-- doc-navigation:start -->\n${switches}\n\n[Team AI Box — README](${link(readmePath(locale))})\n<!-- doc-navigation:end -->\n\n`;
}
