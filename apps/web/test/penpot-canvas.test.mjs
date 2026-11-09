import assert from 'node:assert/strict';
import test from 'node:test';
import {observeCanvas} from '../src/design/penpot-canvas.ts';
import {canvasCopy} from '../src/design/penpot-canvas-copy.ts';
import {supportedLocales} from '../src/i18n.ts';

const dashboard='#/dashboard/recent';
const fileId='2318cb9e-a684-4ff1-b1d0-4a518e116534';
const origin='https://workspace.example';

function fixture(){
  const attributes=new Set(),dataset={},updates=[];
  const link={removed:false,remove(){this.removed=true;}};
  let frameCallback,mutationCallback,disconnected=false,save='saving';
  const win=new EventTarget();
  Object.assign(win,{
    location:{origin,pathname:'/api/v1/design/editor/',hash:dashboard},
    requestAnimationFrame(callback){frameCallback=callback;return 1;},
    cancelAnimationFrame(){frameCallback=undefined;},
    MutationObserver:class{
      constructor(callback){mutationCallback=callback;}
      observe(){}
      disconnect(){disconnected=true;}
    },
  });
  const doc={
    body:{}, documentElement:{dataset,toggleAttribute(name,value){value?attributes.add(name):attributes.delete(name);},
      removeAttribute(name){attributes.delete(name);}},
    head:{append(element){assert.equal(element,link);}},
    createElement(tag){assert.equal(tag,'link');return link;},
    querySelector(selector){
      if(selector.endsWith('__file-name'))return {getAttribute:()=> 'Canvas fixture'};
      if(selector.endsWith('__status-notification'))return {getAttribute:()=>save,
        classList:{contains:()=>save==='saved'}};
      if(selector.endsWith('__saved-status'))return save==='saved'?{}:null;
      throw new Error('Unexpected selector');
    },
  };
  const frame=Object.assign(new EventTarget(),{contentWindow:win,contentDocument:doc,
    ownerDocument:{location:{origin,href:origin+'/apps/penpot'}}});
  return {frame,win,link,attributes,dataset,updates,setSave(value){save=value;mutationCallback();},
    flush(){const cb=frameCallback;frameCallback=undefined;cb?.();}, disconnected:()=>disconnected};
}

test('canvas follows the same-origin native file and its real save acknowledgement',()=>{
  const f=fixture();
  const bridge=observeCanvas(f.frame,'/assets/penpot-canvas-test.css',file=>f.updates.push(file));
  assert.equal(f.link.href,origin+'/assets/penpot-canvas-test.css');
  assert.deepEqual(f.updates,[null]);
  f.win.location.hash='#/workspace?file-id='+fileId;
  f.win.dispatchEvent(new Event('hashchange'));f.flush();
  assert.equal(f.attributes.has('data-tab-design-canvas'),true);
  assert.deepEqual(f.updates.at(-1),{id:fileId,name:'Canvas fixture',saveText:'saving',saved:false});
  bridge.back();
  assert.match(f.win.location.hash,/^#\/workspace/);
  bridge.setPanel('layers');
  assert.equal(f.dataset.tabDesignPanel,'layers');
  bridge.setPanel('properties');
  assert.equal(f.dataset.tabDesignPanel,'properties');
  bridge.setPanel(null);
  assert.equal(f.dataset.tabDesignPanel,undefined);
  f.setSave('saved');f.flush();
  assert.equal(f.updates.at(-1).saved,true);
  bridge.back();
  assert.equal(f.win.location.hash,dashboard);
  f.win.dispatchEvent(new Event('hashchange'));f.flush();
  assert.equal(f.attributes.has('data-tab-design-canvas'),false);
  assert.equal(f.updates.at(-1),null);
  bridge.dispose();
  assert.equal(f.link.removed,true);
  assert.equal(f.disconnected(),true);
});

test('canvas ignores other iframe origins and has labels for every platform locale',()=>{
  const f=fixture();
  f.win.location.origin='https://unrelated.example';
  assert.equal(observeCanvas(f.frame,'/assets/style.css',file=>f.updates.push(file)),undefined);
  assert.deepEqual(f.updates,[null]);
  for(const locale of supportedLocales) assert.ok(canvasCopy[locale]?.every(label=>label.trim()) && canvasCopy[locale].length===4);
});
