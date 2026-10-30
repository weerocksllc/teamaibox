import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { ComputerDesktopAccess, desktopCapabilities } from '../src/virtual-computers/desktop-access.mjs';
import { createPlatformApiServer } from '../server/platform-api.mjs';
import { LocalAuthentication } from '../src/identity/auth-service.mjs';
import { MemoryIdentityRepository } from '../src/identity/memory-repository.mjs';
import { PasswordHasher } from '../src/identity/password.mjs';
import { IdentityPreferencesService } from '../src/identity/preferences-service.mjs';

const id = randomUUID(), user = randomUUID(), context = { identityId: user, sessionId: randomUUID() };
const pathname = `/api/v1/virtual-computers/${id}/desktop-sessions`;
const computer = { id, ownerId: user, state: 'running', runId: randomUUID() };
const cap = token => new URLSearchParams({ token, GUAC_DATA_SOURCE: 'json', GUAC_ID: id, GUAC_TYPE: 'c',
  GUAC_WIDTH: '1920', GUAC_HEIGHT: '1080', GUAC_DPI: '96', GUAC_TIMEZONE: 'Asia/Shanghai' });
function access(options = {}) { return new ComputerDesktopAccess({ resolveOwnedComputer: async () => computer,
  provider: { async connect() { throw Error('unexpected dial'); } }, ...options }); }
const issue = (api, ctx = context, mode='console') => api.handle({ method: 'POST', pathname, context: ctx, body: {mode} });

test('pending shutdown preserves owned recovery access but stopped guests remain inaccessible', async t => {
  let current={...computer,state:'stopping'};
  const api=access({resolveOwnedComputer:async()=>current});t.after(()=>api.close());
  assert.equal((await issue(api)).status,201);
  await assert.rejects(issue(api,{...context,identityId:randomUUID()}),{code:'computer_not_found'});
  current={...current,state:'stopped'};
  await assert.rejects(issue(api),{code:'computer_desktop_unavailable'});
});

test('desktop route issues only an owned running computer grant, without exposing runtime details', async t => {
  const api = access(); t.after(() => api.close());
  assert.equal(api.matches('POST', pathname), true); assert.equal(api.matches('GET', pathname), false);
  const result = await issue(api);
  assert.equal(result.status, 201); assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(result.body).sort(), ['authToken', 'connectionId', 'dataSource','viewerId']);
  assert.equal(result.body.connectionId, id); assert.match(result.body.authToken, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(issue(api, { ...context, identityId: randomUUID() }), { code: 'computer_not_found' });
  await assert.rejects(issue(api, {}), { code: 'invalid_session' });
  for (const body of [{ hostname: 'attacker' }, { password: 'no' }, {mode:'shell'}, {mode:null}, [], null])
    await assert.rejects(api.handle({ method: 'POST', pathname, context, body }), { code: 'computer_desktop_input_invalid' });
});

test('installation console uses the same ownership checks without a second guest or public management port',async t=>{
  const api=access();t.after(()=>api.close());
  const result=await api.handle({method:'POST',pathname,context,body:{mode:'console'}});
  assert.equal(result.status,201);assert.deepEqual(Object.keys(result.body).sort(),['authToken','connectionId','dataSource','viewerId']);
  await assert.rejects(api.handle({method:'POST',pathname,context:{...context,identityId:randomUUID()},body:{mode:'console'}}),{code:'computer_not_found'});
});
test('display query cannot select another connection, inject credentials or override protocol/host', () => {
  const valid = cap('opaque'); valid.append('GUAC_AUDIO', 'audio/L16;rate=44100,channels=2');
  const result = desktopCapabilities(valid, id);
  assert.equal(result.has('token'), false); assert.equal(result.has('GUAC_ID'), false);
  assert.equal(result.get('GUAC_WIDTH'), '1920');
  for (const key of ['hostname', 'password', 'GUAC_PASSWORD', 'GUAC_USERNAME', 'GUAC_WIDTH']) {
    const q = new URLSearchParams(valid); q.append(key, 'evil');
    assert.throws(() => desktopCapabilities(q, id), { code: 'computer_desktop_input_invalid' });
  }
  for (const value of ['0', '-1', 'NaN', '9007199254740992']) {
    const q = new URLSearchParams(valid); q.set('GUAC_WIDTH', value);
    assert.throws(() => desktopCapabilities(q, id));
  }
  const q = new URLSearchParams(valid); q.set('GUAC_ID', randomUUID()); assert.throws(() => desktopCapabilities(q, id));
});

async function socketFixture(t, options = {}) {
  const upstreamServer = createServer(), upstreamWss = new WebSocketServer({ server: upstreamServer });
  upstreamWss.on('connection', ws => ws.on('message', (bytes, binary) => {
    if (bytes.toString() === 'request-login') { ws.send('5.error,5.Login,3.769;'); ws.close(1008, '769: private upstream detail'); }
    else ws.send(bytes, { binary });
  }));
  upstreamServer.listen(0, '127.0.0.1'); await once(upstreamServer, 'listening');
  let selected = computer, permitted = context, calls = 0;
  let closed; const connectionClosed = new Promise(resolve => { closed = resolve; });
  const api = access({ resolveOwnedComputer: async () => selected, checkMs: 20,
    onEvent: event => { if (event.kind === 'closed') closed(); },
    provider: { async connect({ capabilities, computer: c, signal }) {
      calls++; assert.equal(c.id, id); assert.equal(capabilities.has('token'), false);
      const ws = new WebSocket(`ws://127.0.0.1:${upstreamServer.address().port}`, 'guacamole');
      signal.addEventListener('abort', () => ws.terminate(), { once: true });
      await once(ws, 'open'); ws.pause(); return ws;
    } }, ...options });
  const server = createServer();
  server.on('upgrade', (req, sock, head) => api.attachUpgrade(req, sock, head, {
    context: permitted, authenticate: async () => permitted,
  }).catch(() => { sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { api.close(); for (const ws of upstreamWss.clients) ws.terminate(); upstreamWss.close();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstreamServer.close(r))]); });
  const open = async token => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/v1/virtual-computers/${id}/desktop-tunnel?${cap(token)}`, 'guacamole');
    await once(ws, 'open'); return ws;
  };
  return { api, open, connectionClosed, setComputer: c => selected = c, setContext: c => permitted = c, calls: () => calls };
}
test('real WebSocket forwards text/binary, consumes grant once, and signout closes only desktop transport', async t => {
  const f = await socketFixture(t), grant = await issue(f.api,context,'desktop'), ws = await f.open(grant.body.authToken);
  for (const [bytes, binary] of [['4.sync,1.1;', false], [Buffer.from([1, 2, 3]), true]]) {
    const response = once(ws, 'message'); ws.send(bytes, { binary });
    const [actual, isBinary] = await response; assert.deepEqual(actual, Buffer.from(bytes)); assert.equal(isBinary, binary);
  }
  await assert.rejects(f.open(grant.body.authToken)); assert.equal(f.calls(), 1);
  const close = once(ws, 'close'); f.api.handleSignOut({ context }); await close;
});
test('expired, foreign-session and old-runtime grants cannot open an upstream', async t => {
  let now = 1000; const f = await socketFixture(t, { clock: () => now });
  const expired = await issue(f.api); now += 60_001; await assert.rejects(f.open(expired.body.authToken));
  const foreign = await issue(f.api); f.setContext({ ...context, sessionId: randomUUID() }); await assert.rejects(f.open(foreign.body.authToken));
  f.setContext(context); const changed = await issue(f.api); f.setComputer({ ...computer, runId: randomUUID() });
  await assert.rejects(f.open(changed.body.authToken)); assert.equal(f.calls(), 0);
});
test('current ownership and login revocation close an already connected desktop', async t => {
  const f = await socketFixture(t), grant = await issue(f.api), ws = await f.open(grant.body.authToken);
  const close = once(ws, 'close'); f.setComputer({ ...computer, ownerId: randomUUID() }); await close;
});
test('Windows authentication close status and final error reach browser instead of becoming an abnormal reconnect', async t => {
  const f = await socketFixture(t), grant = await issue(f.api,context,'desktop'), ws = await f.open(grant.body.authToken);
  const lastFrame = once(ws, 'message'), closed = once(ws, 'close');
  ws.send('request-login');
  assert.equal((await lastFrame)[0].toString(), '5.error,5.Login,3.769;');
  const [code, reason] = await closed;
  assert.equal(code, 1008); assert.equal(reason.toString(), '769');
});
test('RDP remains independent while console pages may open concurrently', async t => {
  const f = await socketFixture(t), grant = await issue(f.api,context,'desktop'), pending = await issue(f.api,context,'desktop');
  const ws = await f.open(grant.body.authToken);
  await assert.rejects(issue(f.api,context,'desktop'), { code: 'computer_desktop_in_use' });
  await assert.rejects(f.open(pending.body.authToken)); assert.equal(f.calls(), 1);
  const done = once(ws, 'close'); ws.close(); await done;
  // Server observes peer close before a new request is admitted.
  await f.connectionClosed;
  assert.equal((await issue(f.api)).status, 201);
});
test('several console pages share a guest; second page cannot inject input until owner takes control',async t=>{
  const f=await socketFixture(t),a=await issue(f.api),b=await issue(f.api);
  const first=await f.open(a.body.authToken),second=await f.open(b.body.authToken);
  assert.equal(f.calls(),2);assert.notEqual(a.body.viewerId,b.body.viewerId);
  let result=once(first,'message');first.send('3.key,2.65,1.1;4.sync,1.1;');assert.equal((await result)[0].toString(),'3.key,2.65,1.1;4.sync,1.1;');
  result=once(second,'message');second.send('3.key,2.66,1.1;4.sync,1.2;');assert.equal((await result)[0].toString(),'4.sync,1.2;');
});

function http(server, { method = 'GET', path = pathname, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, method, path, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('platform registration reuses HTTPS, login, CSRF, same-origin and signout middleware', async t => {
  const repository = new MemoryIdentityRepository(), origin = 'https://desktop.test';
  const authentication = await LocalAuthentication.create({ repository, hasher: new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 }) });
  await authentication.bootstrapOwner({ loginName: 'owner', displayName: 'Owner', password: 'correct horse battery staple' });
  let calls = 0;
  const api = access({ resolveOwnedComputer: async ({ context: c }) => { calls++; return { ...computer, ownerId: c.identityId }; } });
  const server = createPlatformApiServer({ authentication, preferences: new IdentityPreferencesService({ repository }), publicOrigin: origin,
    logger: { info() {}, warn() {}, error() {} }, computerDesktopApi: api });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  assert.equal((await http(server, { method: 'POST', body: {} })).status, 426);
  assert.equal((await http(server, { method: 'POST', headers: { 'x-forwarded-proto': 'https', origin }, body: {} })).status, 401);
  const login = await http(server, { method: 'POST', path: '/api/auth/sign-in', headers: { 'x-forwarded-proto': 'https', origin, 'content-type': 'application/json' },
    body: { loginName: 'owner', password: 'correct horse battery staple' } });
  assert.equal(login.status, 200);
  const headers = { 'x-forwarded-proto': 'https', origin, 'content-type': 'application/json',
    cookie: login.headers['set-cookie'].map(v => v.split(';', 1)[0]).join('; ') };
  assert.equal((await http(server, { method: 'POST', headers, body: {} })).status, 401);
  headers['x-csrf-token'] = JSON.parse(login.text).csrfToken;
  assert.equal((await http(server, { method: 'POST', headers: { ...headers, origin: 'https://other.test' }, body: {} })).status, 403);
  assert.equal(calls, 0);
  const result = await http(server, { method: 'POST', headers, body: {} });
  assert.equal(result.status, 201, result.text); assert.equal(calls, 1);
  assert.equal((await http(server, { method: 'POST', path: '/api/auth/sign-out', headers, body: {} })).status, 200);
  assert.equal((await http(server, { method: 'POST', headers, body: {} })).status, 401);
});
