import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/public/computers.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
async function fixture(){
 const elements=new Map();let active=null,pending=false,failure=null,calls=[],retries=0;
 const el=id=>{if(!elements.has(id))elements.set(id,{hidden:true,textContent:'',value:'',open:false,disabled:false,attributes:{},
  replaceChildren(){},append(){},removeAttribute(){},setAttribute(k,v){this.attributes[k]=v;},focus(){active=id;},
  setCustomValidity(value){this.validationMessage=value;},showModal(){this.open=true;},close(){this.open=false;},
  reportValidity(){if(el('name').validationMessage){el('name').focus();return false;}return true;},
  querySelectorAll(){return ['name','system','vcpus','memoryGiB','diskGiB','submit'].map(el);}});return elements.get(id);};
 const availability={enabled:true,systems:[{id:'win11',name:'Windows 11',createEnabled:true,minimum:{vcpus:2,memoryGiB:4,diskGiB:64}}],limits:{maximum:{}}};
 const api={hasPending:()=>pending,availability:async()=>availability,list:async()=>({data:[]}),
  async mutate(path,method,body){calls.push({path,method,body});if(failure){pending=!!failure.uncertain;throw failure;}return {state:'submitted'};},
  async retry(){retries++;pending=false;return {state:'submitted'};}};
 const context=vm.createContext({document:{documentElement:{lang:'zh-CN',dataset:{}},getElementById:el,createElement:()=>({}),querySelectorAll:()=>[],addEventListener(){}},
  window:{addEventListener(){}},createComputerApi:()=>api,computerActions:()=>[],setTimeout:()=>1,clearTimeout(){}});
 vm.runInContext(source,context);await new Promise(setImmediate);
 return {el,api,calls,get active(){return active;},get retries(){return retries;},set failure(v){failure=v;},
  async settle(){await new Promise(setImmediate);},run:s=>vm.runInContext(s,context)};
}
test('space-only names are rejected in the open dialog without a request; corrections clear validity',async()=>{
 const f=await fixture();f.el('create').onclick();f.el('name').value='　   ';f.el('create-form').onsubmit({preventDefault(){}});
 assert.equal(f.calls.length,0);assert.equal(f.active,'name');assert.match(f.el('name').validationMessage,/名称/);assert.equal(f.el('editor').open,true);
 f.el('name').value='  Office  ';f.el('name').oninput();assert.equal(f.el('name').validationMessage,'');
 f.el('create-form').onsubmit({preventDefault(){}});await f.settle();assert.equal(f.calls[0].body.name,'Office');assert.equal(f.el('editor').open,false);
});
for(const [dialog,prefix] of [['editor','create'],['delete-dialog','delete']]){
 test(`${prefix}: failed mutations are visible and focused inside their dialog`,async()=>{
  const f=await fixture();f.el(dialog).open=true;f.failure={code:'computer_capacity_unavailable'};
  await f.run("mutate('','POST',{})");assert.equal(f.el(dialog).open,true);assert.equal(f.el(prefix+'-error').hidden,false);
  assert.match(f.el(prefix+'-error').textContent,/资源/);assert.equal(f.active,prefix+'-error');
  assert.equal(f.el(prefix+'-retry').hidden,true);assert.equal(f.el('submit').disabled,false);
 });
 test(`${prefix}: uncertain result locks new submissions and provides same-request retry in place`,async()=>{
  const f=await fixture();f.el(dialog).open=true;f.failure={uncertain:true};await f.run("mutate('','POST',{})");
  assert.equal(f.el(prefix+'-retry').hidden,false);assert.equal(f.el('submit').disabled,true);
  f.el('name').value='duplicate';f.el('create-form').onsubmit({preventDefault(){}});assert.equal(f.calls.length,1);
  await f.el(prefix+'-retry').onclick();assert.equal(f.retries,1);assert.equal(f.calls.length,1);assert.equal(f.el(dialog).open,false);
 });
}
test('request in progress exposes busy state and prevents another submit',async()=>{
 const f=await fixture();let resolve;f.api.mutate=()=>new Promise(r=>{resolve=r;});f.el('editor').open=true;
 const request=f.run("mutate('','POST',{})");assert.equal(f.el('editor').attributes['aria-busy'],'true');assert.equal(f.el('submit').disabled,true);
 resolve({state:'submitted'});await request;assert.equal(f.el('editor').attributes['aria-busy'],'false');assert.equal(f.el('submit').disabled,false);
});
