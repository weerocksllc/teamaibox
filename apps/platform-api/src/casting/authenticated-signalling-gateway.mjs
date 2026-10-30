import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const ROUTE = /^\/api\/v1\/casting\/media\/([A-Za-z0-9_-]{43})\/rtc$/;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const accept = key => createHash('sha1').update(key+GUID).digest('base64');
const unavailable = () => Error('cast_signalling_unavailable');
const QUERY = new Set(['sdk','version','protocol','client_protocol','auto_subscribe','adaptive_stream',
  'os','os_version','device_model','browser','browser_version','network']);
function validParameter(name, value) {
  return QUERY.has(name) && typeof value === 'string' && value.length <= 128
    && /^[A-Za-z0-9_. -]*$/.test(value)
    && (name !== 'client_protocol' || /^[0-9]{1,4}$/.test(value));
}

function privateHost(host) {
  if (host === 'trusted-media' || host.endsWith('.teamaibox.internal')) return true;
  if (isIP(host) !== 4) return false;
  const [a,b] = host.split('.').map(Number);
  return a===10 || a===127 || (a===192&&b===168) || (a===172&&b>=16&&b<=31);
}

/** Fixed private, pinned-mTLS SFU hop. Never forwards the browser's cookie,
 * Authorization header, hostname, path, Origin or arbitrary query parameters.
 * The same-origin gateway URL is not a generic reverse proxy.
 */
export class NodeMtlsCastingSignallingUpstream {
  #origin; #tls; #request; #closed=false;
  constructor({ origin, serverName, ca, cert, key, requestFactory = httpsRequest } = {}) {
    const target = new URL(origin);
    if (target.protocol !== 'https:' || target.pathname !== '/' || target.username || target.password
      || target.search || target.hash || !privateHost(target.hostname)
      || typeof serverName !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(serverName) || isIP(serverName)
      || ![ca,cert,key].every(value=>Buffer.isBuffer(value)&&value.length>=64&&value.length<=1024*1024)
      || typeof requestFactory !== 'function') throw new TypeError('Invalid private signalling configuration');
    this.#origin=target.origin;this.#request=requestFactory;
    this.#tls={ca:Buffer.from(ca),cert:Buffer.from(cert),key:Buffer.from(key),servername:serverName,
      minVersion:'TLSv1.3',rejectUnauthorized:true};
  }

  async connect({ accessToken, parameters }) {
    if(this.#closed||typeof accessToken!=='string'||accessToken.length>12_288
      ||!Array.isArray(parameters)||parameters.length>QUERY.size)throw unavailable();
    const url=new URL('/rtc',this.#origin);
    url.searchParams.set('access_token',accessToken);
    const seen=new Set();
    for(const [name,value] of parameters) {
      if(seen.has(name)||!validParameter(name,value))throw unavailable();
      seen.add(name);url.searchParams.set(name,value);
    }
    const key=randomBytes(16).toString('base64');
    return new Promise((resolve,reject)=>{
      let settled=false;
      const request=this.#request(url,{...this.#tls,method:'GET',maxHeaderSize:8192,
        headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':key}});
      const fail=()=>{if(settled)return;settled=true;request.destroy();reject(unavailable());};
      request.setTimeout(10_000,fail);
      request.once('error',fail);request.once('response',response=>{response.destroy();fail();});
      request.once('upgrade',(response,socket,head)=>{
        if(settled || response.statusCode!==101 || response.headers['sec-websocket-accept']!==accept(key)
          || response.headers.upgrade?.toLowerCase()!=='websocket'
          || response.headers['sec-websocket-protocol'] || head.length>65536) { socket.destroy();fail();return; }
        settled=true;request.setTimeout(0);socket.setTimeout(0);
        resolve({socket,head});
      });
      request.end();
    });
  }

  close() { this.#closed=true;this.#tls.ca.fill(0);this.#tls.cert.fill(0);this.#tls.key.fill(0); }
}

/** In-process same-origin WSS upgrade handler; enable only with a private SFU.
 * attachUpgrade returns false for an unrelated path, otherwise handles all
 * errors without logging the URL, cookie or one-use token. It is not currently
 * enabled by Platform only with its explicit private runtime/signalling
 * configuration; session creation still requires independent runtime admission.
 */
export class AuthenticatedCastingSignallingGateway {
  #admission; #upstream; #secure; #origin; #timers; #connections=new Map(); #closed=false; #cleanupTimer;
  constructor({ admission, upstream, assertSecureRequest, publicOrigin,
    setIntervalFactory=setInterval,clearIntervalFactory=clearInterval }={}) {
    if(!admission?.admit||!admission?.reauthorize||!admission?.disconnect||!admission?.close
      ||!upstream?.connect||typeof assertSecureRequest!=='function') throw new TypeError('Invalid casting gateway dependencies');
    const origin=new URL(publicOrigin);
    if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash) {
      throw new TypeError('Invalid casting gateway origin');
    }
    this.#admission=admission;this.#upstream=upstream;this.#secure=assertSecureRequest;this.#origin=origin.origin;
    this.#timers={set:setIntervalFactory,clear:clearIntervalFactory};
    this.#cleanupTimer=this.#timers.set(()=>{void this.retryCleanup();},1000);
    this.#cleanupTimer.unref?.();
  }

  async attachUpgrade(request,socket,head=Buffer.alloc(0)) {
    let url;
    try { url=new URL(request.url,this.#origin); } catch { return false; }
    const match=ROUTE.exec(url.pathname);
    if(!match)return false;
    socket.pause();
    let connectionId=null;let peer=null;let timer=null;let done=false;let checking=false;
    const cleanup=async()=>{
      if(!done){done=true;if(timer)this.#timers.clear(timer);socket.destroy();peer?.destroy();}
      if(connectionId) {
        try { await this.#admission.disconnect(connectionId); this.#connections.delete(connectionId); }
        catch { /* exact cleanup ownership remains for the next sweep/close */ }
      }
    };
    try {
      if(this.#closed||request.method!=='GET'||!request.url.startsWith('/api/v1/casting/media/')
        ||url.origin!==this.#origin||url.username||url.password||url.hash||head.length>65536) throw unavailable();
      await this.#secure(request);
      const key=request.headers['sec-websocket-key'];
      if(request.headers.origin!==this.#origin || request.headers.upgrade?.toLowerCase()!=='websocket'
        || request.headers['sec-websocket-version']!=='13' || request.headers['sec-websocket-protocol']
        || typeof key!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(key)||Buffer.from(key,'base64').length!==16
        || request.url.length>16384) throw unavailable();
      const parameters=[];let token=null;const seen=new Set();
      for(const [name,value] of url.searchParams) {
        if(seen.has(name))throw unavailable();seen.add(name);
        if(name==='access_token'){token=value;continue;}
        if(!validParameter(name,value))throw unavailable();
        parameters.push([name,value]);
      }
      const admitted=await this.#admission.admit({request,handle:match[1],accessToken:token});
      connectionId=admitted.connectionId;
      this.#connections.set(connectionId,{cleanup,isClosing:()=>done});
      socket.once('close',()=>{void cleanup();});socket.once('error',()=>{void cleanup();});
      if(socket.destroyed||this.#closed)throw unavailable();
      const upstream=await this.#upstream.connect({accessToken:token,parameters});peer=upstream.socket;
      if(socket.destroyed||this.#closed||done){peer.destroy();throw unavailable();}
      await this.#admission.reauthorize({request,connectionId});
      if(socket.destroyed||this.#closed||done)throw unavailable();
      peer.once('close',()=>{void cleanup();});peer.once('error',()=>{void cleanup();});
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        +`Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`);
      if(upstream.head.length)socket.write(upstream.head);
      if(head.length)peer.write(head);
      // Node stream piping applies backpressure. These sockets carry only
      // signalling, not media frames; SDP/ICE bytes are never persisted.
      socket.pipe(peer);peer.pipe(socket);socket.resume();
      timer=this.#timers.set(()=>{
        if(checking||done)return;checking=true;
        void this.#admission.reauthorize({request,connectionId}).catch(cleanup).finally(()=>{checking=false;});
      },5000);timer.unref?.();
    } catch {
      if(!socket.destroyed&&connectionId===null) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',()=>socket.destroy());
        return true;
      }
      await cleanup();
    }
    return true;
  }

  async retryCleanup() {
    for(const {cleanup,isClosing} of this.#connections.values()) {
      if(this.#closed||isClosing())await cleanup();
    }
    await this.#admission.retryCleanup?.();
    if(this.#closed && this.#connections.size===0) {
      try {
        await this.#admission.close();
        this.#timers.clear(this.#cleanupTimer);
        this.#upstream.close?.();
      } catch { /* keep the sweep alive until exact media removal is confirmed */ }
    }
  }

  async close() {
    this.#closed=true;
    await Promise.all([...this.#connections.values()].map(({cleanup})=>cleanup()));
    await this.#admission.close();
    this.#connections.clear();
    this.#timers.clear(this.#cleanupTimer);
    this.#upstream.close?.();
  }
}
