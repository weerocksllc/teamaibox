import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { administratorNavigation } from '../src/authorization/view-policy.mjs';
import { permissionKeys, roles } from '../../../packages/authorization/src/index.mjs';
import { translations } from '../../../packages/ui-system/src/global-translations.mjs';

test('retired product archive has no navigation, role grant, client or translated controls', () => {
  assert.equal(administratorNavigation.some(x => x.id === 'backups'), false);
  assert.equal(permissionKeys.some(x => x.startsWith('backup:')), false);
  assert.equal(JSON.stringify(roles).includes('backup:'), false);
  const retiredDirectory = new URL('../src/backups', import.meta.url);
  assert.deepEqual(existsSync(retiredDirectory) ? readdirSync(retiredDirectory) : [], []);
  for (const dictionary of Object.values(translations)) {
    assert.equal(Object.keys(dictionary).some(k => /^(backup\.|admin\.backups\.)/.test(k)), false);
  }
});

test('removed administrator deep links render unavailable without redirecting to another feature', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(!availableAdminDomains\.has\(activeAdminItem\)\) return;/);
  assert.match(source, /if \(!availableAdminDomains\.has\(activeItem\)\)\s*\{\s*return <main[^>]*><h1>\{t\("admin.not_available"\)\}/);
  assert.doesNotMatch(source, /BackupPanel|backup-client|admin\.backups/);
});
