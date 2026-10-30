import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { MemorySourceCenterRepository } from "../src/memory-source-center-repository.mjs";
import { SourceCenterService } from "../src/source-center-service.mjs";

const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const POOL = "018f6f18-24d7-7c21-9b62-8c017419959b";
const viewer = { identityId: ADMIN, permissions: ["source:view"] };
const manager = { identityId: ADMIN, permissions: ["source:view", "source:manage"] };

test("source policies accept more than 64 sources/scopes and 256 rules without changing permissions", async () => {
  const service=new SourceCenterService({repository:new MemorySourceCenterRepository(),idFactory:randomUUID});
  const sources=[];
  for(let i=0;i<70;i++)sources.push(await service.createSource({context:manager,declaration:declaration({sourceKey:`pip.fixture.${i}`,
    displayName:'软件源'.repeat(100),packageScopes:Array.from({length:70},(_,n)=>`scope-${n}`),
    endpoint:{url:'https://example.test/'+('segment/'.repeat(80)),networkZone:'internet'},
    cache:{mode:'read-through',maximumBytes:10_000_000,ttlSeconds:63_072_000,retainVerified:true}})}));
  const policy=await service.createPolicy({context:manager,declaration:{policyKey:'pip.large-policy',displayName:'完整规则',ecosystem:'pip',environment:'agent',
    selector:{architecture:'arm64'},offlineMode:'allow-online',sources:sources.map((source,i)=>({sourceId:source.sourceId,priority:i})),
    packageRules:Array.from({length:300},(_,i)=>({pattern:`package-${i}`,decision:'allow'}))}});
  assert.equal((await service.listSources({context:viewer})).data.length,70);assert.equal(policy.sources.length,70);
  assert.equal(policy.packageRules.length,300);assert.equal(sources[0].packageScopes.length,70);
  await assert.rejects(service.createPolicy({context:viewer,declaration:policy}),{code:'source_permission_required'});
});

function declaration(overrides = {}) {
  return {
    sourceKey: "pip.public.cache",
    displayName: "PyPI proxy cache",
    ecosystem: "pip",
    kind: "proxy-cache",
    endpoint: { url: "http://source-gateway.internal/pypi/", networkZone: "internal" },
    priority: 100,
    packageScopes: ["*"],
    architectures: ["arm64", "source"],
    trust: { checksumRequired: true, signaturePolicy: "preferred" },
    credentialSecretKey: null,
    onlineMode: "auto",
    cache: { mode: "read-through", maximumBytes: 10_000_000, ttlSeconds: 3_600, retainVerified: true },
    enabled: true,
    ...overrides,
  };
}

function fixture({ healthSink = null } = {}) {
  const audit = [];
  let sequence = 0;
  const ids = [
    "018f6f18-24d7-7c21-9b62-8c0174199501",
    "018f6f18-24d7-7c21-9b62-8c0174199502",
    "018f6f18-24d7-7c21-9b62-8c0174199503",
    "018f6f18-24d7-7c21-9b62-8c0174199504",
    "018f6f18-24d7-7c21-9b62-8c0174199505",
  ];
  return {
    audit,
    service: new SourceCenterService({
      repository: new MemorySourceCenterRepository(),
      idFactory: () => ids[sequence++],
      clock: () => new Date(`2026-08-11T06:00:0${sequence}.000Z`),
      audit: async (event) => audit.push(event),
      healthSink,
    }),
  };
}

test("administrators configure pip, npm, and apt sources without exposing credentials", async () => {
  const { service, audit } = fixture();
  const pip = await service.createSource({ context: manager, declaration: declaration() });
  const npm = await service.createSource({ context: manager, declaration: declaration({
    sourceKey: "npm.external.upstream", displayName: "Private npm", ecosystem: "npm", kind: "upstream",
    endpoint: { url: "https://npm.example.test/", networkZone: "internet" },
    packageScopes: ["@team/*"], architectures: ["all"], credentialSecretKey: "source.npm.private.token",
    cache: { mode: "none", maximumBytes: 0, ttlSeconds: 0, retainVerified: false },
  }) });
  const apt = await service.createSource({ context: manager, declaration: declaration({
    sourceKey: "apt.offline.arm64", displayName: "Offline Ubuntu", ecosystem: "apt", kind: "offline-media",
    endpoint: { url: "http://source-gateway.internal/apt/offline/", networkZone: "internal" },
    architectures: ["arm64"], onlineMode: "offline", storagePoolId: POOL,
    cache: { mode: "immutable-offline", maximumBytes: 100_000_000, ttlSeconds: 0, retainVerified: true },
  }) });

  assert.equal(pip.health.state, "unknown");
  assert.equal(npm.credentialConfigured, true);
  assert.equal(npm.credentialSecretKey, "source.npm.private.token");
  assert.equal(JSON.stringify(npm).includes("token-value"), false);
  assert.equal(apt.storagePoolId, POOL);
  const overview = await service.overview({ context: viewer });
  assert.deepEqual(Object.keys(overview.byEcosystem), ["apt", "npm", "pip"]);
  assert.equal(overview.sourceCount, 3);
  assert.equal(audit.length, 3);
  assert.equal(JSON.stringify(audit).includes("token-value"), false);
});

test("source declarations enforce transport, credential, offline-media, and trust boundaries", async () => {
  const { service } = fixture();
  await assert.rejects(service.createSource({ context: viewer, declaration: declaration() }), { code: "source_permission_required", status: 403 });
  await assert.rejects(service.createSource({ context: manager, declaration: declaration({ kind: "upstream", endpoint: { url: "http://pypi.org/simple/", networkZone: "internet" } }) }), { code: "source_tls_required" });
  await assert.rejects(service.createSource({ context: manager, declaration: declaration({ kind: "upstream", endpoint: { url: "https://user:secret@pypi.org/simple/", networkZone: "internet" } }) }), { code: "source_input_invalid" });
  await assert.rejects(service.createSource({ context: manager, declaration: declaration({ kind: "upstream", credentialSecretKey: "source.npm.wrong" }) }), { code: "source_credential_reference_invalid" });
  await assert.rejects(service.createSource({ context: manager, declaration: declaration({ kind: "offline-media", onlineMode: "offline", cache: { mode: "immutable-offline", maximumBytes: 1, ttlSeconds: 0, retainVerified: true } }) }), { code: "source_storage_required" });
  await assert.rejects(service.createSource({ context: manager, declaration: declaration({ trust: { checksumRequired: false, signaturePolicy: "preferred" } }) }), { code: "source_trust_invalid" });
});

test("source health and mutations use optimistic revisions", async () => {
  const { service } = fixture();
  const source = await service.createSource({ context: manager, declaration: declaration() });
  const healthy = await service.reportHealth({ context: manager, sourceId: source.sourceId, expectedRevision: 1, observation: { state: "healthy", latencyMilliseconds: 14 } });
  assert.equal(healthy.revision, 2);
  assert.equal(healthy.health.state, "healthy");
  await assert.rejects(service.reportHealth({ context: manager, sourceId: source.sourceId, expectedRevision: 1, observation: { state: "offline", errorCode: "source_unreachable" } }), { code: "source_revision_conflict", status: 409 });
  const offline = await service.reportHealth({ context: manager, sourceId: source.sourceId, expectedRevision: 2, observation: { state: "offline", errorCode: "source_unreachable" } });
  const updated = await service.updateSource({ context: manager, sourceId: source.sourceId, expectedRevision: 3, declaration: { onlineMode: "offline", enabled: false } });
  assert.equal(offline.health.errorCode, "source_unreachable");
  assert.equal(updated.onlineMode, "offline");
  assert.equal(updated.enabled, false);
});

test("source health observations are published to operational diagnostics", async () => {
  const observations = [], { service } = fixture({ healthSink: { async recordSourceHealth(value) { observations.push(value); } } });
  const source = await service.createSource({ context: manager, declaration: declaration() });
  await service.reportHealth({ context: manager, sourceId: source.sourceId, expectedRevision: 1, observation: { state: "degraded", latencyMilliseconds: 42, errorCode: "upstream_slow" } });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].health.state, "degraded");
});

test("diagnostic health sink failure cannot invalidate a committed source observation", async () => {
  const { service, audit } = fixture({ healthSink: { async recordSourceHealth() { throw new Error("diagnostics unavailable"); } } });
  const source = await service.createSource({ context: manager, declaration: declaration() });
  const result = await service.reportHealth({ context: manager, sourceId: source.sourceId, expectedRevision: 1, observation: { state: "healthy", latencyMilliseconds: 10 } });
  assert.equal(result.health.state, "healthy");
  assert.ok(audit.some((event) => event.action === "source_center.health_publish_failed"));
});

test("policies select ordered ecosystem sources by workload and architecture", async () => {
  const { service } = fixture();
  const local = await service.createSource({ context: manager, declaration: declaration() });
  const upstream = await service.createSource({ context: manager, declaration: declaration({
    sourceKey: "pip.external.upstream", displayName: "PyPI", kind: "upstream",
    endpoint: { url: "https://pypi.org/simple/", networkZone: "internet" },
    cache: { mode: "none", maximumBytes: 0, ttlSeconds: 0, retainVerified: false },
  }) });
  const policy = await service.createPolicy({ context: manager, declaration: {
    policyKey: "pip.agent.arm64", displayName: "Agent Python", ecosystem: "pip", environment: "agent",
    selector: { teamKey: "engineering", sandboxProfileKey: "python", architecture: "arm64" },
    offlineMode: "prefer-offline",
    sources: [{ sourceId: local.sourceId, priority: 10 }, { sourceId: upstream.sourceId, priority: 20 }],
    packageRules: [{ pattern: "torch", decision: "pin", version: "2.8.0" }, { pattern: "malicious-*", decision: "deny" }],
    enabled: true,
  } });
  assert.deepEqual(policy.sources.map(({ sourceId }) => sourceId), [local.sourceId, upstream.sourceId]);
  assert.equal(policy.packageRules[0].version, "2.8.0");
  const updated = await service.updatePolicy({ context: manager, policyId: policy.policyId, expectedRevision: 1, declaration: { offlineMode: "require-offline" } });
  assert.equal(updated.revision, 2);
  assert.equal(updated.offlineMode, "require-offline");
  await assert.rejects(service.updatePolicy({ context: manager, policyId: policy.policyId, expectedRevision: 1, declaration: { enabled: false } }), { code: "source_policy_revision_conflict", status: 409 });
});

test("policies cannot mix ecosystems or duplicate priorities", async () => {
  const { service } = fixture();
  const pip = await service.createSource({ context: manager, declaration: declaration() });
  const npm = await service.createSource({ context: manager, declaration: declaration({ sourceKey: "npm.cache", ecosystem: "npm", architectures: ["all"] }) });
  const base = {
    policyKey: "pip.agent", displayName: "Agent Python", ecosystem: "pip", environment: "agent",
    selector: { architecture: "arm64" }, offlineMode: "allow-online", packageRules: [], enabled: true,
  };
  await assert.rejects(service.createPolicy({ context: manager, declaration: { ...base, sources: [{ sourceId: npm.sourceId, priority: 1 }] } }), { code: "source_policy_invalid", status: 409 });
  await assert.rejects(service.createPolicy({ context: manager, declaration: { ...base, sources: [{ sourceId: pip.sourceId, priority: 1 }, { sourceId: npm.sourceId, priority: 1 }] } }), { code: "source_policy_invalid" });
});
