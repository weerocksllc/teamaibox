import {createServer} from 'node:net';
import {createCipheriv,createHmac,randomUUID} from 'node:crypto';
import {computerCommand} from '../../../../services/scheduler/src/computer-command.mjs';

// Apache Guacamole JSON extension format, identical to the already exercised
// lab integration. The token delegates this connection, not a Windows login.
// Guest credentials remain in the RDP authentication exchange.
export function guacamoleConnectionToken(key,payload) {
  if(!Buffer.isBuffer(key)||key.length!==16)throw TypeError('Invalid installed desktop key');
  const json=Buffer.from(JSON.stringify(payload)),signed=Buffer.concat([createHmac('sha256',key).update(json).digest(),json]);
  const cipher=createCipheriv('aes-128-cbc',key,Buffer.alloc(16));
  try{return Buffer.concat([cipher.update(signed),cipher.final()]).toString('base64');}
  finally{json.fill(0);signed.fill(0);}
}

/** Guacd shares the Platform host network and reaches only a loopback port.
 * Each accepted connection is carried through the current managed Node Agent
 * transport to the exact run. Nothing depends on a developer laptop/SSH or
 * publishes a raw guest RDP/VNC port. The listener dies with its desktop.
 */
export class ManagedDesktopBackends {
  #router;#origin;#key;#fetch;#sessions=new Set();#closed=false;
  constructor({nodeAgentRouter,guacamoleOrigin,jsonSecret,fetcher=fetch}) {
    if(typeof nodeAgentRouter?.connectComputerDesktop!=='function'||!Buffer.isBuffer(jsonSecret)||jsonSecret.length!==16)throw TypeError('Desktop configuration incomplete');
    const url=new URL(guacamoleOrigin);
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash
      ||url.pathname!=='/guacamole/')throw TypeError('Guacamole must be installed on Platform loopback');
    this.#router=nodeAgentRouter;this.#origin=url;this.#key=Buffer.from(jsonSecret);this.#fetch=fetcher;
  }
  async forComputer({computer,signal,kind='console'}) {
    if(this.#closed||!['rdp','console'].includes(kind)||!['running','stopping'].includes(computer?.state)||computer.runId!==computer.run?.id||!computer.run?.containerId)throw Error('Computer desktop unavailable');
    signal.throwIfAborted();
    const payload=computerCommand({id:randomUUID(),action:'inspect',command:{...computer,computerId:computer.id}});
    const controller=new AbortController(),connections=new Set(),servers=new Set();let closed=false;
    const close=()=>{if(closed)return;closed=true;controller.abort();signal.removeEventListener('abort',close);
      for(const s of connections)s.destroy();for(const server of servers)server.close();this.#sessions.delete(close);};
    const listener=async streamKind=>{
    const server=createServer(socket=>{
      socket.pause();connections.add(socket);socket.on('error',()=>{});
      const child=new AbortController();let upstream;
      const retire=()=>{child.abort();socket.destroy();upstream?.destroy();connections.delete(socket);connections.delete(upstream);};
      socket.once('close',retire);
      void (async()=>{
        try{
          upstream=await this.#router.connectComputerDesktop({nodeId:computer.nodeId,payload,kind:streamKind,correlationId:payload.operationId,
            signal:AbortSignal.any([controller.signal,child.signal])});
          if(closed||socket.destroyed){upstream.destroy();return;}
          connections.add(upstream);upstream.on('error',retire);upstream.once('close',retire);
          socket.pipe(upstream);upstream.pipe(socket);socket.resume();upstream.resume();
        }catch{retire();}
      })();
    });
    servers.add(server);
      await new Promise((resolve,reject)=>{
        const aborted=()=>reject(Error('Desktop cancelled'));
        controller.signal.addEventListener('abort',aborted,{once:true});
        server.once('error',error=>{controller.signal.removeEventListener('abort',aborted);reject(error);});
        server.listen(0,'127.0.0.1',()=>{controller.signal.removeEventListener('abort',aborted);if(closed){server.close();reject(Error('Desktop closed'));}else resolve();});
      });
      signal.throwIfAborted();if(closed||this.#closed)throw Error('Desktop closed');
      return server.address().port;
    };
    this.#sessions.add(close);signal.addEventListener('abort',close,{once:true});
    try{
      const port=await listener(kind);
      // A second connection belongs to exactly the same owned run. Only guacd
      // can reach this ephemeral loopback listener; closing the view closes both.
      const audioPort=kind==='console'?await listener('audio'):null;
      // Do not force NLA. Windows guests may expose NLA, TLS, or the native
      // encrypted RDP security layer depending on edition and guest policy.
      // Guacamole's "any" mode negotiates the strongest mutually supported
      // mode and can still request credentials interactively when NLA wins.
      const parameters=kind==='rdp'?{'security':'any','cert-tofu':'true','resize-method':'display-update',
        'disable-audio':'false','enable-drive':'false','enable-printing':'false','disable-copy':'true','disable-paste':'true'}:
        {'enable-audio':'true','audio-servername':`tcp:127.0.0.1:${audioPort}`,'disable-copy':'true','disable-paste':'true','disable-display-resize':'true'};
      const url=new URL('websocket-tunnel',this.#origin);url.protocol='ws:';
      return {tunnelUrl:url.href,close,issueSession:async({signal:requestSignal})=>{
        if(closed||this.#closed)throw Error('Desktop closed');
        const data=guacamoleConnectionToken(this.#key,{username:'computer-'+computer.ownerId,expires:Date.now()+60000,
          connections:{[computer.id]:{protocol:kind==='rdp'?'rdp':'vnc',parameters:{hostname:'127.0.0.1',port:String(port),...parameters}}}});
        const response=await this.#fetch(new URL('api/tokens',this.#origin),{method:'POST',redirect:'error',
          headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data}),
          signal:AbortSignal.any([controller.signal,requestSignal,AbortSignal.timeout(10000)])});
        if(!response.ok){await response.body?.cancel();throw Error('Desktop gateway unavailable');}
        const value=await response.json();
        if(typeof value.authToken!=='string'||!value.authToken||value.dataSource!=='json')throw Error('Invalid desktop gateway response');
        return {authToken:value.authToken,dataSource:'json',connectionId:computer.id};
      }};
    }catch(error){close();throw error;}
  }
  close(){this.#closed=true;for(const close of this.#sessions)close();this.#key.fill(0);}
}
