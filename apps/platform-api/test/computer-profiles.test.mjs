import test from 'node:test';
import assert from 'node:assert/strict';
import {profileImport,profilePublication,profileRevision} from '../src/virtual-computers/computer-profiles.mjs';
import {PostgresComputerCapacity} from '../../../services/scheduler/src/postgres-computer-capacity.mjs';
const profile=()=>({id:'windows11',name:'Windows 11',version:'25H2',edition:'Pro',runtimeImage:'sha256:'+'a'.repeat(64),
  firmwareDigest:'sha256:'+'b'.repeat(64),mediaDigest:'sha256:'+'c'.repeat(64),driverDigest:'sha256:'+'d'.repeat(64),
  minimum:{vcpus:2,memoryGiB:4,diskGiB:64},tpm:true,secureBoot:true,remoteDesktop:true,
  rights:{activationRequired:true,redistributionAllowed:false,remoteUseLicenseRequired:true,environment:'development'}});
test('system import requires fixed identities and explicit rights facts, not arbitrary host instructions',()=>{
  const p=profile();assert.deepEqual(profileImport({profile:p}),p);
  for(const bad of [{...p,id:'../windows'},{...p,name:42},{...p,rights:{}},{...p,rights:{...p.rights,licenseKey:'secret'}},
    {...p,command:'docker run'},{...p,mediaDigest:'latest'}])assert.throws(()=>profileImport({profile:bad}));
  assert.throws(()=>profileImport({profile:p,enabled:true}));
});
test('profile revision is stable across JSON key order but changes when publication changes',()=>{
  const p=profile(),row={profile:p,create_enabled:false};
  assert.equal(profileRevision(row),profileRevision({...row,profile:Object.fromEntries(Object.entries(p).reverse())}));
  assert.notEqual(profileRevision(row),profileRevision({...row,create_enabled:true}));
  assert.deepEqual(profilePublication({enabled:true,expectedRevision:profileRevision(row)}),{enabled:true,expectedRevision:profileRevision(row)});
  assert.throws(()=>profilePublication({enabled:true,expectedRevision:'old'}));
});
test('publication requires a connected node with exact installed media/runtime, not just a known profile ID',async()=>{
  const p=profile(),now=Date.now(),node={id:'node',generation:1,lifecycle_state:'ready',recovery_state:'healthy',trust_kind:'managed_appliance',appliance_role:'appliance-core',architecture:'arm64'};
  const baseline={nodeId:'node',nodeGeneration:1,poolId:'pool',encryption:'luks2',sampledAt:now,freeStorageBytes:100,volumes:[],
    storageOverheadBytes:1,storageReserveBytes:1,installedProfiles:[p]};
  const db={query:async()=>({rows:[node]}),transaction:async cb=>cb(db)};
  const cap=new PostgresComputerCapacity({ localNodeId: 'node',database:db,clock:()=>now,installedNodes:[{nodeId:'node',poolId:'pool',profileIds:[p.id],policy:{maximumSampleAgeMs:5000,storageOverheadBytes:1,storageReserveBytes:1}}],baselineProvider:{read:async()=>baseline}});
  await cap.checkProfile(p);
  for(const key of ['runtimeImage','firmwareDigest','mediaDigest','driverDigest','tpm']){
    await assert.rejects(cap.checkProfile({...p,[key]:key==='tpm'?false:'sha256:'+'e'.repeat(64)}),{code:'computer_profile_not_installed'});
  }
  await cap.checkProfile({...p,runtimeImage:'sha256:'+'e'.repeat(64)},{runtimeUpdates:{windows11:{from:'sha256:'+'e'.repeat(64),to:p.runtimeImage}}});
  await cap.checkProfile({...p,runtimeImage:'sha256:'+'e'.repeat(64)},{runtimeUpdates:{windows11:{from:['sha256:'+'e'.repeat(64),'sha256:'+'f'.repeat(64)],to:p.runtimeImage}}});
  baseline.installedProfiles=[];await assert.rejects(cap.checkProfile(p),{code:'computer_profile_not_installed'});
  baseline.installedProfiles=[p];node.lifecycle_state='offline';await assert.rejects(cap.checkProfile(p),{code:'computer_profile_not_installed'});
});
