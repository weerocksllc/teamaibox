import {productText} from './product-localization.mjs';
// Desktop size is expressed in CSS pixels at 96 DPI. Do not divide it by the
// screen pixel ratio: that produces a tiny desktop enlarged into blurry text.
const ENGLISH = {
  '虚拟显示器':'Virtual monitor','远程桌面':'Remote desktop','开机':'Start','正在开机，等待显示器连接…':'Starting. Waiting for the monitor…',
  '正在打开虚拟显示器…':'Opening virtual monitor…','这台电脑已关机。点击“开机”后可在这里看到引导画面。':'This computer is off. Select Start to watch it boot here.',
  '开机请求未完成，请重试。':'Could not start the computer. Please retry.','开机请求待确认，点击重试同一请求。':'Start request not confirmed. Select Start to retry the same request.',
  '静音':'Mute','显示器连接失败，请重新连接；不需要远程桌面密码。':'Monitor connection failed. Reconnect; no remote desktop password is needed.',
  '显示 Windows 登录界面时，请直接在画面内登录。声音需点击“开启声音”。':'If Windows shows its sign-in screen, sign in inside the display. Select Enable sound for audio.',
  'Windows 桌面':'Windows desktop','正在连接…':'Connecting…','开启声音':'Enable sound','重新连接':'Reconnect','全屏':'Full screen','离开桌面':'Leave desktop',
  'Windows 远程桌面':'Windows remote desktop','登录 Windows':'Sign in to Windows',
  '使用这台电脑已有的 Windows 账户。密码只用于本次连接，不会保存到浏览器。':'Use the existing Windows account on this computer. Your password is used for this connection only and is not saved in the browser.',
  '用户名':'Username','密码':'Password','域（通常留空）':'Domain (usually blank)','登录桌面':'Sign in',
  '关闭或离开页面不会关闭 Windows。':'Closing or leaving this page does not shut down Windows.',
  '连接已中断，正在自动重连…':'Connection interrupted. Reconnecting…',
  '请从虚拟电脑页面登录后重新打开。':'Sign in from Virtual Computers, then reopen this desktop.',
  '这台电脑已在另一个页面打开。关闭那个页面后，点击“重新连接”。':'This computer is open in another page. Close that page, then select Reconnect.',
  '平台登录已过期，请从虚拟电脑页面重新打开。':'Your platform session has expired. Reopen this desktop from Virtual Computers.',
  '这台电脑当前不可访问，请返回虚拟电脑页面检查。':'This computer is currently unavailable. Check it in Virtual Computers.',
  '请重新登录 Windows':'Please sign in to Windows again','登录未成功，请检查 Windows 用户名和密码。':'Sign-in failed. Check the Windows username and password.',
  '连接暂时中断，正在自动恢复…':'Connection interrupted. Recovering…','正在打开安装与恢复画面…':'Opening installation and recovery…',
  '正在打开桌面…':'Opening desktop…','等待登录 Windows':'Waiting for Windows sign-in','已连接':'Connected',
  '桌面服务暂时不可达，正在重试…':'Desktop service is temporarily unreachable. Retrying…','正在登录 Windows…':'Signing in to Windows…',
  '声音已开启':'Sound enabled','点击重试声音':'Retry sound','浏览器未允许播放声音，请再点击“开启声音”。':'The browser blocked audio. Select Enable sound again.',
  '正在重新连接…':'Reconnecting…','已离开桌面，Windows 仍在运行':'Desktop disconnected. Windows is still running.',
  '安装与恢复画面不传声音。进入 Windows 后，请使用“打开桌面”。':'Installation and recovery does not carry audio. Use Open desktop after entering Windows.',
  '请从“虚拟电脑”打开这台电脑。':'Open this computer from Virtual Computers.'
  ,'这台电脑已关机，请返回虚拟电脑页面开机。':'This computer is shut down. Start it from Virtual Computers.'
};
export function desktopText(locale, message) { return ENGLISH[message] ? productText(locale, ENGLISH[message], message) : message; }

export function desktopSize(width, height) {
  if (![width, height].every(v => Number.isFinite(v) && v > 0)) return null;
  return { width: Math.max(200, Math.floor(width)), height: Math.max(200, Math.floor(height)), dpi: 96 };
}

export class ReconnectSchedule {
  attempt = 0;
  next() { return Math.min(15000, 2000 * 2 ** Math.min(this.attempt++, 3)); }
  reset() { this.attempt = 0; }
}

// The server selects the owned computer. Never accept an upstream hostname,
// port or credentials from a browser query string. Lab wiring is injected only
// by the local lab packager and cannot be enabled on the product origin.
export function desktopEndpoints(pageUrl, {computerId, labDesktop} = {}) {
  const page = new URL(pageUrl);
  const selected = page.searchParams.getAll('computerId');
  const modes=page.searchParams.getAll('mode');
  if(modes.length>1||modes.length&&!['desktop','console'].includes(modes[0]))throw new Error('请从“虚拟电脑”打开这台电脑。');
  if (selected.length > 1 || (computerId && selected.length && selected[0] !== computerId)) {
    throw new Error('请从“虚拟电脑”打开这台电脑。');
  }
  computerId ??= selected[0];
  if (labDesktop === 'true' && page.origin === 'http://127.0.0.1:18962') {
    return {session: 'http://127.0.0.1:18961/session', tunnel: 'websocket-tunnel', lab: true};
  }
  if (page.protocol !== 'https:' || labDesktop
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(computerId ?? '')) {
    throw new Error('请从“虚拟电脑”打开这台电脑。');
  }
  const base = `/api/v1/virtual-computers/${computerId.toLowerCase()}`;
  return {session: base + '/desktop-sessions', tunnel: base + '/desktop-tunnel', computer:base, lab: false,mode:modes[0]==='desktop'?'desktop':'console'};
}

export function connectParameters(session, size, audioTypes = []) {
  if (!session?.authToken || session.dataSource !== 'json' || !session.connectionId || !size) {
    throw new Error('Invalid desktop session');
  }
  const query = new URLSearchParams({ token: session.authToken, GUAC_DATA_SOURCE: session.dataSource,
    GUAC_ID: session.connectionId, GUAC_TYPE: 'c', GUAC_WIDTH: String(size.width),
    GUAC_HEIGHT: String(size.height), GUAC_DPI: String(size.dpi), GUAC_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone });
  for (const type of audioTypes) query.append('GUAC_AUDIO', type);
  for (const type of ['image/png', 'image/jpeg']) query.append('GUAC_IMAGE', type);
  return query.toString();
}

export function desktopRequestHeaders(cookie, lab = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (lab) return headers;
  const tokens = cookie.split(';').map(v => v.trim()).filter(v => v.startsWith('__Host-teamaibox-csrf='));
  if (tokens.length !== 1 || !tokens[0].slice('__Host-teamaibox-csrf='.length)) throw Error('请先登录 Team AI Box。');
  headers['x-csrf-token'] = tokens[0].slice('__Host-teamaibox-csrf='.length);
  return headers;
}
