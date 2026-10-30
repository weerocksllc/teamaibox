import assert from "node:assert/strict";
import test from "node:test";
import { ProtectedOfficeCatalogRepository } from "../src/applications/protected-office-catalog-repository.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const keys = ["chat", "image-generation", "ocr", "asr", "translation", "embedding"];
function fixture() {
  let now = Date.parse("2026-09-07T01:00:00Z"), reads = 0;
  const profiles = keys.map((capabilityKey, i) => ({ capabilityKey, profileKey: `${capabilityKey}.main.v1`, profileId: id(i + 1), workerId: id(i + 11) }));
  const manifest = profiles.map((p) => ({ workerId: p.workerId, modelProfileId: p.profileId, imageDigest: `sha256:${"a".repeat(64)}`,
    configurationDigest: `sha256:${"b".repeat(64)}`, placementClass: "protected-resident", maintenanceGeneration: 1 }));
  const identities = manifest.map((p, i) => ({ ...p, healthy: true, state: "running", containerId: String(i).repeat(64), startedAt: "2026-09-07T00:00:00Z" }));
  const state = { manifest: { profiles: manifest }, healthy_identities: identities, recovery_state: "healthy",
    active_transaction: false, node_state: "ready", node_generation: 1, revision: 42,
    desired_state_revision: 6, observed_state_revision: 6, last_seen_at: new Date(now).toISOString() };
  const registrations = profiles.map((p) => ({ id: p.profileId, profile_key: p.profileKey, capability_key: p.capabilityKey,
    placement_class: "protected-resident", certification_state: "validating" }));
  const actual = structuredClone(identities);
  const options = { repository: { async snapshot() { return { plugins: [], health: [], capabilities: keys.map((capabilityKey) => ({
    capabilityKey, eligible: true, providerRoute: true, certifiedProfiles: ["old.aux.profile"], providerRoutableProfiles: ["old.aux.profile"],
  })) }; } }, database: { async query(sql) { return { rows: sql.includes("SELECT protected_set") ? [structuredClone(state)] : structuredClone(registrations) }; } },
  runtime: { async inspectProtectedProfile({ profile }) { reads++; return structuredClone(actual.find((p) => p.workerId === profile.workerId)); } },
  setId: "office.baseline", nodeId: id(100), profiles, clock: () => now };
  return { source: new ProtectedOfficeCatalogRepository(options), options, state, registrations, actual, profiles,
    reads: () => reads, advance: (ms) => { now += ms; } };
}

test("canonical healthy office set supplies six actual local routes without legacy Worker rows or certification promotion", async () => {
  const f = fixture();
  const result = await f.source.snapshot();
  assert.equal(f.reads(), 6);
  for (const capability of result.capabilities) {
    assert.equal(capability.localRoute, true);
    assert.equal(capability.selectedProfileId, f.profiles.find(p => p.capabilityKey === capability.capabilityKey).profileId);
    assert.equal(capability.selectedCertificationState, "validating");
    assert.equal(capability.certified, false);
    assert.deepEqual(capability.localActuallyRoutableProfiles, [`${capability.capabilityKey}.main.v1`]);
    assert.deepEqual(capability.providerRoutableProfiles, []);
    assert.equal(capability.providerRoute, false);
    assert.doesNotMatch(JSON.stringify(capability), /old\.aux/);
  }
  await f.source.snapshot(); assert.equal(f.reads(), 6);
  f.advance(5_000); await f.source.snapshot(); assert.equal(f.reads(), 12);
});

for (const [name, change] of [
  ["stale heartbeat", (f) => f.advance(120_001)],
  ["active transaction", (f) => { f.state.active_transaction = true; }],
  ["incomplete convergence", (f) => { f.state.desired_state_revision++; }],
  ["missing identity", (f) => f.state.healthy_identities.pop()],
]) test(`fails closed for ${name}, without falling back to auxiliary office defaults`, async () => {
  const f = fixture(); change(f);
  const result = await f.source.snapshot();
  assert.ok(result.capabilities.every((c) => !c.localRoute));
  assert.ok(result.capabilities.every((c) => c.selectedProfileId === null));
  const chat = result.capabilities.find((c) => c.capabilityKey === "chat");
  assert.equal(chat.eligible, false); assert.deepEqual(chat.providerRoutableProfiles, []);
});

test("heartbeat advancement is harmless but a raced canonical transition wins over healthy reads", async () => {
  for (const race of [false, true]) {
    const f = fixture(); const inspect = f.options.runtime.inspectProtectedProfile;
    f.options.runtime.inspectProtectedProfile = async (input) => {
      f.state.last_seen_at = "2026-09-07T01:00:00.001Z"; f.advance(1);
      if (race) f.state.revision++;
      return inspect(input);
    };
    assert.equal((await f.source.snapshot()).capabilities[0].localRoute, !race);
  }
});

test("inspection errors fail closed without leaking diagnostic secrets", async () => {
  const f = fixture(); f.options.runtime.inspectProtectedProfile = async () => { throw new Error("private secret"); };
  const result = await f.source.snapshot();
  assert.ok(result.capabilities.every((c) => !c.localRoute));
  assert.doesNotMatch(JSON.stringify(result), /private secret/);
});

test("canonical normalized identities omit ephemeral Docker fields but still require authenticated runtime metadata", async () => {
  const f = fixture();
  f.state.healthy_identities.forEach((i) => { delete i.containerId; delete i.startedAt; });
  assert.ok((await f.source.snapshot()).capabilities.every((c) => c.localRoute));
  f.advance(5_000); delete f.actual[0].containerId;
  const capabilities = (await f.source.snapshot()).capabilities;
  assert.equal(capabilities.filter(c => c.localRoute).length, 5);
  assert.equal(capabilities.find(c => c.capabilityKey === 'chat').localRoute, false);
});

test('mixed loading, failed health, identity and registration errors isolate only the affected capability', async () => {
  for (const mutate of [
    f => { f.actual[0].healthy = false; f.actual[0].startupState = 'loading'; },
    f => { f.actual[0].containerId = 'c'.repeat(64); },
    f => { f.registrations[0].profile_key = 'wrong.profile'; },
    f => { const inspect = f.options.runtime.inspectProtectedProfile;
      f.options.runtime.inspectProtectedProfile = input => {
        if (input.profile.workerId === f.profiles[0].workerId) throw Error('private');
        return inspect(input);
      }; },
  ]) {
    const f = fixture(); mutate(f);
    const result = (await f.source.snapshot()).capabilities;
    assert.equal(result.filter(c => c.localRoute).length, 5);
    assert.equal(result.find(c => c.capabilityKey === 'chat').localRoute, false);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('per-profile loading clears when its runtime becomes healthy', async () => {
  const f = fixture(); f.actual[0].healthy = false; f.actual[0].startupState = 'loading';
  let result = (await f.source.snapshot()).capabilities;
  assert.equal(result.find(c => c.capabilityKey === 'chat').startupState, 'loading');
  assert.equal(result.find(c => c.capabilityKey === 'asr').startupState, 'ready');
  f.actual[0].healthy = true; f.advance(5000);
  result = (await f.source.snapshot()).capabilities;
  assert.ok(result.every(c => c.startupState === 'ready' && c.localRoute));
});

test('fresh boot progress explains unavailable routes even with a stale heartbeat, without enabling them', async () => {
  const f = fixture(); f.advance(120001);
  f.options.runtime.inspectStartupStates = async () => new Map(f.profiles.map((p, i) => [p.workerId, i === 0 ? 'retrying' : 'loading']));
  const result = (await f.source.snapshot()).capabilities;
  assert.equal(f.reads(), 0);
  assert.ok(result.every(c => !c.localRoute && !c.eligible && c.selectedProfileId === null));
  assert.equal(result.find(c => c.capabilityKey === 'chat').startupState, 'retrying');
  assert.equal(result.find(c => c.capabilityKey === 'asr').startupState, 'loading');
  f.options.runtime.inspectStartupStates = async () => new Map(f.profiles.map(p => [p.workerId, 'ready']));
  assert.ok((await f.source.snapshot()).capabilities.every(c => !c.localRoute && c.startupState === 'unavailable'));
});
