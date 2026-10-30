import { createHash, randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_.-]{2,191}$/;
const NAME = /^[a-z][a-z0-9_.-]{1,127}$/;
const API = /^[a-z][a-z0-9_.-]{2,127}@v[0-9]+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RANGE = /^(?:[><=~^]{1,2})?[0-9]+(?:\.[0-9]+){0,2}(?:[-+][a-z0-9.-]+)?(?: (?:[><=~^]{1,2})?[0-9]+(?:\.[0-9]+){0,2}(?:[-+][a-z0-9.-]+)?)*$/i;
const PRECISIONS = new Set(["fp32", "bf16", "fp16", "fp8", "nvfp4", "int8", "int4", "awq", "gptq", "other"]);
const QUANTIZED = new Set(["fp8", "nvfp4", "int8", "int4", "awq", "gptq", "other"]);
const DATA_CLASSES = new Set(["public", "internal", "confidential", "restricted"]);
const STAGES = new Set(["discovery", "build", "smoke", "conformance", "quality", "benchmark", "stress_soak", "coexistence_cluster", "security"]);
const FORBIDDEN_EXTENSION_KEY = /(secret|password|credential|bearer|access.?key|private.?key|token)/i;

export class ModelProfileRegistrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelProfileRegistrationError";
    this.code = code;
  }
}

function fail(code, message) { throw new ModelProfileRegistrationError(code, message); }
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("model_profile_invalid", `${label} must be an object`);
  return value;
}
function exact(value, required, optional, label) {
  record(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("model_profile_invalid", `${label}.${key} is unsupported`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("model_profile_invalid", `${label}.${key} is required`);
  return value;
}
function string(value, label, { pattern, maximum = 2048, minimum = 1 } = {}) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || (pattern && !pattern.test(value))) {
    fail("model_profile_invalid", `${label} is invalid`);
  }
  return value;
}
function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("model_profile_invalid", `${label} is invalid`);
  return value;
}
function nullableInteger(value, label, options) { return value === null ? null : integer(value, label, options); }
function timestamp(value, label) {
  const observed = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(observed) || new Date(observed).toISOString() !== value) fail("model_profile_invalid", `${label} must be a canonical timestamp`);
  return value;
}
function uniqueStrings(value, label, { pattern, allowed, maximum = 128, allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum) fail("model_profile_invalid", `${label} is invalid`);
  const result = value.map((item, index) => string(item, `${label}[${index}]`, { pattern, maximum: 2048 }));
  if (new Set(result).size !== result.length || (allowed && result.some((item) => !allowed.has(item)))) fail("model_profile_invalid", `${label} contains duplicate or unsupported values`);
  return [...result].sort();
}
function evidenceRef(value, label) {
  if (value === null) return null;
  const result = string(value, label, { maximum: 2048 });
  if (!/^(?:evidence|object|https):\/\//.test(result)) fail("model_profile_invalid", `${label} must be an evidence, object, or HTTPS reference`);
  return result;
}
function safeSourceUri(value, label) {
  const result = string(value, label, { maximum: 2048 });
  if (result.startsWith("object://")) return result;
  let url;
  try { url = new URL(result); } catch { fail("model_profile_invalid", `${label} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password) fail("model_profile_invalid", `${label} must be HTTPS without credentials`);
  return result;
}
function safeExtensions(value, depth = 0) {
  if (depth > 8) fail("model_profile_invalid", "extensions are too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 128) fail("model_profile_invalid", "extensions array is too large");
    return value.map((item) => safeExtensions(item, depth + 1));
  }
  record(value, "extensions");
  if (Object.keys(value).length > 128) fail("model_profile_invalid", "extensions object is too large");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!NAME.test(key) || FORBIDDEN_EXTENSION_KEY.test(key)) fail("model_profile_invalid", "extensions contain a forbidden key");
    result[key] = safeExtensions(item, depth + 1);
  }
  return result;
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function normalizeDeclaration(input) {
  const value = exact(input, [
    "profileKey", "capabilityId", "executionKind", "source", "artifacts", "artifactDigest",
    "engine", "precision", "quantizationRecipe", "compatibility", "apiContracts", "limits",
    "resourceEnvelope", "coldStart", "dataPolicy", "knownLimitations", "validationEvidence", "exclusive",
  ], ["extensions"], "profile");
  const profileKey = string(value.profileKey, "profile.profileKey", { pattern: KEY, maximum: 192 });
  const capabilityId = string(value.capabilityId, "profile.capabilityId", { pattern: UUID, maximum: 36 });
  if (!new Set(["local", "managed_node", "external_provider"]).has(value.executionKind)) fail("model_profile_invalid", "profile.executionKind is invalid");

  const source = exact(value.source, ["model", "revision", "license", "provenance"], [], "profile.source");
  const license = exact(source.license, ["name", "spdxId", "usage", "reviewStatus", "textDigest", "evidenceRef"], [], "profile.source.license");
  if (license.spdxId !== null) string(license.spdxId, "profile.source.license.spdxId", { pattern: /^[A-Za-z0-9.+-]{1,64}$/, maximum: 64 });
  if (!new Set(["commercial", "non-commercial", "research", "unknown"]).has(license.usage)
    || !new Set(["pending", "approved", "rejected"]).has(license.reviewStatus)) fail("model_profile_invalid", "profile license policy is invalid");
  const provenance = exact(source.provenance, ["publisher", "sourceUri", "retrievedAt", "sourceDigest", "evidenceRef"], [], "profile.source.provenance");

  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 1024) fail("model_profile_invalid", "profile.artifacts is invalid");
  const artifactNames = new Set();
  const artifacts = value.artifacts.map((item, index) => {
    const artifact = exact(item, ["name", "role", "digest", "sizeBytes", "mediaType"], ["signatureDigest"], `profile.artifacts[${index}]`);
    const name = string(artifact.name, `profile.artifacts[${index}].name`, { pattern: NAME, maximum: 128 });
    if (artifactNames.has(name)) fail("model_profile_invalid", "profile artifact names must be unique");
    artifactNames.add(name);
    if (!new Set(["weights", "tokenizer", "config", "engine", "adapter", "provider-contract", "other"]).has(artifact.role)) fail("model_profile_invalid", "profile artifact role is invalid");
    return {
      name, role: artifact.role,
      digest: string(artifact.digest, `profile.artifacts[${index}].digest`, { pattern: DIGEST, maximum: 71 }),
      sizeBytes: integer(artifact.sizeBytes, `profile.artifacts[${index}].sizeBytes`, { minimum: 1 }),
      mediaType: string(artifact.mediaType, `profile.artifacts[${index}].mediaType`, { maximum: 256 }),
      ...(artifact.signatureDigest === undefined ? {} : { signatureDigest: string(artifact.signatureDigest, `profile.artifacts[${index}].signatureDigest`, { pattern: DIGEST, maximum: 71 }) }),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const artifactDigest = string(value.artifactDigest, "profile.artifactDigest", { pattern: DIGEST, maximum: 71 });
  if (!artifacts.some(({ digest }) => digest === artifactDigest)) fail("model_profile_invalid", "profile.artifactDigest must identify a declared artifact");

  const engine = exact(value.engine, ["name", "version", "runtime", "runtimeVersion", "imageDigest", "configurationDigest"], [], "profile.engine");
  const normalizedEngine = {
    name: string(engine.name, "profile.engine.name", { pattern: NAME, maximum: 128 }),
    version: string(engine.version, "profile.engine.version", { maximum: 128 }),
    runtime: string(engine.runtime, "profile.engine.runtime", { pattern: NAME, maximum: 128 }),
    runtimeVersion: string(engine.runtimeVersion, "profile.engine.runtimeVersion", { maximum: 128 }),
    imageDigest: string(engine.imageDigest, "profile.engine.imageDigest", { pattern: DIGEST, maximum: 71 }),
    configurationDigest: string(engine.configurationDigest, "profile.engine.configurationDigest", { pattern: DIGEST, maximum: 71 }),
  };
  if (!PRECISIONS.has(value.precision)) fail("model_profile_invalid", "profile.precision is invalid");
  let quantizationRecipe = null;
  if (value.quantizationRecipe !== null) {
    const recipe = exact(value.quantizationRecipe, ["scheme", "tool", "toolVersion", "recipeDigest", "parametersDigest", "calibrationDatasetDigest"], [], "profile.quantizationRecipe");
    quantizationRecipe = {
      scheme: string(recipe.scheme, "profile.quantizationRecipe.scheme", { pattern: NAME, maximum: 128 }),
      tool: string(recipe.tool, "profile.quantizationRecipe.tool", { maximum: 256 }),
      toolVersion: string(recipe.toolVersion, "profile.quantizationRecipe.toolVersion", { maximum: 128 }),
      recipeDigest: string(recipe.recipeDigest, "profile.quantizationRecipe.recipeDigest", { pattern: DIGEST, maximum: 71 }),
      parametersDigest: string(recipe.parametersDigest, "profile.quantizationRecipe.parametersDigest", { pattern: DIGEST, maximum: 71 }),
      calibrationDatasetDigest: recipe.calibrationDatasetDigest === null ? null : string(recipe.calibrationDatasetDigest, "profile.quantizationRecipe.calibrationDatasetDigest", { pattern: DIGEST, maximum: 71 }),
    };
  }
  if (QUANTIZED.has(value.precision) !== Boolean(quantizationRecipe)) fail("model_profile_invalid", "profile precision and quantization recipe disagree");
  if (value.precision === "nvfp4" && quantizationRecipe.scheme !== "nvfp4") fail("model_profile_invalid", "NVFP4 requires an exact NVFP4 recipe");

  const compatibility = exact(value.compatibility, ["architectures", "hardware", "software"], [], "profile.compatibility");
  const hardware = exact(compatibility.hardware, ["acceleratorFamilies", "minimumComputeCapability", "minimumUnifiedMemoryBytes", "minimumCpuCores", "codecDirections"], [], "profile.compatibility.hardware");
  const codecDirections = exact(hardware.codecDirections, ["encode", "decode"], [], "profile.compatibility.hardware.codecDirections");
  const software = exact(compatibility.software, ["os", "kernelRange", "driverRange", "cudaRange", "containerToolkitRange"], [], "profile.compatibility.software");
  const range = (item, label) => item === null ? null : string(item, label, { pattern: RANGE, maximum: 128 });
  const normalizedCompatibility = {
    architectures: uniqueStrings(compatibility.architectures, "profile.compatibility.architectures", { allowed: new Set(["linux/arm64/v8", "linux/amd64"]), maximum: 2 }),
    hardware: {
      acceleratorFamilies: uniqueStrings(hardware.acceleratorFamilies, "profile.compatibility.hardware.acceleratorFamilies", { pattern: NAME, maximum: 32, allowEmpty: true }),
      minimumComputeCapability: range(hardware.minimumComputeCapability, "profile.compatibility.hardware.minimumComputeCapability"),
      minimumUnifiedMemoryBytes: integer(hardware.minimumUnifiedMemoryBytes, "profile.compatibility.hardware.minimumUnifiedMemoryBytes"),
      minimumCpuCores: integer(hardware.minimumCpuCores, "profile.compatibility.hardware.minimumCpuCores"),
      codecDirections: {
        encode: integer(codecDirections.encode, "profile.compatibility.hardware.codecDirections.encode", { maximum: 1024 }),
        decode: integer(codecDirections.decode, "profile.compatibility.hardware.codecDirections.decode", { maximum: 1024 }),
      },
    },
    software: {
      os: string(software.os, "profile.compatibility.software.os", { maximum: 128 }),
      kernelRange: range(software.kernelRange, "profile.compatibility.software.kernelRange"),
      driverRange: range(software.driverRange, "profile.compatibility.software.driverRange"),
      cudaRange: range(software.cudaRange, "profile.compatibility.software.cudaRange"),
      containerToolkitRange: range(software.containerToolkitRange, "profile.compatibility.software.containerToolkitRange"),
    },
  };

  const limits = exact(value.limits, ["maximumInputBytes", "maximumOutputBytes", "maximumContextTokens", "maximumOutputTokens", "maximumBatchSize", "maximumDurationSeconds", "maximumConcurrentRequests"], [], "profile.limits");
  const normalizedLimits = Object.fromEntries(Object.entries(limits).map(([key, item]) => [key, nullableInteger(item, `profile.limits.${key}`, { minimum: 1 })]));
  if (normalizedLimits.maximumBatchSize === null || normalizedLimits.maximumConcurrentRequests === null) fail("model_profile_invalid", "profile batch and concurrency limits are required");

  const resources = exact(value.resourceEnvelope, ["accountingMode", "cpuMillis", "unifiedMemoryBytes", "storageBytes", "networkBitsPerSecond", "acceleratorUnits", "codecSessions", "evidenceRef"], [], "profile.resourceEnvelope");
  if (!new Set(["observed", "provider_contract"]).has(resources.accountingMode)) fail("model_profile_invalid", "profile resource accounting mode is invalid");
  const normalizedResources = {
    accountingMode: resources.accountingMode,
    cpuMillis: integer(resources.cpuMillis, "profile.resourceEnvelope.cpuMillis"),
    unifiedMemoryBytes: integer(resources.unifiedMemoryBytes, "profile.resourceEnvelope.unifiedMemoryBytes"),
    storageBytes: integer(resources.storageBytes, "profile.resourceEnvelope.storageBytes"),
    networkBitsPerSecond: integer(resources.networkBitsPerSecond, "profile.resourceEnvelope.networkBitsPerSecond"),
    acceleratorUnits: integer(resources.acceleratorUnits, "profile.resourceEnvelope.acceleratorUnits", { maximum: 1024 }),
    codecSessions: integer(resources.codecSessions, "profile.resourceEnvelope.codecSessions", { maximum: 65536 }),
    evidenceRef: evidenceRef(resources.evidenceRef, "profile.resourceEnvelope.evidenceRef"),
  };
  if (value.executionKind === "external_provider") {
    if (resources.accountingMode !== "provider_contract" || Object.entries(normalizedResources).some(([key, item]) => !new Set(["accountingMode", "evidenceRef"]).has(key) && item !== 0)) {
      fail("model_profile_invalid", "external provider profiles cannot invent physical resource capacity");
    }
  } else if (resources.accountingMode !== "observed" || normalizedResources.cpuMillis === 0 || normalizedResources.unifiedMemoryBytes === 0) {
    fail("model_profile_invalid", "managed profiles require observed CPU and unified memory");
  }

  const coldStart = exact(value.coldStart, ["estimatedMilliseconds", "artifactReadBytes", "evidenceRef"], [], "profile.coldStart");
  const dataPolicy = exact(value.dataPolicy, ["allowedDataClasses", "externalProcessing"], [], "profile.dataPolicy");
  if (!new Set(["forbidden", "approved_only", "allowed"]).has(dataPolicy.externalProcessing)) fail("model_profile_invalid", "profile.dataPolicy.externalProcessing is invalid");
  if (value.executionKind === "external_provider" && dataPolicy.externalProcessing === "forbidden") fail("model_profile_invalid", "external provider profile forbids its own execution path");

  if (!Array.isArray(value.validationEvidence) || value.validationEvidence.length > 256) fail("model_profile_invalid", "profile.validationEvidence is invalid");
  const validationEvidence = value.validationEvidence.map((item, index) => {
    const evidence = exact(item, ["stage", "result", "runId", "evidenceRef", "observedAt", "environmentDigest"], [], `profile.validationEvidence[${index}]`);
    if (!STAGES.has(evidence.stage) || !new Set(["passed", "failed", "incomplete"]).has(evidence.result)) fail("model_profile_invalid", "profile validation evidence state is invalid");
    const reference = evidenceRef(evidence.evidenceRef, "profile.validationEvidence.evidenceRef");
    if (reference === null) fail("model_profile_invalid", "profile validation evidence requires a durable reference");
    return {
      stage: evidence.stage, result: evidence.result,
      runId: string(evidence.runId, "profile.validationEvidence.runId", { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/, maximum: 128 }),
      evidenceRef: reference,
      observedAt: timestamp(evidence.observedAt, "profile.validationEvidence.observedAt"),
      environmentDigest: string(evidence.environmentDigest, "profile.validationEvidence.environmentDigest", { pattern: DIGEST, maximum: 71 }),
    };
  }).sort((left, right) => left.stage.localeCompare(right.stage) || left.runId.localeCompare(right.runId));
  if (new Set(validationEvidence.map(({ runId }) => runId)).size !== validationEvidence.length) fail("model_profile_invalid", "profile validation run IDs must be unique");

  return Object.freeze({
    profileKey,
    capabilityId,
    executionKind: value.executionKind,
    source: {
      model: string(source.model, "profile.source.model", { maximum: 512 }),
      revision: string(source.revision, "profile.source.revision", { maximum: 256 }),
      license: {
        name: string(license.name, "profile.source.license.name", { maximum: 256 }),
        spdxId: license.spdxId,
        usage: license.usage,
        reviewStatus: license.reviewStatus,
        textDigest: string(license.textDigest, "profile.source.license.textDigest", { pattern: DIGEST, maximum: 71 }),
        evidenceRef: evidenceRef(license.evidenceRef, "profile.source.license.evidenceRef"),
      },
      provenance: {
        publisher: string(provenance.publisher, "profile.source.provenance.publisher", { maximum: 256 }),
        sourceUri: safeSourceUri(provenance.sourceUri, "profile.source.provenance.sourceUri"),
        retrievedAt: timestamp(provenance.retrievedAt, "profile.source.provenance.retrievedAt"),
        sourceDigest: string(provenance.sourceDigest, "profile.source.provenance.sourceDigest", { pattern: DIGEST, maximum: 71 }),
        evidenceRef: evidenceRef(provenance.evidenceRef, "profile.source.provenance.evidenceRef"),
      },
    },
    artifacts,
    artifactDigest,
    engine: normalizedEngine,
    precision: value.precision,
    quantizationRecipe,
    compatibility: normalizedCompatibility,
    apiContracts: uniqueStrings(value.apiContracts, "profile.apiContracts", { pattern: API, maximum: 128 }),
    limits: normalizedLimits,
    resourceEnvelope: normalizedResources,
    coldStart: {
      estimatedMilliseconds: integer(coldStart.estimatedMilliseconds, "profile.coldStart.estimatedMilliseconds"),
      artifactReadBytes: integer(coldStart.artifactReadBytes, "profile.coldStart.artifactReadBytes"),
      evidenceRef: evidenceRef(coldStart.evidenceRef, "profile.coldStart.evidenceRef"),
    },
    dataPolicy: {
      allowedDataClasses: uniqueStrings(dataPolicy.allowedDataClasses, "profile.dataPolicy.allowedDataClasses", { allowed: DATA_CLASSES, maximum: 4 }),
      externalProcessing: dataPolicy.externalProcessing,
    },
    knownLimitations: uniqueStrings(value.knownLimitations, "profile.knownLimitations", { maximum: 128, allowEmpty: true }),
    validationEvidence,
    exclusive: value.exclusive === true ? true : value.exclusive === false ? false : fail("model_profile_invalid", "profile.exclusive must be boolean"),
    ...(value.extensions === undefined ? {} : { extensions: safeExtensions(record(value.extensions, "profile.extensions")) }),
  });
}

export function validateModelProfileDeclarationV1(input) {
  return structuredClone(normalizeDeclaration(input));
}

export function modelProfileFingerprintV1(input) {
  const normalized = normalizeDeclaration(input);
  return `sha256:${createHash("sha256").update(canonical(normalized)).digest("hex")}`;
}

function requireManager(context) {
  if (!context || !UUID.test(context.identityId ?? "") || !Array.isArray(context.permissions) || !context.permissions.includes("model:manage")) {
    fail("model_profile_manager_required", "Model profile registration requires model management permission");
  }
}

export class ModelProfileRegistrationService {
  #repository;
  #audit;
  #clock;
  #idGenerator;

  constructor({ repository, auditSink, clock = () => new Date(), idGenerator = randomUUID }) {
    if (!repository?.registerImmutable || !repository?.getByKey || !auditSink?.record || typeof idGenerator !== "function") {
      throw new TypeError("model profile registration dependencies are required");
    }
    this.#repository = repository;
    this.#audit = auditSink;
    this.#clock = clock;
    this.#idGenerator = idGenerator;
  }

  async register({ context, profile: input, operationKey }) {
    requireManager(context);
    string(operationKey, "operationKey", { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/, maximum: 128 });
    const declaration = normalizeDeclaration(input);
    const fingerprint = `sha256:${createHash("sha256").update(canonical(declaration)).digest("hex")}`;
    const createdAt = this.#clock().toISOString();
    const profile = {
      schemaVersion: 1,
      profileId: this.#idGenerator(),
      ...structuredClone(declaration),
      certification: {
        state: "experimental",
        evidenceRefs: declaration.validationEvidence.map((item) => item.evidenceRef),
      },
      createdAt,
    };
    if (!UUID.test(profile.profileId) || new Date(createdAt).toISOString() !== createdAt) throw new TypeError("model profile identity generator or clock is invalid");
    let stored;
    try {
      stored = await this.#repository.registerImmutable({
        profile, fingerprint, registeredBy: context.identityId, operationKey,
      });
    } catch (error) {
      if (error?.code === "model_profile_conflict") fail("model_profile_conflict", "A material profile change requires a new profile key");
      throw error;
    }
    await this.#audit.record({
      event: stored.created ? "model_profile.registered" : "model_profile.registration_replayed",
      actorId: context.identityId,
      profileId: stored.profile.profileId,
      profileKey: stored.profile.profileKey,
      fingerprint,
      operationKey,
      occurredAt: createdAt,
    });
    return Object.freeze({ ...structuredClone(stored), fingerprint });
  }

  async get({ context, profileKey }) {
    requireManager(context);
    string(profileKey, "profileKey", { pattern: KEY, maximum: 192 });
    return this.#repository.getByKey(profileKey);
  }
}
