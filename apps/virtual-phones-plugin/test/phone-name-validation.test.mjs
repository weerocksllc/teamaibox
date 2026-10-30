import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
test('phone create and rename reject whitespace locally, preserve the dialog, and allow correction',()=>{
 for(const action of ['create','rename']){
  const handlers={},fields={},requests=[];
  const $=id=>fields[id]??=( {value:'   ',addEventListener:(event,handler)=>handlers[id+event]=handler,
   setCustomValidity(value){this.validationMessage=value;},reportValidity:()=>!fields['#name'].validationMessage,
   close(){this.closed=true;}} );
  const state={editing:{action,phone:action==='rename'?{id:'phone',revision:2}:null},availability:{}};
  const context={$,state,t:()=> 'Enter a phone name, not just spaces.',crypto:{randomUUID:()=> 'request'},phoneRomChoices:()=>[{id:'standard',createEnabled:true}],mutate:r=>requests.push(r)};
  $('#rom-choices input:checked').value='standard';
  const snippet=source.slice(source.indexOf('$("#name").addEventListener("input"'),source.indexOf('$("#retry").addEventListener'));
  vm.runInNewContext(snippet,context);handlers['#edit-formsubmit']({preventDefault(){}});
  assert.equal(requests.length,0);assert.equal($('#editor').closed,undefined);assert.match($('#name').validationMessage,/name/);
  $('#name').value='  Office  ';handlers['#nameinput']();assert.equal($('#name').validationMessage,'');
  handlers['#edit-formsubmit']({preventDefault(){}});assert.equal(requests.length,1);assert.equal(requests[0].body.name,'Office');
 }
});
