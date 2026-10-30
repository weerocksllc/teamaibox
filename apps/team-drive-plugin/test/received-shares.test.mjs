import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { receivedEntries, canEditShared } from '../src/public/received-shares.mjs';

test('identity and team shares of the same file appear once with the current effective role', () => {
  const result = receivedEntries([
    { entry: { id: 'one', name: '报告.txt' }, share: { id: 'a', role: 'viewer' }, access_role: 'viewer' },
    { entry: { id: 'one', name: '报告.txt' }, share: { id: 'b', role: 'viewer' }, access_role: 'editor' },
    { entry: { id: 'two', name: '照片.png' }, share: { id: 'c', role: 'viewer' }, access_role: 'viewer' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].share_id, 'b');
  assert.equal(canEditShared(result[0]), true);
  assert.equal(canEditShared(result[1]), false);
  assert.equal(canEditShared(null), false);
});

test('received view is navigable and refreshes its share before listing descendants', async () => {
  const html = await readFile(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(html, /data-view="shared"/);
  assert.match(source, /sharedWithMe:"共享给我"/);
  assert.match(source, /sharedWithMe:"Shared with me"/);
  assert.match(source, /json\("\/api\/v1\/files\/shared"\)/);
  assert.match(source, /json\(`\/api\/v1\/files\/shared\/\$\{anchor\.share_id\}`\)/);
  assert.match(source, /entryEditable\(entry\)/);
  assert.match(source, /state\.view!=="shared"/);
});
