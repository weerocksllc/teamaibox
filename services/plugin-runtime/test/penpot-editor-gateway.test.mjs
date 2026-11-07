import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createPlatformApiServer } from '../../../apps/platform-api/server/platform-api.mjs';
import { PenpotEditorGateway, PENPOT_EDITOR_PREFIX as PREFIX } from '../../../apps/platform-api/src/design/penpot-editor-gateway.mjs';
import { PlatformError } from '../../../packages/observability/src/index.mjs';
import { PenpotDriveHttpApi } from '../../../apps/platform-api/src/design/penpot-drive-http-api.mjs';

// Real platform HTTP/upgrade routing with an explicitly synthetic native
// transport fixture. Native editor/ACL acceptance is a separate gate.
async function fixture(t, collaboration = null, drive = null) {
  const token = () => randomBytes(32).toString('base64url');
  const users = [0, 1].map(() => ({ platform: token(), csrf: token(), identityId: randomUUID(), sessionId: randomUUID(), active: true }));
  const bindings = new Map(), seen = [], sockets = new Set();
  let nativeAvailable = true;
  const deny = () => { throw new PlatformError('penpot_access_denied', 'Access denied', { status: 403 }); };
  const authentication = { async authenticateSession({ sessionToken, csrfToken, requireCsrf }) {
    const user = users.find(u => u.platform === sessionToken);
    if (!user?.active || (requireCsrf && csrfToken !== user.csrf)) deny();
    return { identityId: user.identityId, sessionId: user.sessionId };
  } };
  const authority = {
    async bindNativeSession({ context, profileId, nativeToken }) {
      if (profileId !== context.identityId || !users.find(u => u.sessionId === context.sessionId)?.active) deny();
      bindings.set(nativeToken, context.sessionId);
    },
    async authenticateNativeSession({ context, nativeToken }) {
      if (!nativeAvailable || bindings.get(nativeToken) !== context.sessionId) deny();
      return {...context,profileId:context.identityId};
    },
  };
  const handoff = { async issue(input) { await authentication.authenticateSession({ ...input, requireCsrf: true }); return { code: token() }; } };
  const upstream = createServer(async (request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    if (request.url === '/api/main/methods/teamaibox-login') {
      for await (const _ of request) { /* drain synthetic one-use request */ }
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'auth-token=' + token() + '; Path=/; HttpOnly' });
      response.end(JSON.stringify({ id: request.headers['x-teamaibox-identity'] }));
    } else if (request.url.split('?')[0] === '/js/config.js') {
      response.end('var penpotFlags = "enable-teamaibox-auth";');
    } else {
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private-upstream=must-not-escape',
        'content-security-policy': "default-src 'self'; frame-ancestors 'self'", 'permissions-policy': 'camera=(), microphone=()',
        'x-internal-redirect': '/private' });
      response.end(JSON.stringify({ native: true }));
    }
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.on('upgrade', (request, socket) => {
    seen.push({ url: request.url, headers: request.headers });
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: private=hidden\r\n\r\n`);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = new PenpotEditorGateway({ authority, handoff, frontendOrigin: upstreamOrigin, backendOrigin: upstreamOrigin, collaboration,
    driveApi:drive&&new PenpotDriveHttpApi({authority,...drive}) });
  const origin = 'https://design.example';
  const server = createPlatformApiServer({ authentication, preferences: {}, publicOrigin: origin,
    logger: { info() {}, warn() {}, error() {} }, penpotEditorGateway: gateway });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { gateway.close(); for (const socket of sockets) socket.destroy();
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]); });
  const headers = (user, nativeCookie = '') => ({ origin, 'x-forwarded-proto': 'https', 'x-csrf-token': user.csrf,
    cookie: `__Host-teamaibox-session=${user.platform}` + (nativeCookie ? '; ' + nativeCookie : '') });
  const enter = async user => {
    const reply = await fetch(base + '/api/v1/design/enter', { method: 'POST', headers: headers(user) });
    assert.equal(reply.status, 200); assert.deepEqual(await reply.json(), { editorPath: PREFIX });
    const cookie = reply.headers.getSetCookie()[0];
    assert.match(cookie, /; Path=\/api\/v1\/design\/editor\/; Secure; HttpOnly; SameSite=Strict$/);
    return cookie.split(';')[0];
  };
  return { users, base, headers, enter, seen, revokeNative: () => { nativeAvailable = false; } };
}

test('dedicated editor route binds users, strips credentials and rejects native alternate login', async t => {
  const f = await fixture(t), [a, b] = f.users;
  const cookie = await f.enter(a);
  assert.equal(f.seen[0].headers.cookie, undefined);
  assert.equal(f.seen[0].headers.authorization, undefined);
  const nativeTab = randomUUID();
  let reply = await fetch(f.base + PREFIX + 'api/main/methods/get-profile', { headers: {
    ...f.headers(a, cookie), authorization: 'Bearer synthetic-not-forwarded', 'x-teamaibox-identity': b.identityId,
    'x-session-id': nativeTab, 'x-external-session-id': 'untrusted-external-identity' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('set-cookie'), null); assert.equal(reply.headers.get('x-internal-redirect'), null);
  assert.equal(reply.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(reply.headers.get('permissions-policy'), 'camera=(), microphone=()');
  const received = f.seen.at(-1).headers;
  assert.match(received.cookie, /^auth-token=/); assert.ok(!received.cookie.includes(a.platform));
  assert.equal(received.authorization, undefined); assert.equal(received['x-teamaibox-identity'], undefined);
  assert.equal(received['x-session-id'], nativeTab); assert.equal(received['x-external-session-id'], undefined);
  const reached = f.seen.length;
  for (const path of ['api/main/methods/login-with-password', 'api/main/methods/%6cogin-with-password',
    'api/main/methods/register-profile', 'api/main/methods/get-current-mcp-token',
    'api/main/methods/teamaibox-file-access', 'api/main/methods/teamaibox-login',
    'api/main/methods/%74eamaibox-file-access', 'api/auth/google', 'dbg', 'internal/assets/private']) {
    reply = await fetch(f.base + PREFIX + path, { headers: f.headers(a, cookie) }); assert.equal(reply.status, 403, path);
  }
  for (const method of ['create-share-link', 'create-team-invitations', 'create-team-with-invitations',
    'get-team-invitation-token', 'update-team-invitation-role', 'create-team-access-request']) {
    reply = await fetch(f.base + PREFIX + 'api/main/methods/' + method,
      { method: 'POST', headers: f.headers(a, cookie), body: '{}' });
    assert.equal(reply.status, 403, method);
  }
  reply = await fetch(f.base + PREFIX, { headers: f.headers(b, cookie) }); assert.equal(reply.status, 403);
  reply = await fetch(f.base + PREFIX, { headers: { ...f.headers(a, cookie), origin: 'https://other.example' } }); assert.equal(reply.status, 403);
  reply = await fetch(f.base + PREFIX, { headers: { ...f.headers(a, cookie), cookie: f.headers(a, cookie).cookie + '; ' + cookie } }); assert.equal(reply.status, 403);
  assert.equal(f.seen.length, reached, 'all denied operations stay outside native transport');
  reply = await fetch(f.base + PREFIX + 'js/config.js?version=2.18.5', { headers: f.headers(a, cookie) });
  assert.equal(reply.status, 200); assert.match(await reply.text(), /globalThis.location.origin/);
  for (const path of ['rasterizer.html', 'render.html']) {
    reply = await fetch(f.base + PREFIX + path, { headers: { ...f.headers(a, cookie), 'x-session-id': 'invalid' } });
    assert.equal(reply.status, 200); assert.equal(f.seen.at(-1).headers['x-session-id'], undefined);
  }
  a.active = false;
  reply = await fetch(f.base + PREFIX, { headers: f.headers(a, cookie) }); assert.equal(reply.status, 403);
});

test('native exporter gets only the current profile as its progress recipient', async t => {
  const f = await fixture(t), [a,b] = f.users;
  const cookie = await f.enter(a);
  const reached = f.seen.length;
  for (const path of ['api/export?profile-id='+b.identityId, 'api/export/extra', 'api/%65xport']) {
    const response = await fetch(f.base+PREFIX+path,{method:'POST',headers:f.headers(a,cookie)});
    assert.equal(response.status,403);
  }
  assert.equal((await fetch(f.base+PREFIX+'api/export',{headers:f.headers(a,cookie)})).status,403);
  assert.equal(f.seen.length,reached);
  const response = await fetch(f.base+PREFIX+'api/export',{method:'POST',headers:{
    ...f.headers(a,cookie),'x-teamaibox-export-profile':b.identityId,'content-type':'application/transit+json',
  },body:'["^ ","~:profile-id","~u'+b.identityId+'"]'});
  assert.equal(response.status,200);
  assert.equal(f.seen.at(-1).headers['x-teamaibox-export-profile'],a.identityId);
  assert.equal(f.seen.at(-1).headers.cookie,cookie.replace('__Secure-tab-design=','auth-token='));
});

test('Drive export requires CSRF and the currently bound editor identity', async t => {
  let writes=0;
  const f=await fixture(t,null,{nativeExporter:{async revision(){return {revision:7,documentVersion:0};}},output:{
    async save(input){
      const actor=await input.currentActor();
      assert.equal(actor.actorIdentityId,f.users[0].identityId);
      assert.equal(input.source.documentVersion,0);writes++;
      return {state:'pending_confirmation',operationId:input.operationId};
    },
  }}),[a,b]=f.users;
  const cookie=await f.enter(a);
  const path=f.base+PREFIX+'_integration/drive/export',operationId=randomUUID();
  const post=(user,headers={},extra={})=>fetch(path,{method:'POST',headers:{
    ...f.headers(user,cookie),'content-type':'application/json',...headers,
  },body:JSON.stringify({operationId,source:{documentVersion:0},target:{},...extra})});
  assert.equal((await post(a,{'x-csrf-token':'invalid'})).status,403);
  assert.equal((await post(b)).status,403);
  assert.equal((await post(a,{}, {identityId:b.identityId})).status,400);
  assert.equal(writes,0);
  const accepted=await post(a);
  assert.equal(accepted.status,202);assert.deepEqual(await accepted.json(),{state:'pending_confirmation',operationId});
  assert.equal(writes,1);
});

test('native collaboration socket is closed within five seconds of permission withdrawal', async t => {
  const f = await fixture(t), a = f.users[0], cookie = await f.enter(a);
  const request = httpRequest(f.base + PREFIX + 'ws/notifications?session-id=' + randomUUID(), { headers: {
    ...f.headers(a, cookie), connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'),
  } });
  const upgraded = once(request, 'upgrade'); request.end();
  const [reply, socket] = await upgraded; t.after(() => socket.destroy()); socket.resume();
  assert.equal(reply.statusCode, 101); assert.equal(reply.headers['set-cookie'], undefined);
  const closed = once(socket, 'close'), started = Date.now(); f.revokeNative();
  await closed;
  assert.ok(Date.now() - started < 5000);
});

test('live subscription denial closes a socket without revoking the user session; a client cannot supply the binding', async t => {
  let observed, allowed=true;
  const firstCheck = new Promise(resolve=>{observed=resolve;});
  const f=await fixture(t,{async checkSubscriptions(binding){
    if(!allowed)throw new Error('file grant removed');observed(binding);
  }}), a=f.users[0], cookie=await f.enter(a), forged=randomUUID();
  const request=httpRequest(f.base+PREFIX+'ws/notifications?session-id='+randomUUID(),{headers:{
    ...f.headers(a,cookie),connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13',
    'sec-websocket-key':randomBytes(16).toString('base64'),'x-teamaibox-design-connection':forged,
  }});
  const upgraded=once(request,'upgrade');request.end();
  const [reply,socket]=await upgraded;assert.equal(reply.statusCode,101);t.after(()=>socket.destroy());socket.resume();
  const actual=f.seen.at(-1).headers['x-teamaibox-design-connection'];assert.notEqual(actual,forged);
  assert.deepEqual(await firstCheck,{profileId:a.identityId,connectionId:actual});
  const closed=once(socket,'close'),started=Date.now();allowed=false;await closed;
  assert.ok(Date.now()-started<5000);
  assert.equal((await fetch(f.base+PREFIX+'api/main/methods/get-profile',{headers:f.headers(a,cookie)})).status,200);
});
