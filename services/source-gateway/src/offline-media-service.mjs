import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { reserveBufferedMedia } from "../../object-service/src/buffered-media-budget.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@+._/-]{1,512}$/;
const ECOSYSTEMS = new Set(["pip", "npm", "apt"]);
const ARCHITECTURES = new Set(["arm64", "amd64", "all", "source"]);
const FILESYSTEMS = new Set(["ext4", "xfs", "exfat"]);
const TRANSPORTS = new Set(["usb", "nvme", "sata"]);

function fail(code, message, status = 400, details = null) { throw new PlatformError(code, message, { status, details }); }
function actor(context, permission) { if (!UUID.test(context?.identityId ?? "")) fail("invalid_session", "Authentication is required", 401); if (!context.permissions?.includes(permission)) fail("source_permission_required", "Software source permission is required", 403); return context.identityId; }
function integer(value, field, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("offline_media_input_invalid", `${field} is invalid`, 400, { field }); return value; }
function bounded(value, field, maximum = 256) { if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail("offline_media_input_invalid", `${field} is invalid`, 400, { field }); return value.trim(); }
function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function translated(error) { if (typeof error?.code === "string" && error.code.startsWith("offline_media_")) fail(error.code, error.message, 409); throw error; }

function observation(value, nodeId, now) {
  if (!value || typeof value !== "object" || value.present !== true || value.readOnly !== true || value.mountMode !== "read-only"
    || !SHA256.test(value.deviceIdentitySha256 ?? "") || !UUID.test(value.filesystemUuid ?? "") || !SHA256.test(value.manifestSha256 ?? "")
    || !KEY.test(value.mediaHandle ?? "") || !FILESYSTEMS.has(value.filesystemType) || !TRANSPORTS.has(value.transport)) {
    fail("offline_media_discovery_invalid", "Offline media discovery evidence is invalid");
  }
  return Object.freeze({
    nodeId, deviceIdentitySha256: value.deviceIdentitySha256, filesystemUuid: value.filesystemUuid,
    volumeLabel: bounded(value.volumeLabel, "volumeLabel", 128), filesystemType: value.filesystemType,
    transport: value.transport, capacityBytes: integer(value.capacityBytes, "capacityBytes", 1),
    mediaHandle: value.mediaHandle, observedManifestSha256: value.manifestSha256,
    availability: "attached", lastSeenAt: now,
  });
}

function dependency(value, ordinal) {
  if (!value || typeof value !== "object") fail("offline_media_manifest_invalid", `dependency ${ordinal} is invalid`);
  return Object.freeze({ name: bounded(value.name, `dependency.${ordinal}.name`, 214), constraint: bounded(value.constraint ?? "*", `dependency.${ordinal}.constraint`, 128), optional: value.optional === true });
}

function artifact(value, ordinal) {
  if (!value || typeof value !== "object" || !ECOSYSTEMS.has(value.ecosystem) || !ARCHITECTURES.has(value.architecture)
    || !SHA256.test(value.sha256 ?? "") || !RELATIVE_PATH.test(value.relativePath ?? "")) {
    fail("offline_media_manifest_invalid", `artifact ${ordinal} is invalid`);
  }
  if (value.architecture === "amd64") fail("offline_media_architecture_unsupported", "AMD64-only artifacts cannot be indexed for Spark", 409);
  if (value.architecture === "source" && value.ecosystem !== "pip") fail("offline_media_architecture_unsupported", "Only Pip source artifacts may use source architecture", 409);
  const signature = value.signature ?? { required: false };
  if (typeof signature !== "object" || typeof signature.required !== "boolean"
    || (signature.required && (!RELATIVE_PATH.test(signature.detachedPath ?? "") || !FINGERPRINT.test(signature.keyFingerprint ?? "")))) {
    fail("offline_media_manifest_invalid", `artifact ${ordinal} signature is invalid`);
  }
  return Object.freeze({
    ecosystem: value.ecosystem, name: bounded(value.name, `artifact.${ordinal}.name`, 214), version: bounded(value.version, `artifact.${ordinal}.version`, 128),
    relativePath: value.relativePath, architecture: value.architecture, sizeBytes: integer(value.sizeBytes, `artifact.${ordinal}.sizeBytes`, 1), sha256: value.sha256,
    dependencies: Object.freeze((value.dependencies ?? []).map(dependency)),
    signature: Object.freeze({ required: signature.required, detachedPath: signature.required ? signature.detachedPath : null, keyFingerprint: signature.required ? signature.keyFingerprint : null }),
  });
}

function parseManifest(bytes, admitMemory) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail("offline_media_manifest_invalid", "Offline media manifest bytes are invalid");
  if (bytes.byteLength < 2) fail("offline_media_manifest_invalid", "Offline media manifest size is invalid");
  const release = admitMemory(bytes.byteLength);
  try {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { fail("offline_media_manifest_invalid", "Offline media manifest is not valid JSON"); }
  if (!value || value.schemaVersion !== 1 || !KEY.test(value.mediaKey ?? "") || !Array.isArray(value.artifacts) || value.artifacts.length < 1
    || !value.signature || !RELATIVE_PATH.test(value.signature.detachedPath ?? "") || !FINGERPRINT.test(value.signature.keyFingerprint ?? "")) {
    fail("offline_media_manifest_invalid", "Offline media manifest declaration is invalid");
  }
  const artifacts = value.artifacts.map(artifact);
  if (new Set(artifacts.map((item) => item.relativePath)).size !== artifacts.length) fail("offline_media_manifest_invalid", "Offline media artifact paths must be unique");
  return Object.freeze({ mediaKey: value.mediaKey, signature: Object.freeze({ detachedPath: value.signature.detachedPath, keyFingerprint: value.signature.keyFingerprint }), artifacts: Object.freeze(artifacts) });
  } finally { release(); }
}

function publicMedia(value) {
  return Object.freeze({
    mediaId: value.mediaId, nodeId: value.nodeId, filesystemUuid: value.filesystemUuid, volumeLabel: value.volumeLabel,
    filesystemType: value.filesystemType, transport: value.transport, capacityBytes: value.capacityBytes,
    observedManifestSha256: value.observedManifestSha256, availability: value.availability,
    approvalState: value.approvalState, lifecycleState: value.lifecycleState, health: Object.freeze(structuredClone(value.health)),
    inventory: value.inventory ? Object.freeze(structuredClone(value.inventory)) : null,
    approvedBy: value.approvedBy ?? null, approvedAt: value.approvedAt ? new Date(value.approvedAt).toISOString() : null,
    lastSeenAt: new Date(value.lastSeenAt).toISOString(), revision: value.revision,
  });
}

function inventory(artifacts) {
  const available = new Set(artifacts.map((value) => `${value.ecosystem}:${value.name}`));
  const indexed = artifacts.map((value) => ({ ...value, dependencies: value.dependencies.map((item) => ({ ...item, available: item.optional || available.has(`${value.ecosystem}:${item.name}`) })) }));
  const missing = indexed.flatMap((value) => value.dependencies.filter((item) => !item.available).map((item) => ({ ecosystem: value.ecosystem, package: value.name, version: value.version, dependency: item.name, constraint: item.constraint })));
  const ecosystems = Object.fromEntries([...ECOSYSTEMS].sort().map((ecosystem) => [ecosystem, {
    artifacts: indexed.filter((item) => item.ecosystem === ecosystem).length,
    packages: new Set(indexed.filter((item) => item.ecosystem === ecosystem).map((item) => item.name)).size,
    bytes: indexed.filter((item) => item.ecosystem === ecosystem).reduce((total, item) => total + item.sizeBytes, 0),
  }]));
  return { indexed: Object.freeze(indexed), summary: Object.freeze({ artifactCount: indexed.length, packageCount: new Set(indexed.map((item) => `${item.ecosystem}:${item.name}`)).size,
    totalBytes: indexed.reduce((total, item) => total + item.sizeBytes, 0), dependencyEdges: indexed.reduce((total, item) => total + item.dependencies.length, 0), missingDependencies: Object.freeze(missing), ecosystems: Object.freeze(ecosystems), architectures: Object.freeze([...new Set(indexed.map((item) => item.architecture))].sort()), complete: missing.length === 0 }) };
}

export class OfflineMediaService {
  #repository; #discovery; #inspector; #clock; #audit; #idFactory; #admitManifestMemory;
  constructor({ repository, discovery, inspector, clock = () => new Date(), audit = async () => {}, idFactory = randomUUID, admitManifestMemory = reserveBufferedMedia }) {
    const repositoryMethods = ["listMedia", "findMedia", "findByDeviceIdentity", "upsertObservation", "markDetached", "approveIndex", "listArtifacts"];
    const inspectorMethods = ["readManifest", "verifyManifest", "verifyArtifact"];
    if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function") || typeof discovery?.listAttached !== "function"
      || !inspector || inspectorMethods.some((method) => typeof inspector[method] !== "function") || typeof clock !== "function" || typeof audit !== "function" || typeof idFactory !== "function" || typeof admitManifestMemory !== "function") {
      throw new TypeError("Offline media dependencies are incomplete");
    }
    this.#repository = repository; this.#discovery = discovery; this.#inspector = inspector; this.#clock = clock; this.#audit = audit; this.#idFactory = idFactory;
    this.#admitManifestMemory = admitManifestMemory;
  }

  async discover({ context, nodeId }) {
    const administrator = actor(context, "source:manage");
    if (!UUID.test(nodeId ?? "")) fail("offline_media_input_invalid", "nodeId is invalid");
    const now = this.#clock(); const raw = await this.#discovery.listAttached({ nodeId });
    if (!Array.isArray(raw)) fail("offline_media_discovery_invalid", "Offline media discovery response is invalid", 502);
    const observations = raw.map((value) => observation(value, nodeId, now));
    if (new Set(observations.map((value) => value.deviceIdentitySha256)).size !== observations.length) fail("offline_media_discovery_invalid", "Offline media discovery identities are duplicated", 502);
    const seen = new Set();
    for (const item of observations) {
      const current = await this.#repository.findByDeviceIdentity(item.deviceIdentitySha256);
      const value = current ? { ...item, mediaId: current.mediaId, createdAt: current.createdAt, createdBy: current.createdBy, updatedAt: now }
        : { ...item, mediaId: this.#idFactory(), approvalState: "pending", lifecycleState: "discovered", health: { state: "unknown", errorCode: null, observedAt: now }, inventory: null, revision: 1, createdAt: now, createdBy: administrator, updatedAt: now };
      const saved = await this.#repository.upsertObservation({ existingMediaId: current?.mediaId ?? null, value }).catch(translated);
      seen.add(saved.mediaId);
    }
    for (const current of await this.#repository.listMedia({ nodeId })) {
      if (!seen.has(current.mediaId) && current.availability !== "detached") await this.#repository.markDetached(current.mediaId, current.revision, now).catch(translated);
    }
    const result = await this.#repository.listMedia({ nodeId });
    await this.#audit({ action: "source_center.offline_media_discovered", actorIdentityId: administrator, nodeId, attachedCount: observations.length, detachedCount: result.filter((value) => value.availability === "detached").length, occurredAt: now.toISOString() });
    return Object.freeze({ object: "list", data: Object.freeze(result.map(publicMedia)) });
  }

  async list({ context, nodeId = null }) { actor(context, "source:view"); if (nodeId !== null && !UUID.test(nodeId)) fail("offline_media_input_invalid", "nodeId is invalid"); return Object.freeze({ object: "list", data: Object.freeze((await this.#repository.listMedia({ nodeId })).map(publicMedia)) }); }
  async get({ context, mediaId }) { actor(context, "source:view"); if (!UUID.test(mediaId ?? "")) fail("offline_media_input_invalid", "mediaId is invalid"); const value = await this.#repository.findMedia(mediaId); if (!value) fail("offline_media_not_found", "Offline media was not found", 404); return publicMedia(value); }

  async approve({ context, mediaId, expectedRevision, expectedManifestSha256 }) {
    const administrator = actor(context, "source:manage");
    if (!UUID.test(mediaId ?? "") || !SHA256.test(expectedManifestSha256 ?? "")) fail("offline_media_input_invalid", "Offline media approval is invalid");
    const current = await this.#repository.findMedia(mediaId); if (!current) fail("offline_media_not_found", "Offline media was not found", 404);
    integer(expectedRevision, "expectedRevision", 1);
    if (current.revision !== expectedRevision) fail("offline_media_revision_conflict", "Offline media revision changed", 409);
    if (current.availability !== "attached") fail("offline_media_detached", "Offline media is detached", 409);
    const now = this.#clock();
    const attached = await this.#discovery.listAttached({ nodeId: current.nodeId });
    if (!Array.isArray(attached)) fail("offline_media_discovery_invalid", "Offline media discovery response is invalid", 502);
    const observations = attached.map((value) => observation(value, current.nodeId, now));
    if (new Set(observations.map((value) => value.deviceIdentitySha256)).size !== observations.length) fail("offline_media_discovery_invalid", "Offline media discovery identities are duplicated", 502);
    const live = observations.find((value) => value.deviceIdentitySha256 === current.deviceIdentitySha256);
    if (!live) fail("offline_media_detached", "Offline media is no longer attached", 409);
    if (current.observedManifestSha256 !== expectedManifestSha256) fail("offline_media_manifest_changed", "Offline media manifest changed after discovery", 409);
    if (live.observedManifestSha256 !== expectedManifestSha256) fail("offline_media_manifest_changed", "Offline media manifest changed after discovery", 409);
    const manifestBytes = Buffer.from(await this.#inspector.readManifest({ mediaHandle: live.mediaHandle }));
    if (digest(manifestBytes) !== expectedManifestSha256) fail("offline_media_manifest_changed", "Offline media manifest digest no longer matches discovery", 409);
    const manifest = parseManifest(manifestBytes, this.#admitManifestMemory);
    const signature = await this.#inspector.verifyManifest({ mediaHandle: live.mediaHandle, manifestBytes, detachedSignaturePath: manifest.signature.detachedPath, expectedKeyFingerprint: manifest.signature.keyFingerprint });
    if (signature?.status !== "verified" || signature.keyFingerprint !== manifest.signature.keyFingerprint || signature.signedSha256 !== expectedManifestSha256) fail("offline_media_signature_invalid", "Offline media manifest signature verification failed", 409);
    const verified = [];
    for (const item of manifest.artifacts) {
      const evidence = await this.#inspector.verifyArtifact({ mediaHandle: live.mediaHandle, relativePath: item.relativePath, expectedSha256: item.sha256, expectedBytes: item.sizeBytes,
        detachedSignaturePath: item.signature.detachedPath, expectedKeyFingerprint: item.signature.keyFingerprint });
      if (evidence?.actualSha256 !== item.sha256 || evidence.actualBytes !== item.sizeBytes || evidence.integrity !== "verified"
        || (item.signature.required && (evidence.signatureStatus !== "verified" || evidence.keyFingerprint !== item.signature.keyFingerprint))) {
        fail("offline_media_artifact_invalid", "Offline media artifact verification failed", 409, { relativePath: item.relativePath });
      }
      verified.push(Object.freeze({ ...item, signatureStatus: item.signature.required ? "verified" : "manifest-covered" }));
    }
    const indexed = inventory(verified);
    const saved = await this.#repository.approveIndex(mediaId, expectedRevision, { artifacts: indexed.indexed, media: {
      manifestKey: manifest.mediaKey, approvedManifestSha256: expectedManifestSha256, manifestSignerFingerprint: manifest.signature.keyFingerprint,
      approvalState: "approved", lifecycleState: "ready", approvedBy: administrator, approvedAt: now,
      health: { state: indexed.summary.complete ? "healthy" : "degraded", errorCode: indexed.summary.complete ? null : "offline_dependencies_missing", observedAt: now }, inventory: indexed.summary,
    } }).catch(translated);
    if (!saved) fail("offline_media_not_found", "Offline media was not found", 404);
    await this.#audit({ action: "source_center.offline_media_approved", actorIdentityId: administrator, mediaId, manifestSha256: expectedManifestSha256,
      artifactCount: indexed.summary.artifactCount, packageCount: indexed.summary.packageCount, missingDependencyCount: indexed.summary.missingDependencies.length, occurredAt: now.toISOString() });
    return publicMedia(saved);
  }

  async artifacts({ context, mediaId }) { actor(context, "source:view"); const media = await this.#repository.findMedia(mediaId); if (!media) fail("offline_media_not_found", "Offline media was not found", 404); return Object.freeze({ object: "list", media: publicMedia(media), data: Object.freeze((await this.#repository.listArtifacts(mediaId)).map((value) => Object.freeze(structuredClone(value)))) }); }
}
