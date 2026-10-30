import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { bootstrap } from './factory_owner.mjs';
import { MemoryIdentityRepository } from '../apps/platform-api/src/identity/memory-repository.mjs';
import { LocalAuthentication } from '../apps/platform-api/src/identity/auth-service.mjs';
import { PasswordHasher } from '../apps/platform-api/src/identity/password.mjs';

const recoveryCodes = () => Array.from({ length: 8 }, () => 'taib-recovery-' + randomBytes(24).toString('base64url'));

test('fresh installation creates an owner that signs in with admin/admin', async () => {
  const repository = new MemoryIdentityRepository();
  await assert.rejects(bootstrap(repository, { check: true }), /not been initialized/);
  assert.equal((await repository.bootstrapState()).complete, false);
  const result = await bootstrap(repository, { recoveryCodes: recoveryCodes() });
  assert.equal(result.usersCreated, 1);
  const authentication = await LocalAuthentication.create({ repository });
  const session = await authentication.signIn({ loginName: 'admin', password: 'admin', networkIdentifier: 'installation-test' });
  assert.equal(session.identity.loginName, 'admin');
  assert.ok(session.identity.roles.includes('owner'));
  assert.equal((await authentication.bootstrapState()).required, false);
  const original = await repository.findByNormalizedLogin('admin');
  assert.match(original.passwordHash, /^\$argon2id\$/);
  assert.equal((await bootstrap(repository)).usersCreated, 0);
  assert.deepEqual(await repository.findByNormalizedLogin('admin'), original);
});

test('rerun and check preserve a changed password and existing owner', async () => {
  const repository = new MemoryIdentityRepository();
  const result = await bootstrap(repository, { recoveryCodes: recoveryCodes() });
  const hasher = new PasswordHasher();
  const newPassword = 'customer chosen passphrase';
  await repository.resetIdentityPassword(result.ownerIdentityId, await hasher.hash(newPassword), new Date());
  const before = await repository.findByNormalizedLogin('admin');
  for (const check of [false, true]) assert.equal((await bootstrap(repository, { check })).status, 'preserved');
  assert.deepEqual(await repository.findByNormalizedLogin('admin'), before);
  assert.equal(await hasher.verify('admin', before.passwordHash), false);
  assert.equal(await hasher.verify(newPassword, before.passwordHash), true);
  // The factory exception does not change ordinary password policy.
  await assert.rejects(hasher.hash('admin'), /at least 15/);
});

test('different boxes get independently salted password hashes', async () => {
  const hashes = [];
  for (let i = 0; i < 2; i++) {
    const repository = new MemoryIdentityRepository();
    await bootstrap(repository, { recoveryCodes: recoveryCodes() });
    hashes.push((await repository.findByNormalizedLogin('admin')).passwordHash);
  }
  assert.notEqual(hashes[0], hashes[1]);
});

test('an existing custom owner is not renamed or given a second default admin', async () => {
  const repository = new MemoryIdentityRepository();
  const authentication = await LocalAuthentication.create({ repository });
  await authentication.bootstrapOwner({ loginName: 'custom-owner', displayName: 'Owner', password: 'existing owner passphrase' });
  const before = await repository.findByNormalizedLogin('custom-owner');
  assert.equal((await bootstrap(repository)).status, 'preserved');
  assert.deepEqual(await repository.findByNormalizedLogin('custom-owner'), before);
  assert.equal(await repository.findByNormalizedLogin('admin'), null);
});

test('concurrent installers create exactly one owner without overwrites', async () => {
  const repository = new MemoryIdentityRepository();
  const results = await Promise.all([bootstrap(repository, { recoveryCodes: recoveryCodes() }),
    bootstrap(repository, { recoveryCodes: recoveryCodes() })]);
  assert.equal(results.reduce((sum, r) => sum + r.usersCreated, 0), 1);
  assert.equal(results[0].ownerIdentityId, results[1].ownerIdentityId);
});
