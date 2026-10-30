import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {desktopSize, ReconnectSchedule, connectParameters, desktopEndpoints, desktopRequestHeaders, desktopText} from '../src/public/desktop-session.mjs';
import {createComputerApi} from '../src/public/computer-client.mjs';

function harness({responseStatus=200,mode,locale='zh-CN',computerState}={}) {
  const nodes = new Map(), clients = [], keyboards = [], timers = new Map(); let serial = 0, fetches = 0, focus;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {textContent:'',clientWidth:1280,clientHeight:720,
      dataset:{}, handlers:{}, elements:{username:{value:'user'},password:{value:'test-only'},domain:{value:''}},
      addEventListener(type, fn) { this.handlers[type] = fn; },
      replaceChildren() {}, setAttribute() {}, focus() { focus = selector; },
      showModal() { this.open = true; }, close() { this.open = false; }});
    return nodes.get(selector);
  };
  const context = {
    desktopSize, ReconnectSchedule, connectParameters, desktopEndpoints, desktopRequestHeaders, desktopText, createComputerApi, URLSearchParams, Intl, AbortSignal,
    document:{documentElement:{lang:locale},querySelectorAll:()=>[],cookie:'__Host-teamaibox-csrf=test-platform-csrf',querySelector:node,body:{dataset:{computerId:'10000000-0000-4000-8000-000000000001'}}},
    window:{location:{href:'https://10.64.0.20/apps/virtual-computers/desktop'+(mode?'?mode='+mode:'')},addEventListener() {}},
    setTimeout(fn) { const id=++serial;timers.set(id,fn);return id; },clearTimeout(id){timers.delete(id);},
    ResizeObserver: class {observe() {}},
    fetch: async (url) => {fetches++;
      if(!url.endsWith('/desktop-sessions')&&computerState)return {status:200,ok:true,json:async()=>({state:computerState})};
      return {status:responseStatus,ok:responseStatus===200,json:async()=>({authToken:'token'+fetches,dataSource:'json',connectionId:'Windows 11'})};},
    Guacamole:{Status:{Code:{CLIENT_UNAUTHORIZED:0x301,CLIENT_FORBIDDEN:0x303}},Tunnel:{State:{CLOSED:2}},WebSocketTunnel:class {},
      Client:class {
        constructor(tunnel){this.tunnel=tunnel;clients.push(this);this.display={getElement(){return {};},scale(){},getWidth(){return 1280;},getHeight(){return 720;}};this.sent=[];}
        getDisplay(){return this.display;} disconnect(){this.disconnected=true;}
        connect(query){this.query=query;} createArgumentValueStream(type,name){return {owner:this,name};}
        sendKeyEvent(...event){this.keys??=[];this.keys.push(event);} sendMouseState(){}
      },StringWriter:class {
        constructor(stream){this.stream=stream;} sendText(value){this.stream.owner.sent.push([this.stream.name,value]);} sendEnd(){}
      },Keyboard:class {constructor(){keyboards.push(this);}reset(){}},Mouse:class {},AudioPlayer:{getSupportedTypes(){return [];}},AudioContextFactory:{getAudioContext:()=>({suspend:async()=>{}})},
    },
  };
  const source=readFileSync(new URL('../src/public/desktop.mjs',import.meta.url),'utf8').replace(/^import .*\n/gm,'');
  vm.runInNewContext(source,context);
  const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  return {node,clients,keyboards,settle,get fetches(){return fetches;},get scheduled(){return timers.size;},get focus(){return focus;},
    async retry(){const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await settle();}};
}

test('toolbar does not retain keyboard focus after clicking desktop',async()=>{
  const h=harness();await h.settle();h.node('#screen').handlers.pointerdown();assert.equal(h.focus,'#screen');
});
test('virtual monitor reports a drawable display without requiring a Windows login and exposes sound',async()=>{
  const h=harness({mode:'console'});await h.settle();const active=h.clients[0];
  active.onstatechange(3);assert.match(h.node('#status').textContent,/虚拟显示器/);
  active.onsync();assert.equal(h.node('#status').textContent,'已连接');
  assert.notEqual(h.node('#login').open,true);assert.notEqual(h.node('#sound').hidden,true);
});
test('English console and desktop controls do not change guest language or require a guest login',async()=>{
  const h=harness({mode:'console',locale:'en'});await h.settle();const active=h.clients[0];
  active.onstatechange(3);assert.equal(h.node('#status').textContent,'Opening virtual monitor…');
  active.onsync();assert.equal(h.node('#status').textContent,'Connected');
  h.node('#leave').onclick();assert.equal(h.node('#status').textContent,'Desktop disconnected. Windows is still running.');
});
test('an occupied desktop explains how to continue rather than automatically fighting the other viewer',async()=>{
  const h=harness({responseStatus:409});await h.settle();
  assert.match(h.node('#status').textContent,/另一个页面/);assert.equal(h.clients.length,0);assert.equal(h.fetches,1);
});
test('network reconnect obtains fresh gateway authorization and reuses only in-page login',async()=>{
  const h=harness({mode:'desktop'});await h.settle();const old=h.clients[0];
  old.onrequired(['username','password']);h.node('#credentials').handlers.submit({preventDefault(){}});
  assert.equal(h.node('#credentials').elements.password.value,'');
  old.onsync();assert.equal(h.node('#status').textContent,'已连接');
  old.onerror({code:0x200});await h.retry();const next=h.clients[1];next.onrequired(['username','password']);
  assert.equal(h.fetches,2);assert.equal(next.sent[1][1],'test-only');assert.equal(h.node('#login').open,false);
  assert.equal(new URLSearchParams(next.query).get('token'),'token2');assert.equal(old.disconnected,true);
});
test('authentication rejection clears remembered credentials rather than retrying them forever',async()=>{
  const h=harness({mode:'desktop'});await h.settle();const old=h.clients[0];
  old.onrequired(['username','password']);h.node('#credentials').handlers.submit({preventDefault(){}});
  old.onerror({code:0x301});assert.equal(h.node('#login').open,true);
  assert.equal(h.fetches,1);assert.equal(old.disconnected,true);
});
test('leave disconnects desktop and cancels retry without a guest shutdown API call',async()=>{
  const h=harness();await h.settle();h.node('#leave').onclick();
  assert.equal(h.clients[0].disconnected,true);assert.equal(h.fetches,1);
  assert.match(h.node('#status').textContent,/Windows 仍在运行/);
});
test('a transport-only closure recovers even when Client emits no error',async()=>{
  const h=harness();await h.settle();const old=h.clients[0];
  old.tunnel.onstatechange(2);assert.match(h.node('#status').textContent,/自动重连/);
  await h.retry();assert.equal(h.fetches,2);assert.equal(old.disconnected,true);
  old.tunnel.onerror({code:0x200});assert.equal(h.clients[1].disconnected,undefined);
});
test('reconnections retain one keyboard and direct keys only to the current desktop',async()=>{
  const h=harness();await h.settle();const old=h.clients[0];
  old.tunnel.onstatechange(2);await h.retry();
  assert.equal(h.keyboards.length,1);
  h.keyboards[0].onkeydown(65);h.keyboards[0].onkeyup(65);
  assert.equal(old.keys,undefined);assert.deepEqual(h.clients[1].keys,[[1,65],[0,65]]);
  h.node('#leave').onclick();h.keyboards[0].onkeydown(66);
  assert.equal(h.clients[1].keys.length,2);
});
test('an empty display during Windows reboot is not advertised as connected',async()=>{
  const h=harness();await h.settle();const active=h.clients[0];
  active.display.getWidth=()=>0;active.display.getHeight=()=>0;
  active.onsync();assert.notEqual(h.node('#status').textContent,'已连接');
  active.display.getWidth=()=>1280;active.display.getHeight=()=>720;
  active.onsync();assert.equal(h.node('#status').textContent,'已连接');
  h.node('#screen').dataset.desktopWidth='1280';h.node('#screen').dataset.desktopHeight='720';
  active.tunnel.onstatechange(2);assert.equal(h.node('#screen').dataset.desktopWidth,undefined);
});
test('platform access loss does not masquerade as a Windows password failure or keep retrying',async()=>{
  for(const status of [401,403,404]){
    const h=harness({responseStatus:status});await h.settle();
    assert.equal(h.clients.length,0);assert.equal(h.fetches,1);
    assert.notEqual(h.node('#login').open,true);
    assert.match(h.node('#status').textContent,status===401?/平台登录已过期/:/电脑当前不可访问/);
  }
});
test('confirmed guest shutdown ends retries, while an unavailable control channel keeps retrying',async()=>{
  for(const computerState of ['stopped','running',undefined]){
    const h=harness({responseStatus:503,computerState});await h.settle();
    assert.equal(h.clients.length,0);assert.equal(h.fetches,2);
    if(computerState==='stopped') {assert.match(h.node('#status').textContent,/已关机/);assert.equal(h.scheduled,0);assert.equal(h.node('#start').hidden,false);}
    else {assert.match(h.node('#status').textContent,/正在重试/);assert.equal(h.scheduled,1);}
  }
});
test('default monitor never presents an RDP credential dialog, even on protocol rejection',async()=>{
  for(const failure of ['error','required']){
    const h=harness();await h.settle();const active=h.clients[0];active.onsync();assert.equal(h.node('#status').textContent,'已连接');
    if(failure==='error')active.onerror({code:0x301});else active.onrequired(['username','password']);
    assert.notEqual(h.node('#login').open,true);assert.match(h.node('#status').textContent,/不需要远程桌面密码/);
  }
});
test('monitor keeps waiting while the existing start operation starts the guest',async()=>{
  const h=harness({responseStatus:503,computerState:'starting'});await h.settle();
  assert.equal(h.scheduled,1);assert.match(h.node('#status').textContent,/正在开机/);assert.equal(h.node('#start').hidden,true);
});
test('stale display callbacks cannot relabel a disconnected or replacement desktop',async()=>{
  const h=harness();await h.settle();const old=h.clients[0], oldResize=old.display.onresize;
  oldResize(0,0);assert.equal(h.node('#screen').dataset.desktopWidth,undefined);
  old.tunnel.onstatechange(2);await h.retry();
  oldResize(999,999);assert.equal(h.node('#screen').dataset.desktopWidth,undefined);
});
