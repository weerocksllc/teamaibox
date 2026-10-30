import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneCapacityFromEnvironment,phoneMediaFromEnvironment,phoneCameraFromEnvironment,phoneFilesFromEnvironment,phoneRuntimeFromEnvironment,phoneAccessRevoker,applianceCameraAddress } from "../src/virtual-phones/phone-capacity-composition.mjs";

test("phone capacity stays unconfigured by default and accepts only fixed trusted node declarations", () => {
  assert.equal(phoneCapacityFromEnvironment({ environment: {} }), null);
  const database = { query() {}, transaction() {} }, nodeAgentRouter = { readPhoneBaseline() {} };
  const node = { nodeId: "00000000-0000-4000-8000-000000000101", nodeGeneration: 1,
    poolId: "phone-encrypted", imageDigest: `sha256:${"a".repeat(64)}`, maximumPhones: 2 };
  const configure = value => phoneCapacityFromEnvironment({ database, nodeAgentRouter, environment: { PLATFORM_APPLIANCE_NODE_ID: "00000000-0000-4000-8000-000000000101", PLATFORM_VIRTUAL_PHONE_NODES_JSON: JSON.stringify(value) } });
  assert.equal(typeof configure([node]).acquireRun, "function");
  for (const count of [3, 20, null]) assert.equal(typeof configure([{...node,maximumPhones:count}]).acquireRun,'function');
  for (const invalid of [null, {}, [null], [{ ...node, maximumPhones: -1 }], [{ ...node, imageDigest: "latest" }],
    [{ ...node, nodeGeneration: 0 }], [{ ...node, hostPath: "/" }], [node, node]]) assert.throws(() => configure(invalid));
  assert.throws(() => phoneCapacityFromEnvironment({ database, nodeAgentRouter, environment: { PLATFORM_APPLIANCE_NODE_ID: "00000000-0000-4000-8000-000000000101", PLATFORM_VIRTUAL_PHONE_NODES_JSON: "{" } }));
});

test("phone media composition is opt-in and shares only the approved managed nodes",async()=>{
  assert.equal(await phoneMediaFromEnvironment({environment:{}}),null);
  const node={nodeId:"00000000-0000-4000-8000-000000000101",nodeGeneration:1,poolId:"phone-encrypted",imageDigest:`sha256:${"a".repeat(64)}`,maximumPhones:2};
  const configuration={environment:{PLATFORM_APPLIANCE_NODE_ID: "00000000-0000-4000-8000-000000000101", PLATFORM_VIRTUAL_PHONE_NODES_JSON:JSON.stringify([node])},database:{query(){}},
    nodeAgentRouter:{executePhoneMedia(){},connectPhoneSignal(){},connectPhoneADB(){}}};
  const media=await phoneMediaFromEnvironment(configuration);
  assert.equal(media.peerBridge.maximumLeaseMilliseconds,5000);assert.equal(typeof media.signallingUpstream.connect,"function");
  await assert.rejects(phoneMediaFromEnvironment({...configuration,nodeAgentRouter:{}}));
  await assert.rejects(phoneMediaFromEnvironment({...configuration,environment:{PLATFORM_APPLIANCE_NODE_ID: "00000000-0000-4000-8000-000000000101", PLATFORM_VIRTUAL_PHONE_NODES_JSON:JSON.stringify([{...node,url:"https://arbitrary.invalid"}])}}));
});

test('camera composition leaves old schemas untouched unless explicitly enabled',()=>{
  const database={query(){throw Error('must not query old schema');},transaction(){throw Error('must not query old schema');}};
  assert.equal(phoneCameraFromEnvironment({environment:{},database}),null);
  assert.equal(phoneCameraFromEnvironment({environment:{PLATFORM_VIRTUAL_PHONE_CAMERA_ENABLED:'false'},database}),null);
  for(const value of ['yes',true,'1'])assert.throws(()=>phoneCameraFromEnvironment({environment:{PLATFORM_VIRTUAL_PHONE_CAMERA_ENABLED:value},database}));
  assert.throws(()=>phoneCameraFromEnvironment({environment:{PLATFORM_VIRTUAL_PHONE_CAMERA_ENABLED:'true'},database}));
  const node={nodeId:'00000000-0000-4000-8000-000000000101',nodeGeneration:1,poolId:'phone-encrypted',imageDigest:`sha256:${'a'.repeat(64)}`,maximumPhones:2};
  const camera=phoneCameraFromEnvironment({environment:{PLATFORM_VIRTUAL_PHONE_CAMERA_ENABLED:'true',PLATFORM_APPLIANCE_NODE_ID: "00000000-0000-4000-8000-000000000101", PLATFORM_VIRTUAL_PHONE_NODES_JSON:JSON.stringify([node])},database,
    directory:{authorization(){}},objectService:Object.fromEntries(['download','beginMultipart','uploadPart','completeMultipart','abortMultipart'].map(k=>[k,()=>{}])),
    nodeAgentRouter:{executePhoneCamera(){}}});
  assert.equal(typeof camera.start,'function');camera.stopReconciler();
});

test('phone stop/sign-out attempts both access and camera revocation and preserves failures',async()=>{
  const called=[],input={phoneId:'phone',runId:'run',ownerId:'owner',loginSessionId:'login'};
  const accessService={async revokePhoneAccess(value){assert.equal(value,input);called.push('access');return {accessRevoked:true};}};
  assert.equal(phoneAccessRevoker({accessService,cameraService:null}),accessService);
  const cameraService={async revokePhoneAccess(value){assert.equal(value,input);called.push('camera');throw Error('camera stop pending');}};
  await assert.rejects(phoneAccessRevoker({accessService,cameraService}).revokePhoneAccess(input),/stop pending/);
  assert.deepEqual(called.sort(),['access','camera']);
  assert.throws(()=>phoneAccessRevoker({cameraService}));
});

test('every phone entry point rejects a foreign or multi-box installation before runtime access', async () => {
  const local = '00000000-0000-4000-8000-000000000020';
  const foreign = '00000000-0000-4000-8000-000000000019';
  const node = { nodeId: local, nodeGeneration: 1, poolId: 'phone-data', imageDigest: `sha256:${'a'.repeat(64)}`, maximumPhones: null };
  for (const nodes of [[{ ...node, nodeId: foreign }], [node, { ...node, nodeId: foreign }]]) {
    const configuration = { environment: { PLATFORM_APPLIANCE_NODE_ID: local,
      PLATFORM_VIRTUAL_PHONE_NODES_JSON: JSON.stringify(nodes), PLATFORM_VIRTUAL_PHONE_CAMERA_ENABLED: 'true' } };
    for (const create of [phoneCapacityFromEnvironment, phoneFilesFromEnvironment, phoneRuntimeFromEnvironment, phoneCameraFromEnvironment]) {
      assert.throws(() => create(configuration), /exactly this appliance/);
    }
    await assert.rejects(phoneMediaFromEnvironment(configuration), /exactly this appliance/);
  }
});

test('network camera destination comes from this appliance installation, never onboarding history',()=>{
  assert.equal(applianceCameraAddress({PLATFORM_APPLIANCE_LAN_ADDRESS:'192.168.1.20'}),'192.168.1.20');
  assert.equal(applianceCameraAddress({PLATFORM_API_PUBLIC_ORIGIN:'https://10.0.0.20'}),'10.0.0.20');
  for(const address of ['127.0.0.1','8.8.8.8','::1','example.com',''])
    assert.throws(()=>applianceCameraAddress({PLATFORM_APPLIANCE_LAN_ADDRESS:address}));
});
