import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {computerConfiguration,computersFromEnvironment} from '../src/virtual-computers/computer-composition.mjs';

const GiB=1024**3;
const configuration=()=>({version:1,enabled:false,policy:{},installedNodes:[{nodeId:randomUUID(),poolId:'installed-encrypted-pool',profileIds:['windows11'],
  policy:{qemuOverheadBytes:GiB,gatewayOverheadBytes:256*1024**2,hostReserveBytes:16*GiB,storageReserveBytes:8*GiB,
    storageOverheadBytes:2*GiB,cpuReserve:2,maximumSampleAgeMs:10000}}]});
const environment=c=>({PLATFORM_APPLIANCE_NODE_ID:c.installedNodes[0].nodeId,PLATFORM_VIRTUAL_COMPUTERS_CONFIG_JSON:JSON.stringify(c)});
function dependencies(c=configuration()) {
  const calls=[];
  const database={async query(sql){calls.push(sql);return {rows:[]};},async transaction(fn){return fn(database);}};
  const nodeAgentRouter=Object.fromEntries(['readComputerBaseline','readPhoneBaseline','executeComputerCommand'].map(k=>[k,()=>assert.fail('unexpected node side effect')]));
  return {environment:environment(c),database,nodeAgentRouter,calls,directory:{authorization:async()=>({permissions:['computer:use']})}};
}
test('ordinary API upgrade without computer configuration has no DB, node or guest effects',()=>{
  assert.equal(computersFromEnvironment({environment:{}}),null);
  assert.equal(computerConfiguration({}),null);
});
test('invalid installed configurations are rejected before any background work',()=>{
  for(const change of [c=>c.enabled='true',c=>c.policy.storedPerUser=-1,c=>c.policy.maximum={diskGiB:0},
    c=>c.policy.guestPassword='not-allowed',c=>c.installedNodes.push(c.installedNodes[0]),
    c=>c.installedNodes[0].policy.storageOverheadBytes=0,c=>c.installedNodes[0].policy.maximumSampleAgeMs=0,
    c=>c.installedNodes[0].profileIds.push('windows11'),c=>c.installedNodes[0].nodeId='connection-1',
    c=>c.installedNodes[0].policy.unknownSetting=1,c=>c.installedNodes[0].host='browser-selected']){
    const c=configuration();change(c);assert.throws(()=>computerConfiguration(environment(c)),TypeError);
  }
});
test('legacy reserve fields cannot reactivate pooled resource booking',()=>{
  const c=configuration(),policy=computerConfiguration(environment(c)).installedNodes[0].policy;
  assert.equal('cpuReserve' in policy,false);assert.equal('hostReserveBytes' in policy,false);
  assert.equal(policy.storageReserveBytes,0);
});
test('configured service has no invented user limits, disabled creation and no implicit worker start',async()=>{
  const d=dependencies(),runtime=computersFromEnvironment(d);
  assert.equal(d.calls.length,0);
  const result=await runtime.service.availability({context:{identityId:randomUUID()}});
  assert.equal(result.enabled,false);assert.deepEqual(result.limits,{maximum:{},storedPerUser:null,runningPerUser:null});
  assert.equal(d.calls.length,3);assert.match(d.calls[0],/computer_feature_policy/);assert.match(d.calls[1],/computer_quotas/);assert.match(d.calls[2],/computer_profiles/);
  assert.equal(runtime.api.matches('GET','/api/v1/virtual-computers'),true);
  assert.equal(runtime.desktop,null);
  await runtime.close();assert.equal(d.calls.length,3);
});
test('runtime maintenance requires exact installed image pairs, never guest overrides',()=>{
  const c=configuration();c.policy.runtimeUpdates={windows11:{from:'sha256:'+'a'.repeat(64),to:'sha256:'+'b'.repeat(64)}};
  assert.deepEqual(computerConfiguration(environment(c)).policy.runtimeUpdates,c.policy.runtimeUpdates);
  c.policy.runtimeUpdates={windows11:{from:['sha256:'+'a'.repeat(64),'sha256:'+'c'.repeat(64)],to:'sha256:'+'b'.repeat(64)}};
  assert.deepEqual(computerConfiguration(environment(c)).policy.runtimeUpdates,c.policy.runtimeUpdates);
  for(const value of [null,[],{windows11:{from:'latest',to:'sha256:'+'b'.repeat(64)}},
    {windows11:{from:[],to:'sha256:'+'b'.repeat(64)}},{windows11:{from:['sha256:'+'a'.repeat(64),'latest'],to:'sha256:'+'b'.repeat(64)}},
    {windows11:{from:['sha256:'+'a'.repeat(64),'sha256:'+'a'.repeat(64)],to:'sha256:'+'b'.repeat(64)}},
    {windows11:{from:['sha256:'+'b'.repeat(64)],to:'sha256:'+'b'.repeat(64)}},
    {windows11:{from:'sha256:'+'a'.repeat(64),to:'sha256:'+'b'.repeat(64),mediaDigest:'override'}}]) {
    c.policy.runtimeUpdates=value;assert.throws(()=>computerConfiguration(environment(c)),TypeError);
  }
});
test('creation cannot be enabled with only a lifecycle runner and no desktop transport',()=>{
  const c=configuration();c.enabled=true;
  assert.throws(()=>computersFromEnvironment(dependencies(c)),/desktop transport/);
});
test('enabled composition uses installed desktop, and closing API does not stop computers',async()=>{
  const c=configuration();c.enabled=true;c.policy.storedPerUser=5;
  const d=dependencies(c),runtime=computersFromEnvironment({...d,desktopProvider:{connect:()=>assert.fail('no desktop requested')}});
  const result=await runtime.service.availability({context:{identityId:randomUUID()}});
  assert.equal(result.enabled,true);assert.equal(result.limits.storedPerUser,5);
  assert.equal(runtime.desktop.matches('POST',`/api/v1/virtual-computers/${randomUUID()}/desktop-sessions`),true);
  await runtime.close();assert.equal(d.calls.length,3);
});
