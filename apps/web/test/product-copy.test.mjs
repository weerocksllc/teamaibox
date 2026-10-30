import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseSync } from '../../../node_modules/.pnpm/node_modules/rolldown/dist/utils-index.mjs';
import { zhCN, en } from '../src/i18n.ts';
import { shellCopy } from '../../../tools/refine_product_copy.mjs';

const root = new URL('../../../', import.meta.url);
// Historical copy-only review is opt-in; public clones do not contain the
// private development history. Set an available base for a new copy-only PR.
const base = process.env.PRODUCT_COPY_REVIEW_BASE;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const files = base ? git('diff', '--name-only', base, '--', 'apps').trim().split('\n').filter(path => /^apps\/[^/]+\/src\//.test(path)) : [];
const placeholders = value => [...value.matchAll(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g)].map(x => x[0]).sort();
function compare(a, b, path, field = '') {
  if (a === b) return;
  if (Array.isArray(a)) { assert.equal(b.length, a.length, path); return a.forEach((x, i) => compare(x, b[i], path + '[' + i + ']')); }
  if (a && typeof a === 'object') {
    assert.equal(b?.type, a.type, path);
    if (a.type === 'Literal' && typeof a.value === 'string') {
      if (a.value !== b.value) {
        assert.notEqual(field, 'key', path + ' changed key');
        assert.ok(!/^(?:\/api\/|https?:|[a-z0-9_.:-]+$)/.test(a.value), path + ' identifier');
        assert.deepEqual(placeholders(b.value), placeholders(a.value), path + ' placeholders');
      }
      return;
    }
    if (a.type === 'TemplateElement') {
      assert.deepEqual(placeholders(b.value.raw), placeholders(a.value.raw), path + ' template variables');
      assert.equal(b.tail, a.tail); return;
    }
    const keys = value => Object.keys(value).filter(k => !['start', 'end', 'loc', 'raw'].includes(k));
    assert.deepEqual(keys(b), keys(a), path);
    for (const key of keys(a)) compare(a[key], b[key], path + '.' + key, key);
    return;
  }
  assert.equal(b, a, path);
}

test('reviewed shell copy is present in both languages with matching variables', () => {
  for (const [key, [zh, english]] of Object.entries(shellCopy)) {
    assert.equal(zhCN[key], zh, key); assert.equal(en[key], english, key);
    assert.deepEqual(placeholders(zh), placeholders(english), key);
  }
  assert.deepEqual(Object.keys(zhCN).sort(), Object.keys(en).sort());
});

test('application changes are display strings only; code, keys and variables are unchanged', { skip: !base && 'set PRODUCT_COPY_REVIEW_BASE for a copy-only review' }, () => {
  assert.ok(files.length > 0, 'review must include changed application source');
  for (const path of files) {
    const old = git('show', base + ':' + path), current = readFileSync(new URL(path, root), 'utf8');
    if (/\.[cm]?[jt]sx?$/.test(path)) {
      const before = parseSync(path, old), after = parseSync(path, current);
      assert.equal(after.errors.length, 0, path + ' syntax');
      compare(before.program, after.program, path);
    } else if (path.endsWith('.html')) {
      const shape = text => text.replace(/\b(aria-label|title|placeholder)="[^"]*"/g, '$1="DISPLAY"').replace(/>[^<]*</g, '><');
      assert.equal(shape(current), shape(old), path + ' markup structure');
      assert.deepEqual(placeholders(current), placeholders(old), path + ' placeholders');
    } else assert.fail('Unexpected application file changed: ' + path);
  }
});

test('destructive consequences and compatibility details remain explicit', () => {
  const cleanup = readFileSync(new URL('apps/messaging-plugin/src/public/message-cleanup.mjs', root), 'utf8');
  assert.match(cleanup, /不会删除对方的记录，也不会退出群聊/);
  assert.match(cleanup, /收到新消息后，聊天会重新出现/);
  const camera = readFileSync(new URL('apps/virtual-phones-plugin/src/public/phone-camera.mjs', root), 'utf8');
  assert.match(camera, /外部 UDP 推流不加密/); assert.match(camera, /MP4（H\.264）/);
  const phone = readFileSync(new URL('apps/virtual-phones-plugin/src/public/app.js', root), 'utf8');
  assert.match(phone, /Google Play/);
  assert.match(phone, /不代表设备认证或应用兼容保证/);
  assert.match(readFileSync(new URL('apps/wireless-casting-plugin/src/public/app.js', root), 'utf8'), /DRM/);
});
