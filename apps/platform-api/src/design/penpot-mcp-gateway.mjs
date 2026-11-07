import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { realpath, stat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep, extname } from 'node:path';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';
import { readPenpotNativeToken } from './penpot-editor-gateway.mjs';

const PREFIX = '/api/v1/design/editor/_integration/plugin/';
const HOST = '/api/v1/design/editor/_integration/host.js';
const WS = /^\/api\/v1\/design\/editor\/ws\/mcp\/([a-f0-9-]{36})$/;
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const denied = () => { throw new PlatformError('penpot_connection_denied', 'The design connection is unavailable', { status: 403 }); };

/** Transport only. The official MCP continues to own WS tasks and execution. */
export class PenpotMcpGateway {
  #origin; #key; #assets; #connections; #platform; #active = new Set(); #closed = false;
  constructor({ websocketOrigin, serviceKey, pluginAssetsDirectory, connections, platform }) {
    const origin = new URL(websocketOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/'
      || origin.search || origin.hash || !/^[A-Za-z0-9_-]{43}$/.test(serviceKey ?? '')
      || !isAbsolute(pluginAssetsDirectory ?? '') || !connections?.editorTransport || !platform?.authenticateNativeSession) {
      throw new TypeError('Private official MCP transport configuration required');
    }
    this.#origin = origin; this.#key = serviceKey; this.#assets = pluginAssetsDirectory;
    this.#connections = connections; this.#platform = platform;
  }
  matches(path) { return path === HOST || path.startsWith(PREFIX) || WS.test(path); }
  async handle({ request, response, authenticate }) {
    if (this.#closed || !['GET', 'HEAD'].includes(request.method)) denied();
    const check = async () => this.#platform.authenticateNativeSession({ context: await authenticate(), nativeToken: readPenpotNativeToken(request) });
    await check();
    if (request.url === HOST) {
      const contents = await readFile(new URL('./penpot-editor-host.mjs', import.meta.url)); await check();
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : contents); return;
    }
    const relative = request.url?.slice(PREFIX.length);
    if (!request.url?.startsWith(PREFIX) || !/^(?:[A-Za-z0-9_-]+\.(?:js|css|html|json)|assets\/[A-Za-z0-9_.-]+)$/.test(relative ?? '')) denied();
    const root = await realpath(this.#assets), path = await realpath(resolve(root, relative));
    if (!path.startsWith(root + sep) || !MIME[extname(path)]) denied();
    const metadata = await stat(path); if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) denied();
    const contents = await readFile(path); await check();
    response.writeHead(200, { 'content-type': MIME[extname(path)], 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'" });
    response.end(request.method === 'HEAD' ? undefined : contents);
  }
  async attachUpgrade({ request, socket, head, authenticate }) {
    const connectionId = WS.exec(request.url ?? '')?.[1];
    if (this.#closed || !connectionId || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket'
      || request.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(request.headers['sec-websocket-key'] ?? '')) denied();
    const check = async () => this.#connections.editorTransport({ context: await authenticate(),
      nativeToken: readPenpotNativeToken(request), connectionId });
    const first = await check();
    let remote, timer, closed = false;
    const upstream = (this.#origin.protocol === 'https:' ? httpsRequest : httpRequest)(this.#origin, {
      method: 'GET', path: '/', timeout: 5000, headers: {
        host: this.#origin.host, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': request.headers['sec-websocket-key'],
        'x-teamaibox-proxy-key': this.#key, 'x-teamaibox-user-token': first.userToken,
        'x-teamaibox-editor-connection': first.binding.connectionId,
        'x-teamaibox-editor-generation': String(first.binding.generation),
      },
    });
    const close = () => { if (closed) return; closed = true; clearTimeout(timer); this.#active.delete(close);
      upstream.destroy(); remote?.destroy(); socket.destroy(); };
    this.#active.add(close);
    const recheck = async () => {
      let deadline;
      try {
        const current = await Promise.race([check(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('permission_deadline')), 1000); })]);
        if (current.userToken !== first.userToken || current.binding.generation !== first.binding.generation) close();
      } catch { close(); } finally { clearTimeout(deadline); }
      if (!closed) { timer = setTimeout(recheck, 2000); timer.unref(); }
    };
    timer = setTimeout(recheck, 2000); timer.unref();
    socket.once('close', close); socket.on('error', close); upstream.on('error', close); upstream.on('timeout', close);
    upstream.on('response', response => { response.destroy(); close(); });
    upstream.on('upgrade', async (response, peer, remaining) => {
      remote = peer; peer.on('error', close); peer.once('close', close);
      try {
        const current = await check();
        const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (closed || current.userToken !== first.userToken || current.binding.generation !== first.binding.generation
          || response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== accept) { close(); return; }
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        if (head.length) peer.write(head); if (remaining.length) socket.write(remaining);
        peer.pipe(socket).pipe(peer);
      } catch { close(); }
    });
    upstream.end();
  }
  close() { this.#closed = true; for (const close of [...this.#active]) close(); this.#key = ''; }
}
