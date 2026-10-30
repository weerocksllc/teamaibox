import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applianceConfiguration, applianceRuntimeConfigured, signGatewayNodeIdentity,
  SignedGatewayNodeTransportIdentityResolver } from '../server/appliance-runtime.mjs';
import { startApplianceApiProcess } from '../server/appliance-main.mjs';
import { ApplianceAgentHttpApi } from '../src/appliance/appliance-agent-http-api.mjs';

const LOCAL = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const identity = {mutualTls:true,certificateVerified:true,subjectNodeId:LOCAL,certificateFingerprint:'sha256:'+'a'.repeat(64)};

test('installed executor is composed before phone storage without an injected test router', async () => {
  const source = await readFile(new URL('../server/platform-api.mjs', import.meta.url), 'utf8');
  const executor = source.indexOf('ownedManagedNodeRuntime = await createApplianceRuntimeFromEnvironment(');
  const storage = source.indexOf('const storageAdministrationService =');
  assert.ok(executor >= 0 && storage > executor, 'phone storage must be initialized after the installed executor');
});

test("appliance startup requires an installed identity and accepts only loopback execution", async () => {
  assert.equal(applianceRuntimeConfigured({}),false);
  await assert.rejects(startApplianceApiProcess({}),/PLATFORM_APPLIANCE_NODE_ID/);
  assert.deepEqual(applianceConfiguration({PLATFORM_APPLIANCE_NODE_ID:LOCAL}),{nodeId:LOCAL,host:'127.0.0.1',port:9443});
  for (const host of ['10.64.0.19','10.64.0.23','worker.example','0.0.0.0']) {
    assert.throws(()=>applianceConfiguration({PLATFORM_APPLIANCE_NODE_ID:LOCAL,PLATFORM_APPLIANCE_AGENT_HOST:host}),/loopback/);
  }
});

function apiFixture() {
  const calls=[];
  const api=new ApplianceAgentHttpApi({localNodeId:LOCAL,
    service:{async heartbeat(input){calls.push(['heartbeat',input]);return {generation:input.generation};}},
    metricService:{async ingest(input){calls.push(['metrics',input]);return {accepted:true};}}});
  return {api,calls};
}
test("only the installed local identity can report appliance health", async () => {
  const {api,calls}=apiFixture();
  for(const transportIdentity of [undefined,{...identity,subjectNodeId:OTHER},{...identity,certificateVerified:false}]) {
    await assert.rejects(api.handle({method:'POST',pathname:'/api/v1/appliance/heartbeat',body:{generation:7,inventory:{}},transportIdentity}),{code:'appliance_identity_mismatch'});
  }
  await assert.rejects(api.handle({method:'POST',pathname:'/api/v1/appliance/heartbeat',body:{nodeId:OTHER},transportIdentity:identity}),{code:'appliance_identity_mismatch'});
  assert.equal(calls.length,0);
  const response=await api.handle({method:'POST',pathname:'/api/v1/appliance/heartbeat',body:{generation:7,inventory:{health:{state:'healthy'}}},transportIdentity:identity});
  assert.equal(response.status,200); assert.equal(calls[0][1].nodeId,LOCAL); assert.equal(calls[0][1].generation,7);
  await api.handle({method:'POST',pathname:'/api/v1/appliance/metrics',body:{generation:7,snapshot:{sequence:9}},transportIdentity:identity});
  assert.equal(calls[1][1].nodeGeneration,7); assert.deepEqual(calls[1][1].snapshot,{sequence:9});
  for(const path of ['/api/v1/node-enrollments','/api/v1/admin/node-onboarding','/api/v1/admin/node-groups','/api/v1/node-federation/nodes/'+OTHER+'/heartbeat']) {
    assert.equal(api.matches('POST',path),false);
  }
});

test("forged local gateway identity is rejected and valid reports cannot be replayed", () => {
  const key=randomBytes(32),clock=()=>new Date('2026-10-16T08:00:00.000Z');
  const verifier=new SignedGatewayNodeTransportIdentityResolver({key,clock});
  const facts={key,method:'POST',pathname:'/api/v1/appliance/heartbeat',timestamp:clock().toISOString(),nonce:randomBytes(24).toString('base64url'),subjectNodeId:LOCAL,certificateFingerprint:identity.certificateFingerprint};
  const request={method:'POST',url:facts.pathname,headers:{
    'x-teamaibox-node-timestamp':facts.timestamp,'x-teamaibox-node-nonce':facts.nonce,'x-teamaibox-node-id':LOCAL,
    'x-teamaibox-node-certificate-fingerprint':facts.certificateFingerprint,'x-teamaibox-node-signature':signGatewayNodeIdentity(facts)}};
  assert.throws(()=>verifier.resolve({...request,url:'/api/v1/appliance/metrics'}),{code:'managed_node_mtls_required'});
  assert.deepEqual(verifier.resolve(request),identity);
  assert.throws(()=>verifier.resolve(request),{code:'managed_node_mtls_required'});
  verifier.close();key.fill(0);
});
