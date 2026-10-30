import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phoneSystemCatalog, phoneSystemReleases, phoneSystemReleasesFromEnvironment } from '../src/virtual-phones/phone-system-catalog.mjs';
import { LEGACY_PHONE_ROM, GOOGLE_PHONE_ROM } from '../../../services/scheduler/src/phone-rom.mjs';

const base={id:LEGACY_PHONE_ROM,familyId:'aosp',name:'Android AOSP',googlePlay:false,createEnabled:true,reasonCode:null,cameraCapability:'unavailable'};
const google={...base,id:GOOGLE_PHONE_ROM,familyId:'google-experimental',googlePlay:true,createEnabled:false};
const camera={...base,id:'aosp-camera-test-v3',cameraCapability:'verified',createEnabled:false};
test('product catalog has exactly two types, hides build history and never promotes a candidate',()=>{
  const roms=[base,camera,{...camera,id:'aosp-camera-test-v999',createEnabled:true},google];
  for(const rows of [roms,[...roms].reverse()]){
    const values=phoneSystemCatalog(rows);
    assert.equal(values.length,2);assert.deepEqual(values.map(x=>x.name),['标准 Android','Android + Google Play']);
    assert.deepEqual(values.map(x=>x.id),[LEGACY_PHONE_ROM,GOOGLE_PHONE_ROM]);
    assert.equal(values[0].createEnabled,true);assert.equal(values[1].createEnabled,false);
  }
});
test('explicit publication requires its own matching family, deployed release and camera',()=>{
  const gcam={...google,id:'google-camera-test-v1',cameraCapability:'verified',createEnabled:true};
  const releases=phoneSystemReleases({standard:camera.id,'google-play':gcam.id});
  const rows=[base,{...camera,createEnabled:true},gcam];
  assert.ok(phoneSystemCatalog(rows,releases).every(x=>x.createEnabled));
  for(const bad of [{...gcam,cameraCapability:'unavailable'},{...gcam,reasonCode:'phone_rom_not_installed'},
    {...gcam,createEnabled:false},{...gcam,familyId:'aosp'},{...gcam,googlePlay:false}]){
    assert.equal(phoneSystemCatalog([rows[0],rows[1],bad],releases)[1].createEnabled,false);
  }
  assert.ok(phoneSystemCatalog([],releases).every(x=>!x.createEnabled));
  assert.equal(phoneSystemCatalog([...rows,gcam],releases)[1].createEnabled,false);
  assert.equal(base.cameraCapability,'unavailable'); // no mutation of old phones/ROMs
});
test('release configuration is deployment-only, typed and bounded',()=>{
  assert.equal(phoneSystemReleasesFromEnvironment({}),undefined);
  assert.equal(phoneSystemReleases(undefined),null);
  for(const value of [null,[],{}, {standard:LEGACY_PHONE_ROM}, {standard:LEGACY_PHONE_ROM,'google-play':LEGACY_PHONE_ROM},
    {standard:'http://image','google-play':GOOGLE_PHONE_ROM}, {standard:LEGACY_PHONE_ROM,'google-play':GOOGLE_PHONE_ROM,extra:true}]){
    assert.throws(()=>phoneSystemReleases(value));
  }
  assert.throws(()=>phoneSystemReleasesFromEnvironment({PLATFORM_VIRTUAL_PHONE_SYSTEM_RELEASES_JSON:'{'}));
});
