import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhoneWorkspace} from '../src/public/phone-workspace.mjs';

// Controller unit tests, not browser/media acceptance. Real two-tab playback
// is verified separately in the system-trusted browser after deployment.
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function fixture(t){
  class Element extends EventTarget{
    constructor(){super();this.hidden=false;this.textContent='';this.dataset={};this.srcObject=null;this.paused=true;this.muted=false;this.volume=1;this.readyState=0;this.classList={add(){},remove(){}};}
    querySelector(id){return get(id);}querySelectorAll(){return [];}
    replaceChildren(){}focus(){}play(){this.paused=false;return Promise.resolve();}pause(){this.paused=true;}
  }
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const oldDocument=globalThis.document,oldWindow=globalThis.window;
  globalThis.document=Object.assign(new EventTarget(),{hidden:false,body:new Element()});globalThis.window=new EventTarget();
  t.after(()=>{globalThis.document=oldDocument;globalThis.window=oldWindow;});
  t.mock.timers.enable({apis:['setTimeout']});
  const calls=[],sessions=[];let occupied=false,closeWait=null,mediaError=null;
  const api={async connection(phoneId,options){calls.push(['open',options.takeover]);if(occupied&&!options.takeover)throw Object.assign(Error('busy'),{code:'phone_connection_in_use',status:409});return {phoneId,id:'grant-'+calls.length};},
    async closeConnection(phoneId,id){calls.push(['close',id]);await closeWait;}};
  const workspace=createPhoneWorkspace({element:new Element(),api,translate:x=>x,createSession:options=>{if(mediaError)throw mediaError;const s={...options,close(){},key(){},touch(){}};sessions.push(s);return s;}});
  return {workspace,get,calls,sessions,occupy(){occupied=true;},mediaFailure(error){mediaError=error;},delayClose(p){closeWait=p;},open(){workspace.open({id:'phone',name:'test',state:'running'});}};
}

test('automatic recovery never takes over; occupied view stops retries until an explicit click',async t=>{
  const f=fixture(t);f.open();await flush();assert.deepEqual(f.calls,[['open',false]]);
  f.sessions[0].onState('connected');f.occupy();f.sessions[0].onState('disconnected');
  t.mock.timers.tick(1000);await flush();
  assert.equal(f.get('#phone-connection').textContent,'media_in_use');
  assert.equal(f.get('#phone-retry').textContent,'connectHere');assert.equal(f.get('#phone-retry').hidden,false);
  const count=f.calls.length;t.mock.timers.tick(100000);await flush();assert.equal(f.calls.length,count);
  f.get('#phone-retry').dispatchEvent(new Event('click'));await flush();assert.deepEqual(f.calls.at(-1),['open',true]);
  f.sessions.at(-1).onState('connected');assert.equal(f.get('#phone-connection').textContent,'media_connected');f.workspace.close();
});

test('normal reconnect waits for its own exact old connection to close',async t=>{
  const f=fixture(t);f.open();await flush();let release;f.delayClose(new Promise(resolve=>{release=resolve;}));
  f.sessions[0].onState('failed');t.mock.timers.tick(1000);await flush();
  assert.deepEqual(f.calls,[['open',false],['close','grant-1']]);
  release();await flush();assert.deepEqual(f.calls.at(-1),['open',false]);f.workspace.close();
});

test('leaving while old connection closes cannot create a new background connection',async t=>{
  const f=fixture(t);f.open();await flush();let release;f.delayClose(new Promise(resolve=>{release=resolve;}));
  f.sessions[0].onState('failed');t.mock.timers.tick(1000);await flush();f.workspace.close();release();await flush();
  assert.equal(f.calls.filter(c=>c[0]==='open').length,1);
});

test('a protected stop replaces an in-use claim even without a session or retry timer',async t=>{
  const f=fixture(t);f.occupy();f.open();await flush();
  assert.equal(f.get('#phone-connection').textContent,'media_in_use');
  f.workspace.refresh([{id:'phone',name:'test',state:'stopped',errorCode:'phone_resource_protection'}],true);
  assert.equal(f.get('#phone-connection').textContent,'media_protected');
  assert.equal(f.get('#phone-retry').hidden,true);
  const count=f.calls.length;t.mock.timers.tick(100000);await flush();assert.equal(f.calls.length,count);
  // Even a stale click must not create a connection to the stopped phone.
  f.get('#phone-retry').dispatchEvent(new Event('click'));await flush();assert.equal(f.calls.length,count);
  f.workspace.close();
});

test('stopped runtime state invalidates callbacks and reconnects only after running returns',async t=>{
  const f=fixture(t);f.open();await flush();const old=f.sessions[0];old.onState('connected');
  f.workspace.refresh([{id:'phone',name:'test',state:'stopping'}],true);
  assert.equal(f.get('#phone-connection').textContent,'media_stopping');
  old.onState('failed');assert.equal(f.get('#phone-connection').textContent,'media_stopping');
  f.workspace.refresh([{id:'phone',name:'test',state:'stopped'}],true);
  assert.equal(f.get('#phone-connection').textContent,'media_stopped');
  f.workspace.refresh([{id:'phone',name:'test',state:'running'}],true);await flush();
  assert.equal(f.calls.filter(c=>c[0]==='open').length,2);assert.deepEqual(f.calls.at(-1),['open',false]);
  f.workspace.close();
});

test('unavailable browser media releases the grant without automatic retries and permits manual retry',async t=>{
  const f=fixture(t);f.mediaFailure(Object.assign(new Error('unavailable'),{code:'phone_browser_media_unavailable'}));
  f.open();await flush();assert.equal(f.get('#phone-connection').textContent,'media_browser_unavailable');
  assert.equal(f.get('#phone-retry').hidden,false);assert.deepEqual(f.calls,[['open',false],['close','grant-1']]);
  t.mock.timers.tick(100000);await flush();assert.equal(f.calls.length,2);
  f.mediaFailure(null);f.get('#phone-retry').dispatchEvent(new Event('click'));await flush();
  assert.deepEqual(f.calls.at(-1),['open',false]);assert.equal(f.sessions.length,1);
  f.sessions[0].onState('connected');assert.equal(f.get('#phone-connection').textContent,'media_connected');f.workspace.close();
});
