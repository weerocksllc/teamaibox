import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {focusSourceForm} from '../src/sources/source-form-focus.ts';
import {sourceErrorKey} from '../src/sources/source-error.ts';

test('transient source failures do not blame configuration or discard the draft',()=>{
  assert.equal(sourceErrorKey(new TypeError('network unavailable')),'admin.sources.unavailable');
  assert.equal(sourceErrorKey(Object.assign(new Error('database unavailable'),{status:503})),'admin.sources.unavailable');
  assert.equal(sourceErrorKey(Object.assign(new Error('invalid configuration'),{status:400})),'admin.sources.error');
});

test('source form focuses its first input and returns focus on cancellation', () => {
  const document = {activeElement:null,body:{}};
  const opener = {isConnected:true,focus(){document.activeElement=this;}};
  const input = {focus(){document.activeElement=this;}};
  const panel = {ownerDocument:document,querySelector:()=>input,contains:node=>node===input};
  document.activeElement=opener;
  const cleanup=focusSourceForm(panel);
  assert.equal(document.activeElement,input);
  cleanup(); assert.equal(document.activeElement,opener);
  const again=focusSourceForm(panel);
  const elsewhere={};document.activeElement=elsewhere;
  again();assert.equal(document.activeElement,elsewhere);
});

const source=readFileSync(new URL('../src/sources/SourceCenterPanel.tsx',import.meta.url),'utf8');
test('refresh never unmounts a loaded source form, including after errors',()=>{
  assert.match(source,/if \(loading && !loaded\) return/);
  assert.match(source,/finally \{ loadingRef.current = false; setLoading\(false\); setLoaded\(true\); \}/);
  assert.match(source,/if \(loadingRef.current\) return/);
});
test('source and policy forms support cancellation and block edits while saving',()=>{
  assert.match(source,/<Composer id="source-composer"/);
  assert.match(source,/<Composer id="policy-composer"/);
  assert.match(source,/<fieldset[^>]+disabled=\{saving\}/);
  assert.match(source,/event.stopPropagation\(\); if \(!saving\) onClose\(\)/);
  assert.match(source,/disabled=\{saving \|\| composer !== null\}/);
});
