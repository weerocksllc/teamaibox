import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PostgresPenpotConnectionRepository } from '../src/postgres-penpot-connection-repository.mjs';
import { PenpotConnectionAuthority } from '../src/penpot-connection-authority.mjs';
import { penpotRuntimeCredential, penpotCredentialOwner, penpotRuntimeAuthentication } from '../../agent-bridge/src/penpot-runtime-credential.mjs';

test('design credentials are purpose-separated and bound to the existing owner runtime key', () => {
  const owner = randomUUID(), other = randomUUID(), key = randomBytes(32).toString('base64url');
  const token = penpotRuntimeCredential(owner, key), authority = penpotRuntimeAuthentication(owner, key);
  assert.notEqual(token, key); assert.equal(penpotCredentialOwner(token), owner);
  assert.ok(authority.accepts(token)); assert.ok(!authority.accepts(key));
  assert.ok(!authority.accepts(penpotRuntimeCredential(other, key)));
  assert.ok(!penpotRuntimeAuthentication(owner, randomBytes(32).toString('base64url')).accepts(token));
  assert.match(token, /^[A-Za-z0-9_-]{43,128}$/); // official protected MCP contract
  assert.ok(!JSON.stringify(authority).includes(token));
});

const connectionString = process.env.TEAMAIBOX_PENPOT_TEST_DATABASE_URL;
test('persistent selection rejects stale tabs, heartbeat revival, native denial and revoked sessions', {
  skip: !connectionString && 'Requires an explicitly supplied empty disposable PostgreSQL database',
}, async () => {
  const { default: pg } = await import('../../../packages/persistence/node_modules/pg/lib/index.js');
  const database = new pg.Pool({ connectionString, max: 10 });
  try {
    const tables = await database.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')");
    assert.equal(tables.rows[0].n, 0, 'Existing data is never used by this test');
    await database.query('CREATE SCHEMA iam; CREATE TABLE iam.identities(id uuid PRIMARY KEY); CREATE SCHEMA design');
    await database.query(await readFile(new URL('../../../packages/persistence/migrations/000120_penpot_call_boundary.up.sql', import.meta.url), 'utf8'));
    const identityId = randomUUID(), platformSessionId = randomUUID(), profileId = randomUUID();
    await database.query('INSERT INTO iam.identities VALUES ($1)', [identityId]);
    let now = Date.now(), authorized = true, canEdit = true, afterNative = () => {};
    let key = randomBytes(32).toString('base64url');
    const principal = { identityId, platformSessionId, profileId }, repository = new PostgresPenpotConnectionRepository({ database });
    const context = { identityId, sessionId: platformSessionId };
    const route = () => ({ ownerIdentityId: identityId, sandboxKey: 'sandbox.' + 'a'.repeat(32),
      designRuntime: penpotRuntimeAuthentication(identityId, key),
      native: { async request(method, path) { assert.equal(method, 'GET'); return Response.json({ id: path.split('/').at(-1), directory: '/workspace' }); } },
    });
    const service = new PenpotConnectionAuthority({ repository, routes: { resolve: async () => route() }, clock: () => now,
      platform: { async authenticateNativeSession({ nativeToken }) { assert.equal(nativeToken, 'synthetic'); if (!authorized) throw Error('revoked'); return principal; },
        async loadSession() { return authorized ? context : null; }, async authorizeDesign() { return { allowed: authorized }; },
        async validateNativeBinding() { if (!authorized) throw Error('revoked'); } },
      nativePermissions: { async check() { afterNative(); return { canEdit }; } },
    });
    const input = { context, nativeToken: 'synthetic', fileId: randomUUID(), pageId: randomUUID(), sessionID: 'ses_owned', expectedGeneration: 0 };
    const first = await service.select(input); assert.equal(first.generation, 1);
    const race = await Promise.allSettled(Array.from({ length: 8 }, () => service.select({ ...input, expectedGeneration: 1 })));
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    const current = race.find(r => r.status === 'fulfilled').value; assert.equal(current.generation, 2);
    await assert.rejects(service.heartbeat({ context, nativeToken: 'synthetic', connectionId: first.connectionId, generation: 1 }));
    await assert.rejects(service.disconnect({ context, nativeToken: 'synthetic', connectionId: first.connectionId, generation: 1 }));
    assert.equal((await service.resolveCurrentBinding(identityId)).connectionId, current.connectionId);
    authorized = false; await assert.rejects(service.resolveCurrentBinding(identityId)); authorized = true;
    canEdit = false; await assert.rejects(service.resolveCurrentBinding(identityId)); canEdit = true;
    afterNative = () => { authorized = false; };
    await assert.rejects(service.resolveCurrentBinding(identityId), /revoked/);
    authorized = true; afterNative = () => {};
    const oldKey = key; key = randomBytes(32).toString('base64url');
    await assert.rejects(service.resolveCurrentBinding(identityId)); key = oldKey;
    now += 12000; await assert.rejects(service.resolveCurrentBinding(identityId));
    await assert.rejects(service.heartbeat({ context, nativeToken: 'synthetic', connectionId: current.connectionId, generation: 2 }));
    assert.equal(await repository.heartbeat({ ...current, now }), false, 'late heartbeat cannot revive a frozen page');
    const resumed = await service.select({ ...input, expectedGeneration: 2 }); assert.equal(resumed.generation, 3);
    await service.disconnect({ context, nativeToken: 'synthetic', connectionId: resumed.connectionId, generation: 3 });
    await assert.rejects(service.resolveCurrentBinding(identityId));
    assert.equal((await repository.get(identityId)).generation, 3, 'disconnect preserves generation and target, not design deletion');
    await assert.rejects(database.query(await readFile(new URL('../../../packages/persistence/migrations/000120_penpot_call_boundary.down.sql', import.meta.url), 'utf8')), /Disable design AI connections/);
  } finally { await database.end(); }
});
