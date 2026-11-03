import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { PlatformError } from '../../../packages/observability/src/index.mjs';

export const nativeContract = Object.freeze(JSON.parse(readFileSync(new URL('../opencode-native-contract.json', import.meta.url))));
const operations = nativeContract.operations.map(value => ({ ...value,
  pattern: new RegExp('^' + value.path.split('/').map(part => part === '*' ? '.+' : /^\{\w+\}$/.test(part) ? '[A-Za-z0-9_.~-]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$'),
}));
// These control a local TUI, a different server, or the installed engine itself.
// They must never be reachable through a browser's user-instance transport.
const denied = /^(?:tui\.|sync\.|global\.(?:upgrade|dispose)$|app\.log$|experimental\.(?:controlPlane|console|workspace|projectCopy)\.)/;
const failure = (code, status = 400) => new PlatformError(code, 'Assistant native request is unavailable', { status });

export function nativeRequestTarget(method, target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')
    || /[\\#\r\n\0]/.test(target)) throw failure('assistant_native_path_invalid');
  const rawPath = target.split('?')[0];
  // Reject before URL normalization, including encoded separators and dot segments.
  if (rawPath.startsWith('/api/fs/read/')) {
    let file;
    try { file = decodeURIComponent(rawPath.slice('/api/fs/read/'.length)); } catch { throw failure('assistant_native_path_invalid'); }
    if (!file || /[\\%\r\n\0]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) throw failure('assistant_native_path_invalid');
  } else if (rawPath.includes('%') || rawPath.split('/').some(part => part === '.' || part === '..')) throw failure('assistant_native_path_invalid');
  const url = new URL(target, 'http://native.invalid');
  const operation = operations.find(value => value.method === method && value.pattern.test(url.pathname));
  if (!operation || denied.test(operation.operation)) throw failure('assistant_native_route_unavailable', 404);
  if (url.searchParams.has('workspace') || url.searchParams.has('workspaceID') || url.searchParams.has('server')
    || [...url.searchParams.keys()].some(key => key.startsWith('location['))) {
    throw failure('assistant_native_workspace_invalid');
  }
  const directories = url.searchParams.getAll('directory');
  if (directories.length > 1) throw failure('assistant_native_workspace_invalid');
  const directory = directories[0] ?? '/workspace';
  if ((directory !== '/workspace' && !directory.startsWith('/workspace/')) || /[\\\r\n\0]/.test(directory)
    || directory.split('/').some(part => part === '.' || part === '..')) throw failure('assistant_native_workspace_invalid');
  // Native global session discovery distinguishes omitted directory from a
  // directory filter. Ownership still comes from this user's engine instance.
  if (operation.operation !== 'experimental.session.list' || directories.length) url.searchParams.set('directory', directory);
  return Object.freeze({ path: url.pathname + url.search, operation: operation.operation, directory });
}

// A transport only: request bodies, native results and event frames are not
// translated into platform runs or retried. Authentication remains server-side.
export function createNativeTransport({ origin, authorization, prefix = '', fetchImplementation = globalThis.fetch }) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || !['', '/native'].includes(prefix) || typeof authorization !== 'function') throw new TypeError('Native transport configuration is invalid');
  return Object.freeze({
    async upgrade(target, request, socket, head, {signal} = {}) {
      const route = nativeRequestTarget('GET', target);
      const key = request.headers['sec-websocket-key'];
      if (!['pty.connect', 'v2.pty.connect'].includes(route.operation)
        || request.headers.upgrade?.toLowerCase() !== 'websocket'
        || request.headers['sec-websocket-version'] !== '13'
        || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) throw failure('assistant_native_socket_invalid');
      const credential = await authorization();
      if (typeof credential !== 'string' || /[\r\n\0]/.test(credential)) throw failure('assistant_native_credentials_unavailable',503);
      if (signal?.aborted || socket.destroyed) throw failure('assistant_native_disconnected',499);
      const expected = createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      await new Promise((resolve,reject) => {
        let upstreamSocket;
        const upstream = (base.protocol === 'https:' ? https : http).request(base.origin+prefix+route.path, {
          method:'GET', headers:{authorization:credential,connection:'Upgrade',upgrade:'websocket',
            ...(route.operation.startsWith('v2.')?{'x-opencode-directory':encodeURIComponent(route.directory)}:{}),
            'sec-websocket-key':key,'sec-websocket-version':'13'},
        });
        const abort = () => { upstream.destroy(); upstreamSocket?.destroy(); socket.destroy(); };
        const cleanup = () => {signal?.removeEventListener('abort',abort);socket.off('close',abort);};
        signal?.addEventListener('abort',abort,{once:true});socket.once('close',abort);
        upstream.setTimeout(10000,()=>upstream.destroy(Error('handshake_timeout')));
        upstream.once('error',()=>{cleanup();reject(failure('assistant_native_unavailable',503));});
        upstream.once('close',()=>{if(!upstreamSocket){cleanup();reject(failure('assistant_native_disconnected',499));}});
        upstream.once('response',response=>{response.resume();upstream.destroy();cleanup();reject(failure('assistant_native_socket_rejected',502));});
        upstream.once('upgrade',(response,peer,remaining)=>{
          upstreamSocket=peer;
          if(response.statusCode!==101 || response.headers['sec-websocket-accept']!==expected){
            peer.destroy();cleanup();reject(failure('assistant_native_socket_rejected',502));return;
          }
          peer.setTimeout(0);socket.setTimeout(0);
          peer.on('error',abort);socket.on('error',abort);
          peer.once('close',()=>{socket.destroy();cleanup();resolve();});
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${expected}\r\n\r\n`);
          if(remaining.length)socket.write(remaining);
          if(head.length)peer.write(head);
          socket.pipe(peer);peer.pipe(socket);
        });
        upstream.end();
      });
    },
    async request(method, target, { body, signal, accept = 'application/json' } = {}) {
      const route = nativeRequestTarget(method, target);
      const credential = await authorization();
      if (typeof credential !== 'string' || /[\r\n\0]/.test(credential)) throw failure('assistant_native_credentials_unavailable', 503);
      try {
        return await fetchImplementation(base.origin + prefix + route.path, {
          method, redirect: 'manual', signal,
          headers: { authorization: credential, accept,
            ...(route.operation.startsWith('v2.')?{'x-opencode-directory':encodeURIComponent(route.directory)}:{}),
            ...(['pty.connectToken','v2.pty.connectToken'].includes(route.operation)?{'x-opencode-ticket':'1'}:{}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body, ...(typeof body === 'string' || body instanceof Uint8Array ? {} : { duplex: 'half' }) }),
        });
      } catch {
        // Never attach upstream URLs, credentials, request bodies or raw causes.
        throw failure(signal?.aborted ? 'assistant_native_disconnected' : 'assistant_native_unavailable', signal?.aborted ? 499 : 503);
      }
    },
  });
}

export async function forwardNativeResponse(upstream, response) {
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    throw failure('assistant_native_redirect_rejected', 502);
  }
  // Do not forward cookies, challenges, upstream addresses or hop-by-hop headers.
  response.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
    ...(/^\d{1,16}$/.test(upstream.headers.get('x-next-cursor') ?? '') ? {'x-next-cursor':upstream.headers.get('x-next-cursor')} : {}),
  });
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
  else response.end();
}
