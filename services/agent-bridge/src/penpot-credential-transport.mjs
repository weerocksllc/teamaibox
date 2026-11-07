import http from 'node:http';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import {penpotRuntimeCredential} from './penpot-runtime-credential.mjs';
import {penpotRuntimePaths, privateDesignOrigin} from './penpot-runtime-config.mjs';

async function readPrivate(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/workspace' || path.startsWith('/workspace/')) throw Error('private_file');
  const info = await lstat(path);
  if (await realpath(path) !== path || !info.isFile() || info.isSymbolicLink() || info.size > 8192 || info.mode & 0o007) throw Error('private_file');
  return readFile(path);
}
export async function loadPenpotTransport(contextFile = penpotRuntimePaths.context) {
  let bytes, key;
  try {
    bytes = await readPrivate(contextFile);
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.schemaVersion !== 1 || value.enabled !== true
      || value.transportRevision !== 'teamaibox-penpot-transport-2'
      || value.bridgeTokenFile !== penpotRuntimePaths.bridgeToken) throw Error('design_disabled');
    const url = new URL(value.mcpEndpoint);
    if (url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) throw Error('design_endpoint');
    privateDesignOrigin(url.origin);
    key = await readPrivate(value.bridgeTokenFile);
    return {endpoint: url.href, credential: penpotRuntimeCredential(value.identityId, key.toString('utf8').trim())};
  } finally {bytes?.fill(0); key?.fill(0);}
}
function fail(response, status) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
  response.end(JSON.stringify({error: 'Design transport unavailable'}));
}
/** Loopback HTTP credential adapter, not an MCP client/server implementation.
 * Native SDK frames are streamed unchanged to one configured official /mcp.
 * No token in native configuration, browser config APIs or tool arguments.
 * It neither retries requests nor holds a tool queue or session authority. */
export function createPenpotCredentialTransport({load = loadPenpotTransport, fetchImpl = fetch} = {}) {
  const active = new Set();
  const server = http.createServer(async (request, response) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
      || request.headers.origin || request.headers.cookie || request.url !== '/mcp'
      || !['GET', 'POST', 'DELETE'].includes(request.method)) return fail(response, 403);
    const abort = new AbortController(); active.add(abort);
    const close = () => abort.abort(); request.once('aborted', close); response.once('close', close);
    let checking = false, initial;
    // Revocation stops a live event stream too. This does not reconnect it.
    const timer = setInterval(async () => {
      if (checking || abort.signal.aborted || !initial) return;
      checking = true;
      try {const next = await load(); if (next.endpoint !== initial.endpoint || next.credential !== initial.credential) abort.abort();}
      catch {abort.abort();} finally {checking = false;}
    }, 2000); timer.unref();
    try {
      initial = await load();
      const headers = {authorization: 'Bearer ' + initial.credential};
      for (const name of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
        const value = request.headers[name];
        if (value !== undefined) {
          if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value)) throw Error('header');
          headers[name] = value;
        }
      }
      const upstream = await fetchImpl(initial.endpoint, {method: request.method, redirect: 'manual',
        signal: abort.signal, headers,
        ...(request.method === 'POST' ? {body: Readable.toWeb(request), duplex: 'half'} : {})});
      if (upstream.status >= 300 && upstream.status < 400) {await upstream.body?.cancel(); throw Error('redirect');}
      const outgoing = {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'};
      for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
        const value = upstream.headers.get(name); if (value !== null) outgoing[name] = value;
      }
      response.writeHead(upstream.status, outgoing);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response, {signal: abort.signal});
      else response.end();
    } catch {fail(response, 503);}
    finally {clearInterval(timer); active.delete(abort); request.off('aborted', close); response.off('close', close); initial = undefined;}
  });
  const close = server.close.bind(server);
  server.close = (...args) => {for (const controller of active) controller.abort(); return close(...args);};
  return server;
}

/** An optional transport failure cannot take down native sessions/model use. */
export async function startPenpotCredentialTransport({port = 4098, onUnavailable = () => {}, ...options} = {}) {
  const server = createPenpotCredentialTransport(options);
  let reported = false;
  const report = () => { if (!reported) { reported = true; onUnavailable('penpot_transport_unavailable'); } };
  server.on('error', report);
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    return server;
  } catch {
    report(); server.close(); return null;
  }
}
