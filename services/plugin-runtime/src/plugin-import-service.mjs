import { createHash, verify as verifySignature } from "node:crypto";

import {
  manifestSignaturePayload,
  validatePluginManifest,
} from "./manifest-validator.mjs";

const SOURCE_KINDS = new Set(["marketplace", "private-registry", "offline-bundle"]);
const ARTIFACT_KINDS = new Set(["oci-image-manifest", "oci-layer", "sbom", "provenance", "vulnerability-report"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_NAME = /^[a-z][a-z0-9._-]{2,127}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const VERSION_RANGE = /^(?:[><=~^]{1,2}[0-9]+\.[0-9]+\.[0-9]+)(?: (?:[><=~^]{1,2}[0-9]+\.[0-9]+\.[0-9]+))*$/;

export class PluginImportError extends Error {
  constructor(code, gate, message, { retryable = false } = {}) {
    super(message);
    this.name = "PluginImportError";
    this.code = code;
    this.gate = gate;
    this.retryable = retryable;
  }
}

function reject(code, gate, message, options) {
  throw new PluginImportError(code, gate, message, options);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, required, gate, label) {
  if (!isRecord(value)) reject("package_invalid", gate, `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reject("package_invalid", gate, `${label}.${key} is not supported`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) reject("package_invalid", gate, `${label}.${key} is required`);
  }
  return value;
}

function uniqueStrings(value, gate, label, { allowed, pattern } = {}) {
  if (!Array.isArray(value)) reject("package_invalid", gate, `${label} must be an array`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || (allowed && !allowed.has(item)) || (pattern && !pattern.test(item)) || seen.has(item)) {
      reject("package_invalid", gate, `${label} contains an invalid or duplicate value`);
    }
    seen.add(item);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  reject("package_invalid", "bundle-signature", "bundle signature payload is not canonical JSON");
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseVersion(value, gate, label) {
  if (typeof value !== "string" || !SEMVER.test(value)) reject("compatibility_failed", gate, `${label} is not SemVer`);
  const [core] = value.split("-", 1);
  return core.split(".").map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function versionSatisfies(version, range) {
  if (typeof range !== "string" || !VERSION_RANGE.test(range)) return false;
  const candidate = parseVersion(version, "compatibility", "version");
  return range.split(" ").every((constraint) => {
    const match = /^(>=|<=|>|<|=|\^|~)([0-9]+\.[0-9]+\.[0-9]+)$/.exec(constraint);
    if (!match) return false;
    const target = match[2].split(".").map(Number);
    const comparison = compareVersions(candidate, target);
    if (match[1] === ">=") return comparison >= 0;
    if (match[1] === "<=") return comparison <= 0;
    if (match[1] === ">") return comparison > 0;
    if (match[1] === "<") return comparison < 0;
    if (match[1] === "=") return comparison === 0;
    if (match[1] === "^") return comparison >= 0 && candidate[0] === target[0];
    return comparison >= 0 && candidate[0] === target[0] && candidate[1] === target[1];
  });
}

export function validatePluginImportPolicy(policy) {
  const value = exactKeys(policy, new Set(["schemaVersion", "allowedSources", "requiredArchitecture", "platformVersion", "pluginApiVersion", "supplyChain", "permissions"]), new Set(["schemaVersion", "allowedSources", "requiredArchitecture", "platformVersion", "pluginApiVersion", "supplyChain", "permissions"]), "policy", "policy");
  if (value.schemaVersion !== 1) reject("policy_invalid", "policy", "policy.schemaVersion must be 1");
  uniqueStrings(value.allowedSources, "policy", "policy.allowedSources", { allowed: SOURCE_KINDS });
  // An explicit subset is an allowlist, not an incomplete policy. In
  // particular, offline appliances must not need an online registry merely
  // to initialize their plugin manager. Import rejects omitted sources below.
  if (value.requiredArchitecture !== "linux/arm64/v8") reject("policy_invalid", "policy", "the Spark ARM64 architecture must be required");
  if (!SEMVER.test(value.platformVersion) || !SEMVER.test(value.pluginApiVersion)) reject("policy_invalid", "policy", "platform and plugin API versions must be SemVer");
  const supply = exactKeys(value.supplyChain, new Set(["sbomMediaTypes", "provenanceMediaTypes", "provenancePredicateTypes", "vulnerabilityMediaTypes", "maximumScanAgeHours", "maximumDatabaseAgeHours", "maximumCriticalFindings", "maximumHighFindings", "maximumEvidenceBytes"]), new Set(["sbomMediaTypes", "provenanceMediaTypes", "provenancePredicateTypes", "vulnerabilityMediaTypes", "maximumScanAgeHours", "maximumDatabaseAgeHours", "maximumCriticalFindings", "maximumHighFindings", "maximumEvidenceBytes"]), "policy", "policy.supplyChain");
  for (const field of ["sbomMediaTypes", "provenanceMediaTypes", "provenancePredicateTypes", "vulnerabilityMediaTypes"]) {
    uniqueStrings(supply[field], "policy", `policy.supplyChain.${field}`);
    if (!supply[field].length) reject("policy_invalid", "policy", `policy.supplyChain.${field} cannot be empty`);
  }
  for (const field of ["maximumScanAgeHours", "maximumDatabaseAgeHours", "maximumEvidenceBytes"]) {
    if (!Number.isSafeInteger(supply[field]) || supply[field] < 1) reject("policy_invalid", "policy", `policy.supplyChain.${field} must be positive`);
  }
  for (const field of ["maximumCriticalFindings", "maximumHighFindings"]) {
    if (!Number.isSafeInteger(supply[field]) || supply[field] < 0) reject("policy_invalid", "policy", `policy.supplyChain.${field} cannot be negative`);
  }
  const permissions = exactKeys(value.permissions, new Set(["allowedPlatformApiScopes", "maximumScopes", "maximumObjectNamespaces", "maximumEgressHosts"]), new Set(["allowedPlatformApiScopes", "maximumScopes", "maximumObjectNamespaces", "maximumEgressHosts"]), "policy", "policy.permissions");
  uniqueStrings(permissions.allowedPlatformApiScopes, "policy", "policy.permissions.allowedPlatformApiScopes");
  for (const field of ["maximumScopes", "maximumObjectNamespaces", "maximumEgressHosts"]) {
    if (!Number.isSafeInteger(permissions[field]) || permissions[field] < 0) reject("policy_invalid", "policy", `policy.permissions.${field} cannot be negative`);
  }
  return value;
}

function artifactSignatureFacts(artifact) {
  const facts = {
    name: artifact.name,
    kind: artifact.kind,
    digest: artifact.digest,
    sizeBytes: artifact.sizeBytes,
    mediaType: artifact.mediaType,
  };
  if (artifact.architecture !== undefined) facts.architecture = artifact.architecture;
  if (artifact.imageName !== undefined) facts.imageName = artifact.imageName;
  if (artifact.subjects !== undefined) facts.subjects = [...artifact.subjects].sort();
  return facts;
}

export function bundleSignaturePayload(bundle) {
  const descriptor = {
    packageVersion: bundle.packageVersion,
    manifestPayloadDigest: bundle.manifest?.signature?.payloadDigest,
    artifacts: [...(bundle.artifacts ?? [])]
      .map(artifactSignatureFacts)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  return canonicalJson(descriptor);
}

export function bundlePayloadDigest(bundle) {
  return sha256(Buffer.from(bundleSignaturePayload(bundle), "utf8"));
}

async function trustedKey(trustStore, signature, manifest, clock, gate) {
  let trust;
  try { trust = await trustStore.resolve(signature.keyId); } catch { reject("trust_lookup_failed", gate, "publisher trust lookup failed", { retryable: true }); }
  if (!trust || trust.status !== "active" || trust.publisherId !== manifest.publisher.id) reject("signer_untrusted", gate, "signing key is not active for this publisher");
  const now = clock().getTime();
  if (trust.validFrom && now < new Date(trust.validFrom).getTime()) reject("signer_untrusted", gate, "signing key is not yet valid");
  if (trust.validUntil && now >= new Date(trust.validUntil).getTime()) reject("signer_untrusted", gate, "signing key is expired");
  if (Array.isArray(trust.pluginIds) && !trust.pluginIds.includes(manifest.id)) reject("signer_untrusted", gate, "signing key is not authorized for this plugin");
  return trust.publicKey;
}

async function verifyEd25519({ trustStore, signature, manifest, payload, clock, gate }) {
  const publicKey = await trustedKey(trustStore, signature, manifest, clock, gate);
  let valid = false;
  try { valid = verifySignature(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(signature.value, "base64")); } catch { valid = false; }
  if (!valid) reject("signature_verification_failed", gate, "Ed25519 signature verification failed");
}

function validateBundleEnvelope(bundle) {
  exactKeys(bundle, new Set(["packageVersion", "manifest", "artifacts", "bundleSignature", "openArtifact", "close"]), new Set(["packageVersion", "manifest", "artifacts", "bundleSignature", "openArtifact"]), "package", "package");
  if (bundle.packageVersion !== "teamaibox.plugin-package/v1") reject("package_invalid", "package", "packageVersion is unsupported");
  if (!Array.isArray(bundle.artifacts) || !bundle.artifacts.length) reject("package_invalid", "package", "artifacts must be a non-empty array");
  if (typeof bundle.openArtifact !== "function") reject("package_invalid", "package", "openArtifact must be provided by the source adapter");
  const names = new Set();
  for (let index = 0; index < bundle.artifacts.length; index += 1) {
    const artifact = bundle.artifacts[index];
    const path = `artifacts[${index}]`;
    exactKeys(artifact, new Set(["name", "kind", "digest", "sizeBytes", "mediaType", "architecture", "imageName", "subjects"]), new Set(["name", "kind", "digest", "sizeBytes", "mediaType"]), "package", path);
    if (typeof artifact.name !== "string" || !SAFE_NAME.test(artifact.name) || names.has(artifact.name)) reject("package_invalid", "package", `${path}.name is invalid or duplicated`);
    names.add(artifact.name);
    if (!ARTIFACT_KINDS.has(artifact.kind) || !SHA256.test(artifact.digest)) reject("package_invalid", "package", `${path} kind or digest is invalid`);
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) reject("package_invalid", "package", `${path}.sizeBytes is invalid`);
    if (typeof artifact.mediaType !== "string" || !artifact.mediaType.length) reject("package_invalid", "package", `${path}.mediaType is invalid`);
    if (artifact.subjects !== undefined) uniqueStrings(artifact.subjects, "package", `${path}.subjects`, { pattern: SHA256 });
  }
  const signature = exactKeys(bundle.bundleSignature, new Set(["format", "algorithm", "keyId", "payloadDigest", "value"]), new Set(["format", "algorithm", "keyId", "payloadDigest", "value"]), "bundle-signature", "bundleSignature");
  if (signature.format !== "teamaibox.bundle-index/v1" || signature.algorithm !== "Ed25519" || !SHA256.test(signature.payloadDigest)) reject("package_invalid", "bundle-signature", "bundle signature declaration is invalid");
  if (typeof signature.keyId !== "string" || typeof signature.value !== "string") reject("package_invalid", "bundle-signature", "bundle signature identity or value is invalid");
}

async function inspectBytes(source, captureMaximum, gate) {
  const chunks = [];
  const hash = createHash("sha256");
  let total = 0;
  const append = (chunk) => {
    if (!(chunk instanceof Uint8Array)) reject("artifact_read_failed", gate, "artifact reader returned a non-byte chunk");
    total += chunk.byteLength;
    if (captureMaximum !== null && total > captureMaximum) reject("evidence_too_large", gate, "supply-chain evidence exceeds the policy limit");
    const bytes = Buffer.from(chunk);
    hash.update(bytes);
    if (captureMaximum !== null) chunks.push(bytes);
  };
  if (source instanceof Uint8Array) append(source);
  else if (source && typeof source[Symbol.asyncIterator] === "function") {
    for await (const chunk of source) append(chunk);
  } else reject("artifact_read_failed", gate, "artifact reader did not return bytes");
  return {
    bytes: captureMaximum === null ? null : Buffer.concat(chunks),
    total,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

async function verifyArtifacts(bundle, manifest, policy) {
  const images = new Map();
  for (const image of manifest.images) for (const variant of image.variants) images.set(`${image.name}|${variant.architecture}`, { image, variant });
  const imageDigests = new Set([...images.values()].map(({ variant }) => variant.digest));
  const seenImages = new Set();
  const evidence = new Map();
  const verified = [];
  for (const artifact of bundle.artifacts) {
    let source;
    try { source = await bundle.openArtifact(artifact.name); } catch { reject("artifact_read_failed", "checksum", `artifact ${artifact.name} could not be opened`, { retryable: true }); }
    const captureLimit = new Set(["sbom", "provenance", "vulnerability-report"]).has(artifact.kind)
      ? policy.supplyChain.maximumEvidenceBytes : null;
    const { bytes, total, digest } = await inspectBytes(source, captureLimit, "checksum");
    if (total !== artifact.sizeBytes || digest !== artifact.digest) reject("artifact_checksum_failed", "checksum", `artifact ${artifact.name} does not match its size and SHA-256 descriptor`);
    if (artifact.kind === "oci-image-manifest") {
      if (artifact.architecture !== policy.requiredArchitecture || typeof artifact.imageName !== "string") reject("architecture_mismatch", "architecture", `image artifact ${artifact.name} is not the required ARM64 variant`);
      const key = `${artifact.imageName}|${artifact.architecture}`;
      const expected = images.get(key);
      if (!expected || expected.variant.digest !== artifact.digest || expected.variant.mediaType !== artifact.mediaType) reject("image_descriptor_mismatch", "architecture", `image artifact ${artifact.name} is not pinned by the manifest`);
      if (seenImages.has(key)) reject("package_invalid", "architecture", `image variant ${key} is duplicated`);
      seenImages.add(key);
    }
    if (new Set(["sbom", "provenance", "vulnerability-report"]).has(artifact.kind)) {
      if (evidence.has(artifact.kind)) reject("supply_chain_evidence_invalid", artifact.kind, `${artifact.kind} evidence must be unique`);
      let document;
      try { document = JSON.parse(bytes.toString("utf8")); } catch { reject("supply_chain_evidence_invalid", artifact.kind, `${artifact.kind} is not JSON`); }
      evidence.set(artifact.kind, { artifact, document });
    }
    verified.push(Object.freeze({ name: artifact.name, kind: artifact.kind, digest: artifact.digest, sizeBytes: artifact.sizeBytes }));
  }
  if (seenImages.size !== images.size) reject("image_descriptor_mismatch", "architecture", "not every manifest image has an imported ARM64 OCI manifest");
  for (const [kind, item] of evidence) {
    const subjects = new Set(item.artifact.subjects ?? []);
    if (subjects.size !== imageDigests.size || [...imageDigests].some((digest) => !subjects.has(digest))) reject("supply_chain_subject_mismatch", kind, `${kind} does not cover every plugin image digest`);
  }
  return { evidence, verified, imageDigests };
}

function parseTimestamp(value, clock, maxAgeHours, gate, label) {
  const timestamp = new Date(value).getTime();
  const now = clock().getTime();
  if (!Number.isFinite(timestamp) || timestamp > now + 300000 || now - timestamp > maxAgeHours * 3600000) reject("evidence_stale", gate, `${label} is missing, stale, or from the future`);
}

function validateSupplyChain(evidence, policy, clock, imageDigests) {
  for (const kind of ["sbom", "provenance", "vulnerability-report"]) {
    if (!evidence.has(kind)) reject("supply_chain_evidence_missing", kind, `${kind} evidence is required`);
  }
  const sbom = evidence.get("sbom");
  if (!policy.supplyChain.sbomMediaTypes.includes(sbom.artifact.mediaType)
    || !isRecord(sbom.document) || !/^SPDX-2\.[0-9]+$/.test(sbom.document.spdxVersion)
    || sbom.document.SPDXID !== "SPDXRef-DOCUMENT" || !Array.isArray(sbom.document.packages)
    || !sbom.document.packages.length) reject("sbom_invalid", "sbom", "SPDX JSON SBOM is missing required document/package metadata");

  const provenance = evidence.get("provenance");
  if (!policy.supplyChain.provenanceMediaTypes.includes(provenance.artifact.mediaType)
    || provenance.document?._type !== "https://in-toto.io/Statement/v1"
    || !policy.supplyChain.provenancePredicateTypes.includes(provenance.document?.predicateType)
    || !Array.isArray(provenance.document?.subject) || !provenance.document.subject.length
    || typeof provenance.document?.predicate?.builder?.id !== "string") reject("provenance_invalid", "provenance", "SLSA provenance statement is invalid");
  const provenanceSubjects = new Set(provenance.document.subject.map((subject) => subject?.digest?.sha256).filter(Boolean).map((digest) => `sha256:${digest}`));
  if (provenanceSubjects.size !== imageDigests.size || [...imageDigests].some((digest) => !provenanceSubjects.has(digest))) reject("supply_chain_subject_mismatch", "provenance", "SLSA subjects do not match all image digests");

  const vulnerability = evidence.get("vulnerability-report");
  const report = vulnerability.document;
  if (!policy.supplyChain.vulnerabilityMediaTypes.includes(vulnerability.artifact.mediaType)
    || report?.schemaVersion !== 1 || report?.status !== "passed"
    || typeof report?.scanner !== "string" || !isRecord(report?.findings)) reject("vulnerability_status_failed", "vulnerability", "vulnerability report is invalid or not passing");
  parseTimestamp(report.scannedAt, clock, policy.supplyChain.maximumScanAgeHours, "vulnerability", "scan timestamp");
  parseTimestamp(report.databaseUpdatedAt, clock, policy.supplyChain.maximumDatabaseAgeHours, "vulnerability", "scanner database timestamp");
  for (const severity of ["critical", "high", "medium", "low", "unknown"]) {
    if (!Number.isSafeInteger(report.findings[severity]) || report.findings[severity] < 0) reject("vulnerability_status_failed", "vulnerability", `finding count ${severity} is invalid`);
  }
  if (report.findings.critical > policy.supplyChain.maximumCriticalFindings
    || report.findings.high > policy.supplyChain.maximumHighFindings) reject("vulnerability_policy_failed", "vulnerability", "vulnerability severity exceeds import policy");
  return {
    sbomDigest: sbom.artifact.digest,
    provenanceDigest: provenance.artifact.digest,
    vulnerabilityReportDigest: vulnerability.artifact.digest,
    vulnerabilityStatus: report.status,
    vulnerabilityScannedAt: report.scannedAt,
  };
}

function importResult(record) {
  const { manifest: _manifest, ...result } = record;
  return Object.freeze(structuredClone(result));
}

async function validateCompatibilityAndPolicy(manifest, policy, environment) {
  if (!versionSatisfies(policy.platformVersion, manifest.compatibility.platform)) reject("platform_incompatible", "compatibility", "plugin does not support this platform version");
  if (!versionSatisfies(policy.pluginApiVersion, manifest.compatibility.pluginApi)) reject("plugin_api_incompatible", "compatibility", "plugin API range is incompatible");
  const availableCapabilities = new Set(await environment.capabilities());
  const missingCapabilities = manifest.compatibility.requiredCapabilities.filter((item) => !availableCapabilities.has(item));
  if (missingCapabilities.length) reject("capability_missing", "compatibility", "one or more required appliance capabilities are unavailable");
  for (const dependency of manifest.compatibility.dependencies) {
    const installed = await environment.dependency(dependency.pluginId);
    if (!installed) {
      if (!dependency.optional) reject("dependency_missing", "dependencies", `required plugin dependency ${dependency.pluginId} is not installed`);
      continue;
    }
    if (!versionSatisfies(installed.version, dependency.versionRange) || installed.enabled !== true) reject("dependency_incompatible", "dependencies", `plugin dependency ${dependency.pluginId} is disabled or incompatible`);
  }
  const allowedScopes = new Set(policy.permissions.allowedPlatformApiScopes);
  if (manifest.permissions.platformApiScopes.length > policy.permissions.maximumScopes
    || manifest.permissions.platformApiScopes.some((scope) => !allowedScopes.has(scope))) reject("permission_policy_failed", "permissions", "plugin requests an API scope outside administrator policy");
  if (manifest.permissions.objectNamespaces.length > policy.permissions.maximumObjectNamespaces
    || manifest.permissions.network.egressHosts.length > policy.permissions.maximumEgressHosts) reject("permission_policy_failed", "permissions", "plugin namespace or network request exceeds administrator policy");
  if (environment.permissionDecision) {
    const decision = await environment.permissionDecision(manifest);
    if (!decision?.allowed) reject("permission_policy_failed", "permissions", decision?.reason || "administrator policy denied plugin permissions");
  }
}

export class PluginSourceRouter {
  #resolvers;

  constructor(resolvers) {
    this.#resolvers = new Map(Object.entries(resolvers ?? {}));
  }

  async resolve(request) {
    if (!SOURCE_KINDS.has(request?.sourceKind)) reject("source_unsupported", "source", "plugin source is unsupported");
    const resolver = this.#resolvers.get(request.sourceKind);
    if (!resolver || typeof resolver.resolve !== "function") reject("source_unavailable", "source", "plugin source adapter is unavailable", { retryable: true });
    try { return await resolver.resolve(Object.freeze({ ...request })); }
    catch (error) {
      if (error instanceof PluginImportError) throw error;
      reject(error?.code === "plugin_source_not_found" ? "source_not_found" : "source_unavailable", "source",
        error?.code === "plugin_source_not_found" ? "plugin package was not found in the selected source" : "plugin source adapter is unavailable",
        { retryable: error?.code !== "plugin_source_not_found" });
    }
  }
}

export class PluginImportService {
  #sourceRouter;
  #trustStore;
  #repository;
  #environment;
  #policy;
  #clock;

  constructor({ sourceRouter, trustStore, repository, environment, policy, clock = () => new Date() }) {
    if (!sourceRouter || !trustStore || !repository || !environment) throw new TypeError("plugin import dependencies are required");
    this.#sourceRouter = sourceRouter;
    this.#trustStore = trustStore;
    this.#repository = repository;
    this.#environment = environment;
    this.#policy = validatePluginImportPolicy(policy);
    this.#clock = clock;
  }

  importFromMarketplace({ pluginId, version }) {
    return this.#import({ sourceKind: "marketplace", locator: `${pluginId}@${version}` });
  }

  importFromPrivateRegistry({ reference }) {
    return this.#import({ sourceKind: "private-registry", locator: reference });
  }

  importOfflineBundle({ bundleId, expectedBundleDigest }) {
    if (!SHA256.test(expectedBundleDigest ?? "")) reject("package_invalid", "source", "offline bundle checksum must be provided");
    return this.#import({ sourceKind: "offline-bundle", locator: bundleId, expectedBundleDigest });
  }

  async #import(request) {
    if (!this.#policy.allowedSources.includes(request.sourceKind)) reject("source_denied", "source", "administrator policy denies this plugin source");
    let bundle;
    try {
      bundle = await this.#sourceRouter.resolve(request);
      validateBundleEnvelope(bundle);
      const manifestFacts = validatePluginManifest(bundle.manifest);
      await verifyEd25519({
        trustStore: this.#trustStore,
        signature: bundle.manifest.signature,
        manifest: bundle.manifest,
        payload: manifestSignaturePayload(bundle.manifest),
        clock: this.#clock,
        gate: "manifest-signature",
      });
      const actualBundleDigest = bundlePayloadDigest(bundle);
      if (bundle.bundleSignature.payloadDigest !== actualBundleDigest) reject("bundle_checksum_failed", "bundle-signature", "bundle index digest does not match its signed payload");
      if (request.expectedBundleDigest && request.expectedBundleDigest !== actualBundleDigest) reject("bundle_checksum_failed", "source", "offline bundle checksum does not match the selected file");
      await verifyEd25519({
        trustStore: this.#trustStore,
        signature: bundle.bundleSignature,
        manifest: bundle.manifest,
        payload: bundleSignaturePayload(bundle),
        clock: this.#clock,
        gate: "bundle-signature",
      });
      await validateCompatibilityAndPolicy(bundle.manifest, this.#policy, this.#environment);
      const { evidence, verified, imageDigests } = await verifyArtifacts(bundle, bundle.manifest, this.#policy);
      const supplyChain = validateSupplyChain(evidence, this.#policy, this.#clock, imageDigests);
      const verifiedAt = this.#clock().toISOString();
      const record = {
        schemaVersion: 1,
        pluginId: manifestFacts.pluginId,
        pluginType: manifestFacts.pluginType,
        version: manifestFacts.version,
        sourceKind: request.sourceKind,
        manifest: structuredClone(bundle.manifest),
        manifestPayloadDigest: manifestFacts.payloadDigest,
        manifestSignerKeyId: bundle.manifest.signature.keyId,
        bundlePayloadDigest: actualBundleDigest,
        bundleSignerKeyId: bundle.bundleSignature.keyId,
        imageDigests: [...imageDigests].sort(),
        artifacts: verified,
        supplyChain,
        policyVersion: this.#policy.schemaVersion,
        state: "verified",
        verifiedAt,
      };
      try { return importResult(await this.#repository.saveVerified(record)); } catch (error) {
        if (error?.code === "plugin_version_conflict") reject("plugin_version_conflict", "repository", "this plugin version already has different verified content");
        reject("import_persistence_failed", "repository", "verified plugin import could not be persisted", { retryable: true });
      }
    } catch (error) {
      if (error instanceof PluginImportError) throw error;
      if (error?.name === "PluginManifestError") reject("manifest_invalid", "manifest", error.message);
      throw error;
    } finally {
      if (bundle && typeof bundle.close === "function") await bundle.close();
    }
  }
}
