import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSchedulingCandidate,
  rankSchedulingCandidates,
} from "../src/routing-engine.mjs";
import {
  calculateQueueFairness,
  rankQueuedJobs,
} from "../src/fair-share.mjs";

const GIB = 1024 ** 3;

function profile(overrides = {}) {
  const base = {
    profileId: "00000000-0000-4000-8000-000000000101",
    profileKey: "llm.spark.nvfp4.v1",
    capabilityId: "00000000-0000-4000-8000-000000000201",
    precision: "nvfp4",
    compatibility: { architectures: ["linux/arm64/v8"] },
    resourceEnvelope: {
      cpuMillis: 2_000,
      unifiedMemoryBytes: 8 * GIB,
      acceleratorUnits: 1,
      codecSessions: 1,
      storageBytes: GIB,
      networkBitsPerSecond: 100_000_000,
    },
    dataPolicy: {
      allowedDataClasses: ["public", "internal", "confidential"],
      externalProcessing: "approved_only",
    },
    certification: { state: "certified", evidenceRefs: ["evidence://llm-a"] },
    extensions: {
      schedulerRequirements: {
        acceleratorKinds: ["nvidia-blackwell"],
        minimumComputeCapability: "12.0",
        codecDirections: { encode: 1, decode: 1 },
        storageClass: "encrypted_nvme",
        network: { class: "lan_10gbe", maximumLatencyMilliseconds: 5 },
      },
    },
  };
  return { ...base, ...structuredClone(overrides) };
}

function job(overrides = {}) {
  return {
    jobId: "00000000-0000-4000-8000-000000000301",
    ownerIdentityId: "user-a",
    teamId: "team-a",
    capabilityId: "00000000-0000-4000-8000-000000000201",
    operation: "responses",
    dataClass: "internal",
    priority: 50,
    submittedAt: "2026-08-10T00:00:00.000Z",
    inputArtifacts: ["artifact-a", "artifact-b"],
    ...structuredClone(overrides),
  };
}

function candidate(overrides = {}) {
  const base = {
    targetId: "spark-a",
    targetKind: "local",
    lifecycleState: "ready",
    architecture: "arm64",
    operations: ["responses"],
    profile: profile(),
    availableResources: {
      cpuMillis: 10_000,
      unifiedMemoryBytes: 32 * GIB,
      acceleratorUnits: 1,
      codecSessions: 2,
      storageBytes: 100 * GIB,
      networkBitsPerSecond: 1_000_000_000,
    },
    accelerator: {
      kind: "nvidia-blackwell",
      computeCapability: "12.1",
      supportedPrecisions: ["bf16", "fp8", "nvfp4"],
    },
    codec: { encode: 1, decode: 1 },
    storage: { classes: ["encrypted_nvme"] },
    network: { classes: ["management", "lan_10gbe"], latencyMilliseconds: 1 },
    loadCost: { workerState: "warm", coldStartMilliseconds: 0, modelArtifactCached: true },
    locality: {
      inputArtifactIds: ["artifact-a", "artifact-b"],
      modelArtifactCached: true,
      preferredNode: true,
    },
    routingWeight: 100,
  };
  return { ...base, ...structuredClone(overrides) };
}

function externalCandidate(overrides = {}) {
  return candidate({
    targetId: "provider-a",
    targetKind: "external_provider",
    lifecycleState: "healthy",
    architecture: null,
    resourceAccountingMode: "provider_contract",
    availableResources: undefined,
    accelerator: undefined,
    codec: undefined,
    storage: undefined,
    network: undefined,
    providerCapacity: { availableConcurrentRequests: 2, maximumConcurrentRequests: 8 },
    contractState: "passed",
    healthFresh: true,
    ...structuredClone(overrides),
  });
}

function reasonCodes(result) {
  return new Set(result.reasons.map((reason) => reason.code));
}

test("an exact certified Spark profile passes every hard scheduling filter", () => {
  const result = evaluateSchedulingCandidate({ job: job(), candidate: candidate() });

  assert.equal(result.eligible, true);
  assert.equal(result.reasons.length, 0);
  assert.ok(result.score > 0);
  assert.deepEqual(
    Object.keys(result.scoreComponents).sort(),
    ["capacityHeadroom", "loadCost", "locality", "network", "queueFairness", "routingWeight"].sort(),
  );
});

test("profile identity and certification are hard gates", () => {
  const uncertified = candidate();
  uncertified.profile.certification.state = "benchmark";
  assert.ok(reasonCodes(evaluateSchedulingCandidate({ job: job(), candidate: uncertified }))
    .has("model_profile_not_certified"));

  const requested = job({ requestedProfileId: "00000000-0000-4000-8000-000000000999" });
  assert.ok(reasonCodes(evaluateSchedulingCandidate({ job: requested, candidate: candidate() }))
    .has("requested_profile_mismatch"));

  const wrongCapability = candidate();
  wrongCapability.profile.capabilityId = "00000000-0000-4000-8000-000000000888";
  assert.ok(reasonCodes(evaluateSchedulingCandidate({ job: job(), candidate: wrongCapability }))
    .has("capability_mismatch"));
});

test("Experimental profiles require an exact administrator opt-in in a non-production policy", () => {
  const experimental = candidate();
  experimental.profile.certification.state = "experimental";
  const denied = evaluateSchedulingCandidate({ job: job(), candidate: experimental });
  assert.ok(reasonCodes(denied).has("model_profile_experimental_not_enabled"));

  const wrongProfile = evaluateSchedulingCandidate({
    job: job(), candidate: experimental,
    routingPolicy: { environment: "validation", experimentalProfileIds: ["00000000-0000-4000-8000-000000000999"] },
  });
  assert.ok(reasonCodes(wrongProfile).has("model_profile_experimental_not_enabled"));

  const production = evaluateSchedulingCandidate({
    job: job(), candidate: experimental,
    routingPolicy: { environment: "production", experimentalProfileIds: [experimental.profile.profileId] },
  });
  assert.ok(reasonCodes(production).has("model_profile_experimental_not_enabled"));

  const allowed = evaluateSchedulingCandidate({
    job: job(), candidate: experimental,
    routingPolicy: { environment: "validation", experimentalProfileIds: [experimental.profile.profileId] },
  });
  assert.equal(allowed.eligible, true);
});

test("Revalidation Required is excluded from strict certified routing", () => {
  const stale = candidate();
  stale.profile.certification.state = "revalidation_required";
  const result = evaluateSchedulingCandidate({ job: job(), candidate: stale });
  assert.equal(result.eligible, false);
  assert.ok(reasonCodes(result).has("model_profile_revalidation_required"));
});

test("architecture and target health fail closed", () => {
  const wrongArchitecture = candidate({ architecture: "amd64" });
  assert.ok(reasonCodes(evaluateSchedulingCandidate({ job: job(), candidate: wrongArchitecture }))
    .has("architecture_mismatch"));

  const unknownArchitecture = candidate({ architecture: null });
  assert.ok(reasonCodes(evaluateSchedulingCandidate({ job: job(), candidate: unknownArchitecture }))
    .has("architecture_unknown"));

  const stale = candidate({ lifecycleState: "offline" });
  assert.ok(reasonCodes(evaluateSchedulingCandidate({ job: job(), candidate: stale }))
    .has("target_not_ready"));
});

test("data classification and external approval remain explicit hard gates", () => {
  const restricted = evaluateSchedulingCandidate({
    job: job({ dataClass: "restricted" }),
    candidate: candidate(),
  });
  assert.ok(reasonCodes(restricted).has("data_class_not_allowed_by_profile"));

  const external = candidate({
    targetId: "provider-a",
    targetKind: "external_provider",
    lifecycleState: "healthy",
    architecture: null,
    resourceAccountingMode: "provider_contract",
    providerCapacity: { availableConcurrentRequests: 2, maximumConcurrentRequests: 4 },
    contractState: "passed",
    healthFresh: true,
  });
  const notApproved = evaluateSchedulingCandidate({
    job: job(),
    candidate: external,
    routingPolicy: { allowExternal: true },
  });
  assert.ok(reasonCodes(notApproved).has("external_processing_not_approved"));

  const approved = evaluateSchedulingCandidate({
    job: job(),
    candidate: external,
    routingPolicy: { allowExternal: true, externalProcessingApproved: true },
  });
  assert.equal(approved.eligible, true);
});

test("external provider contracts do not invent private hardware metrics", () => {
  const external = candidate({
    targetId: "provider-a",
    targetKind: "external_provider",
    lifecycleState: "healthy",
    architecture: null,
    resourceAccountingMode: "provider_contract",
    availableResources: undefined,
    accelerator: undefined,
    codec: undefined,
    storage: undefined,
    network: undefined,
    providerCapacity: { availableConcurrentRequests: 1, maximumConcurrentRequests: 8 },
    contractState: "passed",
    healthFresh: true,
  });

  const result = evaluateSchedulingCandidate({
    job: job(),
    candidate: external,
    routingPolicy: { allowExternal: true, externalProcessingApproved: true },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.resourceAccountingMode, "provider_contract");
  assert.equal(result.reasons.length, 0);
});

test("hardware and data compatibility remain hard requirements without advance resource booking", async (t) => {
  const cases = [
    ["accelerator kind", (item) => { item.accelerator.kind = "generic"; }, "accelerator_kind_mismatch"],
    ["accelerator precision", (item) => { item.accelerator.supportedPrecisions = ["bf16"]; }, "accelerator_precision_mismatch"],
    ["storage class", (item) => { item.storage.classes = ["ephemeral"]; }, "storage_class_mismatch"],
    ["network class", (item) => { item.network.classes = ["management"]; }, "network_class_mismatch"],
    ["network latency", (item) => { item.network.latencyMilliseconds = 6; }, "network_latency_too_high"],
  ];

  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const item = candidate();
      mutate(item);
      const result = evaluateSchedulingCandidate({ job: job(), candidate: item });
      assert.equal(result.eligible, false);
      assert.ok(reasonCodes(result).has(expected), JSON.stringify(result.reasons));
    });
  }
});

test("an absent resource estimate does not become an advance-booking gate", () => {
  const item = candidate();
  delete item.availableResources.unifiedMemoryBytes;
  const result = evaluateSchedulingCandidate({ job: job(), candidate: item });

  assert.equal(result.eligible, true);
});

test("warm model, object locality, and routing weight produce explainable scores", () => {
  const cold = candidate({
    targetId: "spark-cold",
    loadCost: { workerState: "stopped", coldStartMilliseconds: 180_000, modelArtifactCached: false },
    locality: { inputArtifactIds: [], modelArtifactCached: false, preferredNode: false },
    routingWeight: 0,
  });
  const warm = candidate({ targetId: "spark-warm", routingWeight: 10_000 });
  const result = rankSchedulingCandidates({ job: job(), candidates: [cold, warm] });

  assert.equal(result.selected.targetId, "spark-warm");
  assert.ok(result.eligible[0].scoreComponents.loadCost.contribution
    > result.eligible[1].scoreComponents.loadCost.contribution);
  assert.ok(result.eligible[0].scoreComponents.locality.contribution
    > result.eligible[1].scoreComponents.locality.contribution);
  assert.ok(result.eligible[0].scoreComponents.routingWeight.contribution
    > result.eligible[1].scoreComponents.routingWeight.contribution);
});

test("candidate ties use profile then target identifiers deterministically", () => {
  const result = rankSchedulingCandidates({
    job: job(),
    candidates: [candidate({ targetId: "spark-z" }), candidate({ targetId: "spark-a" })],
  });

  assert.deepEqual(result.eligible.map((entry) => entry.targetId), ["spark-a", "spark-z"]);
  assert.equal(result.selected.targetId, "spark-a");
});

test("rejected candidates expose stable reason counts and waiting state", () => {
  const offline = candidate({ targetId: "spark-offline", lifecycleState: "offline" });
  const small = candidate({ targetId: "spark-small" });
  small.lifecycleState = "offline";
  const result = rankSchedulingCandidates({ job: job(), candidates: [small, offline] });

  assert.equal(result.selected, null);
  assert.equal(result.waitingReason, "no_eligible_target");
  assert.equal(result.reasonCounts.target_not_ready, 2);
});

test("internal-only excludes every external target even when it scores higher", () => {
  const local = candidate({ targetId: "spark-local", routingWeight: 0 });
  const external = externalCandidate({ routingWeight: 10_000 });
  const result = rankSchedulingCandidates({ job: job(), candidates: [external, local], routingPolicy: { mode: "internal_only", externalProcessingApproved: true } });
  assert.equal(result.selected.targetId, "spark-local");
  assert.ok(result.rejected.find((item) => item.targetId === "provider-a").reasons.some((reason) => reason.code === "external_route_not_allowed"));
  assert.equal(result.policyExplanation.reasonCode, "routing.internal_only.internal_selected");
});

test("internal-first uses external overflow only when no internal candidate is eligible", () => {
  const external = externalCandidate({ routingWeight: 10_000 });
  const local = candidate({ targetId: "spark-local", routingWeight: 0 });
  const policy = { mode: "internal_first", externalProcessingApproved: true };
  assert.equal(rankSchedulingCandidates({ job: job(), candidates: [external, local], routingPolicy: policy }).selected.targetId, "spark-local");
  local.lifecycleState = "offline";
  const overflow = rankSchedulingCandidates({ job: job(), candidates: [external, local], routingPolicy: policy });
  assert.equal(overflow.selected.targetId, "provider-a");
  assert.equal(overflow.policyExplanation.selectedTier, "external");
});

test("external-first prefers healthy contracted external compute and falls back internally", () => {
  const local = candidate({ targetId: "spark-local", routingWeight: 10_000 });
  const external = externalCandidate({ routingWeight: 0 });
  const policy = { mode: "external_first", externalProcessingApproved: true };
  assert.equal(rankSchedulingCandidates({ job: job(), candidates: [local, external], routingPolicy: policy }).selected.targetId, "provider-a");
  external.healthFresh = false;
  const fallback = rankSchedulingCandidates({ job: job(), candidates: [local, external], routingPolicy: policy });
  assert.equal(fallback.selected.targetId, "spark-local");
  assert.ok(fallback.reasonCounts.provider_health_stale >= 1);
});

test("weighted routing applies exact administrator target weights", () => {
  const local = candidate({ targetId: "spark-local", routingWeight: 10_000 });
  const external = externalCandidate({ routingWeight: 0 });
  const result = rankSchedulingCandidates({
    job: job(), candidates: [local, external],
    routingPolicy: { mode: "weighted", externalProcessingApproved: true, targetWeights: { "spark-local": 0, "provider-a": 10_000 } },
    scoringWeights: { loadCost: 0, locality: 0, capacityHeadroom: 0, queueFairness: 0, network: 0, routingWeight: 1 },
  });
  assert.equal(result.selected.targetId, "provider-a");
  assert.ok(result.eligible[0].scoreComponents.routingWeight.contribution > result.eligible[1].scoreComponents.routingWeight.contribution);
});

test("pinned routing excludes every nonmatching target and explains unavailable pins", () => {
  const local = candidate({ targetId: "spark-local" });
  const external = externalCandidate();
  const policy = { mode: "pinned", pinnedTargetId: "provider-a", externalProcessingApproved: true };
  assert.equal(rankSchedulingCandidates({ job: job(), candidates: [local, external], routingPolicy: policy }).selected.targetId, "provider-a");
  external.lifecycleState = "unavailable";
  const unavailable = rankSchedulingCandidates({ job: job(), candidates: [local, external], routingPolicy: policy });
  assert.equal(unavailable.selected, null);
  assert.equal(unavailable.waitingReason, "pinned_target_unavailable");
  assert.equal(unavailable.reasonCounts.routing_pin_target_mismatch, 1);
});

test("local-only data can never route externally under external-first, weighted, or pinned policy", () => {
  for (const policy of [
    { mode: "external_first", externalProcessingApproved: true },
    { mode: "weighted", externalProcessingApproved: true },
    { mode: "pinned", pinnedTargetId: "provider-a", externalProcessingApproved: true },
  ]) {
    const result = rankSchedulingCandidates({ job: job({ extensions: { routing: { localOnly: true } } }), candidates: [externalCandidate()], routingPolicy: policy });
    assert.equal(result.selected, null);
    assert.ok(result.reasonCounts.external_route_not_allowed >= 1);
    assert.equal(result.policyExplanation.externalPermitted, false);
  }
});

test("external contract and health freshness are mandatory hard gates", () => {
  const staleContract = externalCandidate({ contractState: "stale" });
  const unknownHealth = externalCandidate({ targetId: "provider-b", healthFresh: undefined });
  const result = rankSchedulingCandidates({ job: job(), candidates: [staleContract, unknownHealth], routingPolicy: { mode: "external_first", externalProcessingApproved: true } });
  assert.equal(result.selected, null);
  assert.equal(result.reasonCounts.provider_contract_stale, 1);
  assert.equal(result.reasonCounts.provider_health_stale, 1);
});

test("hierarchical fair share favors idle users without bypassing priority", () => {
  const state = {
    users: {
      "user-a": { usage: 8, share: 1, activeJobs: 1, concurrencyLimit: 4 },
      "user-b": { usage: 0, share: 1, activeJobs: 0, concurrencyLimit: 4 },
    },
  };
  const userA = job({ jobId: "job-a", ownerIdentityId: "user-a" });
  const userB = job({ jobId: "job-b", ownerIdentityId: "user-b" });
  const ranked = rankQueuedJobs([userA, userB], state, { now: "2026-08-10T00:01:00.000Z" });

  assert.deepEqual(ranked.ranked.map((entry) => entry.jobId), ["job-b", "job-a"]);
  assert.ok(ranked.ranked[0].fairness.score > ranked.ranked[1].fairness.score);

  const urgentA = { ...userA, jobId: "job-urgent", priority: 80 };
  const priorityRank = rankQueuedJobs([urgentA, userB], state, { now: "2026-08-10T00:01:00.000Z" });
  assert.equal(priorityRank.ranked[0].jobId, "job-urgent");
});

test("bounded aging and fair share cannot invert an administrator priority gap", () => {
  const ranked = rankQueuedJobs([
    job({
      jobId: "low-old-idle",
      ownerIdentityId: "user-idle",
      priority: 20,
      submittedAt: "2026-08-09T00:00:00.000Z",
    }),
    job({
      jobId: "urgent-busy",
      ownerIdentityId: "user-busy",
      priority: 80,
      submittedAt: "2026-08-10T00:09:59.000Z",
    }),
  ], {
    users: {
      "user-idle": { usage: 0, share: 1, activeJobs: 0, concurrencyLimit: 4 },
      "user-busy": { usage: 20, share: 1, activeJobs: 1, concurrencyLimit: 4 },
    },
  }, {
    now: "2026-08-10T00:10:00.000Z",
    agingIntervalMilliseconds: 60_000,
    maximumAgingBoost: 20,
  });
  assert.deepEqual(ranked.ranked.map((entry) => entry.jobId), ["urgent-busy", "low-old-idle"]);
  assert.equal(ranked.ranked[1].effectivePriority, 40);
  assert.equal(ranked.ranked[0].effectivePriority, 80);
});

test("fair-share concurrency and quota limits block admission with scope details", () => {
  const state = {
    users: { "user-a": { usage: 1, share: 1, activeJobs: 2, concurrencyLimit: 2 } },
    teams: { "team-a": { usage: 1, share: 2, quotaRemaining: 0 } },
  };
  const fairness = calculateQueueFairness(job(), state);

  assert.equal(fairness.admitted, false);
  assert.deepEqual(fairness.blocking.map((entry) => entry.code), [
    "scope_concurrency_limit",
    "scope_quota_exhausted",
  ]);

  const result = evaluateSchedulingCandidate({
    job: job(),
    candidate: candidate(),
    fairnessState: state,
  });
  assert.equal(result.eligible, false);
  assert.ok(reasonCodes(result).has("scope_concurrency_limit"));
  assert.ok(reasonCodes(result).has("scope_quota_exhausted"));
});

test("queue aging is bounded and scoring configuration rejects unknown dimensions", () => {
  const ranked = rankQueuedJobs([
    job({ jobId: "old", priority: 40, submittedAt: "2026-08-10T00:00:00.000Z" }),
    job({ jobId: "new", priority: 50, submittedAt: "2026-08-10T00:09:30.000Z" }),
  ], {}, {
    now: "2026-08-10T00:10:00.000Z",
    agingIntervalMilliseconds: 60_000,
    maximumAgingBoost: 20,
  });
  assert.equal(ranked.ranked[0].jobId, "old");
  assert.equal(ranked.ranked[0].agingBoost, 10);

  assert.throws(() => evaluateSchedulingCandidate({
    job: job(),
    candidate: candidate(),
    scoringWeights: { magic: 1 },
  }), /unknown scoring weight/);
});
