import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/public/computers.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
async function fixture(){
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{hidden:true,textContent:'',replaceChildren(){},close(){this.open=false;},setAttribute(){},querySelectorAll(){return [];},focus(){this.focused=true;}});return elements.get(id);};
 let unavailable=true,enabled=true,pending=false;
 const api={hasPending:()=>pending,availability:async()=>{if(unavailable)throw {code:'computer_network_unavailable'};return {enabled,systems:[],reasonCode:enabled?null:'computer_creation_paused'};},
  list:async()=>({data:[]}),mutate:async()=>{pending=true;throw {uncertain:true};}};
 const context=vm.createContext({document:{documentElement:{lang:'zh-CN',dataset:{}},getElementById:el,querySelectorAll:()=>[],addEventListener(){}},
  window:{addEventListener(){}},createComputerApi:()=>api,computerActions:()=>[],setTimeout:()=>1,clearTimeout(){}});
 vm.runInContext(source,context);await new Promise(setImmediate);
 return {el,refresh:()=>vm.runInContext('refresh()',context),mutate:()=>vm.runInContext("mutate('','POST',{})",context),
  recover:()=>{unavailable=false;},enable:value=>{enabled=value;}};
}
test('a successful refresh clears a recovered connection error',async()=>{
 const f=await fixture();assert.equal(f.el('error').hidden,false);f.recover();await f.refresh();assert.equal(f.el('error').hidden,true);
});
test('refresh does not erase an uncertain mutation or its same-request retry',async()=>{
 const f=await fixture();f.recover();await f.refresh();await f.mutate();await f.refresh();
 assert.equal(f.el('error').hidden,false);assert.match(f.el('error').textContent,/请求结果尚未确认/);assert.equal(f.el('retry').hidden,false);
});
test('a recovered creation switch clears only its stale availability notice',async()=>{
 const f=await fixture();f.recover();f.enable(false);await f.refresh();assert.match(f.el('notice').textContent,/管理员已暂停/);
 f.enable(true);await f.refresh();assert.equal(f.el('notice').hidden,true);
});
