import { createHash } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EVIDENCE = /^(?:object|evidence):\/\/[A-Za-z0-9/._:-]{1,2000}$/;
export const MODEL_REVALIDATION_FACTS = Object.freeze([
  "modelArtifactDigest", "quantizationRecipeDigest", "engineDigest", "containerImageDigest",
  "driverVersion", "osRelease", "kernelVersion", "cudaInterfaceVersion",
  "containerToolkitVersion", "hardwareDigest", "configurationDigest", "testCorpusDigest",
]);
const DIGEST_FACTS = new Set(MODEL_REVALIDATION_FACTS.filter((key) => key.endsWith("Digest")));

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function canonical(value) {
  if (value === null || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function refs(values) {
  if (!Array.isArray(values) || values.length > 128 || values.some((value) => typeof value !== "string" || !EVIDENCE.test(value))) {
    fail("model_revalidation_input_invalid", "Revalidation evidence references are invalid");
  }
  return [...new Set(values)].sort();
}
function facts(value, { observed = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !MODEL_REVALIDATION_FACTS.includes(key))) {
    fail("model_revalidation_input_invalid", "Revalidation facts are invalid");
  }
  const normalized = {};
  for (const key of MODEL_REVALIDATION_FACTS) {
    const item = value[key];
    if (observed && (item === null || item === undefined)) { normalized[key] = null; continue; }
    if (typeof item !== "string" || item.length < 1 || item.length > 512 || (DIGEST_FACTS.has(key) && !DIGEST.test(item))) {
      fail("model_revalidation_input_invalid", `Revalidation fact ${key} is invalid`);
    }
    normalized[key] = item;
  }
  return Object.freeze(normalized);
}
function publicBaseline(record) {
  return Object.freeze({
    id: record.id, profileId: record.profileId, lifecycleRevision: record.lifecycleRevision,
    validationRunId: record.validationRunId, facts: Object.freeze(structuredClone(record.facts)),
    factsDigest: record.factsDigest, evidenceRefs: Object.freeze(structuredClone(record.evidenceRefs)),
    recordedAt: new Date(record.recordedAt).toISOString(),
  });
}

export class ModelRevalidationService {
  #repository;
  #lifecycle;
  #validationRuns;
  #clock;
  #audit;
  constructor({ repository, lifecycle, validationRuns, clock = () => new Date(), audit = async () => {} }) {
    const methods = ["putBaseline", "getLatestBaseline", "recordCheck"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function")
      || !lifecycle?.getProfile || !lifecycle?.requireRevalidation || !validationRuns?.getRun) {
      throw new TypeError("model revalidation dependencies are incomplete");
    }
    this.#repository = repository; this.#lifecycle = lifecycle;
    this.#validationRuns = validationRuns; this.#clock = clock; this.#audit = audit;
  }

  async recordCertificationBaseline({ context, profileId, lifecycleRevision, validationRunId, facts: input, evidenceRefs = [] }) {
    if (!context?.permissions?.includes("model:manage")) fail("model_manager_required", "Model management permission is required", 403);
    if (!UUID.test(profileId ?? "") || !UUID.test(validationRunId ?? "") || !Number.isSafeInteger(lifecycleRevision) || lifecycleRevision < 1) {
      fail("model_revalidation_input_invalid", "Certification baseline identity is invalid");
    }
    const [profile, run] = await Promise.all([
      this.#lifecycle.getProfile(context, profileId), this.#validationRuns.getRun(validationRunId),
    ]);
    if (profile.state !== "certified" || profile.revision !== lifecycleRevision
      || profile.validationRunId !== validationRunId || run?.state !== "certified") {
      fail("model_revalidation_baseline_blocked", "Only the active Certified validation lineage can establish a baseline", 409);
    }
    const normalized = facts(input); const normalizedRefs = refs(evidenceRefs);
    const result = await this.#repository.putBaseline({
      profileId, lifecycleRevision, validationRunId, facts: normalized,
      factsDigest: digest(normalized), evidenceRefs: normalizedRefs,
      actorIdentityId: context.identityId ?? null, recordedAt: this.#clock(),
    });
    await this.#audit({
      event: "model_profile.certification_baseline_recorded", actorId: context.identityId ?? null,
      profileId, lifecycleRevision, validationRunId, factsDigest: result.baseline.factsDigest,
      created: result.created, evidenceRefs: normalizedRefs,
    });
    return { ...result, baseline: publicBaseline(result.baseline) };
  }

  async evaluate({ context, profileId, observedFacts, evidenceRefs = [] }) {
    if (!context?.permissions?.includes("model:validate") || !context.workerId) {
      fail("model_validator_required", "Model validation worker permission is required", 403);
    }
    if (!UUID.test(profileId ?? "")) fail("model_revalidation_input_invalid", "Model profile identity is invalid");
    const baseline = await this.#repository.getLatestBaseline(profileId);
    if (!baseline) fail("model_revalidation_baseline_missing", "Certification baseline is unavailable", 409);
    const observed = facts(observedFacts, { observed: true });
    const normalizedRefs = refs(evidenceRefs);
    const changes = MODEL_REVALIDATION_FACTS
      .filter((dimension) => baseline.facts[dimension] !== observed[dimension])
      .map((dimension) => ({
        dimension,
        expected: baseline.facts[dimension],
        observed: observed[dimension],
        status: observed[dimension] === null ? "unknown" : "changed",
      }));
    const outcome = changes.length ? "revalidation_required" : "current";
    let lifecycle = null;
    if (changes.length) {
      lifecycle = await this.#lifecycle.requireRevalidation({
        context, profileId, reasonKey: "model.lifecycle.environment_changed",
        evidenceRefs: normalizedRefs,
      });
    }
    const check = await this.#repository.recordCheck({
      profileId, baselineId: baseline.id, observedFacts: observed,
      observedFactsDigest: digest(observed), changedDimensions: changes,
      outcome, evidenceRefs: normalizedRefs, workerId: context.workerId,
      checkedAt: this.#clock(),
    });
    await this.#audit({
      event: "model_profile.revalidation_checked", workerId: context.workerId,
      profileId, baselineId: baseline.id, outcome,
      changedDimensions: changes.map(({ dimension, status }) => ({ dimension, status })),
      evidenceRefs: normalizedRefs,
    });
    return Object.freeze({
      outcome, baseline: publicBaseline(baseline),
      observedFactsDigest: check.observedFactsDigest,
      changedDimensions: Object.freeze(structuredClone(changes)),
      lifecycle,
      checkedAt: new Date(check.checkedAt).toISOString(),
    });
  }
}
