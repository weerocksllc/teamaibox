import assert from 'node:assert/strict';
import { test } from 'node:test';
import {phoneRomChoices,phoneRomDescription} from '../src/public/phone-roms.mjs';
const base={id:'aosp-17-16102939-v1',familyId:'aosp',googlePlay:false,createEnabled:true};
const google={id:'google-experimental-17-16102939-v1',familyId:'google-experimental',googlePlay:true,createEnabled:false};
test('old API history is reduced to two product types without guessing latest',()=>{
  const rows=[base,google,...[1,2,3].map(n=>({...base,id:'aosp-camera-v'+n,createEnabled:true}))];
  assert.deepEqual(phoneRomChoices({roms:rows}).map(x=>x.id),[base.id,google.id]);
  assert.equal(phoneRomChoices({roms:[]}).length,2);
  assert.ok(phoneRomChoices({roms:[]}).every(x=>!x.createEnabled));
});
test('explicit server family mapping selects exact camera release; mixed families fail closed',()=>{
  const systems=[{...base,id:'aosp-camera-v3',systemId:'standard'}, {...google,id:'google-camera-v1',systemId:'google-play'}];
  assert.deepEqual(phoneRomChoices({systems}).map(x=>x.id),systems.map(x=>x.id));
  assert.equal(phoneRomChoices({systems:[{...systems[0],googlePlay:true},systems[1]]})[0].createEnabled,false);
  assert.equal(phoneRomChoices({systems:[...systems,systems[0]]})[0].createEnabled,false);
  assert.equal(phoneRomDescription({...base,name:'Camera v3',version:'Camera v3'},key=>key),'romStandardName');
});
