import assert from "node:assert/strict";
import test from "node:test";

import { ExternalAttemptCoordinator } from "../src/external-attempt-coordinator.mjs";
import { ExternalProviderContractTester } from "../src/external-provider-contract-tester.mjs";
import { ExternalUsageAccountant } from "../src/external-usage-accountant.mjs";
import { MemoryExternalAttemptRepository } from "../src/memory-external-attempt-repository.mjs";
import { MemoryExternalUsageRepository } from "../src/memory-external-usage-repository.mjs";
import { rankSchedulingCandidates } from "../src/routing-engine.mjs";

const GIB = 1024 ** 3;
const JOB = "00000000-0000-4000-8000-000000000101";
const OWNER = "00000000-0000-4000-8000-000000000201";
const CAPABILITY = "00000000-0000-4000-8000-000000000301";
const PROFILE = "00000000-0000-4000-8000-000000000401";
const PROVIDER_A = "00000000-0000-4000-8000-000000000501";
const PROVIDER_B = "00000000-0000-4000-8000-000000000502";
const RESULT = { objectId: "00000000-0000-4000-8000-000000000601", objectVersion: 1, sha256: `sha256:${"d".repeat(64)}`, sizeBytes: 256 };
const OUTPUT = { sequence: 1, sha256: `sha256:${"e".repeat(64)}`, sizeBytes: 64 };
const REQUEST_DIGEST = `sha256:${"f".repeat(64)}`;
let sequence = 700;

function profile() { return { profileId: PROFILE, profileKey: "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1", capabilityId: CAPABILITY, precision: "nvfp4", compatibility: { architectures: ["linux/arm64/v8"] }, resourceEnvelope: { cpuMillis: 2_000, unifiedMemoryBytes: 24 * GIB, acceleratorUnits: 1, codecSessions: 0, storageBytes: GIB, networkBitsPerSecond: 100_000_000 }, dataPolicy: { allowedDataClasses: ["public", "internal", "confidential"], externalProcessing: "approved_only" }, certification: { state: "certified", evidenceRefs: ["evidence://spark/nvfp4"] }, extensions: { schedulerRequirements: { acceleratorKinds: ["nvidia-blackwell"], minimumComputeCapability: "12.0", codecDirections: { encode: 0, decode: 0 }, storageClass: "encrypted_nvme", network: { class: "management", maximumLatencyMilliseconds: 10 } } } }; }
function work(overrides = {}) { return { jobId: JOB, ownerIdentityId: OWNER, capabilityId: CAPABILITY, operation: "responses", dataClass: "internal", priority: 50, submittedAt: "2026-08-11T08:00:00Z", inputArtifacts: [], ...structuredClone(overrides) }; }
function localCandidate(overrides = {}) { return { targetId: "spark-local", targetKind: "local", lifecycleState: "ready", architecture: "arm64", operations: ["responses"], profile: profile(), availableResources: { cpuMillis: 8_000, unifiedMemoryBytes: 72 * GIB, acceleratorUnits: 1, codecSessions: 2, storageBytes: 100 * GIB, networkBitsPerSecond: 1_000_000_000 }, accelerator: { kind: "nvidia-blackwell", computeCapability: "12.1", supportedPrecisions: ["nvfp4"] }, codec: { encode: 2, decode: 2 }, storage: { classes: ["encrypted_nvme"] }, network: { classes: ["management"], latencyMilliseconds: 1 }, loadCost: { workerState: "warm", modelArtifactCached: true, coldStartMilliseconds: 0 }, locality: { inputArtifactIds: [], modelArtifactCached: true, preferredNode: true }, routingWeight: 100, ...structuredClone(overrides) }; }
function externalCandidate(providerId = PROVIDER_A, overrides = {}) { return { ...localCandidate(), targetId: providerId, targetKind: "external_provider", lifecycleState: "healthy", architecture: null, resourceAccountingMode: "provider_contract", availableResources: undefined, accelerator: undefined, codec: undefined, storage: undefined, network: undefined, providerCapacity: { availableConcurrentRequests: 2, maximumConcurrentRequests: 8 }, contractState: "passed", healthFresh: true, locality: { inputArtifactIds: [], modelArtifactCached: false, preferredNode: false }, ...structuredClone(overrides) }; }
function reasons(result) { return result.rejected.flatMap((item) => item.reasons.map((reason) => reason.code)); }
function error(code, facts = {}) { return Object.assign(new Error(code), { code, ...facts }); }
function coordinator(transport) { return new ExternalAttemptCoordinator({ repository: new MemoryExternalAttemptRepository(), transport, clock: () => new Date("2026-08-11T08:00:00Z"), idFactory: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}` }); }
function target(providerId, replayContract = {}) { return { providerId, modelProfileId: PROFILE, providerModel: "giant-llm", request: { model: "giant-llm", input: [{ type: "input_file", file_url: "opaque-scoped-url" }] }, replayContract }; }

class ContractFixtureTransport {
  constructor({ healthy = true } = {}) { this.healthy = healthy; }
  async request({ path }) {
    if (!this.healthy) return { status: 503, headers: {}, body: { error: { code: "unavailable" } }, latencyMilliseconds: 1 };
    if (path === "/models") return { status: 200, headers: {}, body: { object: "list", data: [{ id: "giant-llm" }] }, latencyMilliseconds: 1 };
    if (path === "/responses") return { status: 200, headers: {}, body: { id: "resp_contract", output: [] }, latencyMilliseconds: 2 };
    return { status: 404, headers: {}, body: {}, latencyMilliseconds: 1 };
  }
}
function provider() { return { providerKey: "external.fixture", endpoint: "https://fixture.invalid/v1", auth: { scheme: "none", headerName: null }, trust: { mode: "system_ca", serverName: null }, timeouts: { requestMilliseconds: 1_000 }, healthCheck: { path: "/models" }, modelMappings: [{ modelProfileId: PROFILE, providerModelName: "giant-llm", operations: ["responses"], enabled: true }] }; }

test("validated local Spark worker and contract-tested provider share one explainable routing pool", async () => {
  const contract = await new ExternalProviderContractTester({ transport: new ContractFixtureTransport() }).run({ provider: provider() });
  assert.equal(contract.passed, true);
  const routing = rankSchedulingCandidates({ job: work(), candidates: [externalCandidate(), localCandidate()], routingPolicy: { mode: "internal_first", externalProcessingApproved: true } });
  assert.equal(routing.selected.targetId, "spark-local");
  assert.equal(routing.policyExplanation.selectedTier, "internal");
  const localSparkWorker = { async execute({ requestedProfileId }) { assert.equal(requestedProfileId, PROFILE); return { result: RESULT, engine: "spark-nvfp4-local" }; } };
  const result = await localSparkWorker.execute({ requestedProfileId: routing.selected.profileId });
  assert.equal(result.result.objectId, RESULT.objectId);
});

test("stale provider health immediately falls back to the healthy local Spark worker", () => {
  const providerTarget = externalCandidate();
  const policy = { mode: "external_first", externalProcessingApproved: true };
  assert.equal(rankSchedulingCandidates({ job: work(), candidates: [providerTarget, localCandidate()], routingPolicy: policy }).selected.targetKind, "external_provider");
  providerTarget.healthFresh = false;
  const fallback = rankSchedulingCandidates({ job: work(), candidates: [providerTarget, localCandidate()], routingPolicy: policy });
  assert.equal(fallback.selected.targetId, "spark-local");
  assert.ok(reasons(fallback).includes("provider_health_stale"));
});

test("provider concurrency exhaustion excludes the external target without fabricating capacity", () => {
  const overloaded = externalCandidate(PROVIDER_A, { providerCapacity: { availableConcurrentRequests: 0, maximumConcurrentRequests: 8 } });
  const result = rankSchedulingCandidates({ job: work(), candidates: [overloaded, localCandidate()], routingPolicy: { mode: "external_first", externalProcessingApproved: true } });
  assert.equal(result.selected.targetId, "spark-local");
  assert.ok(reasons(result).includes("provider_capacity_exhausted"));
});

test("timeout before acceptance fails over to the next contracted provider", async () => {
  const calls = [];
  const service = coordinator({ async execute({ providerId }) { calls.push(providerId); if (providerId === PROVIDER_A) throw error("provider_timeout", { retryable: true }); return { providerRequestId: "provider-b-1", output: OUTPUT, result: RESULT }; } });
  const result = await service.dispatchWithFailover({ jobId: JOB, ownerIdentityId: OWNER, requestDigest: REQUEST_DIGEST, targets: [target(PROVIDER_A), target(PROVIDER_B)] });
  assert.equal(result.completed, true);
  assert.deepEqual(calls, [PROVIDER_A, PROVIDER_B]);
});

test("partial external output is retained as digest evidence and never blindly replayed", async () => {
  const calls = [];
  const service = coordinator({ async execute({ providerId, onAccepted, onOutput }) { calls.push(providerId); await onAccepted({ providerRequestId: "partial-1" }); await onOutput(OUTPUT); throw error("provider_stream_disconnected", { retryable: true }); } });
  const result = await service.dispatchWithFailover({ jobId: JOB, ownerIdentityId: OWNER, requestDigest: REQUEST_DIGEST, targets: [target(PROVIDER_A, { reconcileMode: "status" }), target(PROVIDER_B)] });
  assert.equal(result.completed, false);
  assert.equal(result.decision.action, "reconcile");
  assert.deepEqual(calls, [PROVIDER_A]);
  assert.equal(result.attempt.outputChainDigest.startsWith("sha256:"), true);
});

test("local-only data remains on Spark under every external-preferring policy", () => {
  for (const policy of [
    { mode: "external_first", externalProcessingApproved: true },
    { mode: "weighted", externalProcessingApproved: true, targetWeights: { [PROVIDER_A]: 10_000 } },
    { mode: "pinned", externalProcessingApproved: true, pinnedTargetId: PROVIDER_A },
  ]) {
    const result = rankSchedulingCandidates({ job: work({ extensions: { routing: { localOnly: true } } }), candidates: [externalCandidate(), localCandidate()], routingPolicy: policy });
    assert.notEqual(result.selected?.targetKind, "external_provider");
    assert.ok(result.reasonCounts.external_route_not_allowed >= 1);
  }
});

test("external hardware metrics stay unsupported while provider contract capacity remains routable", () => {
  const external = externalCandidate();
  assert.equal(external.availableResources, undefined);
  assert.equal(external.accelerator, undefined);
  const result = rankSchedulingCandidates({ job: work(), candidates: [external], routingPolicy: { mode: "external_first", externalProcessingApproved: true } });
  assert.equal(result.selected.targetId, PROVIDER_A);
  assert.equal(result.selected.resourceAccountingMode, "provider_contract");
});

test("pre-acceptance provider failure preserves job identity and ordered attempt history", async () => {
  const service = coordinator({ async execute({ providerId }) { if (providerId === PROVIDER_A) throw error("provider_overloaded", { retryable: true }); return { providerRequestId: "accepted-b", output: OUTPUT, result: RESULT }; } });
  const result = await service.dispatchWithFailover({ jobId: JOB, ownerIdentityId: OWNER, requestDigest: REQUEST_DIGEST, targets: [target(PROVIDER_A), target(PROVIDER_B)] });
  const history = await service.history({ jobId: JOB });
  assert.equal(result.completed, true);
  assert.deepEqual(history.map((attempt) => [attempt.jobId, attempt.attemptNumber, attempt.providerId, attempt.acceptanceState]), [
    [JOB, 1, PROVIDER_A, "not_accepted"], [JOB, 2, PROVIDER_B, "output_observed"],
  ]);
});

test("external usage accounting is exact immutable and contains no fabricated hardware counters", async () => {
  const service = new ExternalUsageAccountant({ repository: new MemoryExternalUsageRepository() });
  const recorded = await service.record({
    attemptId: "00000000-0000-4000-8000-000000000901", jobId: JOB, providerId: PROVIDER_A,
    accounting: { currency: "USD", inputMicrounitsPerMillionTokens: 1000, outputMicrounitsPerMillionTokens: 2000, imageMicrounitsPerRequest: 0, audioMicrounitsPerMinute: 0, accountingMode: "provider_reported" },
    usage: { inputTokens: 1000, outputTokens: 500, imageRequests: 0, audioMilliseconds: 0, source: "provider_reported" },
    observedAt: new Date("2026-08-11T08:00:00Z"),
  });
  assert.equal(recorded.totalMicrounits, 2);
  assert.deepEqual(recorded.hardwareMetrics, { support: "unsupported", cpu: null, memory: null, accelerator: null, power: null });
  await assert.rejects(service.record({ attemptId: recorded.attemptId, jobId: JOB, providerId: PROVIDER_A, accounting: { currency: "USD", accountingMode: "unpriced" }, usage: { outputTokens: 1, source: "provider_reported" }, observedAt: recorded.observedAt }), { code: "external_usage_conflict" });
});
