import assert from "node:assert/strict";
import test from "node:test";

import { ManagedNodeService } from "../src/managed-node-service.mjs";
import { MemoryManagedNodeRepository } from "../src/memory-managed-node-repository.mjs";

const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b", NODE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const CERT = `sha256:${"c".repeat(64)}`, admin = { identityId: ADMIN, principalKind: "administrator", permissions: ["node:manage"] };

function inventory(overrides = {}) { return { schemaVersion: 1, architecture: "arm64", agentVersion: "1.2.3", health: { state: "healthy", errorCode: null },
  runtimes: [{ runtimeKey: "vllm", version: "0.10.1", imageDigest: `sha256:${"1".repeat(64)}` }],
  modelProfiles: [{ profileId: "018f6f18-24d7-7c21-9b62-8c0174199510", profileKey: "llm.qwen.nvfp4", profileFingerprint: `sha256:${"2".repeat(64)}`, lifecycleState: "certified", operations: ["chat"] }],
  capabilities: [{ capabilityKey: "llm.chat", state: "available", evidenceDigest: `sha256:${"3".repeat(64)}` }],
  resources: { cpu: { totalMillis: 20_000, availableMillis: 18_000 }, unifiedMemory: { totalBytes: 128_000_000_000, availableBytes: 90_000_000_000 }, accelerator: { units: 1 }, codecs: { sessions: 8 }, storage: { availableBytes: 1_000_000_000_000 }, network: { availableBitsPerSecond: 10_000_000_000 } },
  schedulerFacts: { accelerator: { kind: "nvidia-blackwell", computeCapability: "12.1", supportedPrecisions: ["bf16", "nvfp4"], evidenceDigest: `sha256:${"4".repeat(64)}` }, codec: { encodeSessions: 4, decodeSessions: 4, evidenceDigest: `sha256:${"5".repeat(64)}` }, storage: { classes: ["encrypted_nvme"], evidenceDigest: `sha256:${"6".repeat(64)}` }, workerState: "cold", modelArtifactCached: true, inputArtifactIds: [] },
  networkLinks: [{ linkKey: "lan0", networkClass: "10gbe", health: "healthy", speedBitsPerSecond: 10_000_000_000, mtu: 9000, latencyMicroseconds: 80 }], reservations: { cpuMillis: 0, unifiedMemoryBytes: 0, acceleratorUnits: 0, codecSessions: 0, storageBytes: 0, networkBitsPerSecond: 0 }, activeWorkloads: 0, ...overrides }; }

function fixture({ now = new Date("2026-08-11T08:00:00Z"), activeLeases = 0, healthSink = null, onHealthSinkError = async () => {}, repository = new MemoryManagedNodeRepository() } = {}) {
  const audits = [], revoked = [];
  const service = new ManagedNodeService({ repository, localNodeId: NODE, clock: () => new Date(now), staleAfterMilliseconds: 45_000,
    audit: async event => audits.push(event), healthSink, onHealthSinkError });
  return { service, repository, audits, revoked, setNow(value) { now = value; } };
}

async function install(f) {
  const now=new Date("2026-08-11T08:00:00Z");
  await f.repository.createNode({nodeId:NODE,nodeKey:"appliance",architecture:"arm64",trustKind:"managed_appliance",lifecycleState:"joining",
    generation:1,agentVersion:"1.2.3",labels:{},health:{state:"unknown"},inventory:null,lastSeenAt:null,
    certificateFingerprint:CERT,certificateNotAfter:new Date("2027-08-11T00:00:00Z"),revision:1,createdAt:now,updatedAt:now});
}

function transport() { return { mutualTls: true, certificateVerified: true, subjectNodeId: NODE, certificateFingerprint: CERT }; }

test("whole-appliance restart waits for a fresh heartbeat without advancing the saved generation", async () => {
  const old = fixture(); await install(old);
  await old.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  const boot = fixture({ repository: old.repository, now: new Date("2026-08-11T09:00:00Z") });
  await boot.service.beginObservationWindow();
  let node = await boot.repository.findNode(NODE);
  assert.equal(node.lifecycleState, "joining"); assert.equal(node.health.state, "unknown");
  assert.equal(node.generation, 1); assert.equal(node.lastSeenAt.toISOString(), "2026-08-11T08:00:00.000Z");
  // Even lengthy API initialization is not counted as missing node heartbeats.
  boot.setNow(new Date("2026-08-11T09:02:00Z"));
  assert.deepEqual((await boot.service.reconcileStale()).fenced, []);
  boot.setNow(new Date("2026-08-11T09:02:15Z"));
  await boot.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  await boot.service.beginObservationWindow(); // Idempotent; cannot extend the window.
  assert.deepEqual((await boot.service.reconcileStale({ now: new Date("2026-08-11T09:02:46Z") })).fenced, []);
  node = await boot.repository.findNode(NODE);
  assert.equal(node.lifecycleState, "ready"); assert.equal(node.generation, 1);
  const expired = await boot.service.reconcileStale({ now: new Date("2026-08-11T09:03:01Z") });
  assert.equal(expired.fenced[0].generation, 2);
  await assert.rejects(boot.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() }), { code: "stale_node_generation" });
});

test("startup window is bounded and never unfences or re-enables an administratively disabled node", async () => {
  for (const state of ["ready", "draining", "offline", "disabled", "removed"]) {
    const old = fixture(); await install(old);
    const original = await old.repository.findNode(NODE);
    await old.repository.updateNode(NODE, original.revision, { lifecycleState: state });
    const boot = fixture({ repository: old.repository, now: new Date("2026-08-11T09:00:00Z") });
    await boot.service.beginObservationWindow();
    await boot.service.reconcileStale();
    assert.equal((await boot.repository.findNode(NODE)).lifecycleState, state === "ready" ? "joining" : state);
    assert.deepEqual((await boot.service.reconcileStale({ now: new Date("2026-08-11T09:00:44.999Z") })).fenced, []);
    const result = await boot.service.reconcileStale({ now: new Date("2026-08-11T09:00:45Z") });
    assert.equal(result.fenced.length, ["ready", "draining"].includes(state) ? 1 : 0);
    assert.equal((await boot.repository.findNode(NODE)).generation, result.fenced.length ? 2 : 1);
  }
});

test("startup quarantine does not overwrite a concurrently refreshed heartbeat and fails closed on database error", async () => {
  const old = fixture(); await install(old);
  const now = new Date("2026-08-11T09:00:00Z"); old.setNow(now);
  await old.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  await old.repository.awaitFreshHeartbeats({ now });
  assert.equal((await old.repository.findNode(NODE)).lifecycleState, "ready");
  const boot = fixture({ repository: old.repository, now });
  old.repository.awaitFreshHeartbeats = async () => { throw new Error("database unavailable"); };
  await assert.rejects(boot.service.beginObservationWindow(), /database unavailable/);
  await assert.rejects(boot.service.reconcileStale(), /database unavailable/);
});

test("installed appliance accepts complete authenticated inventory", async () => {
  const f = fixture(); await install(f);
  const heartbeat = await f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  assert.equal(heartbeat.lifecycleState, "ready");
  const node = await f.service.get({ context: admin, nodeId: NODE });
  assert.equal(node.inventory.resources.unifiedMemory.availableBytes, 90_000_000_000);
  assert.equal(node.inventory.networkLinks[0].networkClass, "10gbe");
  assert.equal(node.inventory.modelProfiles[0].lifecycleState, "certified");
  const stored = await f.repository.findNode(NODE);
  assert.equal(stored.capacity.cpuMillis, 12_000);
  assert.equal(stored.capacity.unifiedMemoryBytes, 90_000_000_000 - 8 * 1024 ** 3);
  assert.equal(stored.capacity.networkBitsPerSecond, 9_990_000_000);
  assert.equal(JSON.stringify(node).includes("certificateFingerprint"), false);
  assert.deepEqual(f.audits, []);
});

test("heartbeat revision conflict requests retry without accepting the stale write", async () => {
  const f=fixture();await install(f);const original=await f.repository.findNode(NODE);
  f.repository.recordHeartbeat=async()=>{throw Object.assign(Error('revision changed'),{code:'managed_node_revision_conflict'});};
  await assert.rejects(f.service.heartbeat({transportIdentity:transport(),nodeId:NODE,generation:1,inventory:inventory()}),
    {code:'managed_node_revision_conflict',status:409,retryable:true});
  assert.deepEqual(await f.repository.findNode(NODE),original);
});

test("paused controller uses bounded startup recovery without reviving disabled authority", async () => {
  for(const state of ['ready','draining','offline','disabled','removed']){
    const f=fixture();await install(f);await f.service.heartbeat({transportIdentity:transport(),nodeId:NODE,generation:1,inventory:inventory()});
    const original=await f.repository.findNode(NODE);await f.repository.updateNode(NODE,original.revision,{lifecycleState:state});
    await f.service.beginObservationWindow();await f.service.reconcileStale();
    f.setNow(new Date('2026-08-11T08:01:00Z'));await f.service.beginObservationWindow({restartObservation:true});
    const gated=await f.repository.findNode(NODE);assert.equal(gated.generation,1);
    assert.equal(gated.lifecycleState,state==='ready'?'joining':state);
    assert.deepEqual((await f.service.reconcileStale()).fenced,[]);
    f.setNow(new Date('2026-08-11T08:01:46Z'));
    assert.equal((await f.service.reconcileStale()).fenced.length,['ready','draining'].includes(state)?1:0);
  }
});

test("heartbeat requires the exact certificate, generation, ARM64 facts, and secrets-free inventory", async () => {
  const f = fixture(); await install(f);
  await assert.rejects(f.service.heartbeat({ transportIdentity: { ...transport(), mutualTls: false }, nodeId: NODE, generation: 1, inventory: inventory() }), { code: "managed_node_mtls_required" });
  await assert.rejects(f.service.heartbeat({ transportIdentity: { ...transport(), certificateFingerprint: `sha256:${"0".repeat(64)}` }, nodeId: NODE, generation: 1, inventory: inventory() }), { code: "managed_node_certificate_rejected" });
  await assert.rejects(f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory({ architecture: "amd64" }) }), { code: "managed_node_inventory_invalid" });
  await assert.rejects(f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: { ...inventory(), apiToken: "secret" } }), { code: "managed_node_inventory_sensitive" });
  await assert.rejects(f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory({ resources: { ...inventory().resources, cpu: {} } }) }), { code: "managed_node_inventory_invalid" });
  await assert.rejects(f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory({ resources: { ...inventory().resources, unifiedMemory: { totalBytes: 10, availableBytes: 11 } } }) }), { code: "managed_node_inventory_invalid" });
});

test("stale heartbeat fences capacity with a new generation and rejects the old node view", async () => {
  const f = fixture(); await install(f); await f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  const reconciled = await f.service.reconcileStale({ now: new Date("2026-08-11T08:01:00Z") });
  assert.equal(reconciled.fenced[0].lifecycleState, "offline"); assert.equal(reconciled.fenced[0].generation, 2);
  await assert.rejects(f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() }), { code: "stale_node_generation" });
  assert.equal(f.audits.at(-1).action, "compute.node_stale_fenced");
});

test("a draining node is still fenced when its heartbeat becomes stale", async () => {
  const f = fixture(); await install(f); await f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  let node = await f.service.get({ context: admin, nodeId: NODE });
  node = await f.service.setDrain({ context: admin, nodeId: NODE, expectedRevision: node.revision, draining: true });
  assert.equal(node.lifecycleState, "draining");
  const reconciled = await f.service.reconcileStale({ now: new Date("2026-08-11T08:01:00Z") });
  assert.equal(reconciled.fenced[0].lifecycleState, "offline"); assert.equal(reconciled.fenced[0].generation, 2);
});

test("node viewers can read the resource dashboard but cannot mutate lifecycle", async () => {
  const f = fixture(); await install(f);
  const viewer = { identityId: ADMIN, permissions: ["node:view"] };
  assert.equal((await f.service.list({ context: viewer })).data.length, 1);
  await assert.rejects(f.service.setEnabled({ context: viewer, nodeId: NODE, expectedRevision: 1, enabled: false }), { code: "managed_node_permission_required" });
});

test("local appliance labels, drain and enable preserve runtime identities", async () => {
  const f = fixture(); await install(f); await f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  let node = await f.service.get({ context: admin, nodeId: NODE });
  node = await f.service.updateLabels({ context: admin, nodeId: NODE, expectedRevision: node.revision, nodeLabels: { rack: "desk-c" } });
  node = await f.service.setDrain({ context: admin, nodeId: NODE, expectedRevision: node.revision, draining: true }); assert.equal(node.lifecycleState, "draining");
  node = await f.service.setDrain({ context: admin, nodeId: NODE, expectedRevision: node.revision, draining: false });
  node = await f.service.setEnabled({ context: admin, nodeId: NODE, expectedRevision: node.revision, enabled: false }); assert.equal(node.generation, 2);
  node = await f.service.setEnabled({context:admin,nodeId:NODE,expectedRevision:node.revision,enabled:true});
  assert.equal(node.lifecycleState,"joining"); assert.equal(node.generation,3);
});

test("heartbeat and stale fencing publish node and network health without coupling diagnostics availability", async () => {
  const observations = [];
  const f = fixture({ healthSink: { async recordManagedNodeHealth(value) { observations.push(value); } } });
  await install(f);
  await f.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  await f.service.reconcileStale({ now: new Date("2026-08-11T08:01:00Z") });
  assert.deepEqual(observations.map((item) => item.health.state), ["healthy", "offline"]);

  const failures = [];
  const isolated = fixture({ healthSink: { async recordManagedNodeHealth() { throw new Error("diagnostics unavailable"); } },
    onHealthSinkError: async (error, facts) => failures.push([error.message, facts.operation]) });
  await install(isolated);
  const accepted = await isolated.service.heartbeat({ transportIdentity: transport(), nodeId: NODE, generation: 1, inventory: inventory() });
  assert.equal(accepted.lifecycleState, "ready");
  assert.deepEqual(failures, [["diagnostics unavailable", "heartbeat"]]);
});
