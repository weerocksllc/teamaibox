import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';
import { MonitorInput, MonitorRooms } from './monitor-control.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SESSION = new RegExp(`^/api/v1/virtual-computers/(${UUID})/desktop-sessions$`, 'i');
const TUNNEL = new RegExp(`^/api/v1/virtual-computers/(${UUID})/desktop-tunnel$`, 'i');
const MONITOR = new RegExp(`^/api/v1/virtual-computers/(${UUID})/monitor-(sharing|presence|control)$`, 'i');
const INVITATIONS = '/api/v1/virtual-computers/shared-with-me';
function fail(code = 'computer_desktop_unavailable', status = 503) {
  throw new PlatformError(code, status === 404 ? '找不到这台电脑。' : '桌面暂时无法连接，请重试。', { status });
}

// These are display capabilities, never an upstream address or guest login.
// Windows credentials travel inside the RDP exchange, not the HTTP API or URL.
export function desktopCapabilities(query, computerId) {
  const singles = ['token', 'GUAC_DATA_SOURCE', 'GUAC_ID', 'GUAC_TYPE', 'GUAC_WIDTH', 'GUAC_HEIGHT', 'GUAC_DPI', 'GUAC_TIMEZONE'];
  if ([...query.keys()].some(k => ![...singles, 'GUAC_AUDIO', 'GUAC_IMAGE'].includes(k))
    || singles.some(k => query.getAll(k).length !== 1)
    || query.get('GUAC_ID') !== computerId || query.get('GUAC_DATA_SOURCE') !== 'json' || query.get('GUAC_TYPE') !== 'c') {
    fail('computer_desktop_input_invalid', 400);
  }
  for (const key of ['GUAC_WIDTH', 'GUAC_HEIGHT', 'GUAC_DPI']) {
    // Protocol integers, not a fixed product resolution cap.
    if (!/^[1-9][0-9]*$/.test(query.get(key)) || !Number.isSafeInteger(Number(query.get(key)))) fail('computer_desktop_input_invalid', 400);
  }
  const result = new URLSearchParams(query);
  result.delete('token'); result.delete('GUAC_ID'); result.delete('GUAC_DATA_SOURCE');
  return result;
}

/** Reuses platform authentication. Resolver reads current ownership/runtime;
 * provider opens only that server-selected runtime over its managed transport.
 * No VM lifecycle, password storage or independent login system lives here. */
export class ComputerDesktopAccess {
  #resolve; #provider; #clock; #ticketMs; #checkMs; #event; #tickets = new Map(); #connections = new Set();
  #wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  #expiry;
  #sharing; #rooms = new MonitorRooms();
  constructor({ resolveOwnedComputer, provider, sharing = null, clock = Date.now, ticketMs = 60_000, checkMs = 30_000, onEvent = () => {} }) {
    if (typeof resolveOwnedComputer !== 'function' || typeof provider?.connect !== 'function'
      || !Number.isSafeInteger(ticketMs) || ticketMs <= 0 || !Number.isSafeInteger(checkMs) || checkMs <= 0) throw TypeError('Desktop dependencies are incomplete');
    this.#resolve = resolveOwnedComputer; this.#provider = provider; this.#clock = clock;
    this.#ticketMs = ticketMs; this.#checkMs = checkMs;
    this.#event = onEvent;
    this.#sharing = sharing;
    this.#expiry = setInterval(() => { for (const [key, value] of this.#tickets) if (value.expires <= this.#clock()) this.#tickets.delete(key); }, ticketMs).unref();
  }
  matches(method, pathname) {
    const m=MONITOR.exec(pathname);
    return method === 'POST' && SESSION.test(pathname) || !!this.#sharing && (
      method==='GET' && pathname===INVITATIONS || !!m && (m[2]==='sharing'&&['GET','POST'].includes(method)
        || m[2]==='presence'&&method==='GET' || m[2]==='control'&&method==='POST'));
  }
  async #owned(context, computerId, kind='rdp') {
    if (!context?.identityId || !context?.sessionId) fail('invalid_session', 401);
    if(kind==='console'&&this.#sharing)return this.#sharing.resolve({context,computerId,running:true});
    const computer = await this.#resolve({ context, computerId });
    if (!computer || computer.id !== computerId || computer.ownerId !== context.identityId) fail('computer_not_found', 404);
    if (!['running','stopping'].includes(computer.state) || !computer.runId) fail();
    return {...computer,monitorRole:'owner',actorName:context.identity?.displayName??'Owner'};
  }
  #available(computerId,kind) {
    if (kind==='rdp'&&[...this.#connections].some(c => c.computerId === computerId&&c.kind==='rdp')) {
      throw new PlatformError('computer_desktop_in_use', '这台电脑已在另一个页面打开。请关闭那个页面，再重新连接。', { status: 409 });
    }
  }
  async handle({ method, pathname, context, body, query = {} }) {
    if (!this.matches(method, pathname)) fail('not_found', 404);
    const q=query instanceof URLSearchParams?query:new URLSearchParams(query),monitor=MONITOR.exec(pathname);
    const result=value=>({status:200,body:value,headers:{'cache-control':'no-store'}});
    if(pathname===INVITATIONS){if([...q].length)fail('computer_desktop_input_invalid',400);return result(await this.#sharing.invitations(context));}
    if(monitor){
      const id=monitor[1].toLowerCase(),action=monitor[2];
      if([...q.keys()].some(k=>action!=='presence'||k!=='viewerId')||q.getAll('viewerId').length>1)fail('computer_desktop_input_invalid',400);
      if(action==='sharing'){
        if(method==='GET')return result(await this.#sharing.grants(context,id));
        const grants=await this.#sharing.update(context,id,body);
        this.#rooms.updateGrant(id,body.identityId,body.permission);
        for(const [key,ticket] of this.#tickets)if(ticket.computerId===id&&ticket.identityId===body.identityId&&ticket.kind==='console')this.#tickets.delete(key);
        return result(grants);
      }
      const computer=await this.#sharing.resolve({context,computerId:id});
      return result(action==='presence'?this.#rooms.snapshot(id,context,q.get('viewerId'),computer.monitorRole):this.#rooms.action(id,context,body));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k=>k!=='mode')
      || body.mode!==undefined&&!['desktop','console'].includes(body.mode)
      || (query instanceof URLSearchParams ? [...query.keys()].length : Object.keys(query).length)) fail('computer_desktop_input_invalid', 400);
    const computerId = SESSION.exec(pathname)[1].toLowerCase();
    const kind=body.mode==='desktop'?'rdp':'console',viewerId=kind==='console'?randomUUID():null;
    const computer = await this.#owned(context, computerId,kind);
    this.#available(computerId,kind);
    const token = randomBytes(32).toString('base64url');
    // Pending handshakes expire. This expiry does not disconnect a working desktop.
    this.#tickets.set(token, { identityId: context.identityId, sessionId: context.sessionId, computerId,
      runId: computer.runId, kind, viewerId, expires: this.#clock() + this.#ticketMs });
    this.#event({ kind: 'ticket' });
    return { status: 201, body: { authToken: token, dataSource: 'json', connectionId: computerId, ...(viewerId?{viewerId}:{}) }, headers: { 'cache-control': 'no-store' } };
  }
  async attachUpgrade(request, socket, head, { context, authenticate } = {}) {
    const url = new URL(request.url, 'https://platform.invalid'), match = TUNNEL.exec(url.pathname);
    if (!match) return false;
    const computerId = match[1].toLowerCase();
    const capabilities = desktopCapabilities(url.searchParams, computerId);
    const token = url.searchParams.get('token'), grant = this.#tickets.get(token);
    if (!grant || grant.expires <= this.#clock() || grant.computerId !== computerId
      || grant.identityId !== context?.identityId || grant.sessionId !== context?.sessionId) fail('computer_desktop_access_denied', 403);
    if (request.headers['sec-websocket-protocol'] !== 'guacamole' || typeof authenticate !== 'function') fail('computer_desktop_input_invalid', 400);
    this.#tickets.delete(token);
    const computer = await this.#owned(context, computerId,grant.kind);
    if (computer.runId !== grant.runId) fail();
    this.#available(computerId,grant.kind);
    const abort = new AbortController();
    let upstream, downstream, timer, closingTimer, checking = false, closed = false;
    const input=new MonitorInput();
    const connection = { sessionId: context.sessionId, identityId:context.identityId,computerId, kind:grant.kind,
      viewerId:grant.viewerId,role:computer.monitorRole,name:computer.actorName,
      releaseInput:()=>{const keys=input.release();if(keys&&upstream?.readyState===WebSocket.OPEN)upstream.send(keys,()=>{});},close: () => {
      if (closed) return; closed = true; clearInterval(timer); clearTimeout(closingTimer);
      const keys=input.release();this.#rooms.leave(connection);
      this.#event({ kind: 'closed' });
      // Flush held-key releases before tearing down the private upstream.
      const finish=()=>{clearTimeout(closingTimer);abort.abort();upstream?.terminate();};
      if(keys&&upstream?.readyState===WebSocket.OPEN){closingTimer=setTimeout(finish,1000).unref();upstream.send(keys,finish);}else finish();
      downstream?.terminate();
      socket.destroy(); this.#connections.delete(connection);
    } };
    this.#connections.add(connection);
    socket.once('close', connection.close);
    try {
      // Provider returns an OPEN ws connection; cancellation bounds pending opens.
      upstream = await this.#provider.connect({ computer, capabilities, signal: abort.signal, kind:grant.kind });
      this.#event({ kind: 'upstream-open' });
      if (closed || upstream.readyState !== WebSocket.OPEN) { upstream.terminate(); connection.close(); return true; }
      // Ownership/session can change during a slow upstream handshake.
      const fresh = await authenticate();
      const current = await this.#owned(fresh, computerId,grant.kind);
      if (fresh.identityId!==grant.identityId || fresh.sessionId !== grant.sessionId || current.runId !== grant.runId || closed || upstream.readyState !== WebSocket.OPEN) { connection.close(); return true; }
      connection.role=current.monitorRole;
      upstream.pause();
      upstream.once('error', connection.close);
      upstream.once('close', (code, reason) => {
        // Guacamole communicates e.g. CLIENT_UNAUTHORIZED in the close reason.
        // Terminating the browser socket here discards that status (and queued
        // error frames), turning the Windows login prompt into endless retry.
        clearInterval(timer);
        if (!downstream || downstream.readyState !== WebSocket.OPEN) return connection.close();
        const status = /^(\d{1,5})(?:\D|$)/.exec(reason.toString())?.[1] ?? '';
        const closeCode = code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011;
        this.#event({ kind: 'upstream-close', code: closeCode, status });
        downstream.close(closeCode, status); // queues behind existing writes
        closingTimer = setTimeout(connection.close, 5000).unref();
      });
      this.#wss.handleUpgrade(request, socket, head, ws => {
        downstream = ws;
        if(grant.kind==='console')this.#rooms.join(connection);
        this.#event({ kind: 'browser-open' });
        downstream.once('error', connection.close); downstream.once('close', connection.close);
        const forward = (from, to, direction) => from.on('message', (bytes, binary) => {
          this.#event({ kind: 'frame', direction, bytes: bytes.length, binary });
          // Apply transport backpressure, rather than growing an unbounded frame queue.
          from.pause();
          if (to.readyState !== WebSocket.OPEN) return connection.close();
          if(direction==='to-guest'&&grant.kind==='console'){
            try{if(binary)throw Error('Expected monitor text');bytes=input.receive(bytes,()=>this.#rooms.allowed(connection));}
            catch{return connection.close();}
            if(!bytes.length){if(!closed)from.resume();return;}
          }
          to.send(bytes, { binary }, error => { if (error) connection.close(); else if (!closed) from.resume(); });
        });
        forward(upstream, downstream, 'to-browser'); forward(downstream, upstream, 'to-guest'); upstream.resume();
        timer = setInterval(async () => {
          if (checking || closed) return; checking = true;
          try {
            const next = await authenticate(), selected = await this.#owned(next, computerId,grant.kind);
            if (next.identityId!==grant.identityId || next.sessionId !== grant.sessionId || selected.runId !== grant.runId) connection.close();
            else if(grant.kind==='console'&&connection.role!==selected.monitorRole)this.#rooms.updateGrant(computerId,next.identityId,selected.monitorRole);
          } catch { connection.close(); }
          finally { checking = false; }
        }, this.#checkMs).unref();
      });
    } catch { connection.close(); }
    return true;
  }
  handleSignOut({ context }) {
    for (const [key, value] of this.#tickets) if (value.sessionId === context.sessionId) this.#tickets.delete(key);
    for (const connection of this.#connections) if (connection.sessionId === context.sessionId) connection.close();
  }
  close() {
    clearInterval(this.#expiry); this.#tickets.clear();
    for (const connection of this.#connections) connection.close();
    this.#wss.close();
  }
}
