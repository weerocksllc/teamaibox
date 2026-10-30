import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { createProtectedOfficeSetProductionRuntimeFromEnvironment } from "./protected-office-set-production-scenarios.mjs";
import { createProtectedOfficeSetProductionWiringFromEnvironment } from "./protected-office-set-production-wiring.mjs";
import { validateProtectedOfficeGenerationRecovery } from "./protected-office-generation-recovery.mjs";
import { validateRuntimeMaintenance } from "./protected-office-runtime-maintenance.mjs";

const DEPLOYMENT_ID = "teamaibox.protected-office-set-deployment.v5";
const BUNDLE_ID = "teamaibox.protected-office-set-runtime-bundle.v5";
const CAPTURE_RUNNER_ID = "teamaibox.protected-office-set-v5-runtime-capture.v1";
const BUNDLE_ROOT = "/run/teamaibox/protected-office-set/bundle";
const MANIFEST_PATH = `${BUNDLE_ROOT}/bundle-manifest.json`;
const PLAN_RELATIVE_PATH = "deploy/compute/protected-office-set-deployment.v5.json";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAXIMUM_FILE_BYTES = 16 * 1024 * 1024;
const defaultFileSystem = Object.freeze({ lstat, readFile, realpath });

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw new TypeError("protected office bundle contains non-canonical JSON");
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function documentDigest(value) {
  return digest(Buffer.from(canonical(value), "utf8"));
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function exactKeys(value, expected, label) {
  object(value, label);
  if (!same(Object.keys(value).sort(), [...expected].sort())) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.length < 3 || isAbsolute(value) || value.includes("\\")) {
    throw new TypeError(`${label} must be bundle-relative`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`${label} escapes the runtime bundle`);
  }
  return value;
}

function within(root, path) {
  const scoped = relative(root, path);
  return scoped !== "" && scoped !== ".." && !scoped.startsWith(`..${sep}`) && !isAbsolute(scoped);
}

async function boundedFile(root, relativePath, fileSystem, maximum = MAXIMUM_FILE_BYTES) {
  const name = safeRelativePath(relativePath, "protected office bundle file");
  const requested = resolve(root, name);
  if (!within(root, requested)) throw new TypeError("protected office bundle file escapes its root");
  const actual = await fileSystem.realpath(requested);
  if (actual !== requested || !within(root, actual)) throw new TypeError("protected office bundle file cannot be a symbolic link");
  const stats = await fileSystem.lstat(actual);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maximum) {
    throw new TypeError("protected office bundle file is not a bounded regular file");
  }
  const bytes = await fileSystem.readFile(actual);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== stats.size) {
    throw new TypeError("protected office bundle file changed while it was read");
  }
  return Object.freeze({ path: actual, relativePath: name, bytes });
}

/**
 * Validate the post-create bundle without trusting the image filesystem.  The
 * candidate Platform container is created first with this volume mounted RO;
 * a separate installer fills the volume, and the same container ID is then
 * started.  Consequently neither the Platform image nor its config digest can
 * recursively depend on the v5 plan bytes.
 */
export async function loadProtectedOfficeSetRuntimeBundleFromEnvironment(environment = process.env, {
  fileSystem = defaultFileSystem,
  expectedRoot = BUNDLE_ROOT,
} = {}) {
  const configuredRoot = environment.PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT;
  const configuredManifest = environment.PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_MANIFEST_FILE;
  if (configuredRoot !== expectedRoot || configuredManifest !== `${expectedRoot}/bundle-manifest.json`
      || environment.PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID !== DEPLOYMENT_ID) {
    throw new TypeError("protected office v5 bundle environment is incomplete");
  }
  if (!fileSystem?.realpath || !fileSystem?.lstat || !fileSystem?.readFile) {
    throw new TypeError("protected office v5 bundle filesystem is incomplete");
  }
  const root = await fileSystem.realpath(configuredRoot);
  if (root !== configuredRoot) throw new TypeError("protected office v5 bundle root cannot be a symbolic link");
  const manifestFile = await boundedFile(root, "bundle-manifest.json", fileSystem);
  let manifest;
  try { manifest = JSON.parse(manifestFile.bytes.toString("utf8")); }
  catch (error) { throw new TypeError("protected office v5 bundle manifest is not JSON", { cause: error }); }
  finally { manifestFile.bytes.fill(0); }
  exactKeys(manifest, [
    "schemaVersion", "bundleId", "deploymentId", "plan", "bootstrapCapture",
    "installation", "files", "manifestDigest",
  ], "protected office v5 bundle manifest");
  const recorded = manifest.manifestDigest;
  const unsigned = structuredClone(manifest);
  delete unsigned.manifestDigest;
  const planBinding = exactKeys(manifest.plan, ["path", "sha256"],
    "protected office v5 bundle plan");
  const capture = exactKeys(manifest.bootstrapCapture,
    ["path", "runnerId", "runId", "evidenceDigest"],
    "protected office v5 bootstrap capture");
  const installation = exactKeys(manifest.installation, [
    "candidatePlatformContainerId", "candidateCreatedBeforePlan",
    "containerRecreatedAfterPlan", "mountSource", "mountDestination", "mountReadOnly",
  ], "protected office v5 bundle installation");
  if (manifest.schemaVersion !== 1 || manifest.bundleId !== BUNDLE_ID
      || manifest.deploymentId !== DEPLOYMENT_ID || recorded !== documentDigest(unsigned)
      || planBinding.path !== PLAN_RELATIVE_PATH || !SHA256.test(planBinding.sha256 ?? "")
      || capture.runnerId !== CAPTURE_RUNNER_ID || typeof capture.runId !== "string"
      || capture.runId.length < 8 || !SHA256.test(capture.evidenceDigest ?? "")
      || typeof capture.path !== "string" || !capture.path.startsWith("evidence/validation/")
      || !HEX64.test(installation.candidatePlatformContainerId ?? "")
      || installation.candidateCreatedBeforePlan !== true
      || installation.containerRecreatedAfterPlan !== false
      || installation.mountDestination !== expectedRoot || installation.mountReadOnly !== true
      || !Array.isArray(manifest.files) || manifest.files.length < 1) {
    throw new TypeError("protected office v5 bundle manifest drifted");
  }
  const seen = new Set();
  const orderedNames = [];
  for (const entry of manifest.files) {
    exactKeys(entry, ["path", "sha256"], "protected office v5 bundle file binding");
    const name = safeRelativePath(entry.path, "protected office v5 bundle file path");
    if (seen.has(name) || !SHA256.test(entry.sha256 ?? "")) {
      throw new TypeError("protected office v5 bundle file bindings are duplicated or invalid");
    }
    seen.add(name);
    orderedNames.push(name);
    const file = await boundedFile(root, name, fileSystem);
    try {
      if (digest(file.bytes) !== entry.sha256) throw new TypeError(`protected office v5 bundle file drifted: ${name}`);
    } finally { file.bytes.fill(0); }
  }
  if (!same(orderedNames, [...orderedNames].sort()) || seen.has("bundle-manifest.json")) {
    throw new TypeError("protected office v5 bundle file order or self-reference drifted");
  }
  if (!seen.has(PLAN_RELATIVE_PATH)) throw new TypeError("protected office v5 bundle omits its plan");
  if (!seen.has(capture.path)) throw new TypeError("protected office v5 bundle omits its bootstrap capture");
  const captureFile = await boundedFile(root, capture.path, fileSystem);
  let captureEvidence;
  let captureTarget;
  let captureCandidate;
  let captureAgent;
  let captureAuthorities;
  let captureSet;
  let captureBundle;
  let captureMigration;
  try {
    captureEvidence = JSON.parse(captureFile.bytes.toString("utf8"));
    exactKeys(captureEvidence, [
      "schemaVersion", "runnerId", "runId", "status", "capturedAt", "migration",
      "target", "set", "bundle", "privacy", "claimBoundary", "evidenceDigest",
      ...(captureEvidence.schemaVersion === 2 ? ["generationRecovery"] : []),
      ...(captureEvidence.schemaVersion === 3 ? ["runtimeMaintenance"] : []),
    ], "protected office v5 bootstrap capture evidence");
    captureMigration = exactKeys(captureEvidence.migration,
      ["path", "runnerId", "runId", "evidenceDigest", "validator"],
      "protected office v5 bootstrap capture migration");
    captureTarget = exactKeys(captureEvidence.target,
      ["nodeId", "nodeGeneration", "candidatePlatform", "nodeAgentIdentity", "protectedWorkerAuthorities"],
      "protected office v5 bootstrap capture target");
    captureCandidate = exactKeys(captureTarget.candidatePlatform, [
      "containerName", "containerId", "imageId", "imageReference", "configDigest",
      "state", "mount", "environment",
    ], "protected office v5 bootstrap candidate Platform");
    captureAgent = exactKeys(captureTarget.nodeAgentIdentity, [
      "containerName", "containerId", "imageId", "imageReference", "configDigest", "state",
      "stateVolume", "journalPath", "managedEndpoint", "certificatePin",
    ], "protected office v5 bootstrap Node Agent");
    if (!Array.isArray(captureTarget.protectedWorkerAuthorities)
        || captureTarget.protectedWorkerAuthorities.length !== 6) {
      throw new TypeError("protected office v5 bootstrap worker authorities drifted");
    }
    captureAuthorities = captureTarget.protectedWorkerAuthorities.map((entry) => {
      exactKeys(entry, [
        "slot", "workerId", "modelProfileId", "leaseId", "fencingToken", "nodeGeneration",
      ], "protected office v5 bootstrap worker authority");
      if (typeof entry.slot !== "string" || entry.slot.length < 3
          || !UUID.test(entry.workerId ?? "") || !UUID.test(entry.modelProfileId ?? "")
          || !UUID.test(entry.leaseId ?? "") || !Number.isInteger(entry.fencingToken)
          || entry.fencingToken < 1 || entry.nodeGeneration !== captureTarget.nodeGeneration) {
        throw new TypeError("protected office v5 bootstrap worker authority drifted");
      }
      return entry;
    });
    if (new Set(captureAuthorities.map((entry) => entry.slot)).size !== 6
        || new Set(captureAuthorities.map((entry) => entry.workerId)).size !== 6
        || new Set(captureAuthorities.map((entry) => entry.modelProfileId)).size !== 6) {
      throw new TypeError("protected office v5 bootstrap worker authorities are duplicated");
    }
    captureSet = exactKeys(captureEvidence.set,
      ["desiredStateRevision", "maintenanceGeneration"],
      "protected office v5 bootstrap capture set");
    captureBundle = exactKeys(captureEvidence.bundle, [
      "volumeName", "destination", "manifestFile", "planFile", "readOnly",
      "bundleInstalled", "candidateCreatedBeforePlan", "containerRecreatedAfterPlan",
    ], "protected office v5 bootstrap capture bundle");
    const captureUnsigned = structuredClone(captureEvidence);
    delete captureUnsigned.evidenceDigest;
    if (![1, 2, 3].includes(captureEvidence?.schemaVersion)) throw new TypeError("protected office v5 bootstrap capture schema drifted");
    if (captureEvidence?.runnerId !== CAPTURE_RUNNER_ID) throw new TypeError("protected office v5 bootstrap capture runner drifted");
    if (captureEvidence?.runId !== capture.runId) throw new TypeError("protected office v5 bootstrap capture run drifted");
    if (captureEvidence?.status !== "passed") throw new TypeError("protected office v5 bootstrap capture status drifted");
    if (captureEvidence?.evidenceDigest !== capture.evidenceDigest
        || documentDigest(captureUnsigned) !== capture.evidenceDigest) {
      throw new TypeError("protected office v5 bootstrap capture digest drifted");
    }
    const captureTimestamp = Date.parse(captureEvidence.capturedAt ?? "");
    const expectedCandidateEnvironment = {
      PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID: DEPLOYMENT_ID,
      PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT: expectedRoot,
      PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_MANIFEST_FILE: configuredManifest,
      PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT: expectedRoot,
      PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE: `${expectedRoot}/${PLAN_RELATIVE_PATH}`,
      PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: captureTarget.nodeId,
      PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION: String(captureTarget.nodeGeneration),
    };
    if (captureCandidate.state !== "created"
        || !captureEvidence.capturedAt?.endsWith("Z") || !Number.isFinite(captureTimestamp)
        || captureBundle.destination !== expectedRoot
        || captureBundle.manifestFile !== configuredManifest
        || captureBundle.planFile !== `${expectedRoot}/${PLAN_RELATIVE_PATH}`
        || captureBundle.readOnly !== true || captureBundle.bundleInstalled !== false
        || captureBundle.candidateCreatedBeforePlan !== true
        || captureBundle.containerRecreatedAfterPlan !== false
        || !same(captureCandidate.mount, {
          type: "volume", source: captureBundle.volumeName,
          destination: expectedRoot, readOnly: true,
        })
        || !same(captureCandidate.environment, expectedCandidateEnvironment)
        || !same(captureEvidence.privacy, {
          credentialsRetained: false, environmentSecretsRetained: false,
          commandOutputRetained: false, userContentRetained: false,
        })
        || !same(captureEvidence.claimBoundary, {
          migrationComplete: true, candidateContainerCaptured: true,
          bundleInstalled: false, v5PlanGenerated: false, task21_4Complete: false,
        })) {
      throw new TypeError("protected office v5 bootstrap capture sequence drifted");
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError("protected office v5 bootstrap capture is not JSON", { cause: error });
    }
    throw error;
  } finally { captureFile.bytes.fill(0); }
  async function lineageDocument(binding) {
    exactKeys(binding, ["path", "runnerId", "runId", "evidenceDigest"], "protected office lineage binding");
    if (!binding.path?.startsWith("evidence/validation/") || !seen.has(binding.path)) {
      throw new TypeError("protected office bundle omits lineage evidence");
    }
    const file = await boundedFile(root, binding.path, fileSystem);
    try {
      const value = JSON.parse(file.bytes.toString("utf8"));
      const unsigned = structuredClone(value); delete unsigned.evidenceDigest;
      if (value.runnerId !== binding.runnerId || value.runId !== binding.runId
          || value.status !== "passed" || value.evidenceDigest !== binding.evidenceDigest
          || documentDigest(unsigned) !== binding.evidenceDigest) throw new TypeError("protected office lineage digest drifted");
      return value;
    } finally { file.bytes.fill(0); }
  }
  async function validateLineage(current, visited = new Set()) {
    if (visited.has(current.evidenceDigest) || visited.size >= 32) throw new TypeError("protected office lineage cycle or depth exceeded");
    visited.add(current.evidenceDigest);
    if (current.schemaVersion === 3) {
      const receipt = await lineageDocument(current.runtimeMaintenance);
      const predecessor = await lineageDocument(receipt.predecessorCapture);
      if (predecessor.runnerId !== CAPTURE_RUNNER_ID) throw new TypeError("protected office predecessor capture runner drifted");
      await validateLineage(predecessor, visited);
      validateRuntimeMaintenance(receipt, current.runtimeMaintenance, current, predecessor);
    } else if (current.schemaVersion === 2) {
    const recovery = exactKeys(current.generationRecovery,
      ["path", "runnerId", "runId", "evidenceDigest"], "protected office generation recovery binding");
    if (!recovery.path?.startsWith("evidence/validation/") || !seen.has(recovery.path)) {
      throw new TypeError("protected office bundle omits generation recovery");
    }
    const recoveryFile = await boundedFile(root, recovery.path, fileSystem);
    try {
      const receipt = JSON.parse(recoveryFile.bytes.toString("utf8"));
      let predecessor = null;
      let previousRecovery = null;
      if (receipt.schemaVersion === 2) {
        predecessor = await lineageDocument(receipt.predecessorCapture);
        if (predecessor.runnerId !== CAPTURE_RUNNER_ID) throw new TypeError("protected office predecessor capture runner drifted");
        await validateLineage(predecessor, visited);
        if (receipt.previousRecovery) previousRecovery = await lineageDocument(receipt.previousRecovery);
        if (receipt.companionRetirement) {
          const retired = exactKeys(receipt.companionRetirement, ["path", "sha256", "runId", "evidenceDigest"], "protected office companion retirement binding");
          if (!seen.has(retired.path) || !retired.path.startsWith("evidence/validation/")) throw new TypeError("protected office bundle omits companion retirement");
          const file = await boundedFile(root, retired.path, fileSystem);
          try {
            const value = JSON.parse(file.bytes.toString("utf8"));
            const unsigned = structuredClone(value); delete unsigned.evidenceDigest;
            if (digest(file.bytes) !== retired.sha256 || value.status !== "passed"
                || value.runId !== retired.runId || value.evidenceDigest !== retired.evidenceDigest
                || documentDigest(unsigned) !== `sha256:${retired.evidenceDigest}`
                || value.adapter !== 'db98e5b3ba03727d9f943a50b245f75b0b0cdf0201d49c65dead1762a043d439') {
              throw new TypeError("protected office companion retirement evidence drifted");
            }
          } finally { file.bytes.fill(0); }
        }
      }
      validateProtectedOfficeGenerationRecovery(receipt, recovery, current, predecessor, previousRecovery);
    } finally { recoveryFile.bytes.fill(0); }
    } else if (current.schemaVersion !== 1) throw new TypeError("protected office lineage schema drifted");
  }
  await validateLineage(captureEvidence);
  const planFile = await boundedFile(root, PLAN_RELATIVE_PATH, fileSystem);
  let plan;
  try {
    if (digest(planFile.bytes) !== planBinding.sha256) throw new TypeError("protected office v5 plan binding drifted");
    plan = JSON.parse(planFile.bytes.toString("utf8"));
  } finally { planFile.bytes.fill(0); }
  if (plan?.deploymentId !== DEPLOYMENT_ID || plan?.readyForExecution !== true
      || plan?.runtimeBundle?.root !== expectedRoot
      || plan?.runtimeBundle?.manifestFile !== configuredManifest
      || plan?.runtimeBundle?.planFile !== `${expectedRoot}/${PLAN_RELATIVE_PATH}`
      || plan?.runtimeBundle?.bootstrapCapture?.evidenceDigest !== capture.evidenceDigest
      || plan?.runtimeBundle?.bootstrapCapture?.runId !== capture.runId
      || plan?.runtimeBundle?.candidateCreatedBeforePlan !== true
      || plan?.runtimeBundle?.containerRecreatedAfterPlan !== false
      || plan?.target?.platformIdentity?.containerId !== installation.candidatePlatformContainerId
      || installation.mountSource !== plan?.runtimeBundle?.mount?.source
      || captureCandidate?.containerId
        !== plan?.target?.platformIdentity?.containerId
      || captureCandidate?.containerName
        !== plan?.target?.platformIdentity?.containerName
      || captureCandidate?.imageId !== plan?.target?.platformIdentity?.imageId
      || captureCandidate?.imageReference
        !== plan?.target?.platformIdentity?.imageReference
      || captureCandidate?.configDigest
        !== plan?.target?.platformIdentity?.configDigest
      || !same(captureAgent, plan?.target?.nodeAgentIdentity)
      || captureTarget?.nodeId !== plan?.target?.nodeId
      || captureTarget?.nodeGeneration !== plan?.target?.nodeGeneration
      || captureSet?.desiredStateRevision !== plan?.set?.desiredStateRevision
      || captureSet?.maintenanceGeneration !== plan?.set?.maintenanceGeneration
      || captureBundle?.volumeName !== plan?.runtimeBundle?.mount?.source
      || !same(captureAuthorities, plan?.set?.profiles?.map((profile) => ({
        slot: profile.slot,
        workerId: profile.priorState?.target?.workerId,
        modelProfileId: profile.priorState?.target?.modelProfileId,
        leaseId: profile.priorState?.authority?.leaseId,
        fencingToken: profile.priorState?.authority?.fencingToken,
        nodeGeneration: profile.priorState?.authority?.nodeGeneration,
      })))
      || !same(captureMigration, {
        path: plan?.parents?.legacyCanonicalDeployment?.path,
        runnerId: plan?.parents?.legacyCanonicalDeployment?.runnerId,
        runId: plan?.parents?.legacyCanonicalDeployment?.runId,
        evidenceDigest: plan?.parents?.legacyCanonicalDeployment?.evidenceDigest,
        validator: plan?.parents?.legacyCanonicalDeployment?.validator,
      })) {
    throw new TypeError("protected office v5 plan and bundle boundary disagree");
  }
  return Object.freeze({
    root,
    manifestPath: configuredManifest,
    planFile: resolve(root, PLAN_RELATIVE_PATH),
    manifest: Object.freeze(structuredClone(manifest)),
  });
}

export function createProtectedOfficeSetProductionRuntimeFactory({
  bundleLoader = loadProtectedOfficeSetRuntimeBundleFromEnvironment,
  wiringFactory = createProtectedOfficeSetProductionWiringFromEnvironment,
  runtimeFactory = createProtectedOfficeSetProductionRuntimeFromEnvironment,
  productionBoundaryFactory = null,
} = {}) {
  return async (environment, services = {}) => {
    const bundle = await bundleLoader(environment);
    const boundaryFactory = services.protectedOfficeSetProductionBoundaryFactory
      ?? productionBoundaryFactory;
    if (typeof boundaryFactory !== "function") {
      throw new TypeError("protected office production boundary factory is unavailable");
    }
    const boundaryDependencies = await boundaryFactory(environment, Object.freeze({ ...services, bundle }));
    object(boundaryDependencies, "protected office production boundary dependencies");
    if (typeof boundaryDependencies.publicHttpsInspectionFetcher !== "function") {
      throw new TypeError("protected office production HTTPS inspection fetcher is unavailable");
    }
    if (!Array.isArray(boundaryDependencies.requiredCoreServiceKeys)
        || boundaryDependencies.requiredCoreServiceKeys.length < 1) {
      throw new TypeError("protected office required core-service keys are unavailable");
    }
    const wiring = await wiringFactory(environment, {
      ...boundaryDependencies,
      repositoryRoot: bundle.root,
      planFile: bundle.planFile,
      deploymentId: DEPLOYMENT_ID,
      planRelativePath: PLAN_RELATIVE_PATH,
    });
    let runtime;
    try {
      runtime = await runtimeFactory(environment, {
        ...services,
        fetcher: boundaryDependencies.publicHttpsInspectionFetcher,
        requiredCoreServiceKeys: boundaryDependencies.requiredCoreServiceKeys,
        ...wiring.services,
        });
    } catch (error) {
      await wiring.close();
      throw error;
    }
    let closed = false;
    return Object.freeze({
      ...runtime,
      async close() {
        if (closed) return;
        closed = true;
        const errors = [];
        try { await runtime.close?.(); } catch (error) { errors.push(error); }
        try { await wiring.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "protected office production runtime close failed");
      },
    });
  };
}

export const createProtectedOfficeSetProductionRuntimeFactoryFromEnvironment =
  createProtectedOfficeSetProductionRuntimeFactory();

export const protectedOfficeSetProductionRuntimeFactoryContract = Object.freeze({
  deploymentId: DEPLOYMENT_ID,
  bundleId: BUNDLE_ID,
  bundleRoot: BUNDLE_ROOT,
  manifestPath: MANIFEST_PATH,
  planRelativePath: PLAN_RELATIVE_PATH,
  bootstrapCaptureRunnerId: CAPTURE_RUNNER_ID,
  candidateCreatedBeforePlan: true,
  containerRecreatedAfterPlan: false,
  successFallbacks: false,
});
