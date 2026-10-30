import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {confirmPhoneInstallation} from '../src/public/phone-install-confirmation.mjs';

function fixture(){
  const nodes=new Map();
  for(const id of ['phone-install-confirmation','phone-install-name','phone-install-yes','phone-install-no']){
    const node=new EventTarget();Object.assign(node,{hidden:true,textContent:'',focus(){this.focused=true;}});nodes.set('#'+id,node);
  }
  return {element:{querySelector:id=>nodes.get(id)},nodes,controller:new AbortController()};
}
for(const accepted of [true,false])test(`in-page APK confirmation resolves ${accepted} and clears listeners`,async()=>{
  const f=fixture();const pending=confirmPhoneInstallation(f.element,{name:'fixture.apk'},f.controller.signal);
  assert.equal(f.nodes.get('#phone-install-confirmation').hidden,false);
  assert.equal(f.nodes.get('#phone-install-name').textContent,'fixture.apk');
  assert.equal(f.nodes.get('#phone-install-no').focused,true);
  f.nodes.get(accepted?'#phone-install-yes':'#phone-install-no').dispatchEvent(new Event('click'));
  assert.equal(await pending,accepted);assert.equal(f.nodes.get('#phone-install-confirmation').hidden,true);
  assert.equal(f.nodes.get('#phone-install-name').textContent,'');
  f.controller.abort();
});
test('closing or cancelling an install confirmation rejects and hides it',async()=>{
  const f=fixture();const pending=confirmPhoneInstallation(f.element,{name:'fixture.apk'},f.controller.signal);
  f.controller.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(f.nodes.get('#phone-install-confirmation').hidden,true);
});
test('an already cancelled action cannot open confirmation',()=>{
  const f=fixture();f.controller.abort();assert.throws(()=>confirmPhoneInstallation(f.element,{name:'fixture.apk'},f.controller.signal),{name:'AbortError'});
  assert.equal(f.nodes.get('#phone-install-confirmation').hidden,true);
});
test('production APK controls work without browser modal sandbox permission',async()=>{
  const source=await readFile(new URL('../src/public/phone-files.mjs',import.meta.url),'utf8');
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(source,/window\.confirm\(/);assert.match(source,/phone_install_cancelled/);
  for(const id of ['phone-install-confirmation','phone-install-name','phone-install-yes','phone-install-no'])assert.ok(html.includes(`id="${id}"`));
});
