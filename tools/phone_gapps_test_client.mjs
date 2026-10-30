// Direct Cuttlefish test protocol, not a substitute for member authorization.
// Reachable through this machine's loopback-only SSH/TLS test viewer only.
const device=new URL(location.href).searchParams.get('deviceId');
if(!/^phone-[0-9a-f-]{36}$/.test(device||''))throw Error('test_device_required');
const video=document.querySelector('#phone'),status=document.querySelector('#state');
const ws=new WebSocket(`ws://${location.host}/connect_client`),pc=new RTCPeerConnection({iceServers:[]});
const input=pc.createDataChannel('input-channel',{ordered:true}),tracks=new MediaStream();
let control,serial=Promise.resolve(),pending=[],closed=false;
const send=value=>{if(ws.readyState===1 && ws.bufferedAmount<262144)ws.send(JSON.stringify(value));};
const event=value=>{if(input.readyState==='open' && input.bufferedAmount<16384)input.send(JSON.stringify(value));};
function close(){if(closed)return;closed=true;status.textContent='已断开';input.close();control?.close();pc.close();ws.close();video.srcObject=null;}
pc.ondatachannel=({channel})=>{if(channel.label==='device-control'&&!control)control=channel;else channel.close();};
pc.ontrack=({track})=>{tracks.addTrack(track);video.srcObject=tracks;video.play().catch(()=>{});};
pc.onicecandidate=({candidate})=>{if(candidate)send({message_type:'forward',payload:{type:'ice-candidate',candidate:candidate.toJSON()}});};
pc.onconnectionstatechange=()=>{status.textContent=pc.connectionState==='connected'?'已连接':pc.connectionState;};
ws.onopen=()=>send({message_type:'connect',device_id:device});
ws.onmessage=({data})=>{serial=serial.then(async()=>{
  const message=JSON.parse(data);if(message.error)throw Error('signal_failed');
  if(message.message_type==='config')return;
  if(message.message_type==='device_info'){send({message_type:'forward',payload:{type:'request-offer',ice_servers:[]}});return;}
  const p=message.payload;if(message.message_type!=='device_msg')return;
  if(p.type==='offer'){
    await pc.setRemoteDescription({type:'offer',sdp:p.sdp});for(const c of pending.splice(0))await pc.addIceCandidate(c);
    const answer=await pc.createAnswer();await pc.setLocalDescription(answer);send({message_type:'forward',payload:{type:'answer',sdp:answer.sdp}});
  }else if(p.type==='ice-candidate'){
    const c={candidate:p.candidate,sdpMid:p.mid??null,sdpMLineIndex:p.mLineIndex??null};
    if(pc.remoteDescription)await pc.addIceCandidate(c);else if(pending.length<128)pending.push(c);else throw Error('ice_overflow');
  }
}).catch(close);};
ws.onclose=close;ws.onerror=close;
const touch=(e,down)=>{const r=video.getBoundingClientRect(),scale=Math.min(r.width/720,r.height/1280);
  const x=Math.max(0,Math.min(719,Math.floor((e.clientX-r.left-(r.width-720*scale)/2)/scale)));
  const y=Math.max(0,Math.min(1279,Math.floor((e.clientY-r.top-(r.height-1280*scale)/2)/scale)));
  event({type:'multi-touch',id:[0],x:[x],y:[y],down:down?1:0,device_label:'display_0'});
};
let dragging=false;
video.onpointerdown=e=>{e.preventDefault();video.focus();video.setPointerCapture(e.pointerId);dragging=true;touch(e,true);};
video.onpointermove=e=>{if(dragging)touch(e,true);};
video.onpointerup=e=>{touch(e,false);dragging=false;};video.onpointercancel=e=>{touch(e,false);dragging=false;};
for(const type of ['keydown','keyup'])video.addEventListener(type,e=>{e.preventDefault();event({type:'keyboard',keycode:e.code,event_type:type});});
for(const button of document.querySelectorAll('[data-control]'))button.onclick=()=>{
  if(control?.readyState==='open')for(const button_state of ['down','up'])control.send(JSON.stringify({command:button.dataset.control,button_state}));
};
document.querySelector('#sound').onclick=()=>{video.muted=!video.muted;video.play().catch(()=>{});document.querySelector('#sound').textContent=video.muted?'开启声音':'静音';};
setInterval(()=>{document.querySelector('#resolution').textContent=video.videoWidth?`${video.videoWidth} × ${video.videoHeight}`:'等待画面';
  document.querySelector('#frames').textContent='接收帧：'+(video.getVideoPlaybackQuality?.().totalVideoFrames??0);},2000);
window.addEventListener('pagehide',close);
