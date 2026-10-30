import { calculateQueueFairness } from "./fair-share.mjs";

const RESOURCE_KEYS = [
  "cpuMillis",
  "unifiedMemoryBytes",
  "acceleratorUnits",
  "codecSessions",
  "storageBytes",
  "networkBitsPerSecond",
];

export const DEFAULT_SCORING_WEIGHTS = Object.freeze({
  loadCost: 25,
  locality: 20,
  capacityHeadroom: 20,
  queueFairness: 10,
  network: 10,
  routingWeight: 15,
});

const TARGET_STATES = new Set(["ready", "healthy"]);
const TARGET_KINDS = new Set(["local", "managed_node", "external_provider"]);
const ROUTING_MODES = new Set(["internal_only", "internal_first", "external_first", "weighted", "pinned"]);
const ROUTING_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function profileCertificationState(profile) {
  return profile?.certification?.state ?? profile?.certificationState ?? null;
}

function targetId(candidate) {
  return candidate?.targetId ?? candidate?.candidateId ?? null;
}

function normalizeArchitecture(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (["arm64", "aarch64", "linux/arm64"].includes(normalized)) return "linux/arm64/v8";
  if (["amd64", "x86_64", "linux/x86_64"].includes(normalized)) return "linux/amd64";
  return normalized;
}

function schedulerRequirements(profile) {
  return profile?.extensions?.schedulerRequirements ?? {};
}

function reject(reasons, code, dimension, details = {}) {
  reasons.push({ code, dimension, ...details });
}

function filterTargetState(candidate, reasons) {
  if (candidate.enabled === false) {
    reject(reasons, "target_disabled", "health");
  }

  const state = candidate.lifecycleState ?? candidate.health;
  if (!state) {
    reject(reasons, "target_health_unknown", "health");
  } else if (!TARGET_STATES.has(state)) {
    reject(reasons, "target_not_ready", "health", { observedState: state });
  }
}

function filterProfile(job, candidate, routingPolicy, reasons) {
  const profile = candidate.profile;
  if (!profile) {
    reject(reasons, "model_profile_missing", "model_profile");
    return;
  }

  if (!profile.profileId) {
    reject(reasons, "model_profile_identifier_missing", "model_profile");
  }

  const state = profileCertificationState(profile);
  const experimentalAllowed = state === "experimental"
    && new Set(["development", "validation"]).has(routingPolicy.environment)
    && Array.isArray(routingPolicy.experimentalProfileIds)
    && routingPolicy.experimentalProfileIds.includes(profile.profileId);
  if (state !== "certified" && !experimentalAllowed) {
    const code = state === "experimental"
      ? "model_profile_experimental_not_enabled"
      : state === "revalidation_required"
        ? "model_profile_revalidation_required"
        : "model_profile_not_certified";
    reject(reasons, code, "model_profile", { observedState: state });
  }

  if (profile.capabilityId !== job.capabilityId) {
    reject(reasons, "capability_mismatch", "model_profile", {
      requested: job.capabilityId,
      observed: profile.capabilityId ?? null,
    });
  }

  if (job.requestedProfileId && profile.profileId !== job.requestedProfileId) {
    reject(reasons, "requested_profile_mismatch", "model_profile", {
      requested: job.requestedProfileId,
      observed: profile.profileId ?? null,
    });
  }

  if (Array.isArray(candidate.operations) && !candidate.operations.includes(job.operation)) {
    reject(reasons, "operation_not_supported", "model_profile", {
      requested: job.operation,
    });
  }
}

function filterArchitecture(candidate, reasons) {
  const architectures = candidate.profile?.compatibility?.architectures ?? [];
  const accountingMode = candidate.resourceAccountingMode ?? "observed";
  const observed = normalizeArchitecture(candidate.architecture);

  if (accountingMode === "provider_contract" && !observed) return;

  if (!observed) {
    reject(reasons, "architecture_unknown", "architecture");
    return;
  }

  if (!architectures.map(normalizeArchitecture).includes(observed)) {
    reject(reasons, "architecture_mismatch", "architecture", {
      required: architectures,
      observed,
    });
  }
}

function filterDataPolicy(job, candidate, routingPolicy, reasons) {
  const profilePolicy = candidate.profile?.dataPolicy;
  if (!profilePolicy?.allowedDataClasses?.includes(job.dataClass)) {
    reject(reasons, "data_class_not_allowed_by_profile", "data_policy", {
      dataClass: job.dataClass,
    });
  }

  if (Array.isArray(candidate.allowedDataClasses)
      && !candidate.allowedDataClasses.includes(job.dataClass)) {
    reject(reasons, "data_class_not_allowed_by_target", "data_policy", {
      dataClass: job.dataClass,
    });
  }

  if (candidate.targetKind !== "external_provider") return;

  if (routingPolicy.allowExternal !== true || job.extensions?.routing?.localOnly === true) {
    reject(reasons, "external_route_not_allowed", "data_policy");
  }

  const externalProcessing = profilePolicy?.externalProcessing;
  if (externalProcessing === "forbidden") {
    reject(reasons, "external_processing_forbidden", "data_policy");
  } else if (externalProcessing === "approved_only"
      && routingPolicy.externalProcessingApproved !== true) {
    reject(reasons, "external_processing_not_approved", "data_policy");
  }
}

function filterExternalProviderEvidence(candidate, reasons) {
  if (candidate.targetKind !== "external_provider") return;
  const contractState = candidate.contractState ?? candidate.contract?.state;
  if (contractState !== "passed") reject(reasons, contractState === "stale" ? "provider_contract_stale" : "provider_contract_not_passed", "provider_contract", { observedState: contractState ?? "unknown" });
  if (candidate.healthFresh !== true) reject(reasons, "provider_health_stale", "health");
}

export function normalizeRoutingPolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("routing policy must be an object");
  const mode = value.mode ?? (value.allowExternal === true ? "weighted" : "internal_only");
  if (!ROUTING_MODES.has(mode)) throw new TypeError(`unsupported routing mode ${mode}`);
  const pinnedTargetId = value.pinnedTargetId ?? null;
  const pinnedProfileId = value.pinnedProfileId ?? null;
  if (mode === "pinned" && !pinnedTargetId && !pinnedProfileId) throw new TypeError("pinned routing requires a target or profile identifier");
  for (const [name, identifier] of [["pinnedTargetId", pinnedTargetId], ["pinnedProfileId", pinnedProfileId]]) {
    if (identifier !== null && (typeof identifier !== "string" || !ROUTING_IDENTIFIER.test(identifier))) throw new TypeError(`${name} is invalid`);
  }
  const targetWeights = value.targetWeights ?? {};
  if (!targetWeights || typeof targetWeights !== "object" || Array.isArray(targetWeights)) throw new TypeError("targetWeights must be an object");
  for (const [identifier, weight] of Object.entries(targetWeights)) {
    if (!ROUTING_IDENTIFIER.test(identifier) || !Number.isSafeInteger(weight) || weight < 0 || weight > 10_000) throw new TypeError("targetWeights contains an invalid target or weight");
  }
  return Object.freeze({
    ...value,
    mode,
    allowExternal: mode !== "internal_only",
    externalProcessingApproved: value.externalProcessingApproved === true,
    pinnedTargetId,
    pinnedProfileId,
    targetWeights: Object.freeze({ ...targetWeights }),
  });
}

function filterRoutingPin(candidate, routingPolicy, reasons) {
  if (routingPolicy.mode !== "pinned") return;
  if (routingPolicy.pinnedTargetId && targetId(candidate) !== routingPolicy.pinnedTargetId) reject(reasons, "routing_pin_target_mismatch", "routing_policy", { required: routingPolicy.pinnedTargetId });
  if (routingPolicy.pinnedProfileId && candidate.profile?.profileId !== routingPolicy.pinnedProfileId) reject(reasons, "routing_pin_profile_mismatch", "routing_policy", { required: routingPolicy.pinnedProfileId });
}

function filterProviderContractCapacity(candidate, reasons) {
  if (candidate.targetKind !== "external_provider") {
    reject(reasons, "provider_contract_on_managed_target", "resource_accounting");
    return;
  }

  const available = candidate.providerCapacity?.availableConcurrentRequests;
  if (!Number.isInteger(available) || available < 0) {
    reject(reasons, "provider_capacity_unknown", "provider_concurrency");
  } else if (available < 1) {
    reject(reasons, "provider_capacity_exhausted", "provider_concurrency", {
      required: 1,
      available,
    });
  }
}

function versionTuple(value) {
  const match = String(value ?? "").match(/^(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}

function versionAtLeast(observed, required) {
  const left = versionTuple(observed);
  const right = versionTuple(required);
  if (!left || !right) return false;
  return left[0] > right[0] || (left[0] === right[0] && left[1] >= right[1]);
}

function filterAccelerator(candidate, reasons) {
  const requirements = schedulerRequirements(candidate.profile);
  const requiredUnits = candidate.profile?.resourceEnvelope?.acceleratorUnits ?? 0;
  if (requiredUnits === 0) return;

  const accelerator = candidate.accelerator;
  if (!accelerator || typeof accelerator !== "object") {
    reject(reasons, "accelerator_capability_unknown", "accelerator");
    return;
  }

  if (Array.isArray(requirements.acceleratorKinds)
      && !requirements.acceleratorKinds.includes(accelerator.kind)) {
    reject(reasons, "accelerator_kind_mismatch", "accelerator", {
      required: requirements.acceleratorKinds,
      observed: accelerator.kind ?? null,
    });
  }

  if (!Array.isArray(accelerator.supportedPrecisions)) {
    reject(reasons, "accelerator_precision_unknown", "accelerator", {
      required: candidate.profile.precision,
    });
  } else if (!accelerator.supportedPrecisions.includes(candidate.profile.precision)) {
    reject(reasons, "accelerator_precision_mismatch", "accelerator", {
      required: candidate.profile.precision,
      observed: accelerator.supportedPrecisions,
    });
  }

  if (requirements.minimumComputeCapability
      && !versionAtLeast(accelerator.computeCapability, requirements.minimumComputeCapability)) {
    reject(reasons, "accelerator_compute_capability_mismatch", "accelerator", {
      required: requirements.minimumComputeCapability,
      observed: accelerator.computeCapability ?? null,
    });
  }
}

function filterStorage(candidate, reasons) {
  const requiredClass = schedulerRequirements(candidate.profile).storageClass;
  if (!requiredClass) return;
  const classes = candidate.storage?.classes;
  if (!Array.isArray(classes)) {
    reject(reasons, "storage_class_unknown", "storage", { required: requiredClass });
  } else if (!classes.includes(requiredClass)) {
    reject(reasons, "storage_class_mismatch", "storage", {
      required: requiredClass,
      observed: classes,
    });
  }
}

function filterNetwork(candidate, reasons) {
  const requirement = schedulerRequirements(candidate.profile).network ?? {};
  if (requirement.class) {
    const classes = candidate.network?.classes;
    if (!Array.isArray(classes)) {
      reject(reasons, "network_class_unknown", "network", { required: requirement.class });
    } else if (!classes.includes(requirement.class)) {
      reject(reasons, "network_class_mismatch", "network", {
        required: requirement.class,
        observed: classes,
      });
    }
  }

  if (Number.isFinite(requirement.maximumLatencyMilliseconds)) {
    const observed = candidate.network?.latencyMilliseconds;
    if (!isFiniteNonNegative(observed)) {
      reject(reasons, "network_latency_unknown", "network", {
        maximum: requirement.maximumLatencyMilliseconds,
      });
    } else if (observed > requirement.maximumLatencyMilliseconds) {
      reject(reasons, "network_latency_too_high", "network", {
        maximum: requirement.maximumLatencyMilliseconds,
        observed,
      });
    }
  }
}

function scoreLoadCost(candidate) {
  const load = candidate.loadCost ?? {};
  if (load.workerState === "warm") return 1;
  if (load.workerState === "preparing") return 0.7;

  const coldStartMilliseconds = isFiniteNonNegative(load.coldStartMilliseconds)
    ? load.coldStartMilliseconds
    : 120_000;
  const base = 1 / (1 + coldStartMilliseconds / 30_000);
  return clamp(base + (load.modelArtifactCached ? 0.15 : 0));
}

function scoreLocality(candidate, job) {
  const locality = candidate.locality ?? {};
  const inputs = Array.isArray(job.inputArtifacts) ? job.inputArtifacts : [];
  const localInputs = new Set(locality.inputArtifactIds ?? []);
  const signals = [];

  if (inputs.length > 0) {
    const count = inputs.reduce((total, id) => total + (localInputs.has(id) ? 1 : 0), 0);
    signals.push({ value: count / inputs.length, weight: 0.7 });
  }
  if (typeof locality.modelArtifactCached === "boolean") {
    signals.push({ value: locality.modelArtifactCached ? 1 : 0, weight: 0.2 });
  }
  if (typeof locality.preferredNode === "boolean") {
    signals.push({ value: locality.preferredNode ? 1 : 0, weight: 0.1 });
  }
  if (signals.length === 0) return 0.5;

  const totalWeight = signals.reduce((total, signal) => total + signal.weight, 0);
  return signals.reduce((total, signal) => total + signal.value * signal.weight, 0) / totalWeight;
}

function scoreCapacityHeadroom(candidate) {
  if ((candidate.resourceAccountingMode ?? "observed") === "provider_contract") {
    const available = candidate.providerCapacity?.availableConcurrentRequests ?? 0;
    const maximum = candidate.providerCapacity?.maximumConcurrentRequests ?? available;
    return maximum > 0 ? clamp((available - 1) / maximum) : 0;
  }

  const required = candidate.profile.resourceEnvelope;
  const available = candidate.availableResources ?? {};
  const scores = RESOURCE_KEYS
    .filter((key) => (required[key] ?? 0) > 0)
    .map((key) => clamp((available[key] - required[key]) / available[key]));

  if (scores.length === 0) return 0.5;
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function scoreNetwork(candidate) {
  const required = candidate.profile.resourceEnvelope.networkBitsPerSecond ?? 0;
  const available = candidate.availableResources?.networkBitsPerSecond;
  const latency = candidate.network?.latencyMilliseconds;
  const signals = [];

  if (required > 0 && isFiniteNonNegative(available) && available > 0) {
    signals.push(clamp((available - required) / available));
  }
  if (isFiniteNonNegative(latency)) {
    signals.push(1 / (1 + latency / 10));
  }

  if (signals.length === 0) return 0.5;
  return signals.reduce((total, score) => total + score, 0) / signals.length;
}

function scoreRoutingWeight(candidate) {
  const weight = isFiniteNonNegative(candidate.routingWeight) ? candidate.routingWeight : 100;
  if (weight === 0) return 0;
  return weight / (weight + 100);
}

function calculateScore(job, candidate, fairness, weights) {
  const values = {
    loadCost: scoreLoadCost(candidate),
    locality: scoreLocality(candidate, job),
    capacityHeadroom: scoreCapacityHeadroom(candidate),
    queueFairness: fairness.score,
    network: scoreNetwork(candidate),
    routingWeight: scoreRoutingWeight(candidate),
  };

  const totalWeight = Object.values(weights).reduce((total, value) => total + value, 0);
  if (!(totalWeight > 0)) throw new TypeError("at least one scoring weight must be positive");

  const components = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    value: round(value),
    weight: weights[key],
    contribution: round(value * weights[key] / totalWeight * 100),
  }]));

  return {
    score: round(Object.values(components).reduce((total, item) => total + item.contribution, 0)),
    components,
  };
}

function validateWeights(weights) {
  for (const key of Object.keys(weights)) {
    if (!(key in DEFAULT_SCORING_WEIGHTS)) {
      throw new TypeError(`unknown scoring weight ${key}`);
    }
  }
  const merged = { ...DEFAULT_SCORING_WEIGHTS, ...weights };
  for (const [key, value] of Object.entries(merged)) {
    if (!isFiniteNonNegative(value)) throw new TypeError(`scoring weight ${key} must be non-negative`);
  }
  return merged;
}

export function evaluateSchedulingCandidate({
  job,
  candidate,
  fairnessState = {},
  routingPolicy = {},
  scoringWeights = {},
}) {
  if (!job?.jobId || !job.capabilityId || !job.operation || !job.dataClass) {
    throw new TypeError("job must include jobId, capabilityId, operation, and dataClass");
  }
  if (!targetId(candidate) || !candidate.targetKind) {
    throw new TypeError("candidate must include targetId and targetKind");
  }
  if (!TARGET_KINDS.has(candidate.targetKind)) {
    throw new TypeError(`unsupported targetKind ${candidate.targetKind}`);
  }

  routingPolicy = normalizeRoutingPolicy(routingPolicy);
  const reasons = [];
  filterTargetState(candidate, reasons);
  filterRoutingPin(candidate, routingPolicy, reasons);
  filterProfile(job, candidate, routingPolicy, reasons);
  if (candidate.profile) {
    filterArchitecture(candidate, reasons);
    filterDataPolicy(job, candidate, routingPolicy, reasons);
    filterExternalProviderEvidence(candidate, reasons);
    if ((candidate.resourceAccountingMode ?? "observed") === "provider_contract") {
      filterProviderContractCapacity(candidate, reasons);
    } else {
      filterAccelerator(candidate, reasons);
      filterStorage(candidate, reasons);
      filterNetwork(candidate, reasons);
    }
  }

  const fairness = calculateQueueFairness(job, fairnessState);
  for (const blocking of fairness.blocking) {
    reject(reasons, blocking.code, "queue_fairness", blocking);
  }

  const base = {
    targetId: targetId(candidate),
    targetKind: candidate.targetKind,
    profileId: candidate.profile?.profileId ?? null,
    eligible: reasons.length === 0,
    reasons,
    resourceAccountingMode: candidate.resourceAccountingMode ?? "observed",
    fairness,
  };

  if (reasons.length > 0) return { ...base, score: null, scoreComponents: null };

  const scoring = calculateScore(job, candidate, fairness, validateWeights(scoringWeights));
  return { ...base, score: scoring.score, scoreComponents: scoring.components };
}

/**
 * Evaluate and deterministically rank target/profile pairs. No physical route
 * is disclosed to clients; the result is an internal scheduler decision and
 * preserves complete rejection/score explanations for administrators.
 */
export function rankSchedulingCandidates(input) {
  if (!Array.isArray(input?.candidates)) throw new TypeError("candidates must be an array");

  const routingPolicy = normalizeRoutingPolicy(input.routingPolicy);

  const evaluated = input.candidates.map((candidate) => evaluateSchedulingCandidate({
    job: input.job,
    candidate: Object.hasOwn(routingPolicy.targetWeights, targetId(candidate))
      ? { ...candidate, routingWeight: routingPolicy.targetWeights[targetId(candidate)] }
      : candidate,
    fairnessState: input.fairnessState,
    routingPolicy,
    scoringWeights: input.scoringWeights,
  }));

  const scoreOrdered = evaluated
    .filter((entry) => entry.eligible)
    .sort((left, right) =>
      right.score - left.score
      || left.profileId.localeCompare(right.profileId)
      || left.targetId.localeCompare(right.targetId),
    );
  const internal = scoreOrdered.filter((entry) => entry.targetKind !== "external_provider");
  const external = scoreOrdered.filter((entry) => entry.targetKind === "external_provider");
  const eligible = routingPolicy.mode === "internal_first"
    ? [...internal, ...external]
    : routingPolicy.mode === "external_first"
      ? [...external, ...internal]
      : scoreOrdered;
  const rejected = evaluated
    .filter((entry) => !entry.eligible)
    .sort((left, right) => left.targetId.localeCompare(right.targetId));

  const reasonCounts = {};
  for (const entry of rejected) {
    for (const reason of entry.reasons) {
      reasonCounts[reason.code] = (reasonCounts[reason.code] ?? 0) + 1;
    }
  }

  const selected = eligible[0] ?? null;
  const waitingReason = selected
    ? null
    : routingPolicy.mode === "pinned"
      ? "pinned_target_unavailable"
      : routingPolicy.mode === "internal_only" && evaluated.some((entry) => entry.targetKind === "external_provider")
        ? "no_eligible_internal_target"
        : "no_eligible_target";
  const selectedTier = selected === null ? null : selected.targetKind === "external_provider" ? "external" : "internal";
  return {
    selected,
    eligible,
    rejected,
    waitingReason,
    reasonCounts,
    policyExplanation: {
      mode: routingPolicy.mode,
      selectedTier,
      externalPermitted: routingPolicy.allowExternal && input.job?.extensions?.routing?.localOnly !== true,
      reasonCode: selected === null ? waitingReason : `routing.${routingPolicy.mode}.${selectedTier}_selected`,
    },
  };
}
