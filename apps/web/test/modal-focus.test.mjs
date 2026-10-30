import assert from 'node:assert/strict';
import {test} from 'node:test';
import {containModalFocus,focusPopover} from '../src/modal-focus.ts';
import {taskLabel} from '../src/activity/task-label.ts';
import {createI18nRuntime} from '../src/i18n.ts';
import {readFileSync} from 'node:fs';

function fixture() {
  const listeners=new Map();
  const doc={activeElement:null,addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)};
  const element=(visible=true)=>({tabIndex:0,isConnected:true,getClientRects:()=>visible?[{}]:[],focus(){doc.activeElement=this;}});
  const opener=element(),first=element(),hidden=element(false),last=element();
  doc.activeElement=opener;
  const panel={...element(),ownerDocument:doc,querySelector:()=>first,querySelectorAll:()=>[first,hidden,last],contains:e=>[panel,first,last].includes(e)};
  doc.body=element();
  const key=(shiftKey=false)=>{let prevented=false;listeners.get('keydown')({key:'Tab',shiftKey,preventDefault(){prevented=true;}});return prevented;};
  return {doc,panel,opener,first,last,key,listeners};
}

test('modal focuses its first control, wraps both ways, and restores its opener',()=>{
  const f=fixture(),dispose=containModalFocus(f.panel);
  assert.equal(f.doc.activeElement,f.first);
  assert.equal(f.key(true),true);assert.equal(f.doc.activeElement,f.last);
  assert.equal(f.key(),true);assert.equal(f.doc.activeElement,f.first);
  f.doc.activeElement=f.opener;f.listeners.get('focusin')({target:f.opener});
  assert.equal(f.doc.activeElement,f.first);
  dispose();assert.equal(f.doc.activeElement,f.opener);assert.equal(f.listeners.size,0);
});
test('empty modal remains focusable and does not restore a removed opener',()=>{
  const f=fixture();f.panel.querySelectorAll=()=>[];
  const dispose=containModalFocus(f.panel);
  assert.equal(f.doc.activeElement,f.panel);assert.equal(f.key(),true);
  f.opener.isConnected=false;dispose();assert.equal(f.doc.activeElement,f.panel);
});
test('known and historical task titles never expose untranslated keys',()=>{
  for(const locale of ['zh-CN','en']) {
    const {translate}=createI18nRuntime({locale});
    assert.notEqual(taskLabel('tasks.kind.embedding',translate),'tasks.kind.embedding');
    assert.equal(taskLabel('tasks.kind.retired-task',translate),translate('tasks.kind.unknown'));
  }
});

test('popover restores focus on Escape/unmount without trapping Tab or stealing outside focus',()=>{
  const f=fixture(),dispose=focusPopover(f.panel);
  assert.equal(f.doc.activeElement,f.first);
  assert.equal(f.listeners.size,0);
  f.doc.activeElement=f.doc.body;
  dispose();assert.equal(f.doc.activeElement,f.opener);
  const again=focusPopover(f.panel),outside={};
  f.doc.activeElement=outside;
  again();assert.equal(f.doc.activeElement,outside);
});
test('popover never restores a removed opener',()=>{
  const f=fixture(),dispose=focusPopover(f.panel);
  f.opener.isConnected=false;
  dispose();assert.equal(f.doc.activeElement,f.first);
});

test('global search shortcut closes all preceding overlays before opening search',()=>{
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
  const shortcut=app.slice(app.indexOf('if ((event.metaKey || event.ctrlKey)'),app.indexOf('if (event.key === "Escape")'));
  const transitions=[];
  const event={metaKey:true,key:'k',preventDefault(){}};
  const states=['Task','Profile','Notifications','MobileMenu','Search'];
  new Function('event',...states.map(name=>`set${name}Open`),shortcut)(
    event,...states.map(name=>value=>transitions.push([name,value])));
  assert.deepEqual(transitions,states.map(name=>[name,name==='Search']));
});
test('Escape closes only the foremost shell overlay, preserving the underlying application',()=>{
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
  const escape=app.slice(app.indexOf('if (event.key === "Escape")'),app.indexOf('window.addEventListener("keydown"'));
  const body=escape.slice(0,escape.lastIndexOf('};'));
  const states=['search','task','profile','notifications','mobileMenu'];
  for(const active of states) {
    const transitions=[];
    new Function('event',...states.map(name=>`${name}Open`),
      ...states.map(name=>`set${name[0].toUpperCase()+name.slice(1)}Open`),
      'setActiveApp',body)({key:'Escape'},...states.map(name=>name===active),
      ...states.map(name=>value=>transitions.push([name,value])),
      ()=>assert.fail('must not close underlying application'));
    assert.deepEqual(transitions,[[active,false]]);
  }
});
test('collapsed mobile navigation is hidden and its badge uses actual active tasks',()=>{
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
  assert.match(css,/\.sidebar \{[^}]*visibility: hidden/);
  assert.match(css,/\.sidebar--open \{[^}]*visibility: visible/);
  assert.match(app,/className="workspace" inert=\{mobileMenuOpen\}/);
  assert.match(app,/className="mobile-nav" inert=\{mobileMenuOpen\}/);
  assert.match(app,/className="nav-count">\{activity!\.summary\.active\}/);
  assert.doesNotMatch(app,/className="nav-count">2</);
});
