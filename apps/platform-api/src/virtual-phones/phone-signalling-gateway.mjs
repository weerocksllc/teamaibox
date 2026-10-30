import { WebSocketServer } from "ws";
import {PhoneAdbGateway,matchesPhoneAdbUpgrade} from "./phone-adb-gateway.mjs";

const UUID="[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ROUTE=new RegExp(`^/api/v1/virtual-phones/(${UUID})/connections/(${UUID})/signal$`);
const invalid=()=>{throw Error("phone_signal_invalid");};
const closed=(value,keys)=>value && typeof value==="object" && !Array.isArray(value)
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));

// Only this phone's single negotiation crosses the operator boundary. The
// browser cannot enumerate devices, select another phone, provide relay
// credentials, or turn this route into an arbitrary operator HTTP proxy.
export class PhoneSignalPolicy {
  #id; #selected=false; #offered=false; #answered=false;
  constructor(phoneId) {this.#id=`phone-${phoneId}`;}
  client(value) {
    if(closed(value,["message_type","device_id"]) && value.message_type==="connect") {
      if(this.#selected || value.device_id!==this.#id)invalid();
      this.#selected=true;return {message_type:"connect",device_id:this.#id};
    }
    if(!this.#selected || !closed(value,["message_type","payload"]) || value.message_type!=="forward")invalid();
    const p=value.payload;
    if(closed(p,["type","ice_servers"]) && p.type==="request-offer") {
      if(this.#offered || !Array.isArray(p.ice_servers) || p.ice_servers.length)invalid();
      this.#offered=true;
    } else if(closed(p,["type","sdp"]) && p.type==="answer") {
      if(!this.#offered || this.#answered || typeof p.sdp!=="string" || p.sdp.length>196608 || !p.sdp.startsWith("v=0\r\n"))invalid();
      this.#answered=true;
    } else if(closed(p,["type","candidate"]) && p.type==="ice-candidate") {
      const c=p.candidate;
      if(!this.#offered || !c || typeof c!=="object" || Array.isArray(c)
        || Object.keys(c).some(k=>!["candidate","sdpMid","sdpMLineIndex","usernameFragment"].includes(k))
        || typeof c.candidate!=="string" || c.candidate.length>4096
        || (c.sdpMid!=null && (typeof c.sdpMid!=="string" || c.sdpMid.length>64))
        || (c.sdpMLineIndex!=null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex<0 || c.sdpMLineIndex>16))
        || (c.usernameFragment!=null && (typeof c.usernameFragment!=="string" || c.usernameFragment.length>256)))invalid();
    } else invalid();
    return structuredClone(value);
  }
  device(value) {
    if(!value || typeof value!=="object" || Array.isArray(value))invalid();
    if(value.error)invalid();
    if(value.message_type==="config") return {message_type:"config",ice_servers:[]};
    // Only readiness is required by our fixed-spec UI, not the operator's full
    // device configuration, paths, build properties or other device catalogue.
    if(value.message_type==="device_info" && this.#selected) return {message_type:"device_info"};
    if(value.message_type!=="device_msg" || !this.#offered)invalid();
    const p=value.payload;
    if(p?.type==="offer" && typeof p.sdp==="string" && p.sdp.length<=196608 && p.sdp.startsWith("v=0\r\n")) {
      return {message_type:"device_msg",payload:{type:"offer",sdp:p.sdp}};
    }
    if(p?.type==="ice-candidate" && typeof p.candidate==="string" && p.candidate.length<=4096
      && (p.mid==null || typeof p.mid==="string" && p.mid.length<=64)
      && (p.mLineIndex==null || Number.isInteger(p.mLineIndex) && p.mLineIndex>=0 && p.mLineIndex<=16)) {
      return {message_type:"device_msg",payload:{type:"ice-candidate",candidate:p.candidate,mid:p.mid??null,mLineIndex:p.mLineIndex??null}};
    }
    invalid();
  }
}

/** Public same-origin WSS. Existing Platform login supplies context; access
 * consumes the once-only ticket and owns real peer revocation. Upstream is an
 * installed node connector which only accepts the persisted grant, never a URL.
 * No SDP, frame, token, cookie or upstream error is written to logs/storage.
 */
export class PhoneSignallingGateway {
  #access; #upstream; #origin; #wss; #connections=new Set(); #closed=false; #maximum; #adb;
  constructor({accessService,upstream,publicOrigin,maximumConnections=64,adbUpstream=null}) {
    if(!["consume","assertConnected","disconnect"].every(k=>typeof accessService?.[k]==="function")
      || typeof upstream?.connect!=="function" || !Number.isInteger(maximumConnections) || maximumConnections<1 || maximumConnections>256)throw TypeError("Phone gateway is incomplete");
    const origin=new URL(publicOrigin);
    if(origin.protocol!=="https:" || origin.pathname!=="/" || origin.search || origin.hash || origin.username || origin.password)throw TypeError("Phone gateway requires HTTPS");
    this.#origin=origin.origin;this.#access=accessService;this.#upstream=upstream;this.#maximum=maximumConnections;
    this.#adb=adbUpstream ? new PhoneAdbGateway({accessService,upstream:adbUpstream,publicOrigin}) : null;
    this.#wss=new WebSocketServer({noServer:true,clientTracking:false,perMessageDeflate:false,maxPayload:262144,maxFragments:64,maxBufferedChunks:128});
    this.#wss.on("error",()=>{});
  }
  async attachUpgrade(request,socket,head,{context}={}) {
    if(matchesPhoneAdbUpgrade(request.url))return this.#adb ? this.#adb.attachUpgrade(request,socket,head) : false;
    const match=ROUTE.exec(request.url??"");
    if(!match)return false;
    if(this.#closed || request.method!=="GET" || request.headers.origin!==this.#origin || request.headers["sec-websocket-protocol"]
      || !context?.identityId || !context?.sessionId || this.#connections.size>=this.#maximum) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return true;
    }
    // Reserve before async authentication. Per-connection first-frame and
    // heartbeat timeouts release abandoned upgrades without unbounded queues.
    const record={close:()=>socket.destroy()};this.#connections.add(record);
    try {
      this.#wss.handleUpgrade(request,socket,head,ws=>this.#session(ws,record,context,match[1],match[2]));
    } catch {this.#connections.delete(record);socket.destroy();}
    socket.once("close",()=>this.#connections.delete(record));
    return true;
  }
  #session(ws,record,context,phoneId,grantId) {
    const policy=new PhoneSignalPolicy(phoneId),abort=new AbortController();
    let grant=null,peer=null,ended=false,serial=Promise.resolve(),queued=0,authenticated=false;
    let heartbeat=null,checking=false,pong=true,cleaning=null;
    const cleanup=async()=>{
      if(!ended) {
        ended=true;abort.abort();clearTimeout(firstFrame);clearInterval(heartbeat);
        ws.terminate();try{peer?.close();}catch{}this.#connections.delete(record);
      }
      if(grant && !cleaning) {
        cleaning=this.#access.disconnect(grant).catch(()=>{});await cleaning;
        // Failed revocation remains durable; AccessService reconciles it and
        // the phone itself expires its independently enforced short lease.
      }
    };
    record.close=cleanup;
    const firstFrame=setTimeout(()=>void cleanup(),5000);firstFrame.unref();
    const send=value=>{
      if(ended)return;
      if(ws.readyState!==1 || ws.bufferedAmount>262144){void cleanup();return;}
      ws.send(JSON.stringify(value),error=>{if(error)void cleanup();});
    };
    ws.on("error",()=>void cleanup());ws.on("close",()=>void cleanup());ws.on("pong",()=>{pong=true;});
    ws.on("message",(bytes,binary)=>{
      if(ended)return;
      if(binary || queued>=16 || !authenticated && bytes.length>1024){void cleanup();return;}
      queued++;
      serial=serial.then(async()=>{
        if(ended)return;
        let value=JSON.parse(bytes.toString("utf8"));
        if(!authenticated) {
          if(!closed(value,["type","token"]) || value.type!=="phone.authenticate" || !/^[A-Za-z0-9_-]{43}$/.test(value.token??""))invalid();
          grant=await this.#access.consume({context,phoneId,grantId,kind:"control",token:value.token});
          value=null;
          if(ended){await cleanup();return;}
          peer=await this.#upstream.connect({grant,signal:abort.signal,
            onMessage:message=>{try{send(policy.device(message));}catch{void cleanup();}},onClose:()=>void cleanup()});
          if(ended){peer?.close();await cleanup();return;}
          if(!peer || typeof peer.send!=="function" || typeof peer.close!=="function")invalid();
          await this.#access.assertConnected({context,grant});
          if(ended)return;
          authenticated=true;clearTimeout(firstFrame);send({type:"phone.signal.ready"});
          heartbeat=setInterval(()=>{
            if(ended)return;
            if(!pong){void cleanup();return;}
            pong=false;ws.ping();
            if(checking)return;checking=true;
            void this.#access.assertConnected({context,grant}).catch(cleanup).finally(()=>{checking=false;});
          },2000);heartbeat.unref();
        } else {
          await this.#access.assertConnected({context,grant});
          if(!ended)peer.send(policy.client(value));
        }
      }).catch(cleanup).finally(()=>{bytes.fill(0);queued--;});
    });
  }
  async close() {
    if(this.#closed)return;this.#closed=true;
    await this.#adb?.close();
    await Promise.all([...this.#connections].map(x=>x.close()));this.#connections.clear();this.#wss.close();
  }
}
