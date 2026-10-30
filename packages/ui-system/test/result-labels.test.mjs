import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

for(const app of ['ocr','asr','translation'])test(`${app}: locale refresh changes labels, not result content or requests`,async()=>{
 const source=await readFile(new URL(`../../../apps/${app}-plugin/src/public/app.js`,import.meta.url),'utf8');
 const hook=source.slice(source.indexOf('function refreshResultLabels()'));
 assert.ok(hook.startsWith('function refreshResultLabels()'));
 assert.doesNotMatch(hook,/\b(?:fetch|json|poll|result|presentResult)\s*\(|\.value\s*=|replaceChildren/);
 assert.doesNotMatch(source,/\.style\.width\s*=\s*new Intl/);
 assert.doesNotMatch(source,/className\s*=.*?block-\$\{blockLabel/);
 const elements=new Map();
 const $=key=>{if(!elements.has(key))elements.set(key,{textContent:'old',value:'user edited text',dataset:{status:'succeeded'},style:{width:'100%'}});return elements.get(key)};
 const state={locale:'de',jobId:'00000000-fixture',file:null,result:null};
 const document={querySelectorAll:()=>[]};
 vm.runInNewContext(`${hook};refreshResultLabels()`,{state,$,document,t:(key)=>`de:${key}`,Intl,TERMINAL:new Set(['succeeded'])});
 assert.ok([...elements.values()].some(el=>el.textContent.startsWith('de:')));
 for(const el of elements.values())assert.equal(el.value,'user edited text');
});
