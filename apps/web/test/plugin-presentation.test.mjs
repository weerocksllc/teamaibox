import assert from 'node:assert/strict';
import test from 'node:test';
import {inspectPluginPresentation,watchPluginPresentation} from '../src/applications/plugin-presentation.mjs';

const origin='https://appliance.example';
const source='/plugins/official.wireless-casting?locale=en&theme=dark';
function fixture() {
  const doc={URL:'about:blank',readyState:'loading',documentElement:{dataset:{}}};
  const frame={contentDocument:doc},timers=new Map(),seen={ready:[],failed:0,published:0,states:[]};
  let serial=0;
  const options={frame:()=>frame,source,origin,locale:'en',
    publish:()=>seen.published++,onReady:locale=>seen.ready.push(locale),onFailure:()=>seen.failed++,
    onDocumentState:state=>seen.states.push(state),
    schedule:fn=>{timers.set(++serial,fn);return serial;},cancel:id=>timers.delete(id)};
  const tick=()=>{const next=timers.entries().next().value;assert.ok(next);timers.delete(next[0]);next[1]();};
  const load=(locale)=>{doc.URL=origin+source;doc.readyState='complete';if(locale)doc.documentElement.dataset.uiPresentedLocale=locale;};
  return {doc,frame,timers,seen,options,tick,load};
}
test('missed child-ready event is reconciled from the actual document, independently of business APIs',()=>{
  const f=fixture();const monitor=watchPluginPresentation(f.options);
  f.load();f.tick();assert.deepEqual(f.seen.ready,[]);
  f.doc.documentElement.dataset.uiPresentedLocale='en';f.tick();
  assert.deepEqual(f.seen.ready,['en']);assert.equal(f.timers.size,0);
  monitor.check();assert.deepEqual(f.seen.ready,['en']);
});
test('already-painted cached document is accepted without publishing or waiting for onLoad',()=>{
  const f=fixture();f.load('en');watchPluginPresentation(f.options);
  assert.deepEqual(f.seen.ready,['en']);assert.equal(f.seen.published,0);assert.equal(f.timers.size,0);
});
test('blank, other documents, and wrong language never unhide the frame',()=>{
  const f=fixture();f.doc.documentElement.dataset.uiPresentedLocale='en';
  watchPluginPresentation(f.options);assert.deepEqual(f.seen.ready,[]);
  f.doc.URL=origin+'/';f.tick();assert.deepEqual(f.seen.ready,[]);
  f.doc.URL='https://other.example'+source;f.tick();assert.deepEqual(f.seen.ready,[]);
  f.load('zh-CN');f.tick();assert.deepEqual(f.seen.ready,[]);
  f.load('en');f.tick();assert.deepEqual(f.seen.ready,['en']);
});
test('bounded timeout exposes failure; eventual real load can recover without an automatic reload',()=>{
  const f=fixture(),monitor=watchPluginPresentation({...f.options,maximumAttempts:2});
  f.tick();assert.equal(f.seen.failed,1);assert.equal(f.timers.size,0);
  monitor.check();assert.equal(f.seen.failed,1);assert.equal(f.timers.size,0);
  f.load('en');monitor.check();assert.deepEqual(f.seen.ready,['en']);
});
test('retry starts a fresh bounded observer; cleanup ignores late loads and clears every scheduled check',()=>{
  const f=fixture();const old=watchPluginPresentation({...f.options,maximumAttempts:1});
  assert.equal(f.seen.failed,1);old.stop();
  const current=watchPluginPresentation(f.options);
  current.check();assert.equal(f.timers.size,1);
  f.load('en');old.check();assert.deepEqual(f.seen.ready,[]);
  current.check();assert.deepEqual(f.seen.ready,['en']);current.stop();assert.equal(f.timers.size,0);
});
test('early missing theme tokens do not leave startup unhandled or poll indefinitely',()=>{
  const f=fixture();let tries=0;
  watchPluginPresentation({...f.options,publish:()=>{if(++tries===1)throw Error('not mounted yet');},maximumAttempts:3});
  f.tick();f.load('en');f.tick();assert.deepEqual(f.seen.ready,['en']);assert.equal(f.seen.failed,0);
});
test('inaccessible document is a bounded, content-free state',()=>{
  const frame={get contentDocument(){throw Error('sensitive detail');}};
  assert.deepEqual(inspectPluginPresentation(frame,source,origin),{state:'unavailable',locale:null});
});
test('a stranded blank document exposes failure without automatically navigating or refreshing',()=>{
  const f=fixture();let navigations=0;
  f.frame.isConnected=true;Object.defineProperty(f.frame,'src',{set(value){assert.equal(value,source);navigations++;}});
  const monitor=watchPluginPresentation(f.options);
  for(let n=0;n<31;n++)f.tick();
  assert.equal(navigations,0);assert.equal(f.seen.failed,1);assert.equal(f.timers.size,0);
  f.load('en');monitor.check();assert.deepEqual(f.seen.ready,['en']);
});
test('slow initialized documents and later blank documents are never automatically navigated',()=>{
  const f=fixture();let navigations=0;
  f.frame.isConnected=true;Object.defineProperty(f.frame,'src',{set(){navigations++;}});
  f.load();watchPluginPresentation(f.options);
  for(let n=0;n<9;n++)f.tick();assert.equal(navigations,0);
  f.doc.URL='about:blank';for(let n=0;n<10;n++)f.tick();assert.equal(navigations,0);
});
