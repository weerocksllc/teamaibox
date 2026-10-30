import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneApprovedNodes} from '../src/phone-approved-nodes.mjs';
import {installedPhoneRom,installedPhoneRuntime} from '../src/phone-rom.mjs';
const old='sha256:'+'a'.repeat(64), updated='sha256:'+'b'.repeat(64);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const phone={id:id(1),ownerId:id(2),volumeId:id(3),romVersionId:'google-preview',rom:{imageDigest:old}};
const mapping={phoneId:phone.id,ownerId:phone.ownerId,volumeId:phone.volumeId,romVersionId:phone.romVersionId,
 fromImageDigest:old,toImageDigest:updated,androidSystemDigest:'sha256:'+'c'.repeat(64)};
const node={nodeId:id(4),nodeGeneration:8,imageDigest:old,poolId:'phone-pool',maximumPhones:2,
 roms:[{romVersionId:'google-preview',imageDigest:old,cameraSources:['image','browser','video']},{romVersionId:'google-fixed',imageDigest:updated,cameraSources:['image','browser','video']}],
 runtimeMaintenance:[mapping]};
test('host repair preserves catalog/default but selects repaired runtime for only the exact phone',()=>{
 const n=phoneApprovedNodes([node]).get(node.nodeId);
 assert.equal(installedPhoneRom(n,phone.romVersionId,old).imageDigest,old);
 assert.equal(installedPhoneRuntime(n,phone).imageDigest,updated);
 assert.deepEqual(installedPhoneRuntime(n,phone).cameraSources,['image','browser','video']);
 for(const key of ['id','ownerId','volumeId'])assert.equal(installedPhoneRuntime(n,{...phone,[key]:id(99)}).imageDigest,old);
 assert.equal(installedPhoneRuntime(n,{...phone,rom:{imageDigest:updated}}),null);
});
test('current runs keep their image and arbitrary images are rejected',()=>{
 const n=phoneApprovedNodes([node]).get(node.nodeId);
 assert.equal(installedPhoneRuntime(n,phone,old).imageDigest,old);
 assert.equal(installedPhoneRuntime(n,phone,updated).imageDigest,updated);
 assert.equal(installedPhoneRuntime(n,phone,'sha256:'+'d'.repeat(64)),null);
 assert.equal(installedPhoneRuntime(n,{...phone,id:id(99)},updated),null);
});
test('maintenance must identify one installed compatible target and cannot be ambiguous',()=>{
 for(const value of [{...mapping,ownerId:''},{...mapping,androidSystemDigest:''},{...mapping,toImageDigest:old},
 {...mapping,fromImageDigest:updated},{...mapping,toImageDigest:'sha256:'+'d'.repeat(64)},{...mapping,extra:true}]) {
  assert.throws(()=>phoneApprovedNodes([{...node,runtimeMaintenance:[value]}]));
 }
 assert.throws(()=>phoneApprovedNodes([{...node,runtimeMaintenance:[mapping,mapping]}]));
 const n=phoneApprovedNodes([node]).get(node.nodeId);assert.throws(()=>{n.runtimeMaintenance[0].toImageDigest=old});
});
test('successive host repairs preserve control of the current run until the next start',()=>{
 const newest='sha256:'+'d'.repeat(64);
 const configured={...node,roms:[...node.roms,{romVersionId:'google-newest',imageDigest:newest}],
  runtimeMaintenance:[{...mapping,toImageDigest:newest,previousImageDigests:[updated]}]};
 const n=phoneApprovedNodes([configured]).get(node.nodeId);
 assert.equal(installedPhoneRuntime(n,phone,updated).imageDigest,updated);
 assert.equal(installedPhoneRuntime(n,phone).imageDigest,newest);
 assert.equal(installedPhoneRuntime(n,{...phone,ownerId:id(99)},updated),null);
 assert.throws(()=>n.runtimeMaintenance[0].previousImageDigests.push(old));
 for(const previousImageDigests of [[updated,updated],[newest],['sha256:'+'e'.repeat(64)]])
  assert.throws(()=>phoneApprovedNodes([{...configured,runtimeMaintenance:[{...configured.runtimeMaintenance[0],previousImageDigests}]}]));
});
test('installed ROM history and repair records are not limited by development sample counts',()=>{
 const roms=[...node.roms,...Array.from({length:30},(_,i)=>({romVersionId:'history-'+i,imageDigest:old}))];
 const runtimeMaintenance=Array.from({length:20},(_,i)=>({...mapping,phoneId:id(100+i)}));
 const n=phoneApprovedNodes([{...node,roms,runtimeMaintenance}]).get(node.nodeId);
 assert.equal(n.roms.length,32);assert.equal(n.runtimeMaintenance.length,20);
});
test('node count policy accepts administrator values and resource-based placement',()=>{
 for(const maximumPhones of [3,20,null]) assert.equal(phoneApprovedNodes([{...node,maximumPhones}]).get(node.nodeId).maximumPhones,maximumPhones);
 for(const maximumPhones of [0,-1,1.2,Infinity,'3']) assert.throws(()=>phoneApprovedNodes([{...node,maximumPhones}]));
});

test('node runtime adapter applies to new phones without changing either Android catalog identity',()=>{
 for(const romVersionId of ['aosp-current','google-current']){
  const configured={...node,runtimeMaintenance:[],roms:[{romVersionId,imageDigest:old,
   runtimeImageDigest:updated,androidSystemDigest:mapping.androidSystemDigest,cameraSources:['image','browser','video','usb','udp']}]};
  const n=phoneApprovedNodes([configured]).get(node.nodeId);
  const created={...phone,id:id(90),romVersionId};
  assert.equal(installedPhoneRom(n,romVersionId,old).imageDigest,old);
  assert.equal(installedPhoneRom(n,romVersionId,updated),null);
  assert.equal(installedPhoneRuntime(n,created).imageDigest,updated);
  for(const image of [old,updated])assert.equal(installedPhoneRuntime(n,created,image).imageDigest,image);
  assert.equal(installedPhoneRuntime(n,created,'sha256:'+'e'.repeat(64)),null);
  const other=phoneApprovedNodes([{...configured,roms:[{romVersionId,imageDigest:old}]}]).get(node.nodeId);
  assert.equal(installedPhoneRuntime(other,created).imageDigest,old);
  assert.equal(installedPhoneRuntime(other,created,updated),null);
 }
});
test('node runtime adapter requires a pinned runtime and unchanged Android system declaration',()=>{
 for(const patch of [{runtimeImageDigest:updated},{androidSystemDigest:mapping.androidSystemDigest},
  {runtimeImageDigest:old,androidSystemDigest:mapping.androidSystemDigest},
  {runtimeImageDigest:updated,androidSystemDigest:'latest'},
  {runtimeImageDigest:'latest',androidSystemDigest:mapping.androidSystemDigest}]){
  assert.throws(()=>phoneApprovedNodes([{...node,runtimeMaintenance:[],roms:[{romVersionId:phone.romVersionId,imageDigest:old,...patch}]}]));
 }
 const n=phoneApprovedNodes([{...node,roms:node.roms.map((rom,i)=>i?rom:{...rom,
  runtimeImageDigest:'sha256:'+'d'.repeat(64),androidSystemDigest:mapping.androidSystemDigest})}]).get(node.nodeId);
 assert.equal(installedPhoneRuntime(n,phone).imageDigest,updated,'existing per-phone repair remains pinned');
 assert.equal(installedPhoneRuntime(n,{...phone,id:id(90)}).imageDigest,'sha256:'+'d'.repeat(64));
 assert.throws(()=>{n.roms[0].runtimeImageDigest=old;});
});
