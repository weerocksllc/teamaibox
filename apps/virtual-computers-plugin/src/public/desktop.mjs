import { desktopSize, ReconnectSchedule, connectParameters, desktopEndpoints, desktopRequestHeaders, desktopText } from './desktop-session.mjs';
import {createComputerApi} from './computer-client.mjs';
import {mountMonitorSharing} from './monitor-sharing.mjs';
import {normalizeProductLocale,productLocaleDirection} from './product-localization.mjs';
import {createInstallationPanel} from './installation-panel.mjs';
import {installationText} from './installation-text.mjs';
import {computerOsText} from './computer-os-text.mjs';
const screen = document.querySelector('#screen'), status = document.querySelector('#status');
const notice = document.querySelector('#notice'), login = document.querySelector('#login');
const form = document.querySelector('#credentials'), retry = new ReconnectSchedule();
const translate = message => desktopText(document.documentElement.lang, message);
for (const node of document.querySelectorAll('[data-desktop-text]')) { node.dataset.desktopSource=node.textContent; node.textContent = translate(node.textContent); }
document.title = translate('Windows 桌面') + ' · Team AI Box';
screen.setAttribute('aria-label', translate('Windows 远程桌面'));
let client, mouse, timer, resizeTimer, generation = 0, left = false, credentials = null, required = [], ownedComputer, startOperation;
const lifecycle=createComputerApi(), start=document.querySelector('#start'), sound=document.querySelector('#sound');
const installationPanel=createInstallationPanel(),installationButton=document.createElement('button');
installationButton.type='button';installationButton.hidden=true;installationButton.textContent=installationText(document.documentElement.lang,'install');
document.querySelector('header nav').append(installationButton);
installationButton.onclick=async()=>{
 try{const id=new URLSearchParams(location.search).get('computerId');await installationPanel.manage(await lifecycle.get(id));}
 catch{show('这台电脑当前不可访问，请返回虚拟电脑页面检查。');}
};
let soundEnabled=false;
let endpoints;
let sharing,canControl=false;
// One keyboard listener for this page. Recreating Guacamole.Keyboard on every
// reconnect accumulates DOM listeners; reset releases keys, not listeners.
const keyboard = new Guacamole.Keyboard(screen);
keyboard.onkeydown = key => { if(endpoints?.mode!=='console'||canControl)client?.sendKeyEvent(1, key); return false; };
keyboard.onkeyup = key => {if(endpoints?.mode!=='console'||canControl)client?.sendKeyEvent(0, key);};
screen.onblur = () => keyboard.reset();
const show = message => { status.dataset.desktopSource=message; status.textContent = translate(message); };
// Presentation updates must never reconnect a guest or alter control ownership.
window.addEventListener('storage',event=>{
  if(event.key==='teamaibox.recent-theme'&&['light','dark','system'].includes(event.newValue)){
    const theme=event.newValue==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):event.newValue;
    document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;
  }
  if(event.key!=='teamaibox.recent-locale'||!event.newValue)return;
  document.documentElement.lang=normalizeProductLocale(event.newValue);document.documentElement.dir=productLocaleDirection(event.newValue);
  for(const node of document.querySelectorAll('[data-desktop-source]'))node.textContent=translate(node.dataset.desktopSource);
  const title=translate(endpoints?.mode==='console'?'虚拟显示器':'远程桌面');
  document.querySelector('#view-title').textContent=title;document.title=title+' · Team AI Box';screen.setAttribute('aria-label',title);
  sound.textContent=translate(soundEnabled?'静音':'开启声音');
  document.querySelector('footer').textContent=endpoints?.mode==='console'?computerOsText(document.documentElement.lang,'monitor'):translate('关闭或离开页面不会关闭 Windows。');
  sharing?.refreshLabels();
  installationButton.textContent=installationText(document.documentElement.lang,'install');installationPanel.refreshLabels();
});
const dimensions = () => desktopSize(screen.clientWidth, screen.clientHeight);
// Guacamole consumes mouse events; explicitly move keyboard focus back from
// toolbar controls before forwarding a click into the Windows desktop.
screen.addEventListener('pointerdown', () => screen.focus(), { capture: true });
const sendCredentials = () => {
  if (!client || !credentials) return;
  for (const name of required) {
    if (!['username', 'password', 'domain'].includes(name)) continue;
    const writer = new Guacamole.StringWriter(client.createArgumentValueStream('text/plain', name));
    writer.sendText(credentials[name] || ''); writer.sendEnd();
  }
};
function cleanup() {
  keyboard.reset(); required = [];
  sharing?.leave();
  delete screen.dataset.desktopWidth; delete screen.dataset.desktopHeight;
  const old = client; client = null;
  if (old) { old.onerror = old.onstatechange = old.onrequired = null; old.disconnect(); }
  if (mouse) { mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = null; mouse = null; }
}
function schedule(message) {
  if (left || timer) return;
  cleanup();
  const delay = retry.next();
  show(message || '连接已中断，正在自动重连…');
  timer = setTimeout(() => { timer = null; connect(); }, delay);
}
async function connect() {
  if (left) return;
  cleanup();
  const current = ++generation;
  show('正在连接…');
  try {
    if(startOperation){
      const operation=await lifecycle.operation(startOperation);
      if(left||generation!==current)return;
      if(operation.state==='failed'){startOperation=null;start.hidden=false;show('开机请求未完成，请重试。');return;}
      if(operation.state==='succeeded')startOperation=null;
    }
    let headers;
    try { headers = desktopRequestHeaders(document.cookie, endpoints.lab); }
    catch { credentials = null; show('请从虚拟电脑页面登录后重新打开。'); return; }
    const response = await fetch(endpoints.session, { method: 'POST', credentials: 'same-origin',
      headers, body: JSON.stringify(endpoints.mode?{mode:endpoints.mode}:{}), cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (left || generation !== current) return;
    if (response.status === 409) {
      show('这台电脑已在另一个页面打开。关闭那个页面后，点击“重新连接”。'); return;
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      credentials = null;
      show(response.status === 401 ? '平台登录已过期，请从虚拟电脑页面重新打开。'
        : '这台电脑当前不可访问，请返回虚拟电脑页面检查。');
      return;
    }
    if (!response.ok) {
      // A normal guest shutdown is not a broken network. Only query the owned
      // computer after a failed handshake, without adding a second live poll.
      if (response.status === 503 && endpoints.computer) {
        const state = await fetch(endpoints.computer, {credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000)});
        const computer = state.ok ? await state.json() : null;
        if (left || generation !== current) return;
        if (computer?.state === 'stopped') {
          ownedComputer=computer;start.hidden=endpoints.mode!=='console';screen.replaceChildren();
          if(startOperation){schedule('正在开机，等待显示器连接…');return;}
          show('这台电脑已关机。点击“开机”后可在这里看到引导画面。'); return;
        }
        if(computer?.state==='starting'){start.hidden=true;schedule('正在开机，等待显示器连接…');return;}
      }
      throw new Error('gateway unavailable');
    }
    const session = await response.json();
    if (left || generation !== current) return;
    start.hidden=true;
    const tunnel = new Guacamole.WebSocketTunnel(endpoints.tunnel);
    client = new Guacamole.Client(tunnel);
    const active = client, display = active.getDisplay();
    screen.replaceChildren(display.getElement());
    active.onerror = error => {
      if (client !== active || current !== generation || left) return;
      if (error.code === Guacamole.Status.Code.CLIENT_UNAUTHORIZED || error.code === Guacamole.Status.Code.CLIENT_FORBIDDEN) {
        if(endpoints.mode==='console'){credentials=null;cleanup();show('显示器连接失败，请重新连接；不需要远程桌面密码。');return;}
        credentials = null; cleanup(); show('请重新登录 Windows');
        document.querySelector('#login-error').textContent = translate('登录未成功，请检查 Windows 用户名和密码。');
        form.elements.password.value = ''; if (!login.open) login.showModal(); return;
      }
      schedule('连接暂时中断，正在自动恢复…');
    };
    // Guacamole Client reports protocol errors, but does not forward transport
    // closure/errors. Without these handlers a dead desktop can say connected.
    tunnel.onerror = active.onerror;
    tunnel.onstatechange = state => {
      if (client === active && !left && state === Guacamole.Tunnel.State.CLOSED) schedule();
    };
    active.onstatechange = state => {
      if (client !== active || current !== generation || left) return;
      if (state === 3) { show(endpoints.mode === 'console' ? '正在打开虚拟显示器…' : credentials ? '正在打开桌面…' : '等待登录 Windows'); screen.focus(); }
      if (state === 3 && session.viewerId) sharing?.join(session.viewerId);
      if (state === 5) schedule();
    };
    active.onrequired = fields => {
      if (client !== active || current !== generation || left) return;
      if(endpoints.mode==='console'){cleanup();show('显示器连接失败，请重新连接；不需要远程桌面密码。');return;}
      required = fields;
      if (credentials) sendCredentials();
      else { show('等待登录 Windows'); if (!login.open) login.showModal(); }
    };
    active.onsync = () => {
      // Protocol sync also arrives before Windows has a drawable desktop (for
      // example while rebooting). Do not report a 0x0 display as connected or
      // reset the reconnect backoff merely because a socket is alive.
      if (client === active && (credentials || endpoints.mode === 'console') && !login.open && display.getWidth() > 0 && display.getHeight() > 0) {
        retry.reset(); show('已连接');
      }
    };
    display.onresize = (width, height) => {
      if (client !== active || current !== generation || left || width <= 0 || height <= 0) return;
      // Keep the whole desktop visible while the server applies display-update.
      display.scale(Math.min(screen.clientWidth / width, screen.clientHeight / height));
      screen.dataset.desktopWidth = String(width); screen.dataset.desktopHeight = String(height);
    };
    mouse = new Guacamole.Mouse(display.getElement());
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = event => {if(endpoints.mode!=='console'||canControl)active.sendMouseState(event, true);};
    const types = Guacamole.AudioPlayer.getSupportedTypes();
    active.connect(connectParameters(session, dimensions(), types));
  } catch (error) {
    // Exception category only: no URL, connection token, account or password.
    screen.dataset.connectionError = error instanceof TypeError ? 'type-error' : error instanceof ReferenceError ? 'reference-error' : 'connection-error';
    if (current === generation && !left) schedule('桌面服务暂时不可达，正在重试…');
  }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  credentials = { username: form.elements.username.value, password: form.elements.password.value, domain: form.elements.domain.value };
  form.elements.password.value = ''; login.close();
  show('正在登录 Windows…');
  if (client && required.length) sendCredentials(); else connect();
});
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { const size = dimensions(); if (client && size) {
    if(endpoints.mode!=='console')client.sendSize(size.width, size.height);
    const display=client.getDisplay();if(display.getWidth()>0&&display.getHeight()>0)display.scale(Math.min(screen.clientWidth/display.getWidth(),screen.clientHeight/display.getHeight()));
  } }, 200);
}).observe(screen);
sound.onclick = async () => {
  const context = Guacamole.AudioContextFactory.getAudioContext();
  try {
    if(soundEnabled)await context?.suspend();else await context?.resume();
    soundEnabled=context?.state==='running';sound.setAttribute('aria-pressed',String(soundEnabled));
    sound.textContent=translate(soundEnabled?'静音':'开启声音');
    if(!soundEnabled&&context?.state!=='suspended')throw Error('audio unavailable');
  }
  catch (_) { notice.textContent = translate('浏览器未允许播放声音，请再点击“开启声音”。'); notice.hidden = false; }
};
start.onclick=async()=>{
  if(start.disabled||!ownedComputer||endpoints.mode!=='console')return;
  start.disabled=true;left=false;clearTimeout(timer);timer=null;
  try{
    const operation=await(lifecycle.hasPending()?lifecycle.retry():lifecycle.mutate('/'+ownedComputer.id+'/start','POST',{expectedRevision:ownedComputer.revision}));
    if(operation.state==='failed')throw Error('start failed');
    startOperation=operation.id;start.hidden=true;retry.reset();await connect();
  }catch(error){show(error.uncertain?'开机请求待确认，点击重试同一请求。':'开机请求未完成，请重试。');}
  finally{start.disabled=false;}
};
document.querySelector('#reconnect').onclick = () => {
  left = false; generation++; clearTimeout(timer); timer = null; cleanup(); schedule('正在重新连接…');
};
document.querySelector('#fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
document.querySelector('#leave').onclick = () => {
  left = true; generation++; clearTimeout(timer); timer = null; credentials = null; cleanup(); screen.replaceChildren();
  Guacamole.AudioContextFactory.getAudioContext()?.suspend().catch(()=>{});soundEnabled=false;sound.textContent=translate('开启声音');sound.setAttribute('aria-pressed','false');
  show('已离开桌面，Windows 仍在运行');
};
window.addEventListener('pagehide', () => { left = true; generation++; credentials = null; clearTimeout(timer); cleanup(); });
try {
  endpoints = desktopEndpoints(window.location.href, document.body.dataset);
  if(endpoints.computer)fetch(endpoints.computer,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000)})
   .then(async response=>{if(response.ok){await response.json();installationButton.hidden=false;}}).catch(()=>{});
  const title=translate(endpoints.mode==='console'?'虚拟显示器':'远程桌面');
  document.querySelector('#view-title').textContent=title;document.title=title+' · Team AI Box';screen.setAttribute('aria-label',title);
  if (endpoints.mode === 'console') {
    sharing=mountMonitorSharing({base:endpoints.computer,onControl:value=>{canControl=value;if(!value)keyboard.reset();}});
    document.querySelector('footer').textContent=computerOsText(document.documentElement.lang,'monitor');
  }
  connect();
} catch (error) { left = true; show(error.message); }
