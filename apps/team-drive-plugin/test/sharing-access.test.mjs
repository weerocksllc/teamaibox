import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {configureSharingAction} from '../src/public/sharing-access.mjs';

function fixture(request) {
  return {button:{disabled:false},hint:{hidden:true,textContent:''},request,entryId:'file-a',isCurrent:()=>true,translate:key=>key};
}
test('sharing remains disabled until the server confirms per-file authority', async()=>{
  let complete;
  const f=fixture(path=>{assert.equal(path,'/api/v1/files/entries/file-a/shares');return new Promise(resolve=>{complete=resolve;});});
  const pending=configureSharingAction(f);
  assert.equal(f.button.disabled,true);assert.equal(f.hint.textContent,'sharingChecking');
  complete({data:[]});await pending;
  assert.equal(f.button.disabled,false);assert.equal(f.hint.hidden,true);
});
for(const status of [403,404,503]) test(`sharing explains ${status} without offering a doomed submit`,async()=>{
  const f=fixture(async()=>{throw Object.assign(new Error('denied'),{status});});
  await configureSharingAction(f);assert.equal(f.button.disabled,true);
  assert.equal(f.hint.hidden,false);assert.equal(f.hint.textContent,status===503?'sharingUnavailable':'sharingDenied');
});
test('invalid server data cannot enable sharing',async()=>{
  const f=fixture(async()=>({}));await configureSharingAction(f);
  assert.equal(f.button.disabled,true);assert.equal(f.hint.textContent,'sharingUnavailable');
});
test('late replies from another selection do not enable its action',async()=>{
  const f=fixture(async()=>({data:[]}));f.isCurrent=()=>false;
  await configureSharingAction(f);assert.equal(f.button.disabled,true);
});
test('production details wire a disabled action and visible explanation',async()=>{
  const source=await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
  assert.match(source,/configureSharingAction\(\{button:share/);
  assert.match(source,/share\.disabled=true/);
  assert.match(source,/if\(!share\.disabled\)openShare\(entry\)/);
  assert.match(source,/state\.selected\?\.id===entry\.id&&share\.isConnected/);
  assert.match(source,/当前账号没有此文件的共享权限/);
});
