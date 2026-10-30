import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, sign, verify } from 'node:crypto';
import { publisherKey } from './plugin-publisher.mjs';

test('publisher initialization is idempotent: two releases retain one signing identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'publisher-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'key.pem');
  await assert.rejects(publisherKey(path), { code: 'ENOENT' });
  const first = await publisherKey(path, { initialize: true });
  const bytes = await readFile(path);
  const second = await publisherKey(path, { initialize: true });
  assert.deepEqual(await readFile(path), bytes);
  for (const [key, value] of [[first, 'page release 1'], [second, 'page release 2']]) {
    const payload = Buffer.from(value);
    assert.equal(verify(null, payload, createPublicKey(first), sign(null, payload, key)), true);
  }
  assert.equal(verify(null, Buffer.from('modified'), createPublicKey(first), sign(null, Buffer.from('original'), second)), false);
});

test('publisher rejects public key files and symlinks instead of silently replacing a key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'publisher-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'key.pem'); await publisherKey(path, { initialize: true });
  await chmod(path, 0o644); await assert.rejects(publisherKey(path), /private owned/);
  await chmod(path, 0o600); await symlink(path, join(dir, 'link.pem'));
  await assert.rejects(publisherKey(join(dir, 'link.pem')));
  await chmod(dir, 0o755); await assert.rejects(publisherKey(path), /private and owned/);
});
