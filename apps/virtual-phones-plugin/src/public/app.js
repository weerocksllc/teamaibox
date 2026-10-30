import {applyProductLabels} from './product-localization.mjs';
import { localizedCatalogs, normalizeProductLocale } from "./product-localization.mjs";
import { applyPluginPreferenceSnapshotV1 } from "/plugins/official.virtual-phones/preferences-v1.mjs";
import { createPhoneApi, phoneActions, TRANSIENT } from "./phone-client.mjs";
import { createPhoneWorkspace } from "./phone-workspace.mjs";
import { createPhoneDebug } from "./phone-debug.mjs";
import {createPhoneFiles} from './phone-files.mjs';
import {createPhoneCamera} from './phone-camera.mjs';
import {phoneSelection} from './phone-selection.mjs';
import {phoneRomChoices,phoneRomDescription,renderPhoneRoms} from './phone-roms.mjs';

const messages = localizedCatalogs({
  "zh-CN": { title:"我的虚拟手机", subtitle:"独立的工作手机，数据保留在盒子里。", create:"＋ 创建手机", refresh:"刷新",
    quotaLabel:"手机概况",workspaceLabel:"虚拟手机工作区",screenLabel:"手机画面；点击后可使用键盘",controlsLabel:"手机控制",toolsTitle:"手机工具",
    cameraSourceLabel:"摄像头来源",cameraPreviewLabel:"本机摄像头预览",
    open:"打开手机",returnList:"← 手机列表",reconnect:"重新连接",enableAudio:"开启声音",androidBack:"返回",androidHome:"主页",androidRecent:"最近应用",
    volumeUp:"音量＋",volumeDown:"音量－",fullscreen:"全屏",workspaceHint:"关闭页面或返回列表不会关机。需要结束本次运行，请在列表中关机。",
    media_connecting:"正在连接手机…",media_connected:"已连接",media_reconnecting:"连接中断，正在恢复…",media_failed:"暂时无法连接手机，请重试。",
    media_browser_unavailable:"当前浏览器的实时音视频功能不可用，无法显示手机。请检查浏览器设置或扩展，或换用支持实时音视频的浏览器。此问题不会删除手机已保存的数据。",
    media_disconnected:"连接已断开",media_closed:"已退出手机画面",media_in_use:"这部手机已在其他页面打开。手机仍在运行，可切换到这里操作。",connectHere:"在这里连接",
    media_stopped:"手机已关机。请返回列表重新开机。",media_stopping:"手机正在关机…",media_unavailable:"手机暂不可用，请返回列表查看状态。",
    media_protected:"手机因内存不足已保护性关机，数据仍保留。请返回列表重新开机。",
    debugTitle:"ADB 调试",debugHint:"仅连接当前手机，不开放宿主或其他手机。最多 15 分钟，退出登录、关闭调试或到期即断开。",
    debugOff:"调试已关闭。",debugEnable:"开启 15 分钟",debugEnabling:"正在开启调试…",debugAuthorized:"已授权至 {time}。连接码仅能使用一次。",
    debugExpired:"调试授权已到期。",debugEnableFailed:"未能开启调试，请重试。",debugClosing:"正在关闭调试…",debugCloseFailed:"暂时未能确认关闭，请重试。已有连接仍受授权期限限制。",
    debugDisable:"关闭调试",debugDismiss:"返回手机",debugDownload:"下载转接工具，在装有 Node.js 24 和标准 adb 的电脑上运行。电脑需信任盒子证书。",
    debugTool:"下载连接工具",debugNotice:"开源说明",debugRun:"在下载目录执行下面的命令。命令不含连接码。",
    debugPaste:"终端询问时粘贴一次连接码；随后按终端提示执行 adb connect。",debugCode:"一次连接码（60 秒内使用）",debugCopy:"复制连接码",
    debugCodeExpired:"连接码已过期。已经建立的调试可继续到授权结束；尚未连接请先关闭，再重新开启。",
    empty:"还没有手机", emptyHint:"创建后即可保存应用和文件，每部手机的数据互相独立。", name:"手机名称", nameRequired:"请输入手机名称，不能只填写空格。", cancel:"取消", save:"保存",
    confirm:"我确认删除这部手机及其应用、文件和数据。此操作不能撤销。", boundary:"每部手机独立存储。关闭页面不会关机。", eyebrow:"个人工作空间",
    stored:"已保存 {n} / {max} 部", runningQuota:"运行中 {n} / {max} 部", storedResource:"已保存 {n} 部", runningQuotaResource:"运行中 {n} 部", more:"更多", start:"开机", stop:"关机", restart:"重启", rename:"改名", delete:"删除手机",
    creating:"正在创建", stopped:"已关机", starting:"正在开机", running:"运行中", stopping:"正在关机", unavailable:"暂不可用", error:"需要处理", deleting:"正在删除", deleted:"已删除",
    createHint:"每部手机：6 GiB 内存上限、2 CPU、16 GiB 数据空间。创建后尝试开机；资源不足时仍保留已创建的手机。",
    deleteHint:"仅删除「{name}」，不会影响其他手机。", spec:"Android 17 · 720 × 1280 · 16 GiB 存储", submitted:"操作已提交，状态会自动更新。",
    unavailableHint:"虚拟手机服务尚未就绪，请联系管理员。", mediaPending:"暂时无法打开手机画面，当前仍可查看运行状态。",
    uncertain:"上次操作的结果尚未确认。重试会继续同一次操作，不会重复创建。", retry:"确认上次操作",
    phone_network_unavailable:"暂时无法连接服务。请检查连接后重试。", phone_response_invalid:"服务返回的数据不完整，请刷新重试。",
    invalid_session:"登录已过期，请返回工作台重新登录。", phone_permission_required:"当前账户没有虚拟手机权限。",
    phone_capacity_unavailable:"盒子的可用资源不足，请稍后重试。", phone_storage_unavailable:"手机存储尚未就绪。",
    phone_resource_protection:"运行盒子的资源紧张，这部手机已保护性关机。已保存的数据保留，资源恢复后可重新开机。",
    phone_storage_full:"手机存储空间不足。", phone_disabled:"虚拟手机暂未启用。", phone_runtime_unavailable:"手机运行服务尚未就绪。",
    phone_node_unavailable:"本机手机服务暂不可用，数据不受影响。", phone_stored_quota:"已达到可保存的手机数量上限。",
    phone_running_quota:"已达到可同时运行的手机数量上限。", phone_state_conflict:"手机状态已变化，请刷新后重试。",
    phone_operation_conflict:"这部手机正在处理另一项操作，请稍候。", phone_stop_unconfirmed:"尚未确认关机，运行额度仍保留。",
    phone_request_failed:"操作未能完成，请刷新状态后重试。" },
  en: { title:"My virtual phones", subtitle:"Independent work phones. Your data stays on the box.", create:"＋ Create phone", refresh:"Refresh",
    quotaLabel:"Phone overview",workspaceLabel:"Virtual phone workspace",screenLabel:"Phone screen; click to use the keyboard",controlsLabel:"Phone controls",toolsTitle:"Phone tools",
    cameraSourceLabel:"Camera source",cameraPreviewLabel:"Local camera preview",
    open:"Open phone",returnList:"← Phone list",reconnect:"Reconnect",enableAudio:"Enable audio",androidBack:"Back",androidHome:"Home",androidRecent:"Recent apps",
    volumeUp:"Volume +",volumeDown:"Volume −",fullscreen:"Fullscreen",workspaceHint:"Leaving this page does not shut down the phone. Shut it down from the list to finish the current run.",
    media_connecting:"Connecting…",media_connected:"Connected",media_reconnecting:"Connection interrupted…",media_failed:"The phone could not be reached. Retry to connect.",
    media_browser_unavailable:"Real-time audio and video are unavailable in this browser. Check browser settings or extensions, or use a browser that supports them. Your phone is still running and its data is retained.",
    media_disconnected:"Disconnected",media_closed:"Phone view closed",media_in_use:"This phone is open in another page and is still running. You can switch control here.",connectHere:"Connect here",
    media_stopped:"The phone is shut down. Return to the list to start it.",media_stopping:"The phone is shutting down…",media_unavailable:"The phone is unavailable. Return to the list for its status.",
    media_protected:"The phone shut down to protect available memory. Saved data is retained. Start it again from the list.",
    debugTitle:"ADB debugging",debugHint:"Access this phone only, not the host or other phones. Lasts up to 15 minutes; sign-out, revocation or expiry disconnects it.",
    debugOff:"Debugging is off.",debugEnable:"Enable for 15 minutes",debugEnabling:"Enabling debugging…",debugAuthorized:"Authorized until {time}. The connection code is single-use.",
    debugExpired:"Debug authorization expired.",debugEnableFailed:"Debugging could not be enabled. Retry.",debugClosing:"Closing debugging…",debugCloseFailed:"Closure could not be confirmed. Retry; the authorization deadline still applies.",
    debugDisable:"Disable debugging",debugDismiss:"Return to phone",debugDownload:"Download the relay tool. Run it on a computer with Node.js 24 and standard adb. The computer must trust the box certificate.",
    debugTool:"Download relay tool",debugNotice:"Open-source notice",debugRun:"Run this command in the download directory. It does not contain the connection code.",
    debugPaste:"Paste the single-use code when prompted, then follow the terminal's adb connect instructions.",debugCode:"Single-use code (use within 60 seconds)",debugCopy:"Copy code",
    debugCodeExpired:"The code expired. Connected debugging continues until authorization ends; if not connected, disable and enable again.",
    empty:"No phones yet", emptyHint:"Keep your apps and files in separate, private phones.", name:"Phone name", nameRequired:"Enter a phone name, not just spaces.", cancel:"Cancel", save:"Save",
    confirm:"I confirm deleting this phone, its apps, files and data. This cannot be undone.", boundary:"Independent phone storage. Leaving this page does not shut down the phone.", eyebrow:"Personal workspace",
    stored:"Saved {n} / {max}", runningQuota:"Running {n} / {max}", storedResource:"Saved {n}", runningQuotaResource:"Running {n}", more:"More", start:"Start", stop:"Shut down", restart:"Restart", rename:"Rename", delete:"Delete phone",
    creating:"Creating", stopped:"Stopped", starting:"Starting", running:"Running", stopping:"Stopping", unavailable:"Unavailable", error:"Needs attention", deleting:"Deleting", deleted:"Deleted",
    createHint:"Each phone: 6 GiB memory limit, 2 CPU, 16 GiB data. Creation attempts to start it; if capacity is unavailable, the saved phone is retained.",
    deleteHint:"Only “{name}” will be deleted. Other phones are unaffected.", spec:"Android 17 · 720 × 1280 · 16 GiB storage", submitted:"Request submitted. Status updates automatically.",
    unavailableHint:"Virtual phones are not ready. Please contact an administrator.", mediaPending:"The phone display is not connected yet. You can still check its status here.",
    uncertain:"The last request has not been confirmed. Retrying continues the same request without creating a duplicate.", retry:"Confirm last request",
    phone_network_unavailable:"The service could not be reached. Check your connection and retry.", phone_response_invalid:"The service returned incomplete data. Refresh and retry.",
    invalid_session:"Your session expired. Sign in again from the workbench.", phone_permission_required:"Your account cannot use virtual phones.",
    phone_capacity_unavailable:"The appliance does not have enough free resources. Try again later.", phone_storage_unavailable:"Phone storage is not ready.",
    phone_resource_protection:"This phone was shut down because this appliance is under memory pressure. Saved data is retained. Start it again when capacity recovers.",
    phone_storage_full:"Phone storage is full.", phone_disabled:"Virtual phones are disabled.", phone_runtime_unavailable:"The phone runtime is not ready.",
    phone_node_unavailable:"The local phone service is unavailable. Your data is unaffected.", phone_stored_quota:"You have reached your saved-phone limit.",
    phone_running_quota:"You have reached your running-phone limit.", phone_state_conflict:"Phone state changed. Refresh and retry.",
    phone_operation_conflict:"Another operation is in progress for this phone.", phone_stop_unconfirmed:"Shutdown is not confirmed yet. Please wait for the current operation.",
    phone_request_failed:"The request could not be completed. Refresh status and retry." },
});
const $ = selector => document.querySelector(selector), api = createPhoneApi();
const state = { locale:normalizeProductLocale(new URLSearchParams(location.search).get('locale')), data:[], quota:null, availability:null, ready:false, busy:false, pending:null, editing:null, readSequence:0, readError:false };
let timer, refreshing = false, stopped = false;
const t = (key, values = {}) => Object.entries(values).reduce((text,[key,value]) => text.replaceAll(`{${key}}`, String(value)), messages[state.locale][key] ?? messages[state.locale].phone_request_failed);
const text = (selector, value) => { $(selector).textContent = value; };
function note(selector, value) { text(selector, value); $(selector).hidden = !value; }
let phoneDebug,phoneFiles,phoneCamera;
Object.assign(messages['zh-CN'],{romTitle:'选择手机系统',romPinned:'系统不会自动更换，手机数据独立保存。',
  romStandardName:'标准 Android',romGoogleName:'Android + Google Play',romTechnical:'系统详情',
  romCameraSettings:'支持摄像头，可在设置中选择画面来源',romCameraPending:'摄像头支持准备中',
  romPlay:'含 Google Play',romNoPlay:'不含 Google Play',romExperimental:'实验版',romAospHint:'轻量、默认推荐，不含 Google 服务',
  romPlayHint:'可登录 Google；不代表设备认证或应用兼容保证',romCamera:'虚拟摄像头',romCameraUnavailable:'尚未开放',romCameraReady:'可用',
  phone_rom_unavailable:'此版本尚未开放新建',phone_rom_not_installed:'盒子尚未安装此系统版本',
  boundary:'每部手机独立存储。关闭页面不会关机。'});
Object.assign(messages.en,{romTitle:'Choose phone system',romPinned:'Your system stays fixed and phone data is stored independently.',
  romStandardName:'Standard Android',romGoogleName:'Android + Google Play',romTechnical:'System details',
  romCameraSettings:'Camera supported; choose its input in camera settings',romCameraPending:'Camera support is being prepared',
  romPlay:'Google Play included',romNoPlay:'No Google Play',romExperimental:'Experimental',romAospHint:'Lightweight default, without Google services',
  romPlayHint:'Google sign-in; no device certification or application compatibility guarantee',romCamera:'Virtual camera',romCameraUnavailable:'Not yet available',romCameraReady:'Available',
  phone_rom_unavailable:'Not open for creation yet',phone_rom_not_installed:'This system version is not installed on the appliance',
  boundary:'Independent phone storage. Leaving this page does not shut down the phone.'});
let selectionStorage;try{selectionStorage=window.sessionStorage;}catch{}
const selection=phoneSelection(selectionStorage);
messages['zh-CN'].filesTitle='文件与 APK';messages.en.filesTitle='Files and APKs';
messages['zh-CN'].cameraTitle='虚拟摄像头';messages.en.cameraTitle='Virtual camera';
Object.assign(messages['zh-CN'],{camera:'虚拟摄像头',camera_active:'图片输入已开启',camera_starting:'正在准备摄像头输入',camera_stopping:'正在关闭摄像头输入',cameraManage:'管理／关闭输入'});
Object.assign(messages.en,{camera:'Virtual camera',camera_active:'Image input is on',camera_starting:'Preparing camera input',camera_stopping:'Stopping camera input',cameraManage:'Manage / stop input'});
messages['zh-CN'].camera_browser_active='浏览器摄像头已开启';messages.en.camera_browser_active='Browser camera is on';
messages['zh-CN'].camera_video_active='视频输入已开启';messages.en.camera_video_active='Video input is on';
messages['zh-CN'].camera_usb_active='盒子 USB 摄像头已开启';messages.en.camera_usb_active='Appliance USB camera is on';
messages['zh-CN'].camera_udp_active='网络视频流已开启';messages.en.camera_udp_active='Network video stream is on';
Object.assign(messages['zh-CN'],{audio_none:'尚未收到音轨',audio_ended:'声音连接已结束',audio_failed:'网页声音播放失败，请重试',
  audio_blocked:'点击手机画面即可开启声音',audio_paused:'网页声音已暂停',audio_muted:'网页声音已静音',audio_waiting:'等待声音数据',audio_playing:'网页声音已开启',
  statsPlayback:'网页声音状态',statsPlayback_paused:'网页暂停播放',statsPlayback_muted:'网页静音',statsPlayback_readyState:'媒体就绪状态',statsPlayback_liveTracks:'有效音轨数'});
Object.assign(messages.en,{audio_none:'No audio track yet',audio_ended:'Audio track ended',audio_failed:'Browser audio failed; retry playback',
  audio_blocked:'Click the phone to enable audio',audio_paused:'Browser audio paused',audio_muted:'Browser audio muted',audio_waiting:'Waiting for audio data',audio_playing:'Browser audio enabled',
  statsPlayback:'Browser audio state',statsPlayback_paused:'Playback paused',statsPlayback_muted:'Playback muted',statsPlayback_readyState:'Media ready state',statsPlayback_liveTracks:'Live audio tracks'});
Object.assign(messages['zh-CN'],{statsTitle:'连接状态',statsClose:'收起',statsRtt:'网络往返（毫秒）',
  statsHint:'仅在此处打开时读取，不上传。计数及平均值自本次连接开始；网络往返不是完整操作延迟，— 表示浏览器未提供。',
  stats_video:'画面',stats_audio:'音频',stats_input:'输入',stats_width:'宽',stats_height:'高',stats_framesPerSecond:'接收帧率',
  stats_framesDecoded:'已解码帧',stats_framesDropped:'丢弃帧',stats_packetsLost:'丢包',stats_jitterBufferMs:'平均缓冲（毫秒）',stats_decodeMs:'平均解码（毫秒）',
  stats_packetsReceived:'收到包数',stats_totalSamplesReceived:'收到采样数',stats_totalAudioEnergy:'累计音频能量',stats_totalSamplesDuration:'采样时长（秒）',
  stats_concealedSamples:'补偿采样数',stats_messagesSent:'已发送消息',stats_state:'状态'});
Object.assign(messages.en,{statsTitle:'Connection details',statsClose:'Collapse',statsRtt:'Network round trip (ms)',
  statsHint:'Read only while open, never uploaded. Counters and averages cover this connection. RTT is not end-to-end latency; — means unavailable.',
  stats_video:'Video',stats_audio:'Audio',stats_input:'Input',stats_width:'Width',stats_height:'Height',stats_framesPerSecond:'Received FPS',
  stats_framesDecoded:'Decoded frames',stats_framesDropped:'Dropped frames',stats_packetsLost:'Lost packets',stats_jitterBufferMs:'Mean buffer (ms)',stats_decodeMs:'Mean decode (ms)',
  stats_packetsReceived:'Received packets',stats_totalSamplesReceived:'Received samples',stats_totalAudioEnergy:'Total audio energy',stats_totalSamplesDuration:'Sample duration (s)',
  stats_concealedSamples:'Concealed samples',stats_messagesSent:'Messages sent',stats_state:'State'});
const workspace=createPhoneWorkspace({element:$("#phone-workspace"),api,translate:t,onPhoneExit:()=>{phoneDebug?.reset();phoneFiles?.reset();phoneCamera?.reset();},onReturn:()=>{
  selection.clear();
  history.replaceState(null,"",location.pathname);$("#refresh").focus({preventScroll:true});
}});
phoneDebug=createPhoneDebug({element:$("#phone-adb-dialog"),api,translate:t,getPhoneId:()=>workspace.phoneId});
phoneFiles=createPhoneFiles({element:$('#phone-files-dialog'),getPhone:()=>state.data.find(p=>p.id===workspace.phoneId)});
phoneCamera=createPhoneCamera({element:$('#phone-camera-dialog'),getPhone:()=>state.data.find(p=>p.id===workspace.phoneId),findPhone:id=>state.data.find(p=>p.id===id),indicator:$('#phone-camera-indicator'),onChange:(id,value)=>{const phone=state.data.find(p=>p.id===id);if(phone){phone.cameraInput=value;render();}}});
$('#phone-open-camera').addEventListener('click',()=>{$('#phone-workspace-more').open=false;phoneCamera.open();});
$('#phone-open-files').addEventListener('click',()=>{$('#phone-workspace-more').open=false;phoneFiles.open();});
$("#phone-open-adb").addEventListener("click",()=>{$("#phone-workspace-more").open=false;phoneDebug.open();});
function openPhone(phone){selection.remember(phone.id);history.replaceState(null,"",`${location.pathname}#phone=${phone.id}`);text('#phone-rom-description',phoneRomDescription(phone.rom,t));text('#phone-rom-technical',phone.rom ? `${phone.rom.version} · ${phone.rom.id}` : 'Android 17 · AOSP');workspace.open(phone);}
function canStart() { return state.ready && state.availability?.enabled && state.availability.runtimeConfigured; }
function button(action, phone) {
  const node = document.createElement("button"); node.type = "button"; node.textContent = t(action); node.dataset.action = action; node.dataset.phone = phone.id;
  node.className = action === "start" ? "primary" : ["delete","remove-record"].includes(action) ? "danger" : "";
  node.disabled = state.busy || Boolean(state.pending) || !state.ready;
  node.addEventListener("click", () => {
    const menu = node.closest("details"); if (menu) menu.open = false;
    if(action==="open")openPhone(phone);
    else if(action==='camera')phoneCamera.open(phone);
    else if (["rename", "delete", "remove-record"].includes(action)) edit(action === "remove-record" ? "delete" : action, phone);
    else void mutate({action, phoneId:phone.id, body:{expectedRevision:phone.revision}, key:crypto.randomUUID()});
  });
  return node;
}
function render() {
  const active = document.activeElement, focus = active?.dataset?.action ? { action:active.dataset.action, phone:active.dataset.phone } : null;
  const menus = new Set([...document.querySelectorAll(".card details[open]")].map(el => el.dataset.phone));
  const cards = state.data.map(phone => {
    const card = document.createElement("article"); card.className = "card";
    const head = document.createElement("div"); head.className = "card-top";
    const title = document.createElement("h2"); title.textContent = phone.name;
    const badge = document.createElement("span"); badge.className = "badge"; badge.dataset.state = phone.state; badge.textContent = t(phone.state);
    head.append(title, badge); card.append(head);
    const spec = document.createElement("p"); spec.className = "spec"; spec.textContent = phoneRomDescription(phone.rom,t); card.append(spec);
    if(phone.rom){const camera=document.createElement('small');camera.className='rom-camera';camera.textContent=`${t('romCamera')} · ${t(phone.rom.cameraCapability==='verified'?'romCameraReady':'romCameraUnavailable')}`;card.append(camera);}
    if(phone.cameraInput&&phone.cameraInput.state!=='stopped'){
      const input=document.createElement('div');input.className='camera-list-state';input.dataset.state=phone.cameraInput.state;
      const label=document.createElement('span');label.textContent=t(['browser','video','usb','udp'].includes(phone.cameraInput.sourceKind)&&phone.cameraInput.state==='active'?'camera_'+phone.cameraInput.sourceKind+'_active':'camera_'+phone.cameraInput.state);input.append(label);
      if(phone.state==='running'){const manage=button('camera',phone);manage.textContent=t('cameraManage');input.append(manage);}card.append(input);
    }
    if (phone.errorCode) { const hint = document.createElement("p"); hint.className = "error-note";
      hint.textContent = t(phone.cleanupMode === "retired-record" ? "retiredRecordHint" : phone.errorCode); card.append(hint); }
    const controls = document.createElement("div"); controls.className = "card-actions";
    if(phone.state==="running")controls.append(button("open",phone));
    const more = document.createElement("details"); more.dataset.phone = phone.id; more.open = menus.has(phone.id);
    const summary = document.createElement("summary"); summary.textContent = t("more"); const menu = document.createElement("div"); menu.className = "menu";
    if(phone.state==='running'&&phone.rom?.cameraCapability==='verified')menu.append(button('camera',phone));
    for (const action of phoneActions(phone, canStart() && (state.quota.runningPerUser === null || state.quota.running < state.quota.runningPerUser || phone.runningCharged))) {
      (["start", "stop"].includes(action) ? controls : menu).append(button(action, phone));
    }
    if (menu.childElementCount) { more.append(summary, menu); controls.append(more); }
    card.append(controls); return card;
  });
  $("#phones").replaceChildren(...cards);
  if (focus) [...document.querySelectorAll("button[data-action]")].find(el => el.dataset.action === focus.action && el.dataset.phone === focus.phone)?.focus({preventScroll:true});
  $("#empty").hidden = !state.ready || state.data.length > 0;
  $("#create").disabled = !canStart() || state.busy || Boolean(state.pending) || state.quota?.storedPerUser != null && state.quota.stored >= state.quota.storedPerUser;
  for (const [selector, key, n, max] of [["#stored","stored",state.quota?.stored,state.quota?.storedPerUser],["#running","runningQuota",state.quota?.running,state.quota?.runningPerUser]]) text(selector, n === undefined ? "—" : t(max === null ? `${key}Resource` : key,{n,max}));
  $("#uncertain").hidden = !state.pending; $("#retry").disabled = state.busy;
}
function translate() {
  document.documentElement.lang=state.locale;applyProductLabels(document,state.locale); document.title = t("title");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  render();workspace.translate();phoneDebug.translate();phoneFiles.translate();phoneCamera.translate();
  if($('#editor').open && state.editing?.action==='create')renderPhoneRoms($('#rom-choices'),state.availability,t);
}
window.addEventListener("message", event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== "teamaibox.plugin-preferences/v1" || event.data.pluginId !== "official.virtual-phones") return;
  try { const applied = applyPluginPreferenceSnapshotV1({currentDocument:document,snapshot:event.data}); document.documentElement.style.colorScheme = applied.effective.theme; state.locale = normalizeProductLocale(applied.effective.locale); translate(); }
  catch { note("#error", t("phone_response_invalid")); }
});
async function refresh() {
  if (refreshing || stopped || document.hidden) return;
  refreshing = true; const sequence = ++state.readSequence;
  try {
    const [list, availability] = await Promise.all([api.list(), api.availability()]);
    if (sequence !== state.readSequence || stopped) return;
    Object.assign(state, list, {availability,ready:true});
    if (state.readError) { note("#error", ""); state.readError = false; }
    await updateOperations();
    note("#notice", state.operationNotice || (canStart() ? "" : t(availability.reasonCode || "unavailableHint")));
    render();
    if($('#editor').open && state.editing?.action==='create')renderPhoneRoms($('#rom-choices'),state.availability,t);
    workspace.refresh(state.data,true);
    phoneFiles.refresh();
    phoneCamera.refresh();
    if(!workspace.phoneId){const selected=selection.resolve(location.hash,state.data);if(selected)openPhone(selected);}
  } catch (error) {
    if (sequence !== state.readSequence || stopped) return;
    state.ready = false; state.readError = true;
    if ([401,403].includes(error.status)) { selection.clear();state.data = []; state.quota = null; state.pending = null; $("#editor").close(); workspace.close(); }
    note("#error", t(error.code)); render();
  } finally {
    refreshing = false; clearTimeout(timer);
    if (!stopped) timer = setTimeout(refresh, state.data.some(phone => TRANSIENT.has(phone.state)) ? 1500 : 5000);
  }
}
const pendingOperations = new Map();
async function updateOperations() {
  for (const [id, tracked] of pendingOperations) {
    try {
      const op = await api.operation(id);
      if (op.state === 'succeeded' || op.state === 'failed') {
        pendingOperations.delete(id);
        state.operationNotice = op.state === 'failed' ? '' : t(tracked.action === 'delete' ? 'deleteComplete' : 'operationComplete');
        if (op.state === 'failed') note('#error', t(op.errorCode));
      }
    } catch { /* Preserve tracking until the operation can be read again. */ }
  }
}
async function mutate(request) {
  if (state.busy || stopped) return;
  state.busy = true; state.pending = request; state.readError = false; ++state.readSequence; render(); note("#error", "");
  try { const result=await api.mutate(request); state.pending = null;
    if(result.object==="virtual_phone.operation") pendingOperations.set(result.id,{phoneId:result.phoneId,action:result.action});
    state.operationNotice=t(result.recordRemoved?"recordRemoved":request.action==="rename"?"saved":"submitted");note("#notice",state.operationNotice); }
  catch (error) {
    // A lost response may have committed. Keep the same key and exact body on retry.
    if (error.status >= 400 && error.status < 500) state.pending = null;
    note("#error", t(error.code));
  } finally { state.busy = false; render(); void refresh(); }
}
function edit(action, phone = null) {
  state.editing = {action,phone}; text("#dialog-title", t(action==="delete" && phone?.cleanupMode==="retired-record" ? "remove-record" : action));
  $("#name").setCustomValidity("");
  text("#dialog-hint", action === "create" ? t("createHint") : action === "delete" ? t(phone.cleanupMode==="retired-record"?"removeRecordHint":"deleteHint", {name:phone.name}) : "");
  $("#name-label").hidden = action === "delete"; $("#name").required = action !== "delete"; $("#name").value = phone?.name ?? "";
  $("#delete-label").hidden = action !== "delete"; $("#confirm-delete").checked = false; $("#confirm-delete").required = action === "delete";
  $('#rom-picker').hidden=action!=='create';$('#rom-picker').disabled=action!=='create';
  if(action==='create')renderPhoneRoms($('#rom-choices'),state.availability,t,{preserve:false});
  text("#delete-label span",t(phone?.cleanupMode==="retired-record"?"confirmRemoveRecord":"confirm"));
  text("#submit", t(action === "delete" && phone?.cleanupMode==="retired-record" ? "remove-record" : action === "rename" ? "save" : action)); $("#editor").showModal();
  (action === "delete" ? $("#confirm-delete") : $("#name")).focus();
}
$("#create").addEventListener("click", () => edit("create"));
$("#cancel").addEventListener("click", () => $("#editor").close());
$("#name").addEventListener("input", () => $("#name").setCustomValidity(""));
$("#edit-form").addEventListener("submit", event => {
  event.preventDefault();
  $("#name").setCustomValidity(state.editing.action !== "delete" && !$("#name").value.trim() ? t("nameRequired") : "");
  if (!$("#edit-form").reportValidity()) return;
  const {action,phone} = state.editing, body = action === "delete" ? {expectedRevision:phone.revision,confirmDelete:$("#confirm-delete").checked}
    : {name:$("#name").value.trim().normalize("NFC"), ...(phone ? {expectedRevision:phone.revision} : {start:true})};
  if(action==='create'){
    const selected=$('#rom-choices input:checked')?.value;
    if(!phoneRomChoices(state.availability).some(rom=>rom.id===selected && rom.createEnabled && !rom.reasonCode))return;
    if(state.availability.roms || state.availability.systems)body.romVersionId=selected;
  }
  if (action !== "delete" && !body.name) return;
  $("#editor").close(); void mutate({action:action==="delete" && phone.cleanupMode==="retired-record"?"remove-record":action,phoneId:phone?.id,body,key:crypto.randomUUID()});
});
$("#retry").addEventListener("click", () => state.pending && void mutate(state.pending));
$("#refresh").addEventListener("click", () => void refresh());
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
window.addEventListener("pagehide", () => { stopped = true; clearTimeout(timer); });
window.addEventListener("pageshow", event => { if (event.persisted) { stopped = false; void refresh(); } });
Object.assign(messages['zh-CN'], {
  'remove-record':'移除旧手机记录', retiredRecordHint:'这是已停用位置上的旧手机记录，不能在本机启动。可从列表移除，原位置数据不会因此删除。',
  removeRecordHint:'仅从本系统移除「{name}」的旧记录及保存名额。原位置上的应用和文件不会被删除；不会影响本机其他手机。',
  confirmRemoveRecord:'我确认移除这条旧记录，并知晓这不代表原位置的数据已删除。',
  recordRemoved:'旧手机记录已移除，原位置数据未删除。', deleteComplete:'手机及其数据已删除。', saved:'名称已保存。', operationComplete:'手机操作已完成。',
});
Object.assign(messages.en, {
  'remove-record':'Remove old phone record', retiredRecordHint:'This phone belongs to a retired location and cannot start here. Removing its record does not erase data at the original location.',
  removeRecordHint:'Remove the old record for “{name}” and its saved-phone slot only. Original-location files and apps are not erased. Other local phones are unaffected.',
  confirmRemoveRecord:'I confirm removal of this old record, not erasure of data at its original location.',
  recordRemoved:'Old phone record removed. Original-location data was not erased.', deleteComplete:'Phone and its data deleted.', saved:'Name saved.', operationComplete:'Phone operation completed.',
});
translate(); void refresh();
// Tell the host when the listener is installed, independently of API readiness.
parent.postMessage({type:'teamaibox.plugin-ready/v1',pluginId:'official.virtual-phones'},location.origin);
