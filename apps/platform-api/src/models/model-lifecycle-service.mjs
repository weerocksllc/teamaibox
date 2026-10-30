import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const EVIDENCE = /^(?:object|evidence):\/\/[A-Za-z0-9/._:-]{1,2000}$/;

export const MODEL_PROFILE_LIFECYCLE_STATES = Object.freeze([
  "experimental", "validating", "certified", "deprecated", "failed", "revalidation_required",
]);

const TRANSITIONS = Object.freeze({
  experimental: new Set(["validating", "deprecated"]),
  validating: new Set(["certified", "failed", "experimental"]),
  certified: new Set(["deprecated", "revalidation_required"]),
  revalidation_required: new Set(["validating", "deprecated", "failed"]),
  failed: new Set(["validating", "deprecated"]),
  deprecated: new Set(["validating"]),
});

export class ModelLifecycleError extends PlatformError {
  constructor(code, message, { status = 400 } = {}) {
    super(code, message, { status });
    this.name = "ModelLifecycleError";
  }
}

function fail(code, message, options) { throw new ModelLifecycleError(code, message, options); }
function requireManager(context) {
  if (!context?.permissions?.includes("model:manage")) fail("model_manager_required", "Model management permission is required", { status: 403 });
}
function requireViewer(context) {
  if (!context?.permissions?.some((permission) => permission === "model:view" || permission === "model:manage")) {
    fail("model_viewer_required", "Model viewing permission is required", { status: 403 });
  }
}
function key(value, label) {
  if (typeof value !== "string" || !KEY.test(value)) fail("model_lifecycle_input_invalid", `${label} is invalid`);
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("model_lifecycle_input_invalid", "Lifecycle revision is invalid");
  return value;
}
function evidenceRefs(value) {
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string" || !EVIDENCE.test(item))) {
    fail("model_lifecycle_input_invalid", "Lifecycle evidence references are invalid");
  }
  return Object.freeze([...new Set(value)].sort());
}
function iso(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail("model_lifecycle_input_invalid", `${label} is invalid`);
  return date;
}
function visibleProfile(profile) {
  if (!profile) return null;
  return Object.freeze({
    profileId: profile.profileId,
    profileKey: profile.profileKey,
    fingerprint: profile.fingerprint,
    state: profile.state,
    revision: profile.revision,
    reasonKey: profile.reasonKey,
    evidenceRefs: Object.freeze(structuredClone(profile.evidenceRefs ?? [])),
    validationRunId: profile.validationRunId ?? null,
    updatedAt: new Date(profile.updatedAt).toISOString(),
  });
}
function visibleOptIn(record) {
  return Object.freeze({
    policyKey: record.policyKey,
    environment: record.environment,
    profileId: record.profileId,
    enabled: record.enabled,
    reasonKey: record.reasonKey,
    revision: record.revision,
    expiresAt: new Date(record.expiresAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  });
}

export class ModelLifecycleService {
  #repository;
  #validationRuns;
  #clock;
  #audit;

  constructor({ repository, validationRuns, clock = () => new Date(), audit = async () => {} }) {
    const methods = ["findProfile", "listProfiles", "transitionLifecycle", "upsertExperimentalOptIn", "listExperimentalOptIns"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function") || !validationRuns?.getRun) {
      throw new TypeError("model lifecycle dependencies are incomplete");
    }
    this.#repository = repository;
    this.#validationRuns = validationRuns;
    this.#clock = clock;
    this.#audit = audit;
  }

  async getProfile(context, profileId) {
    requireViewer(context);
    return visibleProfile(await this.#profile(profileId));
  }

  async listProfiles(context, { limit = 100, afterProfileKey = null } = {}) {
    requireViewer(context);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || (afterProfileKey !== null && (typeof afterProfileKey !== "string" || !/^[a-z][a-z0-9_.-]{2,191}$/.test(afterProfileKey)))) {
      fail("model_lifecycle_input_invalid", "Model profile list query is invalid");
    }
    const profiles = await this.#repository.listProfiles({ limit: limit + 1, afterProfileKey });
    const page = profiles.slice(0, limit).map(visibleProfile);
    return Object.freeze({
      data: Object.freeze(page),
      nextCursor: profiles.length > limit ? page.at(-1)?.profileKey ?? null : null,
    });
  }

  async transition({ context, profileId, expectedRevision, nextState, reasonKey, evidenceRefs: refs = [], validationRunId = null }) {
    requireManager(context);
    if (!UUID.test(profileId ?? "") || !MODEL_PROFILE_LIFECYCLE_STATES.includes(nextState)) {
      fail("model_lifecycle_input_invalid", "Profile lifecycle transition is invalid");
    }
    const current = await this.#profile(profileId);
    revision(expectedRevision);
    if (current.revision !== expectedRevision) fail("model_lifecycle_revision_conflict", "Profile lifecycle revision changed", { status: 409 });
    if (!TRANSITIONS[current.state]?.has(nextState)) {
      fail("model_lifecycle_transition_invalid", `Profile cannot transition from ${current.state} to ${nextState}`, { status: 409 });
    }
    const normalizedReason = key(reasonKey, "Lifecycle reason");
    const normalizedEvidence = evidenceRefs(refs);
    let validationRun = null;
    if (nextState === "validating" || nextState === "certified") {
      if (!UUID.test(validationRunId ?? "")) fail("model_lifecycle_validation_required", "A matching validation run is required", { status: 409 });
      validationRun = await this.#validationRuns.getRun(validationRunId);
      if (!validationRun || validationRun.plan?.profile?.profileKey !== current.profileKey
        || validationRun.plan?.profile?.fingerprint !== current.fingerprint) {
        fail("model_lifecycle_validation_mismatch", "Validation run does not match the immutable profile", { status: 409 });
      }
      if (nextState === "validating" && validationRun.state !== "validating") {
        fail("model_lifecycle_validation_mismatch", "Validation run is not active", { status: 409 });
      }
      if (nextState === "certified" && validationRun.state !== "certified") {
        fail("model_lifecycle_certification_blocked", "Only a fully passed validation run can certify a profile", { status: 409 });
      }
    } else if (validationRunId !== null) {
      fail("model_lifecycle_input_invalid", "This lifecycle transition does not accept a validation run");
    }
    const updated = await this.#repository.transitionLifecycle({
      profileId, expectedRevision, expectedState: current.state, nextState,
      reasonKey: normalizedReason, evidenceRefs: normalizedEvidence,
      validationRunId: validationRun?.runId ?? null,
      actorIdentityId: context.identityId ?? null, occurredAt: this.#clock(),
    });
    await this.#audit({
      event: "model_profile.lifecycle_transitioned", actorId: context.identityId ?? null,
      profileId, profileKey: current.profileKey, fromState: current.state,
      toState: nextState, revision: updated.revision, reasonKey: normalizedReason,
      validationRunId: validationRun?.runId ?? null, evidenceRefs: normalizedEvidence,
    });
    return visibleProfile(updated);
  }

  async beginValidation({ context, profileId, validationRun }) {
    requireManager(context);
    const current = await this.#profile(profileId);
    if (!validationRun || validationRun.state !== "validating"
      || validationRun.plan?.profile?.profileKey !== current.profileKey
      || validationRun.plan?.profile?.fingerprint !== current.fingerprint) {
      fail("model_lifecycle_validation_mismatch", "Active validation does not match the immutable profile", { status: 409 });
    }
    if (current.state === "validating" && current.validationRunId === validationRun.runId) return visibleProfile(current);
    return this.transition({
      context, profileId, expectedRevision: current.revision, nextState: "validating",
      reasonKey: "model.lifecycle.validation_started", validationRunId: validationRun.runId,
      evidenceRefs: [],
    });
  }

  async applyValidationOutcome({ context, profileId, validationRun }) {
    if (!context?.permissions?.includes("model:validate") || !context.workerId) {
      fail("model_validator_required", "Model validation worker permission is required", { status: 403 });
    }
    const current = await this.#profile(profileId);
    if (!validationRun || !new Set(["certified", "failed"]).has(validationRun.state)
      || validationRun.plan?.profile?.profileKey !== current.profileKey
      || validationRun.plan?.profile?.fingerprint !== current.fingerprint
      || current.state !== "validating" || current.validationRunId !== validationRun.runId) {
      fail("model_lifecycle_validation_mismatch", "Terminal validation does not match the active profile lifecycle", { status: 409 });
    }
    const refs = evidenceRefs(validationRun.stages.flatMap((stage) =>
      (stage.result?.evidence ?? []).map((item) => item.reference)));
    const nextState = validationRun.state === "certified" ? "certified" : "failed";
    const reasonKey = validationRun.state === "certified"
      ? "model.lifecycle.validation_passed"
      : "model.lifecycle.validation_failed";
    const updated = await this.#repository.transitionLifecycle({
      profileId, expectedRevision: current.revision, expectedState: current.state,
      nextState, reasonKey, evidenceRefs: refs, validationRunId: validationRun.runId,
      actorIdentityId: null, occurredAt: this.#clock(),
    });
    await this.#audit({
      event: "model_profile.validation_outcome_applied", workerId: context.workerId,
      profileId, profileKey: current.profileKey, validationRunId: validationRun.runId,
      toState: nextState, revision: updated.revision, evidenceRefs: refs,
    });
    return visibleProfile(updated);
  }

  async requireRevalidation({ context, profileId, reasonKey, evidenceRefs: refs = [] }) {
    if (!context?.permissions?.includes("model:validate") || !context.workerId) {
      fail("model_validator_required", "Model validation worker permission is required", { status: 403 });
    }
    const current = await this.#profile(profileId);
    if (current.state === "revalidation_required") return visibleProfile(current);
    if (current.state !== "certified") {
      fail("model_lifecycle_transition_invalid", "Only a Certified profile can require revalidation", { status: 409 });
    }
    const normalizedReason = key(reasonKey, "Revalidation reason");
    const normalizedEvidence = evidenceRefs(refs);
    const updated = await this.#repository.transitionLifecycle({
      profileId, expectedRevision: current.revision, expectedState: "certified",
      nextState: "revalidation_required", reasonKey: normalizedReason,
      evidenceRefs: normalizedEvidence, validationRunId: null,
      actorIdentityId: null, occurredAt: this.#clock(),
    });
    await this.#audit({
      event: "model_profile.revalidation_required", workerId: context.workerId,
      profileId, profileKey: current.profileKey, revision: updated.revision,
      reasonKey: normalizedReason, evidenceRefs: normalizedEvidence,
    });
    return visibleProfile(updated);
  }

  async setExperimentalOptIn({ context, policyKey, environment, profileId, enabled, reasonKey, expiresAt }) {
    requireManager(context);
    const normalizedPolicy = key(policyKey, "Routing policy");
    if (!new Set(["development", "validation"]).has(environment) || !UUID.test(profileId ?? "") || typeof enabled !== "boolean") {
      fail("model_experimental_policy_invalid", "Experimental routing is allowed only for an explicit non-production policy");
    }
    const profile = await this.#profile(profileId);
    if (enabled && profile.state !== "experimental") {
      fail("model_experimental_policy_invalid", "Only an Experimental profile can be explicitly enabled", { status: 409 });
    }
    const expiry = iso(expiresAt, "Experimental routing expiry");
    const lifetime = expiry.getTime() - this.#clock().getTime();
    if (lifetime <= 0 || lifetime > 30 * 24 * 3600_000) {
      fail("model_experimental_policy_invalid", "Experimental routing opt-in must expire within 30 days");
    }
    const normalizedReason = key(reasonKey, "Experimental routing reason");
    const record = await this.#repository.upsertExperimentalOptIn({
      policyKey: normalizedPolicy, environment, profileId, enabled,
      reasonKey: normalizedReason, expiresAt: expiry,
      actorIdentityId: context.identityId ?? null, occurredAt: this.#clock(),
    });
    await this.#audit({
      event: "model_profile.experimental_routing_changed", actorId: context.identityId ?? null,
      policyKey: normalizedPolicy, environment, profileId, enabled,
      reasonKey: normalizedReason, expiresAt: expiry.toISOString(),
    });
    return visibleOptIn(record);
  }

  async routingPolicy({ policyKey, environment }) {
    const normalizedPolicy = key(policyKey, "Routing policy");
    if (environment === "production") {
      return Object.freeze({ policyKey: normalizedPolicy, environment, experimentalProfileIds: Object.freeze([]) });
    }
    if (!new Set(["development", "validation"]).has(environment)) {
      fail("model_experimental_policy_invalid", "Routing policy environment is invalid");
    }
    const records = await this.#repository.listExperimentalOptIns({
      policyKey: normalizedPolicy, environment, now: this.#clock(),
    });
    const experimentalProfileIds = [];
    for (const record of records) {
      const profile = await this.#repository.findProfile(record.profileId);
      if (record.enabled && profile?.state === "experimental") experimentalProfileIds.push(record.profileId);
    }
    return Object.freeze({
      policyKey: normalizedPolicy, environment,
      experimentalProfileIds: Object.freeze([...new Set(experimentalProfileIds)].sort()),
    });
  }

  async #profile(profileId) {
    if (!UUID.test(profileId ?? "")) fail("model_profile_not_found", "Model profile was not found", { status: 404 });
    const profile = await this.#repository.findProfile(profileId);
    if (!profile) fail("model_profile_not_found", "Model profile was not found", { status: 404 });
    if (!MODEL_PROFILE_LIFECYCLE_STATES.includes(profile.state)) {
      fail("model_lifecycle_state_invalid", "Model profile lifecycle state is invalid", { status: 500 });
    }
    return profile;
  }
}
