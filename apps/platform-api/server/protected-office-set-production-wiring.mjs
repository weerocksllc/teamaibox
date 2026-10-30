import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";

import {
  createProtectedOfficeMaintenanceSignerClientFromEnvironment,
} from "./protected-office-maintenance-signer-client.mjs";

const GiB = 2 ** 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._:/-]*@(sha256:[a-f0-9]{64})$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/;
const PROFILE_KEY = /^[a-z0-9][a-z0-9._-]{7,191}$/;
const SLOT_ORDER = Object.freeze([
  "embedding-qwen3",
  "asr-whisper",
  "ocr-hunyuan",
  "translation-lmt4",
  "assistant-qwen38",
  "drawing-flux2",
]);
const CAPABILITIES = Object.freeze([
  "assistant.answer",
  "assistant.agent",
  "translation",
  "drawing.generate",
  "ocr",
  "embeddings",
  "asr.realtime",
]);
const COMPUTE_JOB_CAPABILITIES = Object.freeze(CAPABILITIES
  .filter((capability) => !new Set(["assistant.agent", "asr.realtime"]).has(capability)));
const DEPLOYMENT_ID = "teamaibox.protected-office-set-deployment.v2";
const SET_ID = "office.baseline";
const PLAN_RELATIVE_PATH = "deploy/compute/protected-office-set-deployment.v2.json";
const V5_DEPLOYMENT_ID = "teamaibox.protected-office-set-deployment.v5";
const V5_PLAN_RELATIVE_PATH = "deploy/compute/protected-office-set-deployment.v5.json";
const MAXIMUM_JSON_BYTES = 16 * 1024 * 1024;
const VALIDATOR_TIMEOUT_MILLISECONDS = 15 * 60_000;

const defaultFileSystem = Object.freeze({ lstat, readFile, realpath });

const DEPLOYMENT_CONTRACTS = deepFreeze({
  [DEPLOYMENT_ID]: {
    deploymentId: DEPLOYMENT_ID,
    planRelativePath: PLAN_RELATIVE_PATH,
    requiresRuntimeBundle: false,
  },
  [V5_DEPLOYMENT_ID]: {
    deploymentId: V5_DEPLOYMENT_ID,
    planRelativePath: V5_PLAN_RELATIVE_PATH,
    requiresRuntimeBundle: true,
  },
});

function deploymentContract(deploymentId = DEPLOYMENT_ID, planRelativePath = null) {
  const contract = DEPLOYMENT_CONTRACTS[deploymentId];
  if (!contract || (planRelativePath != null && planRelativePath !== contract.planRelativePath)) {
    throw new TypeError("protected office deployment contract is unsupported");
  }
  return contract;
}

function copy(value) {
  return value == null ? null : structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function positive(value, label, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) {
    throw new TypeError(`${label} must be a ${zero ? "non-negative" : "positive"} safe integer`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) throw new TypeError(`${label} has an invalid shape`);
  return value;
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw new TypeError("value is not canonical JSON");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function fileDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.length < 3 || value.includes("\\") || isAbsolute(value)) {
    throw new TypeError(`${label} must be a repository-relative path`);
  }
  const normalized = value.split("/");
  if (normalized.some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`${label} escapes its repository scope`);
  }
  return value;
}

async function resolvedRoot(repositoryRoot, fileSystem) {
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
    throw new TypeError("protected office repository root must be absolute");
  }
  const requested = resolve(repositoryRoot);
  const actual = await fileSystem.realpath(requested);
  if (requested !== actual) throw new TypeError("protected office repository root cannot be a symbolic link");
  return actual;
}

function within(root, path) {
  const scoped = relative(root, path);
  return scoped !== "" && scoped !== ".." && !scoped.startsWith(`..${sep}`) && !isAbsolute(scoped);
}

async function boundedRegularFile(root, relativePath, label, fileSystem, maximum = MAXIMUM_JSON_BYTES) {
  const name = safeRelativePath(relativePath, label);
  const requested = resolve(root, name);
  if (!within(root, requested)) throw new TypeError(`${label} escapes its repository scope`);
  const actual = await fileSystem.realpath(requested);
  if (actual !== requested || !within(root, actual)) throw new TypeError(`${label} cannot be a symbolic link`);
  const stats = await fileSystem.lstat(actual);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maximum) {
    throw new TypeError(`${label} must be a bounded regular file`);
  }
  const bytes = await fileSystem.readFile(actual);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== stats.size) {
    throw new TypeError(`${label} changed while it was read`);
  }
  return Object.freeze({ path: actual, relativePath: name, bytes });
}

async function jsonFile(root, relativePath, label, fileSystem) {
  const file = await boundedRegularFile(root, relativePath, label, fileSystem);
  try {
    const value = JSON.parse(file.bytes.toString("utf8"));
    object(value, label);
    return Object.freeze({ ...file, value });
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError(`${label} is not valid JSON`, { cause: error });
    throw error;
  } finally {
    file.bytes.fill(0);
  }
}

function imageDigest(value, label) {
  const match = IMAGE_REFERENCE.exec(value ?? "");
  if (!match) throw new TypeError(`${label} is not an immutable OCI image reference`);
  return match[1];
}

function runtimeIdentity(value, expectedContainer, label) {
  object(value, label);
  if (value.containerName !== expectedContainer || !HEX64.test(value.containerId ?? "")
      || !SHA256.test(value.imageId ?? "") || !IMAGE_REFERENCE.test(value.imageReference ?? "")
      || !SHA256.test(value.configDigest ?? "") || value.state !== "running") {
    throw new TypeError(`${label} is not an exact running container identity`);
  }
}

function workerStart(value, profile, plan) {
  object(value, `${profile.slot}.workerStart`);
  const allowed = new Set([
    "workerId", "ownerIdentityId", "sandboxKey", "attemptId", "modelProfileId", "workloadKind",
    "pluginId", "image", "network", "networkPolicyId", "apiScopes", "egressHosts", "limits",
    "security", "mounts", "publishedPorts", "applicationPort", "devices", "environment", "entrypoint", "command",
    "healthCommand", "healthCheck", "tmpfsExecutable", "placementClass", "maintenanceGeneration",
    "configDigest", "nodeId", "nodeGeneration",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${profile.slot}.workerStart has an unknown field`);
  }
  if (value.workerId !== profile.workerId || value.attemptId !== profile.attemptId
      || value.modelProfileId !== profile.modelProfileId || value.image !== profile.imageReference
      || value.workloadKind !== "compute-worker" || value.network !== "compute-internal"
      || value.placementClass !== "protected-resident"
      || value.maintenanceGeneration !== plan.set.maintenanceGeneration
      || value.configDigest !== profile.configurationDigest || value.nodeId !== plan.target.nodeId
      || value.nodeGeneration !== plan.target.nodeGeneration) {
    throw new TypeError(`${profile.slot}.workerStart identity drifted`);
  }
  const limits = object(value.limits, `${profile.slot}.workerStart.limits`);
  if (!Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes < 1) {
    throw new TypeError(`${profile.slot}.workerStart memory limit is invalid`);
  }
  for (const key of ["cpuQuotaMicros", "pidsLimit", "ephemeralBytes", "openFilesLimit"]) {
    positive(limits[key], `${profile.slot}.workerStart.limits.${key}`);
  }
  if (limits.sharedMemoryBytes != null
      && (!Number.isSafeInteger(limits.sharedMemoryBytes) || limits.sharedMemoryBytes < 64 * 1024 ** 2
        || limits.sharedMemoryBytes > limits.memoryBytes)) {
    throw new TypeError(`${profile.slot}.workerStart.limits.sharedMemoryBytes is invalid`);
  }
  const security = object(value.security, `${profile.slot}.workerStart.security`);
  if (!Number.isSafeInteger(security.runAsUid) || security.runAsUid === 0
      || !Number.isSafeInteger(security.runAsGid) || security.runAsGid === 0
      || ["readOnlyRoot", "dropAllCapabilities", "noNewPrivileges"].some((key) => security[key] !== true)
      || ["privileged", "hostPid", "hostIpc", "hostNetwork", "dockerSocket"].some((key) => security[key] !== false)) {
    throw new TypeError(`${profile.slot}.workerStart security is unsafe`);
  }
  if (value.entrypoint != null
      && (!Array.isArray(value.entrypoint) || value.entrypoint.length < 1 || value.entrypoint.length > 32
        || value.entrypoint.some((entry) => typeof entry !== "string" || entry.length < 1
          || entry.length > 4096 || entry.includes("\0")))) {
    throw new TypeError(`${profile.slot}.workerStart.entrypoint is invalid`);
  }
}

function orderedWorkerStart(value) {
  const fields = [
    "workerId", "ownerIdentityId", "sandboxKey", "attemptId", "modelProfileId", "workloadKind",
    "pluginId", "image", "network", "networkPolicyId", "apiScopes", "egressHosts", "limits",
    "security", "mounts", "publishedPorts", "applicationPort", "devices", "environment", "entrypoint", "command",
    "healthCommand", "healthCheck", "tmpfsExecutable", "placementClass", "maintenanceGeneration",
    "configDigest",
  ];
  const result = {};
  for (const field of fields) {
    let entry = value[field];
    if (entry == null || entry === "" || entry === false || entry === 0
        || (Array.isArray(entry) && entry.length === 0)
        || (entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 0)) continue;
    if (field === "limits") {
      const ordered = {};
      for (const key of ["memoryBytes", "cpuQuotaMicros", "pidsLimit", "ephemeralBytes", "sharedMemoryBytes", "workspaceQuotaBytes", "openFilesLimit"]) {
        if (entry[key] != null && entry[key] !== 0) ordered[key] = entry[key];
      }
      entry = ordered;
    } else if (field === "security") {
      const ordered = {};
      for (const key of ["runAsUid", "runAsGid", "readOnlyRoot", "dropAllCapabilities", "noNewPrivileges",
        "privileged", "hostPid", "hostIpc", "hostNetwork", "dockerSocket", "seccompProfile"]) {
        if (Object.hasOwn(entry, key) && entry[key] != null && entry[key] !== "") ordered[key] = entry[key];
      }
      entry = ordered;
    } else if (field === "mounts") {
      entry = entry.map((mount) => ({ type: mount.type, source: mount.source, target: mount.target, readOnly: mount.readOnly }));
    } else if (field === "publishedPorts") {
      entry = entry.map((port) => ({ containerPort: port.containerPort, hostPort: port.hostPort, hostIp: port.hostIp }));
    } else if (field === "healthCheck") {
      entry = {
        test: entry.test,
        intervalNanoseconds: entry.intervalNanoseconds,
        timeoutNanoseconds: entry.timeoutNanoseconds,
        startPeriodNanoseconds: entry.startPeriodNanoseconds,
        retries: entry.retries,
      };
    } else if (field === "environment") {
      entry = Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]));
    }
    result[field] = entry;
  }
  return result;
}

export function workerStartDigest(value) {
  return fileDigest(Buffer.from(JSON.stringify(orderedWorkerStart(value)), "utf8"));
}

function normalizedProfile(profile, plan, workerBySlot) {
  return deepFreeze({
    workerId: profile.workerId,
    modelProfileId: profile.modelProfileId,
    imageDigest: imageDigest(profile.imageReference, `${profile.slot}.imageReference`),
    configurationDigest: profile.configurationDigest,
    placementClass: "protected-resident",
    maintenanceGeneration: plan.set.maintenanceGeneration,
    declaredResidentBytes: profile.declaredResidentBytes,
    dependsOnWorkerIds: profile.dependsOnSlots.map((slot) => workerBySlot.get(slot)),
    stageOrder: profile.stageOrder,
  });
}

function desiredTarget(profile, plan, workerBySlot) {
  return deepFreeze({
    targetKey: profile.targetKey,
    workerId: profile.workerId,
    modelProfileId: profile.modelProfileId,
    containerName: profile.containerName,
    placementClass: "protected-resident",
    maintenanceGeneration: plan.set.maintenanceGeneration,
    stageOrder: profile.stageOrder,
    dependsOnWorkerIds: profile.dependsOnSlots.map((slot) => workerBySlot.get(slot)),
    requiredImageId: profile.imageId,
    requiredImageDigest: profile.imageReference,
    requiredConfigDigest: profile.configurationDigest,
    requiredStartSpecDigest: workerStartDigest(profile.workerStart),
    requiredLabels: copy(profile.requiredLabels),
    dependentContainers: copy(profile.dependentContainers),
  });
}

function validateTarget(value, profile, dependencies, label, { desired = false } = {}) {
  object(value, label);
  const requiredDependencies = value.dependsOnWorkerIds ?? [];
  if (value.targetKey !== profile.targetKey || value.workerId !== profile.workerId
      || !UUID.test(value.modelProfileId ?? "") || value.containerName !== profile.containerName
      || value.placementClass !== "protected-resident" || !Number.isSafeInteger(value.maintenanceGeneration)
      || value.maintenanceGeneration < 1 || value.stageOrder !== profile.stageOrder
      || !same(requiredDependencies, dependencies) || !SHA256.test(value.requiredImageId ?? "")
      || !IMAGE_REFERENCE.test(value.requiredImageDigest ?? "") || !SHA256.test(value.requiredConfigDigest ?? "")
      || !SHA256.test(value.requiredStartSpecDigest ?? "") || !value.requiredLabels
      || typeof value.requiredLabels !== "object" || !Array.isArray(value.dependentContainers ?? [])) {
    throw new TypeError(`${label} identity is incomplete`);
  }
  if (desired && (value.modelProfileId !== profile.modelProfileId || value.requiredImageId !== profile.imageId
      || value.requiredImageDigest !== profile.imageReference
      || value.requiredConfigDigest !== profile.configurationDigest
      || value.requiredStartSpecDigest !== workerStartDigest(profile.workerStart)
      || !same(value.requiredLabels, profile.requiredLabels)
      || !same(value.dependentContainers ?? [], profile.dependentContainers))) {
    throw new TypeError(`${label} does not match the desired protected profile`);
  }
}

function validateParentReference(value, label) {
  object(value, label);
  if (!safeRelativePath(value.path, `${label}.path`).startsWith("evidence/validation/")
      || !value.path.endsWith(".json") || typeof value.runId !== "string" || value.runId.length < 8
      || typeof value.runnerId !== "string" || value.runnerId.length < 8
      || !SHA256.test(value.evidenceDigest ?? "")
      || !safeRelativePath(value.validator, `${label}.validator`).startsWith("tools/validate_")
      || !value.validator.endsWith(".py") || (value.requiredFacts != null && !Array.isArray(value.requiredFacts))) {
    throw new TypeError(`${label} is not an exact immutable parent reference`);
  }
}

async function validatePlan(plan, root, fileSystem, contract) {
  if (plan.schemaVersion !== 1 || plan.deploymentId !== contract.deploymentId
      || plan.readyForExecution !== true) {
    throw new TypeError("protected office deployment plan is not execution-ready");
  }
  if (contract.requiresRuntimeBundle) {
    const bundle = object(plan.runtimeBundle, "protected office runtime bundle");
    const capture = object(bundle.bootstrapCapture, "protected office runtime bundle capture");
    if (bundle.schemaVersion !== 1 || bundle.root !== "/run/teamaibox/protected-office-set/bundle"
        || bundle.manifestFile !== "/run/teamaibox/protected-office-set/bundle/bundle-manifest.json"
        || bundle.planFile !== `/run/teamaibox/protected-office-set/bundle/${contract.planRelativePath}`
        || bundle.mount?.type !== "volume" || bundle.mount?.destination !== bundle.root
        || bundle.mount?.readOnly !== true || !CONTAINER.test(bundle.mount?.source ?? "")
        || capture.runnerId !== "teamaibox.protected-office-set-v5-runtime-capture.v1"
        || typeof capture.path !== "string" || !capture.path.startsWith("evidence/validation/")
        || !SHA256.test(capture.evidenceDigest ?? "") || typeof capture.runId !== "string"
        || capture.runId.length < 8 || bundle.candidateCreatedBeforePlan !== true
        || bundle.containerRecreatedAfterPlan !== false) {
      throw new TypeError("protected office v5 runtime bundle boundary drifted");
    }
  }
  const target = object(plan.target, "protected office deployment target");
  // The execution plan supplies this installation's address. Bind transport
  // to that same address; node UUID/generation are independently checked by
  // the production environment factory before any signer is constructed.
  const sshIdentity = typeof target.ssh === "string"
    ? target.ssh.match(/^([A-Za-z_][A-Za-z0-9_-]{0,31})@([^\s]+)$/) : null;
  if (typeof target.nodeAddress !== "string" || isIP(target.nodeAddress) === 0
      || new Set(["0.0.0.0", "::"]).has(target.nodeAddress)
      || !sshIdentity || sshIdentity[2] !== target.nodeAddress
      || target.nodeRole !== "main-box"
      || !UUID.test(target.nodeId ?? "") || !Number.isSafeInteger(target.nodeGeneration)
      || target.nodeGeneration < 1 || !CONTAINER.test(target.platformContainer ?? "")
      || !CONTAINER.test(target.nodeAgentContainer ?? "")) {
    throw new TypeError("protected office deployment target drifted");
  }
  runtimeIdentity(target.platformIdentity, target.platformContainer, "Platform runtime identity");
  runtimeIdentity(target.nodeAgentIdentity, target.nodeAgentContainer, "Node Agent runtime identity");
  const parents = object(plan.parents, "protected office deployment parents");
  const parentNames = ["profileSetQualification", "schemaDeployment", "legacyCanonicalDeployment"];
  if (!same(Object.keys(parents).sort(), [...parentNames].sort())) {
    throw new TypeError("protected office deployment parent set drifted");
  }
  for (const name of parentNames) validateParentReference(parents[name], `parents.${name}`);
  const manifest = object(plan.profileSetManifest, "protected office profile manifest reference");
  if (!SHA256.test(manifest.sha256 ?? "")) throw new TypeError("protected office profile manifest digest is invalid");
  const manifestFile = await boundedRegularFile(root, manifest.path, "protected office profile manifest", fileSystem);
  try {
    if (fileDigest(manifestFile.bytes) !== manifest.sha256) throw new TypeError("protected office profile manifest drifted");
  } finally { manifestFile.bytes.fill(0); }
  const set = object(plan.set, "protected office set");
  if (set.setId !== SET_ID || !Number.isSafeInteger(set.desiredStateRevision) || set.desiredStateRevision < 1
      || !Number.isSafeInteger(set.maintenanceGeneration) || set.maintenanceGeneration < 1
      || !Array.isArray(set.profiles) || !same(set.profiles.map((profile) => profile?.slot), SLOT_ORDER)) {
    throw new TypeError("protected office set identity or six-profile stage order drifted");
  }
  const workerBySlot = new Map(set.profiles.map((profile) => [profile.slot, profile.workerId]));
  if (new Set(workerBySlot.values()).size !== SLOT_ORDER.length
      || [...workerBySlot.values()].some((workerId) => !UUID.test(workerId ?? ""))) {
    throw new TypeError("protected office Worker identities are incomplete or duplicated");
  }
  let aggregateBytes = 0;
  for (const [index, profile] of set.profiles.entries()) {
    object(profile, `set.profiles[${index}]`);
    const expectedDependencies = index === 0 ? [] : [SLOT_ORDER[0]];
    if (profile.stageOrder !== index + 1 || !same(profile.dependsOnSlots, expectedDependencies)
        || !UUID.test(profile.modelProfileId ?? "") || !PROFILE_KEY.test(profile.profileKey ?? "")
        || !UUID.test(profile.attemptId ?? "") || profile.containerName !== `teamaibox-worker-${profile.workerId}`
        || !SHA256.test(profile.imageId ?? "") || !SHA256.test(profile.configurationDigest ?? "")
        || imageDigest(profile.imageReference, `${profile.slot}.imageReference`) === profile.imageId
        || !Number.isSafeInteger(profile.declaredResidentBytes) || profile.declaredResidentBytes < 1
        || !profile.requiredLabels
        || typeof profile.requiredLabels !== "object" || Array.isArray(profile.requiredLabels)
        || !Array.isArray(profile.dependentContainers)) {
      throw new TypeError(`${profile.slot} deployment identity is incomplete`);
    }
    if (profile.requiredLabels["com.teamaibox.worker-id"] !== profile.workerId
        || profile.requiredLabels["com.teamaibox.model-profile-id"] !== profile.modelProfileId
        || profile.requiredLabels["com.teamaibox.placement-class"] !== "protected-resident") {
      throw new TypeError(`${profile.slot} ownership labels drifted`);
    }
    const configuration = await boundedRegularFile(root, profile.profileConfiguration,
      `${profile.slot} profile configuration`, fileSystem);
    try {
      if (fileDigest(configuration.bytes) !== profile.configurationDigest) {
        throw new TypeError(`${profile.slot} profile configuration digest drifted`);
      }
    } finally { configuration.bytes.fill(0); }
    workerStart(profile.workerStart, profile, plan);
    const dependencies = profile.dependsOnSlots.map((slot) => workerBySlot.get(slot));
    if (dependencies.some((workerId) => !UUID.test(workerId ?? ""))) {
      throw new TypeError(`${profile.slot} dependency is unresolved`);
    }
    if (profile.priorState?.mode !== "exact-canonical") {
      throw new TypeError(`${profile.slot} does not have an exact canonical prior state`);
    }
    authority(profile.priorState.authority, plan.target.nodeGeneration);
    validateTarget(profile.priorState.target, profile, dependencies, `${profile.slot}.priorState.target`);
    aggregateBytes += profile.declaredResidentBytes;
  }
  const controller = object(plan.controller, "protected office production controller");
  const sourceBindings = [
    ["tools/protected_office_set_deployment_adapter.mjs", controller.adapterDigest, "deployment adapter"],
    [controller.driverSourcePath, controller.driverModuleDigest, "production driver"],
    ["tools/protected_office_set_inspection_adapter.mjs", controller.inspectionAdapterDigest, "inspection adapter"],
    [controller.inspectorSourcePath, controller.inspectorModuleDigest, "production inspector"],
  ];
  for (const [path, expected, label] of sourceBindings) {
    if (!SHA256.test(expected ?? "")) throw new TypeError(`${label} digest is invalid`);
    const source = await boundedRegularFile(root, path, label, fileSystem);
    try {
      if (fileDigest(source.bytes) !== expected) throw new TypeError(`${label} source digest drifted`);
    } finally { source.bytes.fill(0); }
  }
  return Object.freeze({ aggregateBytes, workerBySlot });
}

/**
 * Loads only the exact repository deployment plan.  A checked-in planning
 * skeleton with unresolved identities is deliberately rejected.
 */
export async function loadProtectedOfficeSetDeploymentPlan({
  repositoryRoot,
  planFile,
  deploymentId = DEPLOYMENT_ID,
  planRelativePath = null,
  fileSystem = defaultFileSystem,
} = {}) {
  if (!fileSystem?.realpath || !fileSystem?.lstat || !fileSystem?.readFile) {
    throw new TypeError("protected office plan filesystem is incomplete");
  }
  const contract = deploymentContract(deploymentId, planRelativePath);
  const root = await resolvedRoot(repositoryRoot, fileSystem);
  const expectedPlan = resolve(root, contract.planRelativePath);
  if (typeof planFile !== "string" || !isAbsolute(planFile) || resolve(planFile) !== expectedPlan) {
    throw new TypeError(`protected office plan must be the exact ${contract.planRelativePath} file`);
  }
  const file = await jsonFile(root, contract.planRelativePath, "protected office deployment plan", fileSystem);
  const plan = deepFreeze(copy(file.value));
  const validated = await validatePlan(plan, root, fileSystem, contract);
  return Object.freeze({
    plan,
    planDigest: digest(plan),
    planFile: expectedPlan,
    repositoryRoot: root,
    aggregateBytes: validated.aggregateBytes,
  });
}

function requestedProfile(value, expected, label) {
  object(value, label);
  const keys = [
    "workerId", "modelProfileId", "imageDigest", "configurationDigest", "placementClass",
    "maintenanceGeneration", "declaredResidentBytes", "dependsOnWorkerIds", "stageOrder",
  ];
  const projected = Object.fromEntries(keys.map((key) => [key, value[key]]));
  if (!same(projected, expected)) throw new TypeError(`${label} drifted from the execution-ready plan`);
}

function targetIdentity(target, expected) {
  return Object.freeze({
    ...copy(expected),
    workerId: target.workerId,
    modelProfileId: target.modelProfileId,
    imageDigest: imageDigest(target.requiredImageDigest, "previous target image"),
    configurationDigest: target.requiredConfigDigest,
    placementClass: target.placementClass,
    maintenanceGeneration: target.maintenanceGeneration,
  });
}

function identityMatches(value, expected) {
  return value?.workerId === expected.workerId && value?.modelProfileId === expected.modelProfileId
    && value?.imageDigest === expected.imageDigest
    && value?.configurationDigest === expected.configurationDigest
    && value?.placementClass === expected.placementClass
    && value?.maintenanceGeneration === expected.maintenanceGeneration;
}

function authority(value, nodeGeneration) {
  object(value, "protected office lease authority");
  if (!UUID.test(value.leaseId ?? "") || !Number.isSafeInteger(value.fencingToken)
      || value.fencingToken < 1 || value.nodeGeneration !== nodeGeneration) {
    throw new TypeError("protected office lease authority is invalid");
  }
  return deepFreeze(copy(value));
}

/** Constructs the exact factories consumed by ProtectedOfficeSetNodeAgentRuntime. */
export function createProtectedOfficeSetPlanBindings({
  planSnapshot,
  leaseAuthorityProvider,
  realtimePlacementResolver,
  coreServiceProbe,
} = {}) {
  const snapshot = object(planSnapshot, "protected office plan snapshot");
  const plan = object(snapshot.plan, "protected office plan snapshot.plan");
  if (!SHA256.test(snapshot.planDigest ?? "") || snapshot.planDigest !== digest(plan)) {
    throw new TypeError("protected office plan snapshot digest drifted");
  }
  if (typeof leaseAuthorityProvider?.getAuthority !== "function"
      || typeof realtimePlacementResolver?.resolve !== "function"
      || typeof coreServiceProbe?.probe !== "function") {
    throw new TypeError("protected office production binding adapters are incomplete");
  }
  const workerBySlot = new Map(plan.set.profiles.map((profile) => [profile.slot, profile.workerId]));
  const rawByWorker = new Map(plan.set.profiles.map((profile) => [profile.workerId, profile]));
  const normalized = plan.set.profiles.map((profile) => normalizedProfile(profile, plan, workerBySlot));
  const normalizedByWorker = new Map(normalized.map((profile) => [profile.workerId, profile]));
  const desiredTargets = new Map(plan.set.profiles.map((profile) => [
    profile.workerId, desiredTarget(profile, plan, workerBySlot),
  ]));
  const previousTargets = new Map(plan.set.profiles.map((profile) => [
    profile.workerId, deepFreeze(copy(profile.priorState.target)),
  ]));
  const activeAuthorities = new Map(plan.set.profiles.map((profile) => [
    profile.workerId, authority(profile.priorState.authority, plan.target.nodeGeneration),
  ]));
  // Before a transition the live Worker is the captured predecessor, not the
  // desired successor. Advance identity and authority together on completion.
  const activeTargets = new Map(previousTargets);
  const stableInspectionPurposes = new Set([
    "inspect", "probe", "restore", "rollback-verify",
  ]);

  const bindingFactory = async ({ profile, previousIdentity = null, purpose } = {}) => {
    if (typeof purpose !== "string" || purpose.length < 3 || purpose.length > 64) {
      throw new TypeError("protected office binding purpose is invalid");
    }
    const expected = normalizedByWorker.get(profile?.workerId);
    const raw = rawByWorker.get(profile?.workerId);
    if (!expected || !raw) throw new TypeError("protected office binding requested an unknown Worker");
    const previous = previousTargets.get(expected.workerId);
    const desired = desiredTargets.get(expected.workerId);
    let selectedIdentity = expected;
    let selectedTarget = desired;
    if (previousIdentity != null) {
      const priorIdentity = targetIdentity(previous, expected);
      if (identityMatches(previousIdentity, expected)) {
        selectedIdentity = expected;
      } else if (identityMatches(previousIdentity, priorIdentity)) {
        selectedIdentity = priorIdentity;
        selectedTarget = previous;
      } else {
        throw new TypeError("protected office previous Worker identity is not bound by the exact migration parent");
      }
      requestedProfile(profile, identityMatches(profile, expected) ? expected : selectedIdentity,
        "protected office previous profile request");
    } else {
      requestedProfile(profile, expected, "protected office desired profile request");
      if (purpose === "inspect") {
        selectedTarget = activeTargets.get(expected.workerId);
        selectedIdentity = targetIdentity(selectedTarget, expected);
      }
    }
    const worker = copy(raw.workerStart);
    worker.modelProfileId = selectedIdentity.modelProfileId;
    worker.image = selectedTarget.requiredImageDigest;
    worker.configDigest = selectedIdentity.configurationDigest;
    worker.maintenanceGeneration = selectedIdentity.maintenanceGeneration;
    const retained = stableInspectionPurposes.has(purpose)
      ? activeAuthorities.get(worker.workerId) : null;
    const issued = retained ?? await leaseAuthorityProvider.getAuthority(deepFreeze({
      nodeId: plan.target.nodeId,
      nodeGeneration: plan.target.nodeGeneration,
      workerId: worker.workerId,
      attemptId: worker.attemptId,
      modelProfileId: worker.modelProfileId,
      purpose,
      planDigest: snapshot.planDigest,
    }));
    const correlationDigest = createHash("sha256")
      .update(`${snapshot.planDigest}:${worker.workerId}:${worker.modelProfileId}:${purpose}`)
      .digest("hex").slice(0, 32);
    return deepFreeze({
      worker,
      ...(purpose !== "transition" || raw.desiredCompanions == null ? {} : { desiredCompanions: copy(raw.desiredCompanions) }),
      authority: authority(issued, plan.target.nodeGeneration),
      residentBytes: raw.declaredResidentBytes,
      correlationId: `protected-office:${purpose}:${correlationDigest}`,
    });
  };

  // A successful protected-set transition stamps only newly created or
  // replaced containers with the transaction ownership tuple.  Retain the
  // captured tuple for exact no-op members and advance only identities that
  // actually changed.  This keeps later health reads lease/fence exact without
  // allocating mutation authority merely to inspect a protected resident.
  bindingFactory.recordTransition = ({ transactionId, journalRevision, profiles, previousIdentities }) => {
    if (!UUID.test(transactionId ?? "") || !Number.isSafeInteger(journalRevision)
        || journalRevision < 1 || !Array.isArray(profiles)) {
      throw new TypeError("protected office transition authority receipt is invalid");
    }
    for (const expected of profiles) {
      const desired = normalizedByWorker.get(expected.workerId);
      if (!desired || !identityMatches(expected, desired)) {
        throw new TypeError("protected office transition identity receipt drifted");
      }
      const previous = previousIdentities?.[expected.workerId];
      activeTargets.set(expected.workerId, desiredTargets.get(expected.workerId));
      if (previous?.state === "running" && previous.healthy === true
          && identityMatches(previous, expected)) continue;
      activeAuthorities.set(expected.workerId, authority({
        leaseId: transactionId,
        fencingToken: journalRevision,
        nodeGeneration: plan.target.nodeGeneration,
      }, plan.target.nodeGeneration));
    }
  };

  const maintenanceTargetFactory = async ({ profile, previousIdentity = null, purpose } = {}) => {
    if (typeof purpose !== "string" || purpose.length < 3 || purpose.length > 64) {
      throw new TypeError("protected office target purpose is invalid");
    }
    const expected = normalizedByWorker.get(profile?.workerId);
    if (!expected) throw new TypeError("protected office target requested an unknown Worker");
    if (previousIdentity != null) {
      const target = previousTargets.get(expected.workerId);
      const priorIdentity = targetIdentity(target, expected);
      if (!identityMatches(previousIdentity, priorIdentity)) {
        throw new TypeError("protected office previous target is not bound by the exact migration parent");
      }
      requestedProfile(profile, priorIdentity, "protected office previous target request");
      return deepFreeze(copy(target));
    }
    requestedProfile(profile, expected, "protected office desired target request");
    return deepFreeze(copy(desiredTargets.get(expected.workerId)));
  };

  const protectedSetProvider = async ({ nodeId } = {}) => {
    if (nodeId !== plan.target.nodeId) throw new TypeError("protected office set requested for another node");
    return deepFreeze({
      maintenanceGeneration: plan.set.maintenanceGeneration,
      profiles: copy(normalized),
    });
  };

  const guardedRealtimePlacementResolver = Object.freeze({
    async resolve(request) {
      const result = await realtimePlacementResolver.resolve(deepFreeze(copy(object(request,
        "realtime placement request"))));
      if (!Array.isArray(result)) throw new TypeError("realtime placement production adapter returned a non-array");
      return deepFreeze(copy(result));
    },
  });

  const guardedCoreServiceProbe = async ({ nodeId, setId, phase } = {}) => {
    if (nodeId !== plan.target.nodeId || setId !== SET_ID || typeof phase !== "string" || phase.length < 2) {
      throw new TypeError("protected office core-service probe request drifted");
    }
    const result = object(await coreServiceProbe.probe(deepFreeze({
      nodeId,
      setId,
      phase,
      planDigest: snapshot.planDigest,
    })), "protected office core-service probe result");
    if (result.healthy !== true || result.nodeId !== nodeId || result.setId !== setId || result.phase !== phase
        || result.source !== "authenticated-core-service-probe"
        || !Number.isFinite(new Date(result.observedAt).getTime())) {
      throw new TypeError("protected office core-service probe did not prove the authenticated service health");
    }
    return deepFreeze(copy(result));
  };

  return Object.freeze({
    bindingFactory,
    maintenanceTargetFactory,
    protectedSetProvider,
    realtimePlacementResolver: guardedRealtimePlacementResolver,
    coreServiceProbe: guardedCoreServiceProbe,
  });
}

function pointer(document, path) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError("parent fact pointer is invalid");
  let value = document;
  for (const raw of path.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (raw.replace(/~[01]/g, "").includes("~")) throw new TypeError("parent fact pointer escape is invalid");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= value.length) {
        throw new TypeError(`parent fact is missing: ${path}`);
      }
      value = value[Number(token)];
    } else if (value && typeof value === "object" && Object.hasOwn(value, token)) {
      value = value[token];
    } else {
      throw new TypeError(`parent fact is missing: ${path}`);
    }
  }
  return value;
}

/** Read-only exact parent evidence validation; validator execution is delegated to a strict runner. */
export function createProtectedOfficeSetParentEvidenceVerifier({
  planSnapshot,
  validatorRunner,
  fileSystem = defaultFileSystem,
} = {}) {
  const snapshot = object(planSnapshot, "protected office plan snapshot");
  const plan = object(snapshot.plan, "protected office plan");
  if (snapshot.planDigest !== digest(plan) || typeof validatorRunner?.runStrictValidator !== "function") {
    throw new TypeError("protected office parent verifier dependencies are incomplete");
  }
  return Object.freeze({
    async verify({ plan: requestedPlan } = {}) {
      if (digest(requestedPlan) !== snapshot.planDigest) {
        throw new TypeError("protected office parent verification requested a different plan");
      }
      for (const [name, reference] of Object.entries(plan.parents)) {
        const evidenceFile = await jsonFile(snapshot.repositoryRoot, reference.path,
          `${name} parent evidence`, fileSystem);
        const evidence = copy(evidenceFile.value);
        const recorded = evidence.evidenceDigest;
        delete evidence.evidenceDigest;
        if (recorded !== reference.evidenceDigest || digest(evidence) !== recorded
            || evidence.runId !== reference.runId || evidence.runnerId !== reference.runnerId
            || ![evidence.status, evidence.outcome].includes("passed")) {
          throw new TypeError(`${name} parent evidence identity or digest drifted`);
        }
        for (const fact of reference.requiredFacts ?? []) {
          object(fact, `${name} required fact`);
          const actual = pointer(evidence, fact.pointer);
          if (typeof actual !== typeof fact.equals || !same(actual, fact.equals)) {
            throw new TypeError(`${name} required parent fact drifted`);
          }
        }
        const validator = await boundedRegularFile(snapshot.repositoryRoot, reference.validator,
          `${name} strict validator`, fileSystem, 2 * 1024 * 1024);
        validator.bytes.fill(0);
        const result = object(await validatorRunner.runStrictValidator(deepFreeze({
          validatorPath: validator.path,
          evidencePath: evidenceFile.path,
          repositoryRoot: snapshot.repositoryRoot,
          timeoutMilliseconds: VALIDATOR_TIMEOUT_MILLISECONDS,
        })), `${name} strict validator result`);
        if (result.status !== "passed" || result.exitCode !== 0
            || result.validatorPath !== validator.path || result.evidencePath !== evidenceFile.path) {
          throw new TypeError(`${name} strict parent validator failed or verified another file`);
        }
      }
      return Object.freeze({
        parentsValidated: true,
        adapterDigest: plan.controller.adapterDigest,
        driverDigest: plan.controller.driverModuleDigest,
      });
    },
  });
}

function exactScenarioRequest(value, snapshot, label) {
  object(value, label);
  if (typeof value.runId !== "string" || value.runId.length < 8 || !UUID.test(value.actionId ?? "")
      || !SHA256.test(value.idempotencyKey ?? "") || digest(value.plan) !== snapshot.planDigest) {
    throw new TypeError(`${label} identity drifted`);
  }
}

export function createProtectedOfficeSetPublicHttpsScenarioRunner({ planSnapshot, client } = {}) {
  const snapshot = object(planSnapshot, "protected office plan snapshot");
  if (typeof client?.runConcurrentOffice !== "function") {
    throw new TypeError("protected office public HTTPS production client is missing");
  }
  return Object.freeze({
    async runConcurrentOffice(request) {
      exactScenarioRequest(request, snapshot, "protected office public HTTPS request");
      let origin;
      try { origin = new URL(request.publicOrigin); } catch {
        throw new TypeError("protected office public HTTPS origin is invalid");
      }
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/"
          || origin.search || origin.hash) {
        throw new TypeError("protected office scenario must use authenticated public HTTPS");
      }
      const result = object(await client.runConcurrentOffice(deepFreeze(copy(request))),
        "protected office public HTTPS result");
      if (result.transport !== "authenticated-public-https"
          || !UUID.test(result.assistantRunId ?? "") || !UUID.test(result.realtimeSessionId ?? "")
          || !UUID.test(result.ordinaryConflictingJobId ?? "")
          || !result.jobIds || !same(Object.keys(result.jobIds).sort(), [...COMPUTE_JOB_CAPABILITIES].sort())
          || Object.values(result.jobIds).some((jobId) => !UUID.test(jobId ?? ""))) {
        throw new TypeError("protected office public HTTPS client did not return exact durable execution identities");
      }
      return deepFreeze(copy(result));
    },
  });
}

export function createProtectedOfficeSetMaintenanceContextProvider({ planSnapshot, allocator } = {}) {
  const snapshot = object(planSnapshot, "protected office plan snapshot");
  if (typeof allocator?.create !== "function") throw new TypeError("protected office maintenance allocator is missing");
  // This adapter feeds the canonical maintenance-signature payload.  Keep
  // membership sorted independently of dependency/stage order in the plan.
  const expectedWorkerIds = snapshot.plan.set.profiles.map((profile) => profile.workerId).sort();
  return Object.freeze({
    async create(request) {
      object(request, "protected office maintenance allocation request");
      if (!same(request.workerIds, expectedWorkerIds)
          || request.maintenanceGeneration !== snapshot.plan.set.maintenanceGeneration
          || request.operation !== "protected-set.maintenance") {
        throw new TypeError("protected office maintenance allocation request drifted");
      }
      const result = object(await allocator.create(deepFreeze(copy(request))),
        "protected office maintenance allocation result");
      if (!UUID.test(result.transactionId ?? "") || !Number.isSafeInteger(result.journalRevision)
          || result.journalRevision < 1 || !same(result.workerIds, expectedWorkerIds)
          || !same(result.allowedOperations, ["protected-set.maintenance"])
          || result.maintenanceGeneration !== snapshot.plan.set.maintenanceGeneration
          || Object.hasOwn(result, "signature")) {
        throw new TypeError("protected office maintenance allocator did not persist the exact unsigned context");
      }
      return deepFreeze(copy(result));
    },
  });
}

export function createProtectedOfficeSetPlatformLifecycleController({ planSnapshot, client } = {}) {
  const snapshot = object(planSnapshot, "protected office plan snapshot");
  if (["inspect", "beginPlatformRestart", "recoverPlatformRestart"]
    .some((method) => typeof client?.[method] !== "function")) {
    throw new TypeError("protected office Platform lifecycle production client is incomplete");
  }
  const invoke = async (method, request) => {
    object(request, `protected office lifecycle ${method} request`);
    if (typeof request.runId !== "string" || !UUID.test(request.actionId ?? "")
        || !SHA256.test(request.idempotencyKey ?? "")) {
      throw new TypeError(`protected office lifecycle ${method} request identity is invalid`);
    }
    const result = await client[method](deepFreeze(copy(request)));
    if (method === "beginPlatformRestart") {
      throw new TypeError("protected office lifecycle restart returned without a real Platform disconnect");
    }
    object(result, `protected office lifecycle ${method} result`);
    if (!["ready", "restart-requested", "complete"].includes(result.phase)) {
      throw new TypeError(`protected office lifecycle ${method} result phase is invalid`);
    }
    return deepFreeze(copy(result));
  };
  return Object.freeze({
    inspect: (request) => invoke("inspect", request),
    beginPlatformRestart: (request) => invoke("beginPlatformRestart", request),
    recoverPlatformRestart: (request) => invoke("recoverPlatformRestart", request),
    planDigest: snapshot.planDigest,
  });
}

export function createProtectedOfficeSetFaultController({ planSnapshot, controller } = {}) {
  const snapshot = object(planSnapshot, "protected office plan snapshot");
  if (typeof controller?.executeMidSequenceFailure !== "function") {
    throw new TypeError("protected office fault production controller is missing");
  }
  return Object.freeze({
    async executeMidSequenceFailure(request) {
      exactScenarioRequest(request, snapshot, "protected office fault request");
      const result = object(await controller.executeMidSequenceFailure(request),
        "protected office fault result");
      if (result.observedFailureCode !== snapshot.plan.qualification.faultInjection.expectedFailureCode
          || !UUID.test(result.failedTransactionId ?? "") || !Number.isSafeInteger(result.failedJournalRevision)
          || result.failedJournalRevision < 1 || result.oomKilled !== false) {
        throw new TypeError("protected office fault controller did not prove the exact non-OOM durable failure");
      }
      return deepFreeze(copy(result));
    },
  });
}

/**
 * Produces the service fragment expected by
 * createProtectedOfficeSetProductionRuntimeFromEnvironment.  It performs no
 * deployment itself and has no success fallback for any external boundary.
 */
export async function createProtectedOfficeSetProductionWiringFromEnvironment(
  environment = process.env,
  dependencies = {},
) {
  const repositoryRoot = dependencies.repositoryRoot
    ?? environment.PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT;
  const planFile = dependencies.planFile
    ?? environment.PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE;
  const requestedDeploymentId = dependencies.deploymentId
    ?? environment.PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID
    ?? DEPLOYMENT_ID;
  const contract = deploymentContract(requestedDeploymentId, dependencies.planRelativePath ?? null);
  const planSnapshot = await loadProtectedOfficeSetDeploymentPlan({
    repositoryRoot,
    planFile,
    deploymentId: contract.deploymentId,
    planRelativePath: contract.planRelativePath,
    fileSystem: dependencies.fileSystem ?? defaultFileSystem,
  });
  if (environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID !== planSnapshot.plan.target.nodeId
      || String(planSnapshot.plan.target.nodeGeneration)
        !== environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION) {
    throw new TypeError("protected office runtime environment does not match the execution-ready target");
  }
  const maintenanceSigner = await (dependencies.maintenanceSignerClientFactory
    ?? createProtectedOfficeMaintenanceSignerClientFromEnvironment)(environment,
    dependencies.maintenanceSignerClientOptions ?? {});
  if (typeof maintenanceSigner?.sign !== "function" || typeof maintenanceSigner?.close !== "function") {
    maintenanceSigner?.close?.();
    throw new TypeError("protected office maintenance signer client is incomplete");
  }
  try {
    const protectedOfficeSetBindings = createProtectedOfficeSetPlanBindings({
      planSnapshot,
      leaseAuthorityProvider: dependencies.leaseAuthorityProvider,
      realtimePlacementResolver: dependencies.realtimePlacementResolver,
      coreServiceProbe: dependencies.coreServiceProbe,
    });
    const protectedOfficeSetParentEvidenceVerifier = createProtectedOfficeSetParentEvidenceVerifier({
      planSnapshot,
      validatorRunner: dependencies.validatorRunner,
      fileSystem: dependencies.fileSystem ?? defaultFileSystem,
    });
    const protectedOfficeSetPublicHttpsScenarioRunner = createProtectedOfficeSetPublicHttpsScenarioRunner({
      planSnapshot, client: dependencies.publicHttpsScenarioClient,
    });
    const protectedOfficeSetMaintenanceContextProvider = createProtectedOfficeSetMaintenanceContextProvider({
      planSnapshot, allocator: dependencies.maintenanceContextAllocator,
    });
    const protectedOfficeSetPlatformLifecycleController = createProtectedOfficeSetPlatformLifecycleController({
      planSnapshot, client: dependencies.platformLifecycleClient,
    });
    const protectedOfficeSetFaultController = createProtectedOfficeSetFaultController({
      planSnapshot, controller: dependencies.faultController,
    });
    let closed = false;
    const protectedOfficeSetClose = async () => {
      if (closed) return;
      closed = true;
      await maintenanceSigner.close();
    };
    const services = Object.freeze({
      protectedOfficeSetBindings,
      protectedOfficeSetParentEvidenceVerifier,
      protectedOfficeSetPublicHttpsScenarioRunner,
      protectedOfficeSetMaintenanceContextProvider,
      protectedOfficeSetMaintenanceSigner: maintenanceSigner,
      protectedOfficeSetPlatformLifecycleController,
      protectedOfficeSetFaultController,
      protectedOfficeSetClose,
    });
    return Object.freeze({ planSnapshot, services, close: protectedOfficeSetClose });
  } catch (error) {
    await maintenanceSigner.close();
    throw error;
  }
}

export const protectedOfficeSetProductionWiringContract = deepFreeze({
  deploymentId: DEPLOYMENT_ID,
  exactPlanRelativePath: PLAN_RELATIVE_PATH,
  slots: [...SLOT_ORDER],
  capabilities: [...CAPABILITIES],
  environment: [
    "PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT",
    "PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE",
    "PLATFORM_PROTECTED_OFFICE_SET_NODE_ID",
    "PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION",
    "PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE",
    "PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY",
  ],
  injectedProductionBoundaries: {
    leaseAuthorityProvider: "getAuthority(request) -> {leaseId,fencingToken,nodeGeneration}",
    validatorRunner: "runStrictValidator({validatorPath,evidencePath,repositoryRoot,timeoutMilliseconds})",
    coreServiceProbe: "probe(request) -> authenticated reserve observation",
    realtimePlacementResolver: "resolve(request) -> production placement candidates",
    publicHttpsScenarioClient: "runConcurrentOffice(request) -> durable authenticated HTTPS job IDs",
    maintenanceContextAllocator: "create(request) -> persisted unsigned context + journalRevision",
    platformLifecycleClient: "inspect/beginPlatformRestart/recoverPlatformRestart",
    faultController: "executeMidSequenceFailure(request) -> durable non-OOM rollback identity",
  },
  successFallbacks: false,
});

export const protectedOfficeSetProductionWiringV5Contract = deepFreeze({
  ...protectedOfficeSetProductionWiringContract,
  deploymentId: V5_DEPLOYMENT_ID,
  exactPlanRelativePath: V5_PLAN_RELATIVE_PATH,
  runtimeBundleRequired: true,
  bootstrapCaptureRunnerId: "teamaibox.protected-office-set-v5-runtime-capture.v1",
});
