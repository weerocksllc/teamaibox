import { WebSocket } from 'ws';

/** Transport adapter. Endpoint/authorization are resolved by the node runtime,
 * never supplied by the browser. The returned socket is paused until the
 * platform ownership/session recheck and downstream handshake finish. */
export class GuacamoleDesktopProvider {
  #backend; #connectMs;
  constructor({ backendForComputer, connectMs = 12_000 }) {
    if (typeof backendForComputer !== 'function' || !Number.isSafeInteger(connectMs) || connectMs <= 0) throw TypeError('Invalid desktop transport');
    this.#backend = backendForComputer; this.#connectMs = connectMs;
  }
  async connect({ computer, capabilities, signal, kind='rdp' }) {
    if(!['rdp','console'].includes(kind))throw TypeError('Invalid desktop kind');
    const backend = await this.#backend({ computer, signal, kind });
    let retired=false;
    const retire=()=>{if(!retired){retired=true;backend.close?.();}};
    try {
    const { authToken, connectionId, dataSource } = await backend.issueSession({ signal });
    if (signal.aborted || !authToken || !connectionId || dataSource !== 'json') throw Error('Desktop backend unavailable');
    const query = new URLSearchParams(capabilities);
    query.set('token', authToken); query.set('GUAC_DATA_SOURCE', dataSource); query.set('GUAC_ID', connectionId);
    const url = new URL(backend.tunnelUrl);
    // A local Unix/SSH adapter may terminate encryption at loopback; a remote
    // network endpoint must use verified TLS. Never disable certificate checks.
    if (url.username || url.password || url.search || url.hash || !['wss:', 'ws:'].includes(url.protocol)
      || url.protocol === 'ws:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Desktop transport must be encrypted or loopback');
    url.search = query.toString();
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, 'guacamole', { ...backend.tls, rejectUnauthorized: true,
        perMessageDeflate: false, handshakeTimeout: this.#connectMs });
      const abort = () => ws.terminate();
      signal.addEventListener('abort', abort, { once: true });
      ws.once('close', () => {signal.removeEventListener('abort', abort);retire();});
      ws.on('error', () => reject(Error('Desktop transport unavailable')));
      ws.once('open', () => { ws.pause(); resolve(ws); });
      if (signal.aborted) abort();
    });
    } catch(error) {retire();throw error;}
  }
}
