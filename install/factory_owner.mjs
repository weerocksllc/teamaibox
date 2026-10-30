/** One-shot offline installer bootstrap; never loaded by the public API. */
import { argon2, createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function bootstrap(repository, { check = false, recoveryCodes = [] } = {}) {
  const present = await repository.bootstrapState();
  if (present.complete) return { status: 'preserved', ownerIdentityId: present.ownerIdentityId, usersCreated: 0 };
  if (check) throw new Error('Default administrator has not been initialized');
  if (recoveryCodes.length !== 8 || new Set(recoveryCodes).size !== 8
      || recoveryCodes.some(c => !/^taib-recovery-[A-Za-z0-9_-]{32}$/.test(c))) {
    throw new Error('Installation recovery codes are incomplete');
  }
  // The explicit factory password is the only exception. Normal user creation
  // and password changes keep the existing policy; no API bypass is introduced.
  const nonce = randomBytes(16);
  const hash = await promisify(argon2)('argon2id', {
    message: Buffer.from('admin'), nonce, memory: 65536, passes: 3, parallelism: 4, tagLength: 32,
  });
  try {
    const identity = await repository.bootstrapOwner({
      loginName: 'admin', normalizedLoginName: 'admin', displayName: 'Administrator',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$' + nonce.toString('base64url') + '$' + hash.toString('base64url'),
      recoveryCodeHashes: recoveryCodes.map(c => createHash('sha256').update(c).digest('hex')),
      now: new Date(),
    });
    return { status: 'created', ownerIdentityId: identity.id, loginName: identity.loginName, usersCreated: 1 };
  } catch (error) {
    // The existing repository holds the bootstrap transaction lock. Another
    // initializer winning the race is never a reason to reset its account.
    if (error.code !== 'bootstrap_complete') throw error;
    const state = await repository.bootstrapState();
    if (!state.complete) throw error;
    return { status: 'preserved', ownerIdentityId: state.ownerIdentityId, usersCreated: 0 };
  } finally {
    hash.fill(0);
    nonce.fill(0);
  }
}

export async function main(options) {
  const fromRoot = path => import(pathToFileURL(resolve(path)).href);
  const { createPostgresDatabaseFromEnvironment } = await fromRoot('packages/persistence/src/postgres-database.mjs');
  const { PostgresIdentityRepository } = await fromRoot('apps/platform-api/src/identity/postgres-repository.mjs');
  const database = await createPostgresDatabaseFromEnvironment();
  try {
    return await bootstrap(new PostgresIdentityRepository({ database }), options);
  } finally {
    await database.close();
  }
}
