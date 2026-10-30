import { WebSocketServer, createWebSocketStream } from "ws";

const UUID="[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ROUTE=new RegExp(`^/api/v1/virtual-phones/(${UUID})/connections/(${UUID})/adb$`);
export const matchesPhoneAdbUpgrade=path=>ROUTE.test(path??"");

/** Only raw ADB for the phone bound to a once-only Web-issued ticket. No
 * password/cookie or token-in-URL; CLI identity remains tied to its Web login.
 * The private phone runtime separately expires and closes the actual socket.
 */
export class PhoneAdbGateway {
  #access;#upstream;#origin;#wss;#connections=new Set();#closed=false;
  constructor({accessService,upstream,publicOrigin}) {
    if(!["consumeDebug","assertConnected","disconnect"].every(k=>typeof accessService?.[k]==="function") || typeof upstream?.connect!=="function")throw TypeError("Phone ADB gateway incomplete");
    const origin=new URL(publicOrigin);
    if(origin.protocol!=="https:" || origin.pathname!=="/" || origin.search || origin.hash || origin.username || origin.password)throw TypeError("Phone ADB requires HTTPS");
    this.#origin=origin.origin;this.#access=accessService;this.#upstream=upstream;
    this.#wss=new WebSocketServer({noServer:true,clientTracking:false,perMessageDeflate:false,maxPayload:65536,maxFragments:32,maxBufferedChunks:64});
    this.#wss.on("error",()=>{});
  }
  async attachUpgrade(request,socket,head) {
    const match=ROUTE.exec(request.url??"");if(!match)return false;
    if(this.#closed || request.method!=="GET" || request.headers.origin && request.headers.origin!==this.#origin
      || request.headers["sec-websocket-protocol"] || this.#connections.size>=32) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return true;
    }
    const record={close:()=>socket.destroy()};this.#connections.add(record);
    try {this.#wss.handleUpgrade(request,socket,head,ws=>this.#session(ws,record,match[1],match[2]));}
    catch {this.#connections.delete(record);socket.destroy();}
    socket.once("close",()=>this.#connections.delete(record));return true;
  }
  #session(ws,record,phoneId,grantId) {
    const abort=new AbortController();
    let grant=null,upstream=null,bridge=null,ended=false,first=true,active=false,heartbeat=null,pong=true,checking=false,cleaning=null;
    const cleanup=async()=>{
      if(!ended) {ended=true;abort.abort();clearTimeout(timeout);clearInterval(heartbeat);ws.terminate();upstream?.destroy();bridge?.destroy();this.#connections.delete(record);}
      if(grant && !cleaning)cleaning=this.#access.disconnect(grant).catch(()=>{});
      await cleaning;
    };
    record.close=cleanup;
    const timeout=setTimeout(()=>void cleanup(),5000);timeout.unref();
    ws.on("error",()=>void cleanup());ws.on("close",()=>void cleanup());ws.on("pong",()=>{pong=true;});
    ws.on("message",(bytes,binary)=>{
      if(ended)return;
      if(!first) {if(!active || !binary)void cleanup();return;}
      first=false;ws.pause();
      if(binary || bytes.length>1024){void cleanup();return;}
      void (async()=>{
        let value=JSON.parse(bytes.toString("utf8"));bytes.fill(0);
        if(!value || Object.keys(value).length!==2 || value.type!=="phone.authenticate" || !/^[A-Za-z0-9_-]{43}$/.test(value.token??""))throw Error("phone_grant_invalid");
        grant=await this.#access.consumeDebug({phoneId,grantId,token:value.token});value=null;
        if(ended){await cleanup();return;}
        const context={identityId:grant.ownerId,sessionId:grant.sessionId};
        upstream=await this.#upstream.connect({grant,signal:abort.signal});
        if(ended){upstream.destroy();await cleanup();return;}
        await this.#access.assertConnected({context,grant});
        if(ended)return;
        upstream.on("error",()=>void cleanup());upstream.on("close",()=>void cleanup());
        ws.send(JSON.stringify({type:"phone.adb.ready"}));
        bridge=createWebSocketStream(ws,{highWaterMark:65536});
        bridge.on("error",()=>void cleanup());bridge.on("close",()=>void cleanup());
        // Node stream piping applies backpressure in both directions. Frames
        // are bounded by maxPayload; there is no growing JS message queue.
        bridge.pipe(upstream);upstream.pipe(bridge);active=true;clearTimeout(timeout);ws.resume();
        heartbeat=setInterval(()=>{
          if(ended)return;
          if(!pong){void cleanup();return;}pong=false;ws.ping();
          if(checking)return;checking=true;
          void this.#access.assertConnected({context,grant}).catch(cleanup).finally(()=>{checking=false;});
        },2000);heartbeat.unref();
      })().catch(cleanup);
    });
  }
  async close() {
    if(this.#closed)return;this.#closed=true;
    await Promise.all([...this.#connections].map(value=>value.close()));this.#connections.clear();this.#wss.close();
  }
}
