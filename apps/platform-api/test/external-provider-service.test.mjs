import assert from "node:assert/strict";
import test from "node:test";

import { EncryptedSecretStore, MemoryCiphertextBackend } from "../../../packages/secrets/src/index.mjs";
import { ExternalProviderService } from "../src/providers/external-provider-service.mjs";
import { MemoryExternalProviderRepository } from "../src/providers/memory-provider-repository.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const NOW = new Date("2026-08-11T10:30:00Z");
const context = Object.freeze({ identityId: uuid(1), permissions: ["provider:view", "provider:manage"] });
const reader = Object.freeze({ service: "provider-adapter", permissions: ["secrets:read"] });

function input(overrides = {}) {
  return {
    providerKey: "external.lab",
    displayName: "External Lab",
    endpoint: "https://a100.lab.example/v1",
    auth: { scheme: "bearer" },
    credential: "provider-secret-value",
    trust: { mode: "system_ca" },
    allowedDataClasses: ["public", "internal"],
    limits: { concurrency: 8, requestsPerMinute: 120, tokensPerMinute: 2_000_000 },
    timeouts: { connectMilliseconds: 2_000, requestMilliseconds: 60_000, idleStreamMilliseconds: 10_000 },
    healthCheck: { path: "/models", intervalSeconds: 30, timeoutMilliseconds: 2_000, failureThreshold: 2 },
    costAccounting: { currency: "USD", inputMicrounitsPerMillionTokens: 100, outputMicrounitsPerMillionTokens: 200, accountingMode: "provider_reported" },
    modelMappings: [{ modelProfileId: uuid(20), providerModelName: "giant-llm", operations: ["responses", "chat.completions"], contextWindow: 131_072, maximumOutputTokens: 8_192 }],
    ...structuredClone(overrides),
  };
}

function fixture({ probeResult = null, repository = new MemoryExternalProviderRepository(), healthSink = null,
  clock = () => NOW, probeResidencyCoordinator = null } = {}) {
  const backend = new MemoryCiphertextBackend();
  const secretStore = new EncryptedSecretStore({ masterKey: Buffer.alloc(32, 7), backend });
  const probes = [];
  const probe = { async run(value) {
    probes.push(value);
    assert.equal(value.credential?.toString("utf8"), "provider-secret-value");
    return (typeof probeResult === "function" ? await probeResult(value) : probeResult)
      ?? { passed: true, evidenceDigest: `sha256:${"a".repeat(64)}`, latencyMilliseconds: 12, failedChecks: [] };
  } };
  const service = new ExternalProviderService({ repository, secretStore, probe, clock, idFactory: () => uuid(10),
    healthSink, probeResidencyCoordinator });
  return { service, repository, secretStore, backend, probes };
}

test("administrator registration stores credentials only in protected ciphertext and returns redacted configuration", async () => {
  const { service, backend } = fixture();
  const created = await service.create({ context, input: input() });
  assert.equal(created.providerId, uuid(10));
  assert.equal(created.lifecycleState, "disabled");
  assert.equal(created.auth.credentialConfigured, true);
  assert.equal(created.trust.customCaConfigured, false);
  assert.deepEqual(created.executionContract, {
    idempotencyMode: "none", replayAfterAcceptance: "prohibited", reconcileMode: "none",
    cancellationMode: "none", sideEffectClass: "none", idempotencyHeader: null,
    statusPathTemplate: null, cancelPathTemplate: null, cancelMethod: null,
  });
  assert.equal("credentialSecretKey" in created, false);
  assert.equal("credential" in created, false);
  const ciphertext = await backend.load(`provider.${uuid(10)}.auth`);
  assert.ok(ciphertext);
  assert.equal(JSON.stringify(ciphertext).includes("provider-secret-value"), false);
  assert.equal(JSON.stringify(created).includes("provider-secret-value"), false);
});

test("provider cannot be enabled until exact capability-contract evidence passes", async () => {
  const { service } = fixture();
  const created = await service.create({ context, input: input() });
  await assert.rejects(() => service.setEnabled({ context, providerId: created.providerId, expectedRevision: 1, enabled: true }), { code: "provider_contract_not_passed" });
  const tested = await service.testContract({ context, providerId: created.providerId, expectedRevision: 1 });
  assert.equal(tested.contract.state, "passed");
  assert.equal(tested.lifecycleState, "disabled");
  const enabled = await service.setEnabled({ context, providerId: created.providerId, expectedRevision: 2, enabled: true });
  assert.equal(enabled.lifecycleState, "healthy");
  assert.equal(enabled.revision, 3);
});

test("provider contract health is observed when a long-running probe completes", async () => {
  const startedAt = new Date("2026-08-11T10:30:00Z");
  const completedAt = new Date("2026-08-11T10:31:15Z");
  let probeCompleted = false;
  const { service } = fixture({
    clock: () => probeCompleted ? completedAt : startedAt,
    probeResult: async () => {
      probeCompleted = true;
      return { passed: true, evidenceDigest: `sha256:${"d".repeat(64)}`, latencyMilliseconds: 75_000, failedChecks: [] };
    },
  });
  const created = await service.create({ context, input: input() });
  const tested = await service.testContract({ context, providerId: created.providerId, expectedRevision: 1 });
  assert.equal(new Date(tested.health.observedAt).toISOString(), completedAt.toISOString());
  assert.equal(new Date(tested.contract.testedAt).toISOString(), completedAt.toISOString());
});

test("failed contract check records bounded health facts and remains disabled", async () => {
  const { service } = fixture({ probeResult: { passed: false, evidenceDigest: `sha256:${"b".repeat(64)}`, latencyMilliseconds: 44, failedChecks: ["models:invalid_schema"] } });
  const created = await service.create({ context, input: input() });
  const tested = await service.testContract({ context, providerId: created.providerId, expectedRevision: 1 });
  assert.equal(tested.contract.state, "failed");
  assert.equal(tested.health.state, "unavailable");
  assert.deepEqual(tested.contract.failedChecks, ["models:invalid_schema"]);
  assert.equal(tested.lifecycleState, "disabled");
});

test("provider contract health is published to operational diagnostics", async () => {
  const observations = [];
  const { service } = fixture({ healthSink: { async recordProviderHealth(value) { observations.push(value); } } });
  const created = await service.create({ context, input: input() });
  await service.testContract({ context, providerId: created.providerId, expectedRevision: 1 });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].health.state, "healthy");
  assert.equal(observations[0].providerId, created.providerId);
});

test("diagnostic health sink failure cannot invalidate a committed provider contract result", async () => {
  const { service } = fixture({ healthSink: { async recordProviderHealth() { throw new Error("diagnostics unavailable"); } } });
  const created = await service.create({ context, input: input() });
  const tested = await service.testContract({ context, providerId: created.providerId, expectedRevision: 1 });
  assert.equal(tested.contract.state, "passed");
});

test("HTTPS, authentication, trust, model, context, rate, timeout, data, and cost declarations fail closed", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.create({ context, input: input({ endpoint: "http://a100.lab.example/v1" }) }), { code: "provider_endpoint_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ credential: "short" }) }), { code: "provider_credential_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ trust: { mode: "custom_ca" } }) }), { code: "provider_trust_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ allowedDataClasses: ["secret"] }) }), { code: "provider_declaration_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ limits: { concurrency: 0 } }) }), { code: "provider_declaration_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ modelMappings: [{ modelProfileId: uuid(20), providerModelName: "m", operations: ["unknown"], contextWindow: 1 }] }) }), { code: "provider_declaration_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ executionContract: { replayAfterAcceptance: "same_provider" } }) }), { code: "provider_declaration_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ executionContract: { reconcileMode: "status", statusPathTemplate: "/responses/static" } }) }), { code: "provider_declaration_invalid" });
});

test("provider execution contracts explicitly map idempotency, status reconciliation, and cancellation", async () => {
  const { service } = fixture();
  const created = await service.create({ context, input: input({ executionContract: {
    idempotencyMode: "provider_key", idempotencyHeader: "Idempotency-Key",
    replayAfterAcceptance: "same_provider", reconcileMode: "status",
    statusPathTemplate: "/responses/{request_id}", cancellationMode: "request",
    cancelPathTemplate: "/responses/{request_id}/cancel", cancelMethod: "POST",
    sideEffectClass: "idempotent",
  } }) });
  assert.equal(created.executionContract.idempotencyMode, "provider_key");
  assert.equal(created.executionContract.statusPathTemplate, "/responses/{request_id}");
  assert.equal(created.executionContract.cancelMethod, "POST");
});

test("provider model resource control is explicit, bounded, and publicly redacted", async () => {
  const { service } = fixture();
  const created = await service.create({ context, input: input({ resourceControl: {
    mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
    statusPath: "/models/status", idleSeconds: 180,
  } }) });
  assert.deepEqual(created.resourceControl, {
    mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
    statusPath: "/models/status", idleSeconds: 180,
  });
  assert.equal(JSON.stringify(created.resourceControl).includes("credential"), false);
});

test("provider model resource control rejects unsafe paths and idle policies", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.create({ context, input: input({ resourceControl: {
    mode: "model_api", preparePath: "/../prepare", unloadPath: "/models/unload",
    statusPath: "/models/status", idleSeconds: 180,
  } }) }), { code: "provider_declaration_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ resourceControl: {
    mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
    statusPath: "/models/status", idleSeconds: 0,
  } }) }), { code: "provider_declaration_invalid" });
  await assert.rejects(() => service.create({ context, input: input({ resourceControl: {
    mode: "model_api", preparePath: "/models/state", unloadPath: "/models/state",
    statusPath: "/models/status", idleSeconds: 180,
  } }) }), { code: "provider_declaration_invalid" });
});

test("external contract probe cannot drain or reserve local office workers", async () => {
  const calls = [];
  const residency = Object.freeze({ providerId: uuid(10), modelProfileId: uuid(20), probe: true });
  const probeResidencyCoordinator = {
    supports(profileId) { calls.push(["supports", profileId]); return profileId === uuid(20); },
    async acquireProbe(value) { calls.push(["acquire", value.providerId, value.modelProfileId]); return residency; },
    async releaseProbe(value) { calls.push(["release", value.lease, value.outcome]); },
  };
  const { service } = fixture({ probeResidencyCoordinator, probeResult: async () => {
    calls.push(["probe"]);
    return { passed: true, evidenceDigest: `sha256:${"e".repeat(64)}`, latencyMilliseconds: 10, failedChecks: [] };
  } });
  const created = await service.create({ context, input: input({ resourceControl: {
    mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
    statusPath: "/models/status", idleSeconds: 180,
  } }) });
  const tested = await service.testContract({ context, providerId: created.providerId, expectedRevision: 1 });
  assert.equal(tested.contract.state, "passed");
  assert.deepEqual(calls.map((item) => item[0]), ["probe"]);
});

test("failed external contract probe never acquires local residency", async () => {
  const calls = [];
  const residency = Object.freeze({ providerId: uuid(10), modelProfileId: uuid(20), probe: true });
  const probeResidencyCoordinator = {
    supports: () => true,
    async acquireProbe() { calls.push("acquire"); return residency; },
    async releaseProbe(value) { calls.push(`release:${value.outcome}`); },
  };
  const { service } = fixture({ probeResidencyCoordinator,
    probeResult: { passed: false, evidenceDigest: `sha256:${"f".repeat(64)}`, latencyMilliseconds: 10,
      failedChecks: ["images.generations:failed"] } });
  const created = await service.create({ context, input: input({ resourceControl: {
    mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
    statusPath: "/models/status", idleSeconds: 180,
  } }) });
  const tested = await service.testContract({ context, providerId: created.providerId, expectedRevision: 1 });
  assert.equal(tested.contract.state, "failed");
  assert.deepEqual(calls, []);
});

test("credential rotation changes only the protected version and never the public record", async () => {
  const { service, secretStore } = fixture();
  const created = await service.create({ context, input: input() });
  const result = await service.rotateCredential({ context, providerId: created.providerId, credential: "replacement-provider-secret" });
  assert.equal(result.activeVersion, 2);
  const seen = await secretStore.withSecret(`provider.${uuid(10)}.auth`, reader, async (secret) => ({ matches: secret.toString("utf8") === "replacement-provider-secret" }));
  assert.equal(seen.matches, true);
  assert.equal(JSON.stringify(await service.get({ context, providerId: created.providerId })).includes("replacement-provider-secret"), false);
});

test("removal requires a disabled provider, revokes protected material, and hides the tombstone", async () => {
  const { service, secretStore } = fixture();
  const created = await service.create({ context, input: input({ trust: { mode: "custom_ca" }, customCaPem: "-----BEGIN CERTIFICATE-----\nfixture-ca\n-----END CERTIFICATE-----" }) });
  const tested = await service.testContract({ context, providerId: created.providerId, expectedRevision: created.revision });
  const enabled = await service.setEnabled({ context, providerId: created.providerId, expectedRevision: tested.revision, enabled: true });
  await assert.rejects(() => service.remove({ context, providerId: created.providerId, expectedRevision: enabled.revision }), { code: "provider_must_be_disabled" });
  const disabled = await service.setEnabled({ context, providerId: created.providerId, expectedRevision: enabled.revision, enabled: false });
  const removed = await service.remove({ context, providerId: created.providerId, expectedRevision: disabled.revision });
  assert.equal(removed.providerId, created.providerId);
  assert.deepEqual((await service.list({ context })).data, []);
  await assert.rejects(() => service.get({ context, providerId: created.providerId }), { code: "provider_not_found" });
  await assert.rejects(() => secretStore.withSecret(`provider.${uuid(10)}.auth`, reader, async () => null), { code: "no_active_version" });
  await assert.rejects(() => secretStore.withSecret(`provider.${uuid(10)}.ca`, reader, async () => null), { code: "no_active_version" });
});

test("failed durable registration revokes any already-provisioned provider secret", async () => {
  const repository = new MemoryExternalProviderRepository();
  repository.create = async () => { const error = new Error("bounded persistence failure"); error.code = "provider_persistence_failed"; throw error; };
  const { service, secretStore } = fixture({ repository });
  await assert.rejects(() => service.create({ context, input: input() }), { code: "provider_persistence_failed" });
  await assert.rejects(() => secretStore.withSecret(`provider.${uuid(10)}.auth`, reader, async () => null), { code: "no_active_version" });
});

test("ordinary users cannot view or manage external provider configuration", async () => {
  const { service } = fixture();
  const member = { identityId: uuid(2), permissions: [] };
  await assert.rejects(() => service.list({ context: member }), { code: "access_denied" });
  await assert.rejects(() => service.create({ context: member, input: input() }), { code: "access_denied" });
});

test("operations viewers receive only bounded provider metrics without endpoint or secret configuration", async () => {
  const { service } = fixture();
  await service.create({ context, input: input() });
  const result = await service.listOperations({ context: { identityId: uuid(3), permissions: ["operations:view"] } });
  assert.equal(result.data[0].limits.concurrency, 8);
  assert.equal(result.data[0].modelMappings[0].contextWindow, 131_072);
  assert.equal("endpoint" in result.data[0], false);
  assert.equal("auth" in result.data[0], false);
  assert.equal(JSON.stringify(result).includes("provider-secret-value"), false);
});

test("probe output cannot inject raw upstream content into durable health evidence", async () => {
  const { service } = fixture({ probeResult: { passed: false, evidenceDigest: `sha256:${"c".repeat(64)}`, latencyMilliseconds: 1, failedChecks: ["Authorization: Bearer leaked"] } });
  const created = await service.create({ context, input: input() });
  await assert.rejects(() => service.testContract({ context, providerId: created.providerId, expectedRevision: 1 }), { code: "provider_probe_invalid" });
});
