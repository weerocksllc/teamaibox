import {PhoneMediaSession,phoneViewportPoint} from './phone-media.mjs';
import {createPhoneDiagnostics} from './phone-diagnostics.mjs';
import {createPhoneAudio} from './phone-audio.mjs';

// Guest reboot outlasts the former three retries (7 seconds). Keep recovery
// bounded by both time and attempts, without a tight ticket-creation loop.
export function phoneReconnectDelay(attempts,elapsedMs) {
  if(attempts>=12 || elapsedMs>=90000)return null;
  return Math.min(1000*2**attempts,5000,90000-elapsedMs);
}

export function createPhoneWorkspace({element,api,translate,onReturn=()=>{},onPhoneExit=()=>{},createSession=options=>new PhoneMediaSession(options)}) {
  const find=id=>element.querySelector(`#${id}`),video=find('phone-video'),audio=find('phone-audio');
  const pointers=new Map(),keys=new Set();
  let phone=null,session=null,ticket=null,epoch=0,connectionState='closed',retryTimer=null,stableTimer=null,retries=0,recoveryStarted=null,suspended=false,wantsRetry=false;
  const playback=createPhoneAudio({audio,button:find('phone-enable-audio'),status:find('phone-audio-status'),translate});
  const diagnostics=createPhoneDiagnostics({element:find('phone-diagnostics'),getSession:()=>session,getPlayback:()=>playback.snapshot(),translate});
  const status=value=>{connectionState=value;find('phone-connection').textContent=translate(`media_${value}`);
    find('phone-retry').hidden=!['failed','disconnected','in_use','browser_unavailable'].includes(value);
    find('phone-retry').textContent=translate(value==='in_use'?'connectHere':'reconnect');};
  const runtimeStatus=()=>status(phone?.errorCode==='phone_resource_protection'?'protected':
    phone?.state==='stopping'?'stopping':phone?.state==='stopped'?'stopped':'unavailable');
  const releaseInput=()=>{
    for(const code of keys)session?.key(code,'keyup');keys.clear();
    for(const point of pointers.values())session?.touch([point],false);pointers.clear();
  };
  function disconnect() {
    diagnostics.close();
    ++epoch;clearTimeout(retryTimer);clearTimeout(stableTimer);retryTimer=null;releaseInput();
    const previous=ticket;ticket=null;const peer=session;session=null;peer?.close();
    video.srcObject=null;playback.reset();
    // Finish closing only our own connection before requesting a new one.
    // Other pages must never be disconnected by recovery or a page refresh.
    return previous?api.closeConnection(previous.phoneId,previous.id).catch(()=>{}):Promise.resolve();
  }
  function retry() {
    if(!phone || phone.state!=='running' || suspended)return;
    recoveryStarted??=performance.now();
    const delay=phoneReconnectDelay(retries,performance.now()-recoveryStarted);
    if(delay===null){wantsRetry=false;status('disconnected');return;}
    wantsRetry=true;
    if(document.hidden || retryTimer)return;
    status('reconnecting');const current=epoch;
    retryTimer=setTimeout(()=>{retryTimer=null;if(current===epoch){
      if(phoneReconnectDelay(retries,performance.now()-recoveryStarted)===null){wantsRetry=false;status('disconnected');return;}
      retries++;void connect(true);
    }},delay);
  }
  async function connect(automatic=false,takeover=false) {
    if(!phone || suspended)return;
    if(phone.state!=='running'){runtimeStatus();return;}
    if(!automatic){retries=0;recoveryStarted=null;}
    wantsRetry=false;
    const closed=disconnect(),current=epoch;status('connecting');
    try {
      await closed;if(current!==epoch)return;
      const value=await api.connection(phone.id,{takeover});
      if(current!==epoch){void api.closeConnection(value.phoneId,value.id).catch(()=>{});return;}
      ticket={phoneId:value.phoneId,id:value.id};
      session=createSession({ticket:value,onState:next=>{if(current!==epoch)return;status(next);
        if(next==='connected'){
          wantsRetry=false;clearTimeout(retryTimer);retryTimer=null;clearTimeout(stableTimer);
          // Rapid connect/fail loops must not reset the retry limit forever.
          stableTimer=setTimeout(()=>{if(current===epoch){retries=0;recoveryStarted=null;}},30000);
        } else if(['failed','disconnected'].includes(next)){clearTimeout(stableTimer);retry();}
      },onTrack:track=>{
        if(current!==epoch)return;
        if(track.kind==='audio'){playback.attach(track);return;}
        const stream=video.srcObject??new MediaStream();stream.addTrack(track);video.srcObject=stream;
        void video.play().catch(()=>{});
      }});
    } catch(error) {if(current===epoch){const old=ticket;ticket=null;
      if(old)void api.closeConnection(old.phoneId,old.id).catch(()=>{});
      if(error.code==='phone_connection_in_use'){wantsRetry=false;clearTimeout(retryTimer);retryTimer=null;status('in_use');return;}
      if(error.code==='phone_browser_media_unavailable'){wantsRetry=false;clearTimeout(retryTimer);retryTimer=null;status('browser_unavailable');return;}
      status('failed');
      if(![401,403].includes(error.status))retry();}}
  }
  function open(value) {
    if(phone?.id!==value.id)onPhoneExit();
    suspended=false;retries=0;phone=value;element.hidden=false;document.body.classList.add('workspace-open');
    find('phone-workspace-title').textContent=phone.name;
    void connect();video.focus({preventScroll:true});
  }
  function close() {
    onPhoneExit();
    wantsRetry=false;disconnect();phone=null;element.hidden=true;document.body.classList.remove('workspace-open');onReturn();
  }
  video.addEventListener('pointerdown',event=>{
    if(pointers.size>=10 || (event.pointerType==='mouse'&&event.button!==0))return;
    const point=phoneViewportPoint(video.getBoundingClientRect(),event.clientX,event.clientY);if(!point)return;
    const used=new Set([...pointers.values()].map(p=>p.id));let id=0;while(used.has(id))id++;
    pointers.set(event.pointerId,{...point,id});video.setPointerCapture(event.pointerId);video.focus({preventScroll:true});
    event.preventDefault();session?.touch([...pointers.values()],true);
  });
  video.addEventListener('pointermove',event=>{
    const previous=pointers.get(event.pointerId);if(!previous)return;
    const point=phoneViewportPoint(video.getBoundingClientRect(),event.clientX,event.clientY,{clamp:true});if(!point)return;
    pointers.set(event.pointerId,{...point,id:previous.id});event.preventDefault();session?.touch([...pointers.values()],true);
  });
  const release=event=>{const point=pointers.get(event.pointerId);if(!point)return;
    session?.touch([point],false);pointers.delete(event.pointerId);if(video.hasPointerCapture(event.pointerId))video.releasePointerCapture(event.pointerId);};
  for(const type of ['pointerup','pointercancel','lostpointercapture'])video.addEventListener(type,release);
  for(const type of ['keydown','keyup'])video.addEventListener(type,event=>{
    if(event.isComposing || event.code==='Tab' || event.code==='Escape')return;event.preventDefault();
    if(type==='keydown')keys.add(event.code);else keys.delete(event.code);session?.key(event.code,type);
  });
  video.addEventListener('blur',releaseInput);
  for(const button of element.querySelectorAll('[data-phone-control]'))button.addEventListener('click',()=>{
    const command=button.dataset.phoneControl;session?.control(command,'down');session?.control(command,'up');video.focus({preventScroll:true});
  });
  // A normal interaction in this phone is also a legitimate playback gesture.
  // After reload/reconnect, users should not have to discover a second button.
  element.addEventListener('click',event=>playback.activate(event));
  element.addEventListener('keydown',event=>playback.activate(event));
  find('phone-fullscreen').addEventListener('click',()=>{void find('phone-stage').requestFullscreen().catch(()=>{});});
  find('phone-retry').addEventListener('click',()=>void connect(false,connectionState==='in_use'));
  find('phone-return').addEventListener('click',close);
  find('phone-open-diagnostics').addEventListener('click',()=>{find('phone-workspace-more').open=false;diagnostics.toggle();});
  find('phone-close-diagnostics').addEventListener('click',()=>diagnostics.close());
  window.addEventListener('pagehide',()=>{suspended=true;wantsRetry=false;disconnect();});
  window.addEventListener('pageshow',event=>{if(event.persisted&&phone){suspended=false;void connect();}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){releaseInput();clearTimeout(retryTimer);retryTimer=null;}else if(wantsRetry)retry();});
  return {open,close,get phoneId(){return phone?.id??null;},refresh(items,authorized){
    if(!phone)return;
    const current=items.find(item=>item.id===phone.id);
    if(!authorized||!current){close();return;}
    phone=current;find('phone-workspace-title').textContent=phone.name;
    if(current.state!=='running'){
      onPhoneExit();wantsRetry=false;
      // A failed claim can leave no session or retry timer. Still invalidate
      // any in-flight request and replace stale "open in another page" text.
      disconnect();runtimeStatus();
    } else if(['stopped','stopping','protected','unavailable'].includes(connectionState)&&!suspended){
      void connect(true);
    }
  },translate(){if(phone)status(connectionState);playback.refresh();}};
}
