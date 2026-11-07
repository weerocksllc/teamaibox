import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PostgresDatabase } from '../../../packages/persistence/src/postgres-database.mjs';
import { LocalAuthentication } from '../../../apps/platform-api/src/identity/auth-service.mjs';
import { PostgresIdentityRepository } from '../../../apps/platform-api/src/identity/postgres-repository.mjs';
import { IdentityPreferencesService } from '../../../apps/platform-api/src/identity/preferences-service.mjs';
import { PasswordHasher } from '../../../apps/platform-api/src/identity/password.mjs';
import { sessionCookie } from '../../../apps/platform-api/src/identity/http-session.mjs';
import { createPlatformApiServer } from '../../../apps/platform-api/server/platform-api.mjs';
import { PenpotHandoffHttpApi } from '../../../apps/platform-api/src/design/penpot-handoff-http-api.mjs';
import { PenpotEditorGateway, PENPOT_EDITOR_PREFIX } from '../../../apps/platform-api/src/design/penpot-editor-gateway.mjs';
import { PenpotPlatformAuthority } from '../src/penpot-platform-authority.mjs';
import { PenpotLoginHandoff } from '../src/penpot-login-handoff.mjs';
import { PostgresPenpotHandoffRepository } from '../src/postgres-penpot-handoff-repository.mjs';

const connectionString = process.env.TEAMAIBOX_PENPOT_TEST_DATABASE_URL;
test('production platform HTTP and PostgreSQL design identity preserve current session boundaries', {
  skip: !connectionString && 'Requires an explicitly supplied empty disposable PostgreSQL database',
  timeout: 60000,
}, async t => {
  const { default: pg } = await import('../../../packages/persistence/node_modules/pg/lib/index.js');
  const pool = new pg.Pool({ connectionString, max: 8 });
  t.after(() => pool.end());
  const database = new PostgresDatabase({ pool });
  const tables = await pool.query(`SELECT count(*)::int AS count FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema')`);
  assert.equal(tables.rows[0].count, 0, 'Existing databases are never used for this test');
  const migrations = new URL('../../../packages/persistence/migrations/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', migrations), 'utf8'));
  for (const row of manifest.migrations.filter(row => row.version <= 118)) {
    const sql = await readFile(new URL(row.up, migrations), 'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'), row.upSha256);
    await pool.query(sql);
  }
  const repository = new PostgresIdentityRepository({ database });
  const hasher = new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 });
  const authentication = await LocalAuthentication.create({ repository, hasher });
  const users = [];
  for (let i = 0; i < 2; i++) {
    const loginName = 'design-' + randomBytes(8).toString('hex');
    const password = randomBytes(32).toString('base64url');
    const identity = await repository.insertIdentity({ loginName, normalizedLoginName: loginName,
      displayName: 'Design member', passwordHash: await hasher.hash(password) });
    const login = await authentication.signIn({ loginName, password, sourceAddress: '127.0.0.1' });
    users.push({ identity, login, context: await authentication.authenticateSession(login) });
  }
  const row = manifest.migrations.find(row => row.version === 119);
  const sql = await readFile(new URL(row.up, migrations), 'utf8');
  assert.equal(createHash('sha256').update(sql).digest('hex'), row.upSha256);
  await pool.query(sql);
  assert.equal(Number((await pool.query('SELECT count(*) FROM iam.identities')).rows[0].count), 2);
  const pluginId = randomUUID(), versionId = randomUUID();
  await pool.query(`INSERT INTO plugins.plugins(id,plugin_key,plugin_type,publisher)
    VALUES ($1,'official.penpot','application','Synthetic fixture')`, [pluginId]);
  await pool.query(`INSERT INTO plugins.plugin_versions(id,plugin_id,version,manifest,manifest_sha256,supply_chain_state,install_state,slot)
    VALUES ($1,$2,'2.18.5','{}',$3,'verified','healthy','blue')`, [versionId, pluginId, randomBytes(32)]);
  await pool.query(`INSERT INTO plugins.runtime_slots(plugin_id,slot,plugin_version_id,slot_state,generation)
    VALUES ($1,'blue',$2,'active',1)`, [pluginId, versionId]);
  await pool.query(`UPDATE plugins.plugins SET current_version_id=$2,active_slot='blue',lifecycle_state='enabled',generation=1 WHERE id=$1`, [pluginId, versionId]);

  const installationId = randomUUID(), tokenPepper = randomBytes(32),
    backendKey = process.env.TEAMAIBOX_PENPOT_TEST_BACKEND_KEY ?? randomBytes(32).toString('base64url');
  const authority = new PenpotPlatformAuthority({ database, installationId, tokenPepper });
  t.after(() => authority.close());
  const handoff = new PenpotLoginHandoff({ repository: new PostgresPenpotHandoffRepository({ database }),
    authentication, installationId, tokenPepper, backendKey,
    authorizeDesign: (context, now) => authority.authorizeDesign(context, now),
    loadSession: (identity, session, now) => authority.loadSession(identity, session, now) });
  const origin = 'https://design.test';
  const nativeOrigins = process.env.TEAMAIBOX_PENPOT_TEST_FRONTEND_ORIGIN && process.env.TEAMAIBOX_PENPOT_TEST_BACKEND_ORIGIN;
  const editor = nativeOrigins ? new PenpotEditorGateway({ authority, handoff,
    frontendOrigin: process.env.TEAMAIBOX_PENPOT_TEST_FRONTEND_ORIGIN,
    backendOrigin: process.env.TEAMAIBOX_PENPOT_TEST_BACKEND_ORIGIN }) : null;
  t.after(() => editor?.close());
  const server = createPlatformApiServer({ authentication, preferences: new IdentityPreferencesService({ repository }),
    publicOrigin: origin, logger: { info() {}, warn() {}, error() {} },
    penpotEditorGateway: editor, penpotHandoffApi: new PenpotHandoffHttpApi({ handoff }) });
  const testSockets = new Set();
  server.on('connection', socket => { testSockets.add(socket); socket.on('close', () => testSockets.delete(socket)); });
  if (editor) server.on('request', (request, response) => {
    if (request.url === '/internal/v1/design/login-handoff') response.on('finish', () => console.info('Private native handoff status:', response.statusCode));
  });
  if (editor) server.prependListener('upgrade', request => {
    if (request.url === '/internal/v1/design/login-handoff') console.info('Private native handoff protocol upgrade:', request.headers.upgrade);
  });
  await new Promise(resolve => server.listen(Number(process.env.TEAMAIBOX_PENPOT_TEST_PLATFORM_PORT ?? 0), '127.0.0.1', resolve));
  t.after(() => { editor?.close(); for (const socket of testSockets) socket.destroy(); server.closeAllConnections();
    return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = user => ({ 'content-type': 'application/json', origin, 'x-forwarded-proto': 'https',
    cookie: sessionCookie(user.login.sessionToken, user.login.expiresAt).split(';')[0], 'x-csrf-token': user.login.csrfToken });
  const post = async (path, headers, body) => {
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const issue = user => post('/api/v1/design/login-handoff', headers(user), {});
  const redeem = (user, code, extra = {}) => post('/internal/v1/design/login-handoff',
    { 'content-type': 'application/json', authorization: 'Bearer ' + backendKey, ...extra },
    { code, identityId: user.identity.id, sessionId: user.context.sessionId });
  const [a, b] = users;
  if (editor) {
    console.info('Native design identity check: platform and isolated schema ready');
    const enter = async user => {
      const reply = await fetch(base + '/api/v1/design/enter', { method: 'POST', headers: headers(user), signal: AbortSignal.timeout(12000) });
      const result = await reply.json();
      console.info('Native design entry status:', reply.status, result.error?.code ?? 'ok', result.error?.details?.upstreamStatus ?? '');
      assert.equal(reply.status, 200, 'Native login through production gateway must succeed: ' + (result.error?.code ?? 'unexpected status'));
      assert.equal(result.editorPath, PENPOT_EDITOR_PREFIX);
      return reply.headers.getSetCookie()[0].split(';')[0];
    };
    const native = async (user, cookie, method, body) => {
      const reply = await fetch(base + PENPOT_EDITOR_PREFIX + 'api/main/methods/' + method, {
        method: body ? 'POST' : 'GET', headers: { ...headers(user), accept: 'application/json',
          cookie: headers(user).cookie + '; ' + cookie }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000) });
      return { status: reply.status, body: await reply.json() };
    };
    const aCookie = await enter(a), bCookie = await enter(b);
    const aProfile = await native(a, aCookie, 'get-profile'), bProfile = await native(b, bCookie, 'get-profile');
    assert.equal(aProfile.status, 200); assert.equal(bProfile.status, 200);
    assert.notEqual(aProfile.body.id, bProfile.body.id);
    const teams = await native(a, aCookie, 'get-teams');
    assert.equal(teams.status, 200); assert.ok(teams.body.length > 0);
    const project = await native(a, aCookie, 'create-project', { 'team-id': teams.body[0].id, name: 'Synthetic protected project' });
    assert.equal(project.status, 200); assert.ok(project.body.id);
    assert.equal((await native(b, aCookie, 'get-profile')).status, 403);
    const deniedProject = await native(b, bCookie, 'get-project', { id: project.body.id });
    assert.notEqual(deniedProject.status, 200, 'Native project ACL must still reject another user');
    await pool.query("UPDATE iam.identities SET display_name='Renamed native member' WHERE id=$1", [a.identity.id]);
    const repeatedCookie = await enter(a), repeatedProfile = await native(a, repeatedCookie, 'get-profile');
    assert.equal(repeatedProfile.body.id, aProfile.body.id);
    assert.equal(repeatedProfile.body.fullname, 'Renamed native member');
    assert.equal((await native(a, repeatedCookie, 'get-project', { id: project.body.id })).status, 200);
    for (const method of ['login-with-password', 'register-profile', 'recover-profile', 'request-email-change']) {
      assert.equal((await native(a, repeatedCookie, method, {})).status, 403);
    }
    const config = await fetch(base + PENPOT_EDITOR_PREFIX + 'js/config.js', { headers: { ...headers(a), cookie: headers(a).cookie + '; ' + repeatedCookie } });
    assert.equal(config.status, 200); assert.match(await config.text(), /globalThis.location.origin/);
    t.diagnostic('Native Penpot login, repeated entry, renamed stable profile, project create/read and native cross-user ACL passed');
  }
  assert.equal((await post('/api/v1/design/login-handoff', { ...headers(a), origin: 'https://other.test' }, {})).status, 403);
  assert.equal((await post('/api/v1/design/login-handoff', { ...headers(a), 'x-csrf-token': randomBytes(32).toString('base64url') }, {})).status, 403);
  const first = await issue(a); assert.equal(first.status, 201);
  assert.equal((await redeem(a, first.body.code, { cookie: 'invalid' })).status, 403);
  assert.equal((await redeem(b, first.body.code)).status, 403);
  const winner = await redeem(a, first.body.code); assert.equal(winner.status, 200);
  assert.equal((await redeem(a, first.body.code)).status, 403);
  const profile = winner.body.profileId;
  await pool.query('UPDATE iam.identities SET display_name=$2 WHERE id=$1', [a.identity.id, 'Renamed member']);
  const repeat = await redeem(a, (await issue(a)).body.code);
  assert.equal(repeat.body.profileId, profile); assert.equal(repeat.body.fullname, 'Renamed member');
  assert.notEqual((await redeem(b, (await issue(b)).body.code)).body.profileId, profile);
  // Application entry for ordinary team-scoped membership, not an admin bypass.
  await pool.query("DELETE FROM iam.role_bindings WHERE identity_id=$1 AND scope_kind='appliance'", [a.identity.id]);
  assert.equal((await issue(a)).status, 201);
  const nativeToken = randomBytes(32).toString('base64url');
  await authority.bindNativeSession({ context: a.context, nativeToken, profileId: profile });
  const nativeBinding = await authority.authenticateNativeSession({ context: a.context, nativeToken });
  assert.equal(nativeBinding.profileId, profile);
  assert.match(nativeBinding.nativeSessionHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(nativeBinding).includes(nativeToken));
  await authority.validateNativeBinding(nativeBinding);
  await assert.rejects(authority.validateNativeBinding({ ...nativeBinding, profileId: randomUUID() }));
  await assert.rejects(authority.validateNativeBinding({ ...nativeBinding, nativeSessionHash: '0'.repeat(64) }));
  await assert.rejects(authority.authenticateNativeSession({ context: b.context, nativeToken }), { code: 'penpot_access_denied' });
  await assert.rejects(authority.bindNativeSession({ context: b.context, nativeToken: randomBytes(32).toString('base64url'), profileId: profile }), { code: 'penpot_access_denied' });
  await pool.query('UPDATE plugins.plugins SET generation=2 WHERE id=$1', [pluginId]);
  await assert.rejects(authority.authenticateNativeSession({ context: a.context, nativeToken }), { code: 'penpot_access_denied' });
  await assert.rejects(authority.validateNativeBinding(nativeBinding), { code: 'penpot_access_denied' });
  const replacementToken = randomBytes(32).toString('base64url');
  await authority.bindNativeSession({ context: a.context, nativeToken: replacementToken, profileId: profile });
  const replacement = await authority.authenticateNativeSession({ context: a.context, nativeToken: replacementToken });
  await authority.validateNativeBinding(replacement);
  await assert.rejects(authority.validateNativeBinding(nativeBinding), { code: 'penpot_access_denied' });
  const pending = await issue(a);
  await authentication.signOut(a.login.sessionToken);
  await assert.rejects(authority.validateNativeBinding(replacement), { code: 'penpot_access_denied' });
  assert.equal((await redeem(a, pending.body.code)).status, 403);
  assert.equal((await issue(a)).status, 401);
  await authority.revokeSession(a.identity.id, a.context.sessionId);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM design.native_sessions WHERE identity_id=$1', [a.identity.id])).rows[0].count, 0);
  if (editor) assert.equal((await pool.query('SELECT count(*)::int AS count FROM design.native_sessions WHERE identity_id=$1', [b.identity.id])).rows[0].count, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM design.profile_mappings')).rows[0].count, 2);
  const rollback = await readFile(new URL(row.down, migrations), 'utf8');
  assert.equal(createHash('sha256').update(rollback).digest('hex'), row.downSha256);
  await assert.rejects(pool.query(rollback), /must be retained/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM design.profile_mappings')).rows[0].count, 2);
});
