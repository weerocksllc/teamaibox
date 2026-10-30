import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneSelection} from '../src/public/phone-selection.mjs';
const id='de7fe8b4-4ef0-4327-845e-af24cd53f4b9',phone={id,state:'running'};
function storage(){const m=new Map();return {getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};}
test('new iframe after top-level refresh reopens only an owned running phone',()=>{
 const s=storage();phoneSelection(s).remember(id);assert.equal(phoneSelection(s).resolve('',[phone]),phone);
});
test('a different owner or deleted phone clears the navigation pointer',()=>{
 const s=storage(),n=phoneSelection(s);n.remember(id);assert.equal(n.resolve('',[]),null);assert.equal(n.resolve('',[phone]),null);
});
test('explicit return to phone list clears automatic reopen',()=>{
 const n=phoneSelection(storage());n.remember(id);n.clear();assert.equal(n.resolve('',[phone]),null);
});
test('stopped phones and malformed pointers never auto-start a VM',()=>{
 const n=phoneSelection(storage());n.remember(id);assert.equal(n.resolve('',[{...phone,state:'stopped'}]),null);
 n.remember('https://evil.invalid');assert.equal(n.resolve('',[phone]),null);
});
test('storage blocked by browser remains usable with owned hash navigation',()=>{
 const n=phoneSelection({getItem(){throw Error()},setItem(){throw Error()},removeItem(){throw Error()}});
 n.remember(id);n.clear();assert.equal(n.resolve('',[phone]),null);assert.equal(n.resolve('#phone='+id,[phone]),phone);
});
