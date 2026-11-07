import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';

export const PENPOT_EDITOR_PREFIX = '/api/v1/design/editor/';
const ENTER = '/api/v1/design/enter';
const COOKIE = '__Secure-tab-design';
const SAFE = new Set(['GET', 'HEAD']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPLOAD_LIMIT = 128 * 1024 * 1024;
const forbidden = () => { throw new PlatformError('penpot_access_denied', 'Design access is unavailable or has expired', { status: 403 }); };
const unavailable = () => new PlatformError('penpot_unavailable', 'The design service is unavailable', { status: 503 });
const NATIVE_AUTH = /^(?:login(?:-with-password)?|logout|register(?:-profile)?|prepare-register(?:-profile)?|request-profile-recovery|recover-profile|update-profile-password|update-profile-email|request-email-change|delete-profile|verify-token|create-access-token|delete-access-token|get-access-tokens|get-current-mcp-token|teamaibox-login)$/;
// External invitations and anonymous links are not platform directory grants.
// Native libraries, authorized prototype viewing and existing files stay intact.
const EXTERNAL_SHARING = new Set(['create-share-link', 'create-team-invitations',
  'create-team-with-invitations', 'get-team-invitation-token', 'update-team-invitation-role',
  'create-team-access-request']);

function serviceOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Design upstream must be an operator-configured service origin');
  }
  return url;
}

export function readPenpotNativeToken(request) {
  const values = String(request.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='));
  if (values.length !== 1) forbidden();
  const token = values[0].slice(COOKIE.length + 1);
  if (!/^[A-Za-z0-9_.~=-]{20,4096}$/.test(token)) forbidden();
  return token;
}

function nativePath(request) {
  const raw = request.url ?? '';
  if (!raw.startsWith(PENPOT_EDITOR_PREFIX) || /[\\#\x00-\x20]/.test(raw)) forbidden();
  const path = '/' + raw.slice(PENPOT_EDITOR_PREFIX.length);
  let pathname;
  try { pathname = decodeURIComponent(path.split('?')[0]); } catch { forbidden(); }
  // Do not normalize ambiguous paths into a different authenticated endpoint.
  if (/%(?:2e|2f|5c|25|00)/i.test(path.split('?')[0]) || /[\\\x00-\x1f]/.test(pathname)
    || pathname.includes('//') || pathname.split('/').some(p => p === '.' || p === '..')) forbidden();
  const method = /^\/api\/main\/methods\/([^/]+)$/.exec(pathname)?.[1];
  if (method && (method.startsWith('teamaibox-') || NATIVE_AUTH.test(method) || EXTERNAL_SHARING.has(method))) forbidden();
  if (pathname === '/api/export' && path !== pathname) forbidden();
  if (!(method || ['/', '/index.html', '/rasterizer.html', '/render.html'].includes(pathname)
    || /^\/(?:js|css|images|fonts|assets|plugins)\//.test(pathname)
    || pathname === '/api/export' || pathname === '/ws/notifications')) forbidden();
  return path;
}

function forwardHeaders(request, target, token, upgrade = false) {
  const headers = { host: target.host, cookie: 'auth-token=' + token };
  for (const key of ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since']) {
    if (typeof request.headers[key] === 'string') headers[key] = request.headers[key];
  }
  // Native per-tab collaboration correlation is not a platform identity or an
  // auth token. Keep this bounded UUID so Penpot can correlate its own edits.
  if (UUID.test(request.headers['x-session-id'] ?? '')) {
    headers['x-session-id'] = request.headers['x-session-id'];
  }
  if (upgrade) {
    headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
    for (const key of ['sec-websocket-key', 'sec-websocket-version']) headers[key] = request.headers[key];
  }
  return headers;
}

function responseHeaders(reply) {
  const result = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
  for (const key of ['content-type', 'content-length', 'content-encoding', 'content-disposition', 'content-range',
    'accept-ranges', 'etag', 'last-modified', 'content-security-policy', 'permissions-policy',
    'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy']) {
    if (reply.headers[key] !== undefined) result[key] = reply.headers[key];
  }
  // No native Set-Cookie, CORS, redirects or upstream/internal headers escape.
  result['x-frame-options'] = 'SAMEORIGIN';
  return result;
}

async function boundedBody(response, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw unavailable();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Dedicated native-editor transport. No generic plugin proxy policy is relaxed.
 * The platform owns entry/session binding; native Penpot owns document ACLs.
 */
export class PenpotEditorGateway {
  #authority; #handoff; #frontend; #backend; #mcp; #collaboration; #drive; #active = new Set(); #closed = false;
  constructor({ authority, handoff, frontendOrigin, backendOrigin, mcpGateway = null, collaboration = null, driveApi = null }) {
    if (!authority?.bindNativeSession || !authority?.authenticateNativeSession || !handoff?.issue) throw new TypeError('Design authorities are required');
    this.#authority = authority; this.#handoff = handoff;
    this.#frontend = serviceOrigin(frontendOrigin); this.#backend = serviceOrigin(backendOrigin);
    this.#mcp = mcpGateway;
    if(collaboration!==null&&typeof collaboration.checkSubscriptions!=='function')throw new TypeError('Invalid native collaboration authority');
    this.#collaboration = collaboration;
    if(driveApi&&(!driveApi.matches||!driveApi.handle))throw new TypeError('Invalid design Drive service');
    this.#drive=driveApi;
  }
  matches(pathname) { return pathname === ENTER || pathname.startsWith(PENPOT_EDITOR_PREFIX); }

  // A stalled permission database fails closed; checks never overlap. Closing
  // a stream stops future transport, not already committed native mutations.
  #watch(check, disconnect) {
    let stopped = false, timer;
    const stop = () => { stopped = true; clearTimeout(timer); this.#active.delete(cancel); };
    const cancel = () => { stop(); disconnect(); };
    const run = async () => {
      let deadline;
      try {
        await Promise.race([check(), new Promise((_, reject) => { deadline = setTimeout(() => reject(unavailable()), 1000); })]);
      } catch { if (!stopped) cancel(); }
      finally { clearTimeout(deadline); }
      if (!stopped) { timer = setTimeout(run, 2000); timer.unref(); }
    };
    timer = setTimeout(run, 2000); timer.unref(); this.#active.add(cancel);
    return stop;
  }

  async handle({ request, response, authenticate, sessionToken, csrfToken }) {
    if (this.#closed) throw unavailable();
    if (this.#mcp?.matches(request.url ?? '')) return this.#mcp.handle({ request, response, authenticate });
    if(this.#drive?.matches(request.url??''))return this.#drive.handle({request,response,authenticate,nativeToken:readPenpotNativeToken(request)});
    const context = await authenticate();
    if (request.url === ENTER) {
      if (request.method !== 'POST' || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) forbidden();
      const issued = await this.#handoff.issue({ sessionToken, csrfToken });
      const reply = await fetch(new URL('/api/main/methods/teamaibox-login', this.#backend), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
        headers: { 'content-type': 'application/json', accept: 'application/json',
          'x-teamaibox-identity': context.identityId ?? context.identity?.id, 'x-teamaibox-session': context.sessionId },
        body: JSON.stringify({ code: issued.code }),
      }).catch(() => { throw unavailable(); });
      if (!reply.ok) { await reply.body?.cancel(); throw new PlatformError('penpot_native_login_failed',
        'The design service could not complete sign-in', { status: 503, details: { upstreamStatus: reply.status } }); }
      const profile = JSON.parse(await boundedBody(reply, 128 * 1024));
      const cookies = reply.headers.getSetCookie().filter(value => value.startsWith('auth-token='));
      if (cookies.length !== 1) throw unavailable();
      const token = cookies[0].split(';')[0].slice('auth-token='.length);
      // Recheck after login: concurrent logout/revocation cannot create a usable binding.
      const current = await authenticate();
      if (current.sessionId !== context.sessionId) forbidden();
      await this.#authority.bindNativeSession({ context: current, profileId: profile.id, nativeToken: token });
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'set-cookie': `${COOKIE}=${token}; Path=${PENPOT_EDITOR_PREFIX}; Secure; HttpOnly; SameSite=Strict` });
      response.end(JSON.stringify({ editorPath: PENPOT_EDITOR_PREFIX }));
      return;
    }
    const path = nativePath(request), token = readPenpotNativeToken(request);
    const check = async () => this.#authority.authenticateNativeSession({ context: await authenticate(), nativeToken: token });
    const native = await check();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) forbidden();
    if (Number(request.headers['content-length'] ?? 0) > UPLOAD_LIMIT) throw new PlatformError('request_too_large', 'Design upload is too large', { status: 413 });
    if (path.split('?')[0] === '/js/config.js' && SAFE.has(request.method)) {
      const reply = await fetch(new URL(path, this.#frontend), { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!reply.ok) throw unavailable();
      const config = await boundedBody(reply, 65536);
      await check();
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : config + `\nvar penpotPublicURI = globalThis.location.origin + ${JSON.stringify(PENPOT_EDITOR_PREFIX)};\nvar penpotProtectedDownloadsBase = penpotPublicURI;\n`
        + (this.#mcp ? `import(${JSON.stringify(PENPOT_EDITOR_PREFIX + '_integration/host.js')}).catch(() => {});\n` : ''));
      return;
    }
    const headers = forwardHeaders(request, this.#frontend, token);
    if (path === '/api/export') {
      if (request.method !== 'POST' || !UUID.test(native?.profileId ?? '')) forbidden();
      // The exporter uses the authenticated recipient, not a profile supplied
      // in Transit. Client headers cannot override this internal field.
      headers['x-teamaibox-export-profile'] = native.profileId;
    }
    const upstream = (this.#frontend.protocol === 'https:' ? httpsRequest : httpRequest)(this.#frontend, {
      path, method: request.method, headers, timeout: 30000,
    });
    const stop = this.#watch(check, () => { upstream.destroy(); response.destroy(); });
    response.once('close', () => { stop(); upstream.destroy(); });
    request.once('aborted', () => upstream.destroy());
    let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size > UPLOAD_LIMIT) upstream.destroy(unavailable()); });
    upstream.on('timeout', () => upstream.destroy(unavailable()));
    upstream.on('error', () => {
      stop();
      if (!response.headersSent) { response.writeHead(503, { 'cache-control': 'no-store' }); response.end(); }
      else response.destroy();
    });
    upstream.on('response', async reply => {
      try {
        await check();
        if (response.destroyed) { reply.destroy(); return; }
        if (reply.statusCode >= 300 && reply.statusCode < 400 && reply.statusCode !== 304) throw unavailable();
        response.writeHead(reply.statusCode, responseHeaders(reply));
        reply.on('error', () => response.destroy()); reply.pipe(response);
      } catch { reply.destroy(); upstream.destroy(unavailable()); }
    });
    request.pipe(upstream);
  }

  async attachUpgrade({ request, socket, head, authenticate }) {
    if (this.#closed) throw unavailable();
    if (this.#mcp?.matches(request.url ?? '')) return this.#mcp.attachUpgrade({ request, socket, head, authenticate });
    const path = nativePath(request);
    if (path.split('?')[0] !== '/ws/notifications' || request.method !== 'GET'
      || request.headers.upgrade?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13'
      || !/^[A-Za-z0-9+/]{22}==$/.test(request.headers['sec-websocket-key'] ?? '')) forbidden();
    const token = readPenpotNativeToken(request);
    const check = async () => this.#authority.authenticateNativeSession({ context: await authenticate(), nativeToken: token });
    await check();
    const connectionId = randomUUID();
    const upstream = (this.#frontend.protocol === 'https:' ? httpsRequest : httpRequest)(this.#frontend, {
      path, headers: { ...forwardHeaders(request, this.#frontend, token, true),
        'x-teamaibox-design-connection': connectionId }, timeout: 5000,
    });
    let remote;
    const stop = this.#watch(async () => {
      const user = await check();
      if (remote && this.#collaboration) await this.#collaboration.checkSubscriptions({ profileId:user.profileId, connectionId });
    }, () => { upstream.destroy(); remote?.destroy(); socket.destroy(); });
    socket.once('close', () => { stop(); upstream.destroy(); remote?.destroy(); });
    socket.on('error', () => { stop(); upstream.destroy(); remote?.destroy(); });
    upstream.on('timeout', () => upstream.destroy(unavailable()));
    upstream.on('error', () => { stop(); socket.destroy(); });
    upstream.on('response', reply => { reply.destroy(); stop(); socket.destroy(); });
    upstream.on('upgrade', async (reply, connection, remoteHead) => {
      remote = connection;
      remote.on('error', () => socket.destroy()); remote.once('close', () => { stop(); socket.destroy(); });
      try {
        await check();
        if (socket.destroyed) { remote.destroy(); return; }
        const expected = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (reply.statusCode !== 101 || reply.headers['sec-websocket-accept'] !== expected) forbidden();
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '
          + reply.headers['sec-websocket-accept'] + '\r\n\r\n');
        if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
        socket.pipe(remote).pipe(socket);
      } catch { remote.destroy(); socket.destroy(); }
    });
    upstream.end();
  }

  close() { this.#closed = true; for (const cancel of [...this.#active]) cancel(); }
}
