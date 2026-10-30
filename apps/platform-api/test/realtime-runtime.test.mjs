import assert from "node:assert/strict";
import test from "node:test";

import { PostgresRealtimePlacementResolver } from "../server/realtime-runtime.mjs";

const base = {
  capability: "asr",
  model: "local/realtime-asr",
  nodeKey: "spark-local",
  modelProfileKey: "asr.realtime.certified.v1",
  route: "local",
  resources: {
    cpuMillis: 2_000,
    unifiedMemoryBytes: 4_294_967_296,
    acceleratorUnits: 1,
    codecSessions: 0,
    storageBytes: 0,
    networkBitsPerSecond: 100_000_000,
  },
  codecDirections: { encodeSessions: 0, decodeSessions: 0 },
  latencyBudgetMilliseconds: 250,
  observedLatencyMilliseconds: 12,
  warm: true,
};

function resolver(row, placements = [base]) {
  const calls = [];
  return {
    calls,
    value: new PostgresRealtimePlacementResolver({
      localNodeId: "11111111-1111-4111-8111-111111111111",
      placements,
      database: { async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: row ? [row] : [] }; } },
    }),
  };
}

test("resolves a ready node only when the speech profile is certified", async () => {
  const setup = resolver({
    node_id: "11111111-1111-4111-8111-111111111111",
    generation: "7",
    lifecycle_state: "ready",
    profile_id: "22222222-2222-4222-8222-222222222222",
    certification_state: "certified",
  });
  const values = await setup.value.resolve({ capability: "asr", model: "local/realtime-asr" });
  assert.equal(values.length, 1);
  assert.equal(values[0].nodeGeneration, 7);
  assert.equal(values[0].modelProfileId, "22222222-2222-4222-8222-222222222222");
  assert.equal(values[0].resources.unifiedMemoryBytes, 4_294_967_296);
  assert.deepEqual(setup.calls[0].parameters, ["spark-local", "asr.realtime.certified.v1", "11111111-1111-4111-8111-111111111111"]);
  assert.match(setup.calls[0].sql, /node.id=\$3::uuid/);
});

test("filters an experimental profile and mismatched model without reserving capacity", async () => {
  const setup = resolver({
    node_id: "11111111-1111-4111-8111-111111111111",
    generation: 7,
    lifecycle_state: "ready",
    profile_id: "22222222-2222-4222-8222-222222222222",
    certification_state: "experimental",
  });
  assert.deepEqual(await setup.value.resolve({ capability: "asr", model: "local/realtime-asr" }), []);
  assert.deepEqual(await setup.value.resolve({ capability: "asr", model: "other/model" }), []);
  assert.equal(setup.calls.length, 1);
});

test("rejects speech placement policies without a model and profile", () => {
  assert.throws(() => resolver(null, [{ ...base, model: null, modelProfileKey: null }]), /certified profile/);
});

test("allows a profile-free WebRTC gateway reservation on a ready node", async () => {
  const setup = resolver({
    node_id: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    lifecycle_state: "ready",
    profile_id: null,
    certification_state: null,
  }, [{ ...base, capability: "webrtc-gateway", model: null, modelProfileKey: null, route: "local" }]);
  const values = await setup.value.resolve({ capability: "webrtc-gateway", model: null });
  assert.equal(values.length, 1);
  assert.equal(values[0].modelProfileId, null);
  assert.equal(values[0].route, "local");
});

test("rejects remote routes and never accepts another appliance returned by persistence", async () => {
  assert.throws(() => resolver(null, [{ ...base, route: 'managed_node' }]), /placement is invalid/);
  const setup = resolver({ node_id: '33333333-3333-4333-8333-333333333333', generation: 1,
    lifecycle_state: 'ready', profile_id: '22222222-2222-4222-8222-222222222222', certification_state: 'certified' });
  assert.deepEqual(await setup.value.resolve({ capability: 'asr', model: 'local/realtime-asr' }), []);
});

test('factory resident ASR uses local committed readiness without claiming certification or measured latency', async () => {
  let ready = false;
  const value = new PostgresRealtimePlacementResolver({
    localNodeId:'11111111-1111-4111-8111-111111111111',
    placements:[{...base, observedLatencyMilliseconds:null, warm:false,
      protectedResident:{setId:'factory-office-test', workerId:'33333333-3333-4333-8333-333333333333', maintenanceGeneration:1}}],
    database:{async query(sql, params) {
      if (sql.includes('protected_office_sets')) {
        assert.match(sql,/p.observed_state_revision=p.desired_state_revision/);
        assert.match(sql,/jsonb_array_elements/);
        assert.equal(params[3],'33333333-3333-4333-8333-333333333333');
        return {rows:ready?[{'?column?':1}]:[]};
      }
      return {rows:[{node_id:'11111111-1111-4111-8111-111111111111', generation:1,
        lifecycle_state:'ready', profile_id:'22222222-2222-4222-8222-222222222222', certification_state:'validating'}]};
    }},
  });
  assert.deepEqual(await value.resolve({capability:'asr',model:'local/realtime-asr'}),[]);
  ready=true;
  const [resolved] = await value.resolve({capability:'asr',model:'local/realtime-asr'});
  assert.equal(resolved.observedLatencyMilliseconds,null);
  assert.equal(resolved.warm,true);
});
