import { localizedCatalogs } from "./product-localization.mjs";
import {sha256Blob} from './sha256.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const words=localizedCatalogs({zh:{title:'虚拟摄像头',hint:'把一张图片提供给这部手机的相机 App。不会启用电脑或手机的真实摄像头。',choose:'选择图片',formats:'JPEG、PNG 或 WebP；保持图片原比例。',consent:'离开手机画面后继续使用此图片，直到关闭输入、退出登录或手机关机。',start:'使用这张图片',stop:'关闭摄像头输入',close:'返回手机',working:'正在准备图片…',stopped:'摄像头输入已关闭',active:'正在使用图片',starting:'正在连接摄像头…',stopping:'正在清空输入…',waiting:'已开启，等待图片',unavailable:'这部手机的系统版本暂不支持摄像头输入。已有手机不会自动更换系统。',failed:'未能完成，请检查手机状态后重试。',unsupported:'图片格式不支持或图片已损坏，请换一张 JPEG、PNG 或 WebP。',oversize:'请选择有效的非空图片。',cancel:'取消准备',cancelled:'已取消准备；未确认启用摄像头。',refresh:'刷新状态',privacy:'图片保存在你的加密存储中，只提供给当前手机。关闭输入后，相机显示空白，不会继续保留旧画面。',output:'相机输出 640 × 480，图片保持比例。',indicator:'摄像头 · 图片'},
en:{title:'Virtual camera',hint:'Supply an image to camera apps in this phone. This does not activate any physical camera.',choose:'Choose image',formats:'JPEG, PNG or WebP; image proportions are preserved.',consent:'Keep using this image after leaving the phone view, until I stop input, sign out or shut down the phone.',start:'Use this image',stop:'Stop camera input',close:'Back to phone',working:'Preparing image…',stopped:'Camera input off',active:'Using image',starting:'Connecting camera…',stopping:'Clearing input…',waiting:'Enabled, waiting for image',unavailable:'This phone system does not support camera input yet. Existing phones are not upgraded automatically.',failed:'Could not finish. Check the phone and retry.',unsupported:'Unsupported or damaged image. Choose a JPEG, PNG or WebP.',oversize:'Choose a valid, non-empty image.',cancel:'Cancel preparation',cancelled:'Preparation cancelled; camera activation was not confirmed.',refresh:'Refresh status',privacy:'The image is in your encrypted storage and is shared only with this phone. Stopping input clears the old image and shows a blank camera frame.',output:'Camera output: 640 × 480, preserving image proportions.',indicator:'Camera · Image'}});
Object.assign(words.zh,{storageFull:'这部手机的数据空间不足，请释放空间或增加存储配额。',memoryUnavailable:'这部手机当前内存不足以解码此视频，请释放内存或增加手机资源。'});
Object.assign(words.en,{storageFull:'This phone has insufficient storage. Free space or increase its storage quota.',memoryUnavailable:'This phone does not have enough available memory to decode this video.'});
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');

import {PhoneBrowserCameraSource} from './phone-browser-camera-source.mjs';
Object.assign(words.zh,{usbTab:'盒子 USB 摄像头',usbHint:'选择插在盒子上的 USB 摄像头。使用前需要管理员为你开放权限。',usbDevice:'选择摄像头',usbChoose:'请选择设备',usbRefresh:'刷新设备',usbEmpty:'未找到可用摄像头。请检查盒子的 USB 连接，并请管理员确认使用权限。',usbConsent:'离开手机画面后继续采集，直到我关闭输入、退出登录或手机关机。',usbPrivacy:'仅传画面，不使用麦克风，不录制。设备拔出或授权取消会停止采集，重新插入后需重新选择。',usbStart:'使用这台摄像头',usbActive:'正在使用盒子 USB 摄像头',usbWaiting:'等待 USB 摄像头画面',usbIndicator:'摄像头 · USB',usbReady:'正在连接盒子摄像头…',usbBusy:'摄像头正在使用中。请稍后重试或选择其他设备。',usbChanged:'设备已拔出或重新插入，请刷新设备后重新选择。',usbDenied:'没有使用此摄像头的权限，请联系管理员。',usbSources:'选择一个来源，提供给这部虚拟手机的相机 App。'});
Object.assign(words.en,{usbTab:'Box USB camera',usbHint:'Choose a USB camera connected to the appliance. An administrator must grant you access first.',usbDevice:'Choose camera',usbChoose:'Select a device',usbRefresh:'Refresh devices',usbEmpty:'No camera is available. Check the appliance’s USB connection and ask an administrator to confirm your access.',usbConsent:'Keep capturing after leaving the phone view until I stop input, sign out or shut down the phone.',usbPrivacy:'Video only, no microphone or recording. Unplugging or permission removal stops capture. Select the device again after reconnecting.',usbStart:'Use this camera',usbActive:'Using box USB camera',usbWaiting:'Waiting for USB camera frames',usbIndicator:'Camera · USB',usbReady:'Connecting box camera…',usbBusy:'Camera in use. Retry later or choose another device.',usbChanged:'Device unplugged or reattached. Refresh and select it again.',usbDenied:'You do not have permission to use this camera. Contact an administrator.',usbSources:'Choose a source for camera apps in this virtual phone.'});
Object.assign(words.zh,{videoTab:'视频文件',videoChoose:'选择视频',videoFormats:'MP4（H.264）。作为相机画面输入；音轨不会作为麦克风输入。',videoConsent:'离开手机画面后继续播放，直到视频结束、关闭输入、退出登录或手机关机。',videoLoop:'循环播放；不勾选时，播放结束后清空相机画面。',videoStart:'使用这段视频',videoWorking:'正在准备视频…',videoActive:'正在播放视频',videoWaiting:'等待视频画面',videoIndicator:'摄像头 · 视频',videoUnsupported:'请使用可正常解码的 H.264 MP4 视频。',videoOversize:'请选择有效的非空 MP4 视频。',videoPrivacy:'视频保存在你的加密存储中，只提供给当前手机。播放结束或关闭输入后清空画面，不启用真实摄像头。',videoOutput:'相机输出 640 × 480、最高 15 帧/秒，保留原比例和方向。',videoHint:'选择图片、视频文件或本机摄像头，提供给这部手机的相机 App。'});
Object.assign(words.en,{videoTab:'Video file',videoChoose:'Choose video',videoFormats:'MP4 (H.264). Supplies camera video; the audio track is not a microphone input.',videoConsent:'Keep playing after leaving the phone view until the video ends, I stop input, sign out or shut down the phone.',videoLoop:'Loop playback. Otherwise the camera clears when the video ends.',videoStart:'Use this video',videoWorking:'Preparing video…',videoActive:'Playing video',videoWaiting:'Waiting for video frames',videoIndicator:'Camera · Video',videoUnsupported:'Use a decodable H.264 MP4 video.',videoOversize:'Choose a valid, non-empty MP4 video.',videoPrivacy:'The video stays in your encrypted storage and is shared only with this phone. End or stop clears the frame. No physical camera is activated.',videoOutput:'Camera output: 640 × 480, up to 15 fps, preserving proportions and orientation.',videoHint:'Choose an image, video file or local camera for camera apps in this phone.'});
Object.assign(words.zh,{imageTab:'图片',browserTab:'浏览器摄像头',browserStart:'开启本机摄像头',browserHint:'将本机摄像头实时提供给这部虚拟手机。仅传视频，不开启麦克风、不录制。',browserPrivacy:'关闭输入、离开这部手机或网页断线后会停止。刷新不会自动重新开启。',browserActive:'正在使用浏览器摄像头',browserIndicator:'摄像头 · 浏览器',browserWaiting:'等待摄像头画面',browserPermission:'请在浏览器中允许摄像头访问。',browserMissing:'没有找到可用摄像头，请检查设备连接。',browserLost:'摄像头连接已停止，请重新开启。',browserReady:'准备连接本机摄像头…',chooseSource:'选择图片或本机摄像头，提供给虚拟手机的相机 App。'});
Object.assign(words.en,{imageTab:'Image',browserTab:'Browser camera',browserStart:'Start local camera',browserHint:'Supply live video from this computer to the virtual phone. No microphone or recording.',browserPrivacy:'Stops when you disable input, leave this phone or lose the page connection. Reload never restarts capture.',browserActive:'Using browser camera',browserIndicator:'Camera · Browser',browserWaiting:'Waiting for camera video',browserPermission:'Allow camera access in your browser.',browserMissing:'No camera found. Check your device.',browserLost:'Camera connection stopped. Start again to reconnect.',browserReady:'Connecting local camera…',chooseSource:'Choose an image or local camera for camera apps in this phone.'});
Object.assign(words.zh,{udpTab:'网络推流',udpHint:'选择管理员配置的网络推流地址。',udpChoose:'请选择入口',udpEmpty:'还没有可用的网络推流入口，请联系管理员在虚拟手机管理中配置。',udpConsent:'我知晓外部 UDP 推流不加密；离开观看后继续接收，直到关闭输入、退出登录或手机关机。',udpPrivacy:'仅接收视频。启动后向下方地址发送 MPEG-TS / H.264；断流后会清空旧画面，再次使用请重新开启。',udpStart:'开始接收',udpActive:'正在接收网络画面',udpWaiting:'已开启，等待推流',udpIndicator:'摄像头 · 网络',udpReady:'正在准备推流入口…',udpPortBusy:'推流端口无法使用，可能已被占用，请联系管理员检查。'});
Object.assign(words.en,{udpTab:'Network stream',udpHint:'Choose a network stream input set up by an administrator.',udpChoose:'Choose input',udpEmpty:'No network input is available. Ask an administrator to configure one in phone management.',udpConsent:'I understand external UDP is unencrypted. Keep receiving after I leave the viewer, until I stop, sign out or shut down the phone.',udpPrivacy:'Video only. Send MPEG-TS / H.264 to the address below after starting. A lost stream clears the camera; start again to reconnect.',udpStart:'Start receiving',udpActive:'Receiving network video',udpWaiting:'Ready, waiting for stream',udpIndicator:'Camera · Network',udpReady:'Preparing stream input…',udpPortBusy:'The stream port is unavailable or busy. Ask an administrator to check.'});
export function createPhoneCamera({element,getPhone,findPhone=null,indicator=null,onChange=()=>{},fetchImpl=fetch}) {
  const find=id=>element.querySelector('#'+id),t=key=>words[document.documentElement.lang][key];
  let phone=null,epoch=0,controller=null,source=null,supported=false,timer=null,browserSupported=false,videoSupported=false,mode='image',browser=null,browserPhone=null;
  let usbSupported=false,usbDevices=[],udpSupported=false,udpSources=[];
  const indicatorKey=kind=>kind==='udp'?'udpIndicator':kind==='usb'?'usbIndicator':kind==='video'?'videoIndicator':kind==='browser'?'browserIndicator':'indicator';
  async function json(path,{method='GET',body,headers={},signal}={}) {
    signal?.throwIfAborted();
    if(method!=='GET'){
      const cookies=document.cookie.split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Host-teamaibox-csrf='));
      if(cookies.length!==1||!cookies[0].slice(22))throw Error('invalid_session');
      headers={...headers,'x-csrf-token':cookies[0].slice('__Host-teamaibox-csrf='.length)};
    }
    const response=await fetchImpl(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal,
      headers:{accept:'application/json',...(body&&!headers['content-type']?{'content-type':'application/json'}:{}),...headers},
      body:body===undefined?undefined:body instanceof Blob?body:JSON.stringify(body)});
    if(!response.headers.get('content-type')?.includes('application/json'))throw Error('phone_response_invalid');
    const reader=response.body.getReader(),chunks=[];let total=0;
    try{for(;;){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>65536){await reader.cancel();throw Error('phone_response_invalid');}chunks.push(r.value);}}
    finally{reader.releaseLock();}
    const value=JSON.parse(await new Blob(chunks).text());signal?.throwIfAborted();
    if(!response.ok)throw Error(value?.error?.code||'phone_request_failed');return value;
  }
  const root=()=>{if(!phone||!UUID.test(phone.id)||!Number.isSafeInteger(phone.generation)||phone.generation<1)throw Error('phone_stale_run');return '/api/v1/virtual-phones/'+phone.id+'/camera';};
  function accept(value){
    if(value?.object!=='virtual_phone.camera'||value.phoneId!==phone.id||value.generation!==undefined&&value.generation!==phone.generation
      ||!['starting','active','stopping','stopped'].includes(value.state)||value.sourceId!==undefined&&!UUID.test(value.sourceId))throw Error('phone_response_invalid');
    source=value;if(value.capabilities){supported=value.capabilities.image===true;browserSupported=value.capabilities.browser===true;videoSupported=value.capabilities.video===true;usbSupported=value.capabilities.usb===true;udpSupported=value.capabilities.udp===true;}
    if(value.state!=='stopped'&&['image','browser','video','usb','udp'].includes(value.sourceKind))mode=value.sourceKind;
    if(value.state!=='stopped'&&value.sourceKind==='video')find('phone-camera-loop').checked=value.loop===true;
    if(browser&&value.state==='stopped'&&browser.sourceId){void browser.stop();}
    if(indicator){indicator.hidden=value.state!=='active';indicator.textContent=t(indicatorKey(value.sourceKind));}
    onChange(phone.id,{state:value.state,generation:phone.generation,...(value.state!=='stopped'?{sourceId:value.sourceId,sourceKind:value.sourceKind??'image'}:{})});
  }
  function render(){
    const on=source&&source.state!=='stopped',capturing=browser&&browser.state!=='off',video=mode==='video',fileSupported=video?videoSupported:supported;
    find('phone-camera-input').disabled=!fileSupported||Boolean(controller)||Boolean(on);
    find('phone-camera-input').accept=video?'video/mp4,.mp4':'image/jpeg,image/png,image/webp';
    find('phone-camera-consent').disabled=!fileSupported||Boolean(controller)||Boolean(on);
    find('phone-camera-loop-label').hidden=!video;find('phone-camera-loop').disabled=!fileSupported||Boolean(controller)||Boolean(on);
    find('phone-camera-start').disabled=!fileSupported||Boolean(controller)||Boolean(on)||!find('phone-camera-consent').checked||!find('phone-camera-input').files.length;
    for(const key of ['choose','formats','consent','start','privacy','output']){
      const el=find('phone-camera-image-panel').querySelector('[data-camera-label="'+key+'"]');
      el.textContent=t(video?'video'+key[0].toUpperCase()+key.slice(1):key);
    }
    find('phone-camera-stop').hidden=!on;find('phone-camera-stop').disabled=Boolean(controller);
    find('phone-camera-cancel').hidden=!controller;find('phone-camera-refresh').disabled=Boolean(controller);
    find('phone-camera-config').hidden=!supported&&!browserSupported&&!videoSupported&&!usbSupported&&!udpSupported;find('phone-camera-unavailable').hidden=supported||browserSupported||videoSupported||usbSupported||udpSupported;
    find('phone-camera-source-tabs').hidden=!browserSupported&&!videoSupported&&!usbSupported&&!udpSupported;
    for(const kind of ['image','browser','video','usb','udp']){const tab=find('phone-camera-tab-'+kind);tab.setAttribute('aria-pressed',String(mode===kind));tab.disabled=Boolean(controller)||Boolean(on)||Boolean(capturing);tab.hidden=!(kind==='udp'?udpSupported:kind==='usb'?usbSupported:kind==='video'?videoSupported:kind==='browser'?browserSupported:supported);}
    find('phone-camera-image-panel').hidden=!['image','video'].includes(mode);find('phone-camera-browser-panel').hidden=mode!=='browser';
    find('phone-camera-usb-panel').hidden=mode!=='usb';
    find('phone-camera-udp-panel').hidden=mode!=='udp';
    const udpLocked=!udpSupported||Boolean(controller)||Boolean(on);
    for(const id of ['phone-camera-udp-source','phone-camera-udp-consent','phone-camera-udp-refresh'])find(id).disabled=udpLocked;
    find('phone-camera-udp-start').hidden=Boolean(on);
    const networkSource=udpSources.find(d=>d.policyId===find('phone-camera-udp-source').value);
    find('phone-camera-udp-start').disabled=udpLocked||!find('phone-camera-udp-consent').checked||!networkSource;
    find('phone-camera-udp-address').textContent=networkSource?'udp://'+networkSource.listenAddress+':'+networkSource.listenPort:'';
    find('phone-camera-usb-picker').hidden=Boolean(on);find('phone-camera-usb-start').hidden=Boolean(on);
    const usbLocked=!usbSupported||Boolean(controller)||Boolean(on);
    for(const id of ['phone-camera-usb-device','phone-camera-usb-consent','phone-camera-usb-refresh'])find(id).disabled=usbLocked;
    find('phone-camera-usb-start').disabled=usbLocked||!find('phone-camera-usb-consent').checked||!usbDevices.some(d=>d.deviceId===find('phone-camera-usb-device').value);
    find('phone-camera-browser-start').disabled=!browserSupported||Boolean(controller)||Boolean(on)||Boolean(capturing);
    const preview=find('phone-camera-local-preview');preview.hidden=!browser?.stream;preview.srcObject=browser?.stream??null;
    find('phone-camera-hint').textContent=t(usbSupported||udpSupported?'usbSources':videoSupported?'videoHint':browserSupported?'chooseSource':'hint');
    find('phone-camera-state').textContent=source?t(source.inputState==='waiting'?(source.sourceKind==='udp'?'udpWaiting':source.sourceKind==='usb'?'usbWaiting':source.sourceKind==='video'?'videoWaiting':source.sourceKind==='browser'?'browserWaiting':'waiting'):source.state==='active'?(source.sourceKind==='udp'?'udpActive':source.sourceKind==='usb'?'usbActive':source.sourceKind==='video'?'videoActive':source.sourceKind==='browser'?'browserActive':'active'):source.state):'';
  }
  function translate(){for(const el of element.querySelectorAll('[data-camera-label]'))el.textContent=t(el.dataset.cameraLabel);render();}
  async function status(signal){const current=epoch,value=await json(root()+'?generation='+phone.generation,{signal});if(current!==epoch)throw Error('phone_stale_run');accept(value);if(value.sourceKind==='udp'&&value.state!=='stopped'&&!udpSources.length){await refreshUdp(signal);find('phone-camera-udp-source').value=value.policyId??'';}}
  async function perform(action,{background=false}={}){
    if(controller||!phone)return;const current=epoch,active=new AbortController();controller=active;
    const timeout=action===upload?null:setTimeout(()=>active.abort(),30000);if(!background)find('phone-camera-status').textContent=t(mode==='udp'?'udpReady':mode==='usb'?'usbReady':mode==='video'?'videoWorking':'working');render();
    try{await action(active.signal);if(current===epoch)find('phone-camera-status').textContent='';}
    catch(error){if(current===epoch){const unavailable=['phone_camera_unavailable','phone_camera_not_configured'].includes(error.message);
      if(unavailable)supported=false;
      find('phone-camera-status').textContent=t(active.signal.aborted?'cancelled':unavailable?'unavailable':error.message==='phone_camera_storage_full'?'storageFull':error.message==='phone_camera_video_memory_unavailable'?'memoryUnavailable':error.message==='phone_camera_udp_port_unavailable'?'udpPortBusy':error.message==='phone_camera_usb_busy'?'usbBusy':error.message==='phone_camera_usb_device_changed'?'usbChanged':error.message==='phone_camera_usb_permission_required'?'usbDenied':error.message==='camera_permission_denied'?'browserPermission':error.message==='camera_device_missing'?'browserMissing':error.message==='phone_camera_video_unsupported'?'videoUnsupported':error.message==='phone_camera_video_too_large'?'videoOversize':error.message==='phone_camera_image_unsupported'?'unsupported':error.message==='phone_camera_image_too_large'?'oversize':'failed');}}
    finally{clearTimeout(timeout);if(current===epoch){controller=null;render();}}
  }
  async function upload(signal){
    const file=find('phone-camera-input').files[0],video=mode==='video',kind=video?'video':'image',loop=find('phone-camera-loop').checked;
    if(video&&!videoSupported||!video&&!supported)throw Error('phone_camera_unavailable');
    if(!file||file.size<1||new TextEncoder().encode(file.name).length>240||/[\\/\p{Cc}\p{Cf}]/u.test(file.name)||file.name.trim()!==file.name)throw Error(video?'phone_camera_video_too_large':'phone_camera_image_too_large');
    if(video&&!/\.mp4$/i.test(file.name))throw Error('phone_camera_video_unsupported');
    if(!find('phone-camera-consent').checked)throw Error('phone_camera_source_unsupported');
    const sha256=await sha256Blob(file,{signal});signal.throwIfAborted();
    let uploadId=null,complete=false;
    try{
      const opened=await json('/api/v1/objects/multipart',{method:'POST',body:{capability:'virtual_phone',name:file.name,media_type:'application/octet-stream',size:file.size,sha256},signal});
      uploadId=opened?.upload?.uploadId;if(!UUID.test(uploadId??''))throw Error('phone_response_invalid');
      const parts=[];
      for(let offset=0;offset<file.size;offset+=4*1024**2){const part=file.slice(offset,offset+4*1024**2),checksum=await hash(await part.arrayBuffer()),number=parts.length+1;
        await json(`/api/v1/objects/multipart/${uploadId}/parts/${number}`,{method:'PUT',body:part,headers:{'content-type':'application/octet-stream','x-content-sha256':checksum},signal});parts.push({part_number:number,sha256:checksum});}
      const finished=await json('/api/v1/objects/multipart/'+uploadId,{method:'POST',body:{parts},signal});complete=true;const object=finished?.object;
      if(!UUID.test(object?.objectId??'')||!Number.isSafeInteger(object.version)||object.version<1||object.size!==file.size||object.integrity?.digest!==sha256)throw Error('phone_response_invalid');
      const value=await json(root(),{method:'POST',signal,body:{expectedGeneration:phone.generation,requestId:crypto.randomUUID(),
        source:{kind,continueWithoutViewer:true,...(video?{loop}:{}),file:{objectId:object.objectId,objectVersion:object.version,name:file.name.normalize('NFC'),sizeBytes:file.size,sha256}}}});
      accept(value);find('phone-camera-input').value='';await status(signal);
    }finally{if(uploadId&&!complete)await json('/api/v1/objects/multipart/'+uploadId,{method:'DELETE',signal:AbortSignal.timeout(5000)}).catch(()=>{});}
  }
  async function stop(signal){if(!UUID.test(source?.sourceId??''))return;
    if(browser&&source.sourceId===browser.sourceId)await browser.stop();
    accept(await json(root(),{method:'DELETE',body:{expectedGeneration:phone.generation,sourceId:source.sourceId},signal}));
    find('phone-camera-consent').checked=false;find('phone-camera-usb-consent').checked=false;await status(signal);
  }
  function clearUsb(){usbDevices=[];find('phone-camera-usb-device').replaceChildren(new Option(t('usbChoose'),''));find('phone-camera-usb-consent').checked=false;}
  async function refreshUsb(signal){
    clearUsb();if(!usbSupported)throw Error('phone_camera_unavailable');
    const current=epoch,value=await json(root()+'/usb-devices?generation='+phone.generation,{signal});
    if(current!==epoch||value.phoneId!==phone.id||value.generation!==phone.generation||!UUID.test(value.runId??'')||!Array.isArray(value.data))throw Error('phone_response_invalid');
    const ids=new Set();
    for(const d of value.data){if(!UUID.test(d.deviceId??'')||! /^[a-f0-9]{64}$/.test(d.attachmentId??'')||typeof d.name!=='string'||ids.has(d.deviceId))throw Error('phone_response_invalid');ids.add(d.deviceId);}
    usbDevices=value.data.map(d=>({deviceId:d.deviceId,attachmentId:d.attachmentId,name:d.name}));
    for(const d of usbDevices)find('phone-camera-usb-device').add(new Option(d.name,d.deviceId));
    find('phone-camera-usb-empty').hidden=usbDevices.length>0;
  }
  async function startUsb(signal){
    const selected=usbDevices.find(d=>d.deviceId===find('phone-camera-usb-device').value);
    if(!usbSupported||!selected||!find('phone-camera-usb-consent').checked)throw Error('phone_camera_source_unsupported');
    accept(await json(root(),{method:'POST',signal,body:{expectedGeneration:phone.generation,requestId:crypto.randomUUID(),
      source:{kind:'usb',deviceId:selected.deviceId,attachmentId:selected.attachmentId,continueWithoutViewer:true}}}));
    await status(signal);
  }
  function clearUdp(){udpSources=[];find('phone-camera-udp-source').replaceChildren(new Option(t('udpChoose'),''));find('phone-camera-udp-consent').checked=false;}
  async function refreshUdp(signal){
    clearUdp();if(!udpSupported)throw Error('phone_camera_unavailable');
    const current=epoch,value=await json(root()+'/network-sources?generation='+phone.generation,{signal});
    if(current!==epoch||value.phoneId!==phone.id||value.generation!==phone.generation||!UUID.test(value.runId??'')||!Array.isArray(value.data))throw Error('phone_response_invalid');
    const ids=new Set();
    for(const d of value.data){if(!UUID.test(d.policyId??'')||!Number.isSafeInteger(d.policyRevision)||d.policyRevision<1||typeof d.name!=='string'||typeof d.listenAddress!=='string'||!Number.isInteger(d.listenPort)||d.externalInputEncrypted!==false||ids.has(d.policyId))throw Error('phone_response_invalid');ids.add(d.policyId);}
    udpSources=value.data;
    for(const d of udpSources)find('phone-camera-udp-source').add(new Option(d.name,d.policyId));
    find('phone-camera-udp-empty').hidden=udpSources.length>0;
  }
  async function startUdp(signal){
    const selected=udpSources.find(d=>d.policyId===find('phone-camera-udp-source').value);
    if(!udpSupported||!selected||!find('phone-camera-udp-consent').checked)throw Error('phone_camera_source_unsupported');
    accept(await json(root(),{method:'POST',signal,body:{expectedGeneration:phone.generation,requestId:crypto.randomUUID(),
      source:{kind:'udp',policyId:selected.policyId,policyRevision:selected.policyRevision,continueWithoutViewer:true}}}));
    await status(signal);
  }
  async function startBrowser(signal){
    if(!browserSupported)throw Error('phone_camera_unavailable');
    if(browser)await browser.dispose();const selected={id:phone.id,generation:phone.generation};browserPhone=selected;
    let instance;instance=new PhoneBrowserCameraSource({phone:selected,json,
      onState(){if(browser===instance){render();}},
      onError(){if(browser===instance)find('phone-camera-status').textContent=t('browserLost');}});browser=instance;
    const abort=()=>{void instance.stop();};signal.addEventListener('abort',abort,{once:true});
    find('phone-camera-status').textContent=t('browserReady');
    try{await instance.start();signal.throwIfAborted();await status(signal);}
    catch(error){await instance.stop();throw error;}finally{signal.removeEventListener('abort',abort);}
  }
  function dismiss(){epoch++;controller?.abort();controller=null;clearInterval(timer);timer=null;element.close();find('phone-camera-input').value='';clearUsb();clearUdp();usbSupported=false;udpSupported=false;}
  function reset(){if(browser){void browser.dispose();browser=null;browserPhone=null;}dismiss();phone=null;source=null;supported=false;browserSupported=false;videoSupported=false;mode='image';if(indicator)indicator.hidden=true;find('phone-camera-consent').checked=false;find('phone-camera-loop').checked=false;render();}
  function open(selected=null){const value=selected??getPhone();if(!value||value.state!=='running')return;
    if(browserPhone&&(browserPhone.id!==value.id||browserPhone.generation!==value.generation)){void browser.dispose();browser=null;browserPhone=null;}
    dismiss();phone=structuredClone(value);source=null;supported=false;browserSupported=false;videoSupported=false;mode=browser?.state!=='off'&&browser?'browser':'image';find('phone-camera-consent').checked=false;find('phone-camera-loop').checked=false;
    translate();element.showModal();void perform(status);
    timer=setInterval(()=>{if(element.open&&!document.hidden)void perform(status,{background:true});},4000);
  }
  find('phone-camera-start').addEventListener('click',()=>void perform(upload));
  find('phone-camera-browser-start').addEventListener('click',()=>void perform(startBrowser));
  for(const kind of ['image','browser','video','usb','udp'])find('phone-camera-tab-'+kind).addEventListener('click',()=>{mode=kind;find('phone-camera-input').value='';find('phone-camera-consent').checked=false;find('phone-camera-loop').checked=false;render();if(kind==='usb')void perform(refreshUsb);if(kind==='udp')void perform(refreshUdp);});
  find('phone-camera-udp-refresh').addEventListener('click',()=>void perform(refreshUdp));
  find('phone-camera-udp-start').addEventListener('click',()=>void perform(startUdp));
  find('phone-camera-udp-source').addEventListener('change',render);find('phone-camera-udp-consent').addEventListener('change',render);
  find('phone-camera-usb-refresh').addEventListener('click',()=>void perform(refreshUsb));
  find('phone-camera-usb-start').addEventListener('click',()=>void perform(startUsb));
  find('phone-camera-usb-device').addEventListener('change',render);find('phone-camera-usb-consent').addEventListener('change',render);
  find('phone-camera-stop').addEventListener('click',()=>void perform(stop));
  find('phone-camera-input').addEventListener('change',render);find('phone-camera-consent').addEventListener('change',render);
  find('phone-camera-close').addEventListener('click',dismiss);find('phone-camera-cancel').addEventListener('click',()=>controller?.abort());
  find('phone-camera-refresh').addEventListener('click',()=>void perform(status));element.addEventListener('cancel',dismiss);
  window.addEventListener('pagehide',reset);indicator?.addEventListener('click',()=>open());
  return {open,reset,translate,refresh(){if(phone){const current=findPhone?findPhone(phone.id):getPhone();if(!current||current.id!==phone.id||current.generation!==phone.generation||current.state!=='running')reset();}
    const selected=getPhone();if(indicator&&selected?.cameraInput){indicator.hidden=selected.cameraInput.state!=='active';indicator.textContent=t(indicatorKey(selected.cameraInput.sourceKind));}}};
}
