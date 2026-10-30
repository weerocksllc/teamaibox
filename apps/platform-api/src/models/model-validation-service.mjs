import { createHash, randomUUID } from "node:crypto";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const KEY = /^[a-z][a-z0-9_.-]{2,191}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IMAGE = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MODEL_VALIDATION_STAGES = Object.freeze([
  "discovery", "build", "smoke", "conformance", "quality", "benchmark",
  "stress_soak", "coexistence_cluster", "security", "certification",
]);

export class ModelValidationError extends Error {
  constructor(code, message) { super(message); this.name = "ModelValidationError"; this.code = code; }
}
function fail(code, message) { throw new ModelValidationError(code, message); }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("model_validation_plan_invalid", `${label} must be an object`); return value; }
function exact(value, required, optional, label) {
  record(value, label); const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("model_validation_plan_invalid", `${label}.${key} is unsupported`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("model_validation_plan_invalid", `${label}.${key} is required`);
  return value;
}
function text(value, label, { pattern, maximum = 512 } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || (pattern && !pattern.test(value))) fail("model_validation_plan_invalid", `${label} is invalid`);
  return value;
}
function digest(value, label) { return text(value, label, { pattern: DIGEST, maximum: 71 }); }
function integer(value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("model_validation_plan_invalid", `${label} is invalid`); return value; }
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  fail("model_validation_plan_invalid", "validation value cannot be canonicalized");
}
function sha(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function timestamp(value, label) { const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("model_validation_result_invalid", `${label} is invalid`); return value; }
function visible(run) {
  if (!run) return null;
  const result = structuredClone(run); delete result.operationKey;
  for (const stage of result.stages) delete stage.claim;
  return Object.freeze(result);
}

export function normalizeModelValidationPlan(input) {
  exact(input, ["runKey", "profile", "build", "deployment", "corpusDigest", "policyDigest", "stages"], [], "plan");
  exact(input.profile, ["profileKey", "fingerprint"], [], "plan.profile");
  exact(input.build, ["jobId", "fingerprint"], [], "plan.build");
  exact(input.deployment, ["jobId", "fingerprint"], [], "plan.deployment");
  if (!Array.isArray(input.stages) || input.stages.length !== MODEL_VALIDATION_STAGES.length) fail("model_validation_plan_invalid", "validation plan must declare every stage exactly once");
  const stages = input.stages.map((item, ordinal) => {
    exact(item, ["stage", "executorImage", "suiteDigest", "configurationDigest", "timeoutSeconds", "exclusive", "evidenceKinds"], [], `plan.stages[${ordinal}]`);
    if (item.stage !== MODEL_VALIDATION_STAGES[ordinal]) fail("model_validation_plan_invalid", "validation stages are missing, duplicated, or out of order");
    if (!Array.isArray(item.evidenceKinds) || item.evidenceKinds.length < 1 || item.evidenceKinds.length > 32
      || new Set(item.evidenceKinds).size !== item.evidenceKinds.length) fail("model_validation_plan_invalid", "validation evidence kinds are invalid");
    return {
      stage: item.stage,
      executorImage: text(item.executorImage, "stage.executorImage", { pattern: IMAGE, maximum: 512 }),
      suiteDigest: digest(item.suiteDigest, "stage.suiteDigest"),
      configurationDigest: digest(item.configurationDigest, "stage.configurationDigest"),
      timeoutSeconds: integer(item.timeoutSeconds, "stage.timeoutSeconds", 1, 7 * 24 * 3600),
      exclusive: typeof item.exclusive === "boolean" ? item.exclusive : fail("model_validation_plan_invalid", "stage.exclusive must be boolean"),
      evidenceKinds: [...item.evidenceKinds].map((kind) => text(kind, "stage.evidenceKind", { pattern: KEY, maximum: 128 })).sort(),
    };
  });
  return Object.freeze({
    schemaVersion: 1,
    runKey: text(input.runKey, "plan.runKey", { pattern: KEY, maximum: 192 }),
    profile: { profileKey: text(input.profile.profileKey, "plan.profile.profileKey", { pattern: KEY, maximum: 192 }), fingerprint: digest(input.profile.fingerprint, "plan.profile.fingerprint") },
    build: { jobId: text(input.build.jobId, "plan.build.jobId", { pattern: UUID }), fingerprint: digest(input.build.fingerprint, "plan.build.fingerprint") },
    deployment: { jobId: text(input.deployment.jobId, "plan.deployment.jobId", { pattern: UUID }), fingerprint: digest(input.deployment.fingerprint, "plan.deployment.fingerprint") },
    corpusDigest: digest(input.corpusDigest, "plan.corpusDigest"),
    policyDigest: digest(input.policyDigest, "plan.policyDigest"), stages,
  });
}

function validationResult(planFingerprint, plan, specification, input) {
  exact(input, ["planFingerprint", "stage", "outcome", "executorImage", "suiteDigest", "configurationDigest", "environmentDigest", "evidence", "metricsDigest", "logDigest", "startedAt", "finishedAt"], ["qualityGate", "benchmarkGate"], "result");
  if (input.planFingerprint !== planFingerprint || input.stage !== specification.stage
    || input.executorImage !== specification.executorImage || input.suiteDigest !== specification.suiteDigest
    || input.configurationDigest !== specification.configurationDigest) fail("model_validation_result_mismatch", "validation result does not match its immutable stage specification");
  if (!new Set(["passed", "failed", "incomplete"]).has(input.outcome)) fail("model_validation_result_invalid", "validation outcome is invalid");
  if (!Array.isArray(input.evidence) || input.evidence.length !== specification.evidenceKinds.length) fail("model_validation_result_invalid", "validation evidence set is incomplete");
  const expectedKinds = new Set(specification.evidenceKinds);
  const evidence = input.evidence.map((item, index) => {
    exact(item, ["kind", "digest", "sizeBytes", "mediaType", "reference"], [], `result.evidence[${index}]`);
    if (!expectedKinds.delete(item.kind)) fail("model_validation_result_invalid", "validation evidence kind is missing or duplicated");
    return {
      kind: item.kind, digest: digest(item.digest, "evidence.digest"),
      sizeBytes: integer(item.sizeBytes, "evidence.sizeBytes"),
      mediaType: text(item.mediaType, "evidence.mediaType", { maximum: 256 }),
      reference: text(item.reference, "evidence.reference", { pattern: /^object:\/\/[A-Za-z0-9/._:-]+$/, maximum: 2048 }),
    };
  }).sort((a, b) => a.kind.localeCompare(b.kind));
  const startedAt = timestamp(input.startedAt, "result.startedAt"); const finishedAt = timestamp(input.finishedAt, "result.finishedAt");
  if (finishedAt <= startedAt) fail("model_validation_result_invalid", "validation result interval is invalid");
  let qualityGate = null;
  if (specification.stage === "quality" && input.outcome !== "incomplete") {
    exact(input.qualityGate, ["suiteDigest", "corpusDigest", "profileFingerprint", "reportDigest", "outcome", "failedMeasurements"], [], "result.qualityGate");
    if (input.qualityGate.suiteDigest !== specification.suiteDigest
      || input.qualityGate.corpusDigest !== plan.corpusDigest
      || input.qualityGate.profileFingerprint !== plan.profile.fingerprint
      || input.qualityGate.reportDigest !== input.metricsDigest
      || !new Set(["passed", "failed"]).has(input.qualityGate.outcome)
      || !Number.isSafeInteger(input.qualityGate.failedMeasurements)
      || input.qualityGate.failedMeasurements < 0
      || (input.qualityGate.outcome === "passed" && input.qualityGate.failedMeasurements !== 0)
      || (input.qualityGate.outcome === "failed" && input.qualityGate.failedMeasurements < 1)
      || input.qualityGate.outcome !== input.outcome) {
      fail("model_validation_quality_gate_failed", "quality-stage outcome does not match its pinned fail-closed quality report");
    }
    qualityGate = Object.freeze(structuredClone(input.qualityGate));
  } else if (input.qualityGate !== undefined) {
    fail("model_validation_result_invalid", "quality gate is accepted only for a completed quality stage");
  }
  let benchmarkGate = null;
  if (specification.stage === "benchmark" && input.outcome !== "incomplete") {
    exact(input.benchmarkGate, ["suiteDigest", "inputSetDigest", "profileFingerprint", "reportDigest", "comparisonKey", "outcome", "failedScenarios"], [], "result.benchmarkGate");
    if (input.benchmarkGate.suiteDigest !== specification.suiteDigest
      || input.benchmarkGate.inputSetDigest !== plan.corpusDigest
      || input.benchmarkGate.profileFingerprint !== plan.profile.fingerprint
      || input.benchmarkGate.reportDigest !== input.metricsDigest
      || !DIGEST.test(input.benchmarkGate.comparisonKey)
      || !new Set(["completed", "failed"]).has(input.benchmarkGate.outcome)
      || !Number.isSafeInteger(input.benchmarkGate.failedScenarios)
      || input.benchmarkGate.failedScenarios < 0
      || (input.benchmarkGate.outcome === "completed" && (input.benchmarkGate.failedScenarios !== 0 || input.outcome !== "passed"))
      || (input.benchmarkGate.outcome === "failed" && (input.benchmarkGate.failedScenarios < 1 || input.outcome !== "failed"))) {
      fail("model_validation_benchmark_gate_failed", "benchmark-stage outcome does not match its pinned complete performance report");
    }
    benchmarkGate = Object.freeze(structuredClone(input.benchmarkGate));
  } else if (input.benchmarkGate !== undefined) {
    fail("model_validation_result_invalid", "benchmark gate is accepted only for a completed benchmark stage");
  }
  return Object.freeze({
    schemaVersion: 1, planFingerprint, stage: input.stage, outcome: input.outcome,
    executorImage: input.executorImage, suiteDigest: input.suiteDigest,
    configurationDigest: input.configurationDigest,
    environmentDigest: digest(input.environmentDigest, "result.environmentDigest"), evidence,
    metricsDigest: digest(input.metricsDigest, "result.metricsDigest"),
    logDigest: digest(input.logDigest, "result.logDigest"), qualityGate, benchmarkGate, startedAt, finishedAt,
  });
}

export class ModelValidationService {
  #repository; #profiles; #engines; #evidence; #lifecycle; #clock; #audit;
  constructor({ repository, profileCatalog, engineJobs, evidenceStore, lifecycle = null, clock = () => new Date(), audit = async () => {} }) {
    for (const method of ["createRun", "getRun", "claimNextStage", "verifyStageClaim", "completeStage"]) if (typeof repository?.[method] !== "function") throw new TypeError(`model validation repository.${method} is required`);
    if (!profileCatalog?.getByKey || !engineJobs?.getBuild || !engineJobs?.getDeployment || !evidenceStore?.verify) throw new TypeError("model validation dependencies are incomplete");
    if (lifecycle !== null && (!lifecycle?.beginValidation || !lifecycle?.applyValidationOutcome)) throw new TypeError("model lifecycle integration is incomplete");
    this.#repository = repository; this.#profiles = profileCatalog; this.#engines = engineJobs; this.#evidence = evidenceStore; this.#lifecycle = lifecycle; this.#clock = clock; this.#audit = audit;
  }
  #admin(context) { if (!context?.permissions?.includes("model:manage")) fail("model_manager_required", "model management permission is required"); }
  #worker(context) { if (!context?.permissions?.includes("model:validate") || !context.workerId) fail("model_validator_required", "model validation worker permission is required"); }

  async createRun({ context, plan, operationKey }) {
    this.#admin(context); text(operationKey, "operationKey", { pattern: OPERATION, maximum: 128 });
    const normalized = normalizeModelValidationPlan(plan);
    const profile = await this.#profiles.getByKey(normalized.profile.profileKey);
    if (!profile || profile.fingerprint !== normalized.profile.fingerprint) fail("model_validation_input_unavailable", "immutable model profile does not match validation plan");
    const build = await this.#engines.getBuild(normalized.build.jobId);
    const deployment = await this.#engines.getDeployment(normalized.deployment.jobId);
    if (!build || build.state !== "succeeded" || build.fingerprint !== normalized.build.fingerprint
      || !deployment || deployment.state !== "succeeded" || deployment.fingerprint !== normalized.deployment.fingerprint
      || deployment.specification.buildJobId !== build.jobId) fail("model_validation_input_unavailable", "successful build/deployment lineage does not match validation plan");
    const fingerprint = sha(normalized);
    const result = await this.#repository.createRun({ plan: normalized, fingerprint, operationKey, requestedBy: context.identityId ?? null });
    if (this.#lifecycle && profile.profile?.profileId) {
      await this.#lifecycle.beginValidation({ context, profileId: profile.profile.profileId, validationRun: result.run });
    }
    await this.#audit({ event: "model_validation.run_created", actorId: context.identityId ?? null, runId: result.run.runId, fingerprint, profileKey: normalized.profile.profileKey, created: result.created });
    return { ...result, run: visible(result.run) };
  }

  async claimNextStage({ context, runId, leaseMilliseconds = 300_000 }) {
    this.#worker(context); integer(leaseMilliseconds, "leaseMilliseconds", 1, 24 * 3600 * 1000);
    const claimToken = randomUUID(); const expiresAt = new Date(this.#clock().getTime() + leaseMilliseconds).toISOString();
    const claimed = await this.#repository.claimNextStage({ runId, workerId: context.workerId, claimToken, expiresAt });
    const { claim: _claim, ...stage } = claimed.stage;
    return Object.freeze({ run: visible(claimed.run), stage: Object.freeze(stage), claimToken, expiresAt });
  }

  async completeStage({ context, runId, ordinal, claimToken, result }) {
    this.#worker(context); integer(ordinal, "ordinal", 0, MODEL_VALIDATION_STAGES.length - 1); text(claimToken, "claimToken", { maximum: 128 });
    if (!(await this.#repository.verifyStageClaim({ runId, ordinal, workerId: context.workerId, claimToken }))) fail("model_validation_fenced", "model validation completion is fenced");
    const run = await this.#repository.getRun(runId);
    if (!run || ordinal !== run.currentOrdinal) fail("model_validation_sequence_conflict", "model validation stage is out of sequence");
    const verified = validationResult(run.fingerprint, run.plan, run.stages[ordinal].specification, result);
    for (const item of verified.evidence) {
      const exists = await this.#evidence.verify(item);
      if (!exists) fail("model_validation_evidence_unavailable", "validation evidence is not verified in protected storage");
    }
    const completed = await this.#repository.completeStage({ runId, ordinal, workerId: context.workerId, claimToken, result: verified });
    if (this.#lifecycle && new Set(["certified", "failed"]).has(completed.run.state)) {
      const profile = await this.#profiles.getByKey(completed.run.plan.profile.profileKey);
      if (!profile?.profile?.profileId) fail("model_validation_input_unavailable", "immutable model profile identity is unavailable");
      await this.#lifecycle.applyValidationOutcome({ context, profileId: profile.profile.profileId, validationRun: completed.run });
    }
    await this.#audit({ event: "model_validation.stage_completed", workerId: context.workerId, runId, stage: verified.stage, outcome: verified.outcome, evidenceDigests: verified.evidence.map((item) => item.digest), environmentDigest: verified.environmentDigest });
    return { run: visible(completed.run), stage: Object.freeze(structuredClone(completed.stage)) };
  }
}

export { sha as modelValidationDigest };
