import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { resolveDownload } from './penpot-patches/ProtectedDownloadURL.mjs';

test('native export IDs follow the current protected origin and subpath', () => {
  const id = randomUUID(), base = 'https://current.example/api/v1/design/editor/';
  const expected = base + 'assets/by-id/' + id;
  for (const input of ['https://previous.example/assets/by-id/' + id, '/assets/by-id/' + id, expected]) {
    assert.equal(resolveDownload(input, base, 'https://current.example'), expected);
  }
  assert.equal(resolveDownload('native-value', undefined, undefined), 'native-value');
  const blob = 'blob:https://current.example/' + id;
  assert.equal(resolveDownload(blob, base, 'https://current.example'), blob);
});

test('protected downloads cannot become a remote or ambiguous URL escape', () => {
  const base = 'https://current.example/api/v1/design/editor/', id = randomUUID();
  for (const input of ['https://remote.example/file', 'javascript:alert(1)',
    'blob:https://other.example/' + id, 'data:text/html,<script>alert(1)</script>',
    'https://user:secret@example.test/assets/by-id/' + id,
    '/assets/by-id/' + id + '?credential=value', '/assets/by-id/' + id + '#fragment', '/assets/by-id/not-a-uuid']) {
    assert.throws(() => resolveDownload(input, base, 'https://current.example'), /Unsupported design download/);
  }
  assert.throws(() => resolveDownload('/assets/by-id/' + id, base, 'https://other.example'), /boundary/);
});
