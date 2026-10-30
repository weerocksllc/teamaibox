import {phoneStatistics} from './phone-statistics.mjs';
// Cuttlefish's signalling/input format, restricted to this phone's authenticated
// gateway. No example operator page, public URL, ADB or device enumeration.
export class PhoneMediaSession {
  #socket; #peer; #input; #control; #closed=false; #pending=[]; #serial=Promise.resolve(); #queued=0; #timer;
  constructor({ticket,origin=globalThis.location?.origin,WebSocketImpl=globalThis.WebSocket,
    PeerConnection=globalThis.RTCPeerConnection,onTrack=()=>{},onState=()=>{}}) {
    const base=new URL(origin);
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if(base.protocol!=="https:" || !uuid.test(ticket?.phoneId ?? "") || !uuid.test(ticket?.id ?? "")
        || !/^[A-Za-z0-9_-]{43}$/.test(ticket?.token ?? "") || ticket.kind!=="control") throw new TypeError("phone_grant_invalid");
    if(typeof PeerConnection!=='function')throw Object.assign(new Error('phone_browser_media_unavailable'),{code:'phone_browser_media_unavailable'});
    this.onState=onState;
    const phoneId=ticket.phoneId,path=`/api/v1/virtual-phones/${phoneId}/connections/${ticket.id}/signal`;
    try {
      try {this.#peer=new PeerConnection({iceServers:[]});} // LAN only; no external STUN/TURN fallback.
      catch(error){
        if(['NotSupportedError','SecurityError'].includes(error?.name))
          throw Object.assign(new Error('phone_browser_media_unavailable'),{code:'phone_browser_media_unavailable'});
        throw error;
      }
      this.#input=this.#peer.createDataChannel("input-channel",{ordered:true});
      this.#socket=new WebSocketImpl(`wss://${base.host}${path}`);
    } catch(error) {
      this.#input?.close();this.#peer?.close();this.#socket?.close();throw error;
    }
    this.#peer.ondatachannel=event=>{
      if(event.channel.label==="device-control" && !this.#control)this.#control=event.channel;
      else event.channel.close(); // No debug/file/camera channels in control UI.
    };
    this.#peer.ontrack=event=>{if(!this.#closed)onTrack(event.track);};
    this.#peer.onicecandidate=event=>{
      if(event.candidate?.candidate)this.#send({message_type:"forward",payload:{type:"ice-candidate",candidate:event.candidate.toJSON()}});
    };
    this.#peer.onconnectionstatechange=()=>{
      if(this.#closed)return;
      if(this.#peer.connectionState==="connected"){clearTimeout(this.#timer);onState("connected");}
      else if(["failed","closed"].includes(this.#peer.connectionState))this.close("failed");
      else if(this.#peer.connectionState==="disconnected"){
        clearTimeout(this.#timer);this.#timer=setTimeout(()=>this.close("disconnected"),5000);onState("reconnecting");
      }
    };
    // Browser WebSocket cannot set an Authorization header. The one-use secret
    // is the first frame over WSS, never a query parameter, log or localStorage.
    let token=ticket.token;
    this.#socket.onopen=()=>{this.#send({type:"phone.authenticate",token});token=null;};
    this.#socket.onmessage=event=>{
      if(this.#closed)return;
      if(typeof event.data!=="string" || event.data.length>262144 || this.#queued>=32)return this.close("failed");
      this.#queued++;
      this.#serial=this.#serial.then(()=>this.#message(JSON.parse(event.data),phoneId))
        .catch(()=>this.close("failed")).finally(()=>{this.#queued--;});
    };
    this.#socket.onerror=()=>this.close("failed");
    this.#socket.onclose=()=>this.close("disconnected");
    this.#timer=setTimeout(()=>this.close("failed"),20000);
    onState("connecting");
  }
  #send(value) {
    if(this.#closed || this.#socket.readyState!==1)return;
    if(this.#socket.bufferedAmount>262144)return this.close("failed");
    this.#socket.send(JSON.stringify(value));
  }
  async #message(message,phoneId) {
    if(this.#closed)return;
    if(message.type==="phone.signal.ready"){
      this.#send({message_type:"connect",device_id:`phone-${phoneId}`});return;
    }
    if(message.error || message.type==="phone.error")throw Error("phone_signal_failed");
    if(message.message_type==="config")return; // Do not accept caller/upstream relay credentials.
    if(message.message_type==="device_info"){
      this.#send({message_type:"forward",payload:{type:"request-offer",ice_servers:[]}});return;
    }
    if(message.message_type!=="device_msg" || !message.payload)throw Error("phone_signal_invalid");
    const value=message.payload;
    if(value.type==="offer" && typeof value.sdp==="string" && value.sdp.length<=196608){
      await this.#peer.setRemoteDescription({type:"offer",sdp:value.sdp});
      if(this.#closed)return;
      for(const candidate of this.#pending.splice(0))await this.#peer.addIceCandidate(candidate);
      const answer=await this.#peer.createAnswer();
      if(this.#closed)return;
      await this.#peer.setLocalDescription(answer);
      this.#send({message_type:"forward",payload:{type:"answer",sdp:answer.sdp}});
    } else if(value.type==="ice-candidate" && typeof value.candidate==="string" && value.candidate.length<=4096){
      const candidate={candidate:value.candidate,sdpMid:value.mid ?? null,sdpMLineIndex:value.mLineIndex ?? null};
      if(this.#peer.remoteDescription)await this.#peer.addIceCandidate(candidate);
      else {if(this.#pending.length>=128)throw Error("phone_ice_overflow");this.#pending.push(candidate);}
    } else throw Error("phone_signal_invalid");
  }
  #event(value) {
    if(this.#closed || this.#input.readyState!=="open")return false;
    // Do not replay queued keystrokes/touches after a connection outage.
    if(this.#input.bufferedAmount>16384){this.close("failed");return false;}
    this.#input.send(JSON.stringify(value));return true;
  }
  key(code,type) {
    if(typeof code!=="string" || !/^[A-Za-z][A-Za-z0-9]{0,47}$/.test(code) || !["keydown","keyup"].includes(type))return false;
    return this.#event({type:"keyboard",keycode:code,event_type:type});
  }
  control(command,state) {
    if(this.#closed || this.#control?.readyState!=="open" || !["home","back","menu","volumeup","volumedown"].includes(command)
       || !["down","up"].includes(state))return false;
    if(this.#control.bufferedAmount>16384){this.close("failed");return false;}
    this.#control.send(JSON.stringify({command,button_state:state}));return true;
  }
  touch(points,down) {
    if(!Array.isArray(points)||points.length<1||points.length>10||typeof down!=="boolean"
      || points.some(p=>![p.id,p.x,p.y].every(Number.isInteger)||p.id<0||p.id>9||p.x<0||p.x>=720||p.y<0||p.y>=1280))return false;
    return this.#event({type:"multi-touch",id:points.map(p=>p.id),x:points.map(p=>p.x),y:points.map(p=>p.y),down:down?1:0,device_label:"display_0"});
  }
  async statistics() {
    if(this.#closed||typeof this.#peer.getStats!=='function')return null;
    const report=await this.#peer.getStats();
    return this.#closed?null:phoneStatistics(report);
  }
  close(state="closed") {
    if(this.#closed)return;
    this.#closed=true;clearTimeout(this.#timer);this.#pending=[];
    this.#input.close();this.#control?.close();this.#peer.close();this.#socket.close();this.onState(state);
  }
}

export function phoneViewportPoint(rect,x,y,{clamp=false}={}) {
  if(!rect || ![rect.left,rect.top,rect.width,rect.height,x,y].every(Number.isFinite) || rect.width<=0 || rect.height<=0)return null;
  const scale=Math.min(rect.width/720,rect.height/1280),width=720*scale,height=1280*scale;
  let px=(x-rect.left-(rect.width-width)/2)/scale,py=(y-rect.top-(rect.height-height)/2)/scale;
  if(!clamp&&(px<0||py<0||px>=720||py>=1280))return null;
  return {x:Math.max(0,Math.min(719,Math.floor(px))),y:Math.max(0,Math.min(1279,Math.floor(py)))};
}
