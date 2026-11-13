import assert from 'node:assert/strict';
import test from 'node:test';
import {observePenpotPresentation} from '../src/design/penpot-presentation.ts';

test('Penpot stays covered until its authenticated document has content and a native theme',()=>{
  const origin='https://workspace.example';
  const classes=new Set();
  const app={firstElementChild:null};
  let change,disconnected=0,ready=0;
  class MutationObserver{
    constructor(check){change=check;}
    observe(){}
    disconnect(){disconnected++;}
  }
  const doc={location:{origin,pathname:'/api/v1/design/editor/'},body:{classList:{contains:value=>classes.has(value)}},
    getElementById:id=>id==='app'?app:null};
  const frame={contentDocument:doc,contentWindow:{MutationObserver},ownerDocument:{location:{origin}}};
  const show=()=>ready++;
  assert.equal(observePenpotPresentation({...frame,contentDocument:{...doc,location:{origin,pathname:'/wrong'}}},show),undefined);
  const stop=observePenpotPresentation(frame,show);
  classes.add('default');
  change();
  assert.equal(ready,0);
  classes.clear();
  app.firstElementChild={};
  change();
  assert.equal(ready,0);
  classes.add('light');
  change();
  assert.equal(ready,1);
  assert.equal(disconnected,1);
  stop();
});
