import { createHash, randomUUID } from "node:crypto";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const KEY = /^[a-z][a-z0-9_.-]{2,191}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IMAGE = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const SECRET_KEY = /(secret|password|credential|bearer|access.?key|private.?key|token)/i;
const BUILD_KINDS = new Set(["passthrough", "export", "quantize", "quantize-export"]);
const OUTPUT_ROLES = new Set(["weights", "engine", "config", "tokenizer", "adapter", "other"]);

export class ModelEngineJobError extends Error {
  constructor(code, message) { super(message); this.name = "ModelEngineJobError"; this.code = code; }
}
function fail(code, message) { throw new ModelEngineJobError(code, message); }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("model_engine_spec_invalid", `${label} must be an object`); return value; }
function exact(value, required, optional, label) {
  record(value, label); const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("model_engine_spec_invalid", `${label}.${key} is unsupported`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("model_engine_spec_invalid", `${label}.${key} is required`);
  return value;
}
function text(value, label, { pattern, maximum = 512 } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || (pattern && !pattern.test(value))) fail("model_engine_spec_invalid", `${label} is invalid`);
  return value;
}
function integer(value, label, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail("model_engine_spec_invalid", `${label} is invalid`); return value; }
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  fail("model_engine_spec_invalid", "value cannot be canonicalized");
}
function digestOf(value) { return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex")}`; }
function digest(value, label) { return text(value, label, { pattern: DIGEST, maximum: 71 }); }
function safeParameters(value, depth = 0) {
  if (depth > 8) fail("model_engine_spec_invalid", "build parameters are too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 256) fail("model_engine_spec_invalid", "build parameter array is too large");
    return value.map((item) => safeParameters(item, depth + 1));
  }
  record(value, "parameters");
  if (Object.keys(value).length > 256) fail("model_engine_spec_invalid", "build parameter object is too large");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) || SECRET_KEY.test(key)) fail("model_engine_spec_invalid", "build parameters contain a forbidden key");
    result[key] = safeParameters(item, depth + 1);
  }
  return result;
}
function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("model_engine_result_invalid", `${label} is not a canonical timestamp`);
  return value;
}
function visible(job) {
  if (!job) return null;
  const { operationKey: _operationKey, claim: _claim, ...result } = job;
  return Object.freeze(structuredClone(result));
}

function runtime(value, label) {
  exact(value, ["os", "architecture", "cudaVersion", "engine", "engineVersion", "framework", "frameworkVersion"], [], label);
  if (value.architecture !== "linux/arm64/v8") fail("model_engine_spec_invalid", `${label}.architecture must be linux/arm64/v8`);
  const version = (item, name) => text(item, name, { pattern: /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/, maximum: 64 });
  return {
    os: text(value.os, `${label}.os`, { maximum: 128 }), architecture: value.architecture,
    cudaVersion: version(value.cudaVersion, `${label}.cudaVersion`),
    engine: text(value.engine, `${label}.engine`, { pattern: KEY, maximum: 128 }),
    engineVersion: version(value.engineVersion, `${label}.engineVersion`),
    framework: text(value.framework, `${label}.framework`, { pattern: KEY, maximum: 128 }),
    frameworkVersion: version(value.frameworkVersion, `${label}.frameworkVersion`),
  };
}

export function normalizeEngineBuildSpecification(input) {
  exact(input, ["buildKey", "candidateId", "source", "builder", "runtime", "recipe", "outputs", "environment", "resources"], [], "build");
  exact(input.source, ["model", "revision", "artifactDigest"], [], "build.source");
  exact(input.builder, ["image", "entrypointDigest"], [], "build.builder");
  const recipe = exact(input.recipe, ["kind", "scheme", "tool", "toolVersion", "parameters", "parametersDigest", "calibrationDatasetDigest", "recipeDigest"], [], "build.recipe");
  if (!BUILD_KINDS.has(recipe.kind)) fail("model_engine_spec_invalid", "build.recipe.kind is invalid");
  record(recipe.parameters, "build.recipe.parameters");
  const parameters = safeParameters(recipe.parameters);
  const parametersDigest = digest(recipe.parametersDigest, "build.recipe.parametersDigest");
  if (digestOf(parameters) !== parametersDigest) fail("model_engine_spec_invalid", "build parameter digest does not match canonical parameters");
  const normalizedRecipeMaterial = {
    kind: recipe.kind, scheme: recipe.scheme === null ? null : text(recipe.scheme, "build.recipe.scheme", { pattern: KEY, maximum: 128 }),
    tool: text(recipe.tool, "build.recipe.tool", { maximum: 256 }),
    toolVersion: text(recipe.toolVersion, "build.recipe.toolVersion", { maximum: 128 }),
    parameters, parametersDigest,
    calibrationDatasetDigest: recipe.calibrationDatasetDigest === null ? null : digest(recipe.calibrationDatasetDigest, "build.recipe.calibrationDatasetDigest"),
  };
  if (new Set(["quantize", "quantize-export"]).has(recipe.kind) && (!normalizedRecipeMaterial.scheme || !normalizedRecipeMaterial.calibrationDatasetDigest)) {
    fail("model_engine_spec_invalid", "quantization requires exact scheme and calibration dataset digest");
  }
  if (!new Set(["quantize", "quantize-export"]).has(recipe.kind) && (normalizedRecipeMaterial.scheme !== null || normalizedRecipeMaterial.calibrationDatasetDigest !== null)) {
    fail("model_engine_spec_invalid", "non-quantized build cannot declare quantization inputs");
  }
  const recipeDigest = digest(recipe.recipeDigest, "build.recipe.recipeDigest");
  if (digestOf(normalizedRecipeMaterial) !== recipeDigest) fail("model_engine_spec_invalid", "recipe digest does not match canonical recipe");
  if (!Array.isArray(input.outputs) || input.outputs.length < 1 || input.outputs.length > 128) fail("model_engine_spec_invalid", "build.outputs is invalid");
  const names = new Set();
  const outputs = input.outputs.map((item, index) => {
    exact(item, ["name", "role", "mediaType"], [], `build.outputs[${index}]`);
    const name = text(item.name, `build.outputs[${index}].name`, { pattern: KEY, maximum: 128 });
    if (names.has(name) || !OUTPUT_ROLES.has(item.role)) fail("model_engine_spec_invalid", "build outputs are duplicated or unsupported");
    names.add(name);
    return { name, role: item.role, mediaType: text(item.mediaType, `build.outputs[${index}].mediaType`, { maximum: 256 }) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  exact(input.environment, ["networkMode", "sourceDateEpoch", "locale", "timezone"], [], "build.environment");
  if (input.environment.networkMode !== "none" || input.environment.locale !== "C.UTF-8" || input.environment.timezone !== "UTC") fail("model_engine_spec_invalid", "build environment must be offline and locale/timezone deterministic");
  exact(input.resources, ["exclusive", "cpuMillis", "unifiedMemoryBytes", "storageBytes"], [], "build.resources");
  if (input.resources.exclusive !== true) fail("model_engine_spec_invalid", "model engine builds must be node-exclusive");
  return Object.freeze({
    schemaVersion: 1,
    buildKey: text(input.buildKey, "build.buildKey", { pattern: KEY, maximum: 192 }),
    candidateId: text(input.candidateId, "build.candidateId", { pattern: KEY, maximum: 192 }),
    source: {
      model: text(input.source.model, "build.source.model", { maximum: 512 }),
      revision: text(input.source.revision, "build.source.revision", { maximum: 256 }),
      artifactDigest: digest(input.source.artifactDigest, "build.source.artifactDigest"),
    },
    builder: {
      image: text(input.builder.image, "build.builder.image", { pattern: IMAGE, maximum: 512 }),
      entrypointDigest: digest(input.builder.entrypointDigest, "build.builder.entrypointDigest"),
    },
    runtime: runtime(input.runtime, "build.runtime"),
    recipe: { ...normalizedRecipeMaterial, recipeDigest }, outputs,
    environment: {
      networkMode: "none", sourceDateEpoch: integer(input.environment.sourceDateEpoch, "build.environment.sourceDateEpoch", 1),
      locale: "C.UTF-8", timezone: "UTC",
    },
    resources: {
      exclusive: true, cpuMillis: integer(input.resources.cpuMillis, "build.resources.cpuMillis", 1),
      unifiedMemoryBytes: integer(input.resources.unifiedMemoryBytes, "build.resources.unifiedMemoryBytes", 1),
      storageBytes: integer(input.resources.storageBytes, "build.resources.storageBytes", 1),
    },
  });
}

function buildResult(specification, fingerprint, input) {
  exact(input, ["specificationFingerprint", "builderImage", "runtime", "recipeDigest", "parametersDigest", "calibrationDatasetDigest", "outputs", "provenanceDigest", "sbomDigest", "logDigest", "environmentDigest", "startedAt", "finishedAt"], [], "result");
  if (input.specificationFingerprint !== fingerprint || input.builderImage !== specification.builder.image
    || canonical(runtime(input.runtime, "result.runtime")) !== canonical(specification.runtime)
    || input.recipeDigest !== specification.recipe.recipeDigest
    || input.parametersDigest !== specification.recipe.parametersDigest
    || input.calibrationDatasetDigest !== specification.recipe.calibrationDatasetDigest) fail("model_engine_result_mismatch", "build result does not reproduce the pinned specification");
  if (!Array.isArray(input.outputs) || input.outputs.length !== specification.outputs.length) fail("model_engine_result_invalid", "build result output set is incomplete");
  const expected = new Map(specification.outputs.map((item) => [item.name, item]));
  const outputs = input.outputs.map((item, index) => {
    exact(item, ["name", "role", "mediaType", "digest", "sizeBytes"], [], `result.outputs[${index}]`);
    const declaration = expected.get(item.name);
    if (!declaration || declaration.role !== item.role || declaration.mediaType !== item.mediaType) fail("model_engine_result_mismatch", "build result output contract changed");
    expected.delete(item.name);
    return { ...declaration, digest: digest(item.digest, "result.output.digest"), sizeBytes: integer(item.sizeBytes, "result.output.sizeBytes", 1) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (expected.size) fail("model_engine_result_invalid", "build result output set is incomplete");
  const startedAt = timestamp(input.startedAt, "result.startedAt");
  const finishedAt = timestamp(input.finishedAt, "result.finishedAt");
  if (finishedAt <= startedAt) fail("model_engine_result_invalid", "build result time interval is invalid");
  return Object.freeze({
    schemaVersion: 1, specificationFingerprint: fingerprint,
    builderImage: input.builderImage, runtime: specification.runtime,
    recipeDigest: input.recipeDigest, parametersDigest: input.parametersDigest,
    calibrationDatasetDigest: input.calibrationDatasetDigest, outputs,
    provenanceDigest: digest(input.provenanceDigest, "result.provenanceDigest"),
    sbomDigest: digest(input.sbomDigest, "result.sbomDigest"),
    logDigest: digest(input.logDigest, "result.logDigest"),
    environmentDigest: digest(input.environmentDigest, "result.environmentDigest"),
    startedAt, finishedAt,
  });
}

export class ModelEngineJobService {
  #repository;
  #artifactCatalog;
  #clock;
  #audit;

  constructor({ repository, artifactCatalog, clock = () => new Date(), audit = async () => {} }) {
    for (const method of ["enqueueBuild", "getBuild", "claimBuild", "verifyBuildClaim", "completeBuild", "failBuild", "enqueueDeployment", "getDeployment", "claimDeployment", "verifyDeploymentClaim", "completeDeployment", "failDeployment"]) {
      if (typeof repository?.[method] !== "function") throw new TypeError(`model engine repository.${method} is required`);
    }
    if (!artifactCatalog?.getArtifact) throw new TypeError("verified model artifact catalog is required");
    this.#repository = repository; this.#artifactCatalog = artifactCatalog; this.#clock = clock; this.#audit = audit;
  }

  #admin(context) { if (!context?.permissions?.includes("model:manage")) fail("model_manager_required", "model management permission is required"); }
  #worker(context) { if (!context?.permissions?.includes("model:build") || !context.workerId) fail("model_builder_required", "model build worker permission is required"); }

  async queueBuild({ context, specification, operationKey }) {
    this.#admin(context); text(operationKey, "operationKey", { pattern: OPERATION, maximum: 128 });
    const normalized = normalizeEngineBuildSpecification(specification);
    const source = await this.#artifactCatalog.getArtifact(normalized.source.artifactDigest, { touch: false });
    if (!source || source.state !== "ready" || source.candidateId !== normalized.candidateId
      || source.sourceRevision !== normalized.source.revision) {
      fail("model_build_input_unavailable", "source model artifact does not match the pinned candidate revision");
    }
    if (normalized.recipe.calibrationDatasetDigest) {
      const calibration = await this.#artifactCatalog.getArtifact(normalized.recipe.calibrationDatasetDigest, { touch: false });
      if (!calibration || calibration.state !== "ready") fail("model_build_input_unavailable", "calibration dataset artifact is not ready in protected storage");
    }
    const fingerprint = digestOf(normalized);
    const result = await this.#repository.enqueueBuild({ specification: normalized, fingerprint, operationKey, requestedBy: context.identityId ?? null });
    await this.#audit({ event: "model_engine_build.queued", actorId: context.identityId ?? null, jobId: result.job.jobId, fingerprint, sourceArtifactDigest: normalized.source.artifactDigest, builderImage: normalized.builder.image, created: result.created });
    return { ...result, job: visible(result.job) };
  }

  async claimBuild({ context, jobId, leaseMilliseconds = 300_000 }) {
    this.#worker(context); integer(leaseMilliseconds, "leaseMilliseconds", 1);
    const claimToken = randomUUID();
    const expiresAt = new Date(this.#clock().getTime() + leaseMilliseconds).toISOString();
    const job = await this.#repository.claimBuild({ jobId, workerId: context.workerId, claimToken, expiresAt });
    return Object.freeze({ job: visible(job), claimToken, expiresAt });
  }

  async completeBuild({ context, jobId, claimToken, result }) {
    this.#worker(context); text(claimToken, "claimToken", { maximum: 128 });
    const job = await this.#repository.getBuild(jobId);
    if (!job) fail("model_engine_job_not_found", "model engine build job was not found");
    if (!(await this.#repository.verifyBuildClaim({ jobId, workerId: context.workerId, claimToken }))) {
      fail("model_engine_job_fenced", "model engine build completion is fenced");
    }
    const verified = buildResult(job.specification, job.fingerprint, result);
    for (const output of verified.outputs) {
      const artifact = await this.#artifactCatalog.getArtifact(output.digest, { touch: false });
      if (!artifact || artifact.state !== "ready" || artifact.sizeBytes !== output.sizeBytes) fail("model_engine_output_unavailable", "build output is not verified in protected model storage");
    }
    const completed = await this.#repository.completeBuild({ jobId, workerId: context.workerId, claimToken, result: verified });
    await this.#audit({ event: "model_engine_build.completed", workerId: context.workerId, jobId, fingerprint: job.fingerprint, outputDigests: verified.outputs.map(({ digest: value }) => value), provenanceDigest: verified.provenanceDigest });
    return visible(completed);
  }

  async failBuild({ context, jobId, claimToken, errorCode }) {
    this.#worker(context); text(errorCode, "errorCode", { pattern: /^[a-z][a-z0-9_]{2,127}$/, maximum: 128 });
    return visible(await this.#repository.failBuild({ jobId, workerId: context.workerId, claimToken, errorCode }));
  }

  async queueDeployment({ context, buildJobId, deployment, operationKey }) {
    this.#admin(context); text(operationKey, "operationKey", { pattern: OPERATION, maximum: 128 });
    const build = await this.#repository.getBuild(buildJobId);
    if (!build || build.state !== "succeeded") fail("model_build_not_ready", "only a successful reproducible build can be deployed");
    exact(deployment, ["deploymentKey", "servingImage", "runtime", "configuration", "configurationDigest", "target", "health"], [], "deployment");
    record(deployment.configuration, "deployment.configuration");
    const configuration = safeParameters(deployment.configuration);
    if (digestOf(configuration) !== deployment.configurationDigest) fail("model_engine_spec_invalid", "deployment configuration digest does not match canonical configuration");
    exact(deployment.target, ["architecture", "acceleratorFamily", "resourceClass", "executionMode"], [], "deployment.target");
    if (deployment.target.architecture !== "linux/arm64/v8" || !new Set(["shared", "exclusive"]).has(deployment.target.executionMode)) fail("model_engine_spec_invalid", "deployment target is invalid");
    exact(deployment.health, ["path", "startupTimeoutSeconds", "successThreshold"], [], "deployment.health");
    const normalized = Object.freeze({
      schemaVersion: 1,
      deploymentKey: text(deployment.deploymentKey, "deployment.deploymentKey", { pattern: KEY, maximum: 192 }),
      buildJobId, buildFingerprint: build.fingerprint,
      outputs: build.result.outputs.map(({ name, role, mediaType, digest: value, sizeBytes }) => ({ name, role, mediaType, digest: value, sizeBytes })),
      servingImage: text(deployment.servingImage, "deployment.servingImage", { pattern: IMAGE, maximum: 512 }),
      runtime: runtime(deployment.runtime, "deployment.runtime"), configuration,
      configurationDigest: digest(deployment.configurationDigest, "deployment.configurationDigest"),
      target: {
        architecture: deployment.target.architecture,
        acceleratorFamily: text(deployment.target.acceleratorFamily, "deployment.target.acceleratorFamily", { pattern: KEY, maximum: 128 }),
        resourceClass: text(deployment.target.resourceClass, "deployment.target.resourceClass", { pattern: KEY, maximum: 128 }),
        executionMode: deployment.target.executionMode,
      },
      health: {
        path: text(deployment.health.path, "deployment.health.path", { pattern: /^\/[A-Za-z0-9/_-]{1,255}$/, maximum: 256 }),
        startupTimeoutSeconds: integer(deployment.health.startupTimeoutSeconds, "deployment.health.startupTimeoutSeconds", 1),
        successThreshold: integer(deployment.health.successThreshold, "deployment.health.successThreshold", 1),
      },
    });
    const fingerprint = digestOf(normalized);
    const queued = await this.#repository.enqueueDeployment({ specification: normalized, fingerprint, operationKey, requestedBy: context.identityId ?? null });
    await this.#audit({ event: "model_engine_deployment.queued", actorId: context.identityId ?? null, jobId: queued.job.jobId, buildJobId, fingerprint, servingImage: normalized.servingImage, created: queued.created });
    return { ...queued, job: visible(queued.job) };
  }

  async claimDeployment({ context, jobId, leaseMilliseconds = 300_000 }) {
    this.#worker(context); integer(leaseMilliseconds, "leaseMilliseconds", 1);
    const claimToken = randomUUID();
    const expiresAt = new Date(this.#clock().getTime() + leaseMilliseconds).toISOString();
    const job = await this.#repository.claimDeployment({ jobId, workerId: context.workerId, claimToken, expiresAt });
    return Object.freeze({ job: visible(job), claimToken, expiresAt });
  }

  async completeDeployment({ context, jobId, claimToken, result }) {
    this.#worker(context); text(claimToken, "claimToken", { maximum: 128 });
    const job = await this.#repository.getDeployment(jobId);
    if (!job) fail("model_engine_job_not_found", "model engine deployment job was not found");
    if (!(await this.#repository.verifyDeploymentClaim({ jobId, workerId: context.workerId, claimToken }))) {
      fail("model_engine_job_fenced", "model engine deployment completion is fenced");
    }
    const specification = job.specification;
    exact(result, ["specificationFingerprint", "servingImage", "runtime", "configurationDigest", "outputDigests", "deploymentManifestDigest", "environmentDigest", "healthEvidenceDigest", "startedAt", "finishedAt"], [], "deploymentResult");
    if (result.specificationFingerprint !== job.fingerprint
      || result.servingImage !== specification.servingImage
      || canonical(runtime(result.runtime, "deploymentResult.runtime")) !== canonical(specification.runtime)
      || result.configurationDigest !== specification.configurationDigest) {
      fail("model_engine_result_mismatch", "deployment result does not reproduce the pinned specification");
    }
    if (!Array.isArray(result.outputDigests)) fail("model_engine_result_invalid", "deployment output digest set is invalid");
    const expected = specification.outputs.map((item) => item.digest).sort();
    const outputDigests = result.outputDigests.map((item) => digest(item, "deploymentResult.outputDigests")).sort();
    if (new Set(outputDigests).size !== outputDigests.length || canonical(outputDigests) !== canonical(expected)) fail("model_engine_result_mismatch", "deployment did not load the exact build outputs");
    const startedAt = timestamp(result.startedAt, "deploymentResult.startedAt");
    const finishedAt = timestamp(result.finishedAt, "deploymentResult.finishedAt");
    if (finishedAt <= startedAt) fail("model_engine_result_invalid", "deployment result time interval is invalid");
    const verified = Object.freeze({
      schemaVersion: 1, specificationFingerprint: job.fingerprint,
      servingImage: result.servingImage, runtime: specification.runtime,
      configurationDigest: result.configurationDigest, outputDigests,
      deploymentManifestDigest: digest(result.deploymentManifestDigest, "deploymentResult.deploymentManifestDigest"),
      environmentDigest: digest(result.environmentDigest, "deploymentResult.environmentDigest"),
      healthEvidenceDigest: digest(result.healthEvidenceDigest, "deploymentResult.healthEvidenceDigest"),
      startedAt, finishedAt,
    });
    const completed = await this.#repository.completeDeployment({ jobId, workerId: context.workerId, claimToken, result: verified });
    await this.#audit({ event: "model_engine_deployment.completed", workerId: context.workerId, jobId, fingerprint: job.fingerprint, deploymentManifestDigest: verified.deploymentManifestDigest, outputDigests });
    return visible(completed);
  }

  async failDeployment({ context, jobId, claimToken, errorCode }) {
    this.#worker(context); text(errorCode, "errorCode", { pattern: /^[a-z][a-z0-9_]{2,127}$/, maximum: 128 });
    return visible(await this.#repository.failDeployment({ jobId, workerId: context.workerId, claimToken, errorCode }));
  }
}

export { canonical as canonicalModelEngineJson, digestOf as modelEngineDigest };
