import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplianceProtectedOfficeRuntime } from '../server/appliance-protected-office-runtime.mjs';
import { startApplianceApiProcess } from '../server/appliance-main.mjs';

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = char => 'sha256:' + char.repeat(64);
function fixture() {
  const environment = { PLATFORM_APPLIANCE_NODE_ID: uuid(1), PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: uuid(1),
    PLATFORM_PROTECTED_OFFICE_SET_ID: 'office.baseline', PLATFORM_APPLIANCE_PROTECTED_TARGET_POLICY_DIGEST: digest('a') };
  const profiles = ['LOCAL_OPENAI', 'DRAWING', 'OCR', 'ASR', 'TRANSLATION', 'EMBEDDING'].map((prefix, index) => {
    environment[prefix + '_WORKER_ID'] = uuid(index + 10);
    environment[prefix + '_PROFILE_ID'] = uuid(index + 20);
    return { workerId: uuid(index + 10), modelProfileId: uuid(index + 20), imageDigest: digest('b'),
      configurationDigest: digest('c'), placementClass: 'protected-resident', maintenanceGeneration: 2 };
  });
  const node = { nodeId: uuid(1), generation: 7, lifecycleState: 'ready' };
  const snapshot = { nodeId: uuid(1), nodeGeneration: 7, healthy: true, protectedTargetPolicyDigest: digest('a'),
    runtimeIdentities: profiles.map(p => ({ workerId: p.workerId, modelProfileId: p.modelProfileId,
      image: 'registry.local/office@' + p.imageDigest, configDigest: p.configurationDigest,
      placementClass: p.placementClass, maintenanceGeneration: p.maintenanceGeneration,
      containerId: 'd'.repeat(64), startedAt: '2026-10-16T00:00:00.000Z', status: 'running', health: 'healthy', identityExact: true })) };
  const calls = [];
  const dependencies = { nodeRepository: { async findNode(id) { assert.equal(id, uuid(1)); return node; } },
    nodeAgentRouter: { async inspectAppliance(request) { calls.push(request); return structuredClone(snapshot); } } };
  return { environment, profiles, node, snapshot, calls, dependencies,
    runtime: createApplianceProtectedOfficeRuntime(environment, dependencies) };
}

test('offline image content ID remains bound to the installed office profile', async () => {
  const { runtime, profiles, snapshot } = fixture();
  snapshot.runtimeIdentities[0].image = profiles[0].imageDigest;
  assert.equal((await runtime.inspectProtectedProfile({ profile: profiles[0] })).healthy, true);
  snapshot.runtimeIdentities[0].image = digest('f');
  await assert.rejects(runtime.inspectProtectedProfile({ profile: profiles[0] }), /differs/);
});

test('six office identities share one authenticated local inspection without acceptance plans or leases', async () => {
  const { runtime, profiles, calls } = fixture();
  const result = await Promise.all(profiles.map(profile => runtime.inspectProtectedProfile({ profile })));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { nodeId: uuid(1), nodeGeneration: 7, correlationId: `protected-office-inspect:${uuid(1)}` });
  assert.equal(result.length, 6);
  for (let i = 0; i < profiles.length; i++) {
    assert.deepEqual(result[i], { ...profiles[i], containerId: 'd'.repeat(64),
      startedAt: '2026-10-16T00:00:00.000Z', state: 'running', healthy: true, startupState: 'ready' });
  }
});

test('unhealthy installed workers are reported honestly; identity, policy and generation drift fail closed', async () => {
  const unhealthy = fixture();
  unhealthy.snapshot.runtimeIdentities[0].health = 'unhealthy';
  assert.equal((await unhealthy.runtime.inspectProtectedProfile({ profile: unhealthy.profiles[0] })).healthy, false);
  for (const change of [
    x => { x.snapshot.nodeId = uuid(99); }, x => { x.snapshot.nodeGeneration++; },
    x => { x.snapshot.healthy = false; },
    x => { x.snapshot.protectedTargetPolicyDigest = digest('f'); },
    x => { x.snapshot.runtimeIdentities.pop(); },
    x => { x.snapshot.runtimeIdentities[1] = x.snapshot.runtimeIdentities[0]; },
    x => { x.snapshot.runtimeIdentities[0].identityExact = false; },
    x => { x.snapshot.runtimeIdentities[0].modelProfileId = uuid(99); },
    x => { x.snapshot.runtimeIdentities[0].image = 'registry.local/other@' + digest('f'); },
    x => { x.snapshot.runtimeIdentities[0].configDigest = digest('f'); },
    x => { x.snapshot.runtimeIdentities[0].maintenanceGeneration++; },
    x => { x.snapshot.runtimeIdentities[0].containerId = 'not-a-container'; },
    x => { x.node.lifecycleState = 'draining'; },
  ]) {
    const x = fixture(); change(x);
    await assert.rejects(x.runtime.inspectProtectedProfile({ profile: x.profiles[0] }));
  }
  const x = fixture();
  await assert.rejects(x.runtime.inspectProtectedProfile({ profile: { ...x.profiles[0], workerId: uuid(99) } }));
  assert.equal(x.calls.length, 0);
  x.environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID = uuid(99);
  assert.throws(() => createApplianceProtectedOfficeRuntime(x.environment, x.dependencies), /exact appliance/);
});

test('normal appliance startup accepts protected set and maintenance settings without any v5 bundle', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'teamaibox-single-office-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'audit-key');
  await writeFile(keyFile, Buffer.alloc(32, 1).toString('base64url'), { mode: 0o600 });
  let observed;
  const server = new EventEmitter(); server.close = () => server.emit('close');
  await startApplianceApiProcess({ PLATFORM_API_PERSISTENCE: 'postgres', PLATFORM_APPLIANCE_NODE_ID: uuid(1),
    PLATFORM_AUDIT_SIGNING_KEY_FILE: keyFile, PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: uuid(1),
    PLATFORM_PROTECTED_OFFICE_SET_ID: 'office.baseline',
    PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST: digest('a'),
    PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: '/installed/maintenance-runtime.json' }, {
    databaseFactory: async () => ({ async ready() {}, async close() {} }),
    async start(_environment, dependencies) { observed = dependencies; return server; },
  });
  assert.equal(observed.protectedOfficeSetRuntimeFactory, undefined);
  assert.equal(observed.protectedOfficeSetProductionBoundaryFactory, undefined);
  assert.equal(typeof observed.maintenanceRuntimeFactory, 'function');
  server.close();
});

test('fresh boot progress distinguishes queued and retrying from failed and ignores stale progress', async () => {
  const f = fixture();
  const now = Date.parse('2026-10-23T00:00:00Z');
  const boot = { schemaVersion: 1, nodeId: f.node.nodeId, updatedAt: new Date(now).toISOString(),
    status: 'recovering', workers: { [f.profiles[0].workerId]: { phase: 'queued' } } };
  const runtime = createApplianceProtectedOfficeRuntime(f.environment, { ...f.dependencies,
    readBootStatus: async () => boot, clock: () => now });
  f.snapshot.runtimeIdentities[0].status = 'exited';
  f.snapshot.runtimeIdentities[0].health = 'unhealthy';
  assert.equal((await runtime.inspectProtectedProfile({ profile: f.profiles[0] })).startupState, 'loading');
  boot.workers[f.profiles[0].workerId].phase = 'retrying';
  assert.equal((await runtime.inspectProtectedProfile({ profile: f.profiles[0] })).startupState, 'retrying');
  boot.updatedAt = new Date(now - 180001).toISOString();
  assert.equal((await runtime.inspectProtectedProfile({ profile: f.profiles[0] })).startupState, 'failed');
  assert.equal((await runtime.inspectProtectedProfile({ profile: f.profiles[1] })).startupState, 'ready');
});

test('appliance entry point rejects historical acceptance activation even when injected by runtime envfile', async () => {
  for (const key of ['PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID', 'PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT',
    'PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE', 'PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID',
    'PLATFORM_PROTECTED_OFFICE_SET_PRODUCTION_BOUNDARY_CONFIG_FILE']) {
    await assert.rejects(startApplianceApiProcess({ PLATFORM_API_PERSISTENCE: 'postgres',
      PLATFORM_APPLIANCE_NODE_ID: uuid(1), [key]: '/historical/value' }), /Historical protected-office acceptance configuration/);
  }
  await assert.rejects(startApplianceApiProcess({ PLATFORM_API_PERSISTENCE: 'postgres',
    PLATFORM_APPLIANCE_NODE_ID: uuid(1), PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: uuid(99) }), /this appliance/);
});

test('boot presentation survives an unreachable Agent and never reports ready without health inspection', async () => {
  const f = fixture(); const now = Date.now();
  const boot = { schemaVersion: 1, nodeId: f.node.nodeId, updatedAt: new Date(now).toISOString(), status: 'recovering',
    workers: { [f.profiles[0].workerId]: { phase: 'retrying' }, [f.profiles[1].workerId]: { phase: 'loading' },
      [f.profiles[2].workerId]: { phase: 'ready' } } };
  f.node.lifecycleState = 'offline';
  const runtime = createApplianceProtectedOfficeRuntime(f.environment, { ...f.dependencies,
    readBootStatus: async () => boot, clock: () => now });
  const states = await runtime.inspectStartupStates();
  assert.equal(states.get(f.profiles[0].workerId), 'retrying');
  assert.equal(states.get(f.profiles[1].workerId), 'loading');
  assert.equal(states.get(f.profiles[2].workerId), 'unavailable');
  assert.equal(f.calls.length, 0);
  await assert.rejects(runtime.inspectProtectedProfile({ profile: f.profiles[0] }));
  boot.updatedAt = new Date(now - 180001).toISOString();
  assert.ok([...(await runtime.inspectStartupStates()).values()].every(s => s === 'unavailable'));
  boot.updatedAt = new Date(now).toISOString(); boot.nodeId = uuid(999);
  assert.ok([...(await runtime.inspectStartupStates()).values()].every(s => s === 'unavailable'));
});
