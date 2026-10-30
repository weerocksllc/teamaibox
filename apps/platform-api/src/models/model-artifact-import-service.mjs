import { createHash, verify as verifySignature } from "node:crypto";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ARTIFACT_NAME = /^(?!.*(?:^|\/)\.\.?($|\/))[A-Za-z0-9][A-Za-z0-9._/+@=-]{0,1023}$/;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export class ModelArtifactImportError extends Error {
  constructor(code, gate, message, { retryable = false } = {}) {
    super(message);
    this.name = "ModelArtifactImportError";
    this.code = code;
    this.gate = gate;
    this.retryable = retryable;
  }
}

function fail(code, gate, message, options) {
  throw new ModelArtifactImportError(code, gate, message, options);
}

function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(value, required, optional, gate, label) {
  if (!isRecord(value)) fail("model_import_invalid", gate, `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("model_import_invalid", gate, `${label}.${key} is unsupported`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("model_import_invalid", gate, `${label}.${key} is required`);
  return value;
}
function string(value, label, { pattern, maximum = 2048 } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || (pattern && !pattern.test(value))) {
    fail("model_import_invalid", "descriptor", `${label} is invalid`);
  }
  return value;
}
function integer(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("model_import_invalid", "descriptor", `${label} is invalid`);
  return value;
}
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  fail("model_import_invalid", "signature", "signature payload cannot be canonicalized");
}
function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function signatureDeclaration(value, { required = false } = {}) {
  if (value === null && !required) return null;
  exact(value, ["algorithm", "keyId", "value"], [], "signature", "signature");
  if (value.algorithm !== "Ed25519") fail("model_signature_invalid", "signature", "only Ed25519 signatures are supported");
  string(value.keyId, "signature.keyId", { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/, maximum: 128 });
  string(value.value, "signature.value", { pattern: /^[A-Za-z0-9+/]+={0,2}$/, maximum: 256 });
  const decoded = Buffer.from(value.value, "base64");
  if (decoded.byteLength !== 64 || decoded.toString("base64") !== value.value) fail("model_signature_invalid", "signature", "Ed25519 signature encoding is invalid");
  decoded.fill(0);
  return { algorithm: value.algorithm, keyId: value.keyId, value: value.value };
}

function globExpression(pattern) {
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") { result += ".*"; index += 1; }
    else if (character === "*") result += "[^/]*";
    else result += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${result}$`);
}

function sourceFor(candidate, artifactName, sourceUri) {
  string(artifactName, "artifactName", { pattern: ARTIFACT_NAME, maximum: 1024 });
  let base;
  let requested;
  try { base = new URL(candidate.source.artifactSourceUri); requested = new URL(sourceUri); } catch {
    fail("model_source_invalid", "source", "model source URI is invalid");
  }
  if (base.protocol !== "https:" || requested.protocol !== "https:" || requested.username || requested.password
    || requested.search || requested.hash) fail("model_source_invalid", "source", "model source must be credential-free HTTPS");
  if (base.pathname.endsWith("/")) {
    const expected = new URL(artifactName, base);
    if (requested.href !== expected.href || requested.origin !== base.origin || !requested.pathname.startsWith(base.pathname)) {
      fail("model_source_invalid", "source", "model artifact is outside the pinned publisher revision");
    }
  } else if (requested.href !== base.href) {
    fail("model_source_invalid", "source", "model artifact does not match the pinned source URI");
  }
  if (!candidate.artifactDecision.allowPatterns.some((pattern) => globExpression(pattern).test(artifactName))) {
    fail("model_source_denied", "source", "model artifact is not allowed by the reviewed candidate policy");
  }
  return requested.href;
}

function descriptorFor(candidate, input) {
  exact(input, ["artifactName", "sizeBytes", "digest", "mediaType", "chunkSizeBytes", "sourceUri", "signature"], [], "descriptor", "descriptor");
  if (!DIGEST.test(input.digest)) fail("model_import_invalid", "descriptor", "descriptor.digest must be SHA-256");
  const sizeBytes = integer(input.sizeBytes, "descriptor.sizeBytes", { maximum: candidate.artifactDecision.maximumDownloadBytes });
  const chunkSizeBytes = integer(input.chunkSizeBytes, "descriptor.chunkSizeBytes", { maximum: MAX_CHUNK_BYTES });
  return Object.freeze({
    artifactName: string(input.artifactName, "descriptor.artifactName", { pattern: ARTIFACT_NAME, maximum: 1024 }),
    sizeBytes,
    digest: input.digest,
    mediaType: string(input.mediaType, "descriptor.mediaType", { maximum: 256 }),
    chunkSizeBytes,
    sourceUri: sourceFor(candidate, input.artifactName, input.sourceUri),
    sourceRevision: candidate.source.revision,
    signature: signatureDeclaration(input.signature),
  });
}

function visibleImport(record) {
  if (!record) return null;
  const { signature: _signature, operationKey: _operationKey, ...result } = record;
  return Object.freeze(structuredClone(result));
}

function candidateMap(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.candidates)) throw new TypeError("model candidate catalog is invalid");
  return new Map(catalog.candidates.map((candidate) => [candidate.candidateId, candidate]));
}

export function modelArtifactSignaturePayload({ candidateId, artifactName, digest, sizeBytes, mediaType, sourceUri, sourceRevision }) {
  return canonical({
    format: "teamaibox.model-artifact-signature/v1", candidateId, artifactName,
    digest, sizeBytes, mediaType, source: { uri: sourceUri, revision: sourceRevision },
  });
}

export function offlineModelBundleSignaturePayload(manifest) {
  return canonical(manifest);
}

async function verifyEd25519({ trustStore, signature, payload, candidateId }) {
  if (!trustStore?.resolve) fail("model_signer_untrusted", "signature", "model signing trust store is unavailable");
  let trust;
  try { trust = await trustStore.resolve(signature.keyId); } catch {
    fail("model_trust_lookup_failed", "signature", "model signing trust lookup failed", { retryable: true });
  }
  if (!trust || trust.status !== "active" || (Array.isArray(trust.candidateIds) && !trust.candidateIds.includes(candidateId))) {
    fail("model_signer_untrusted", "signature", "model signing key is not trusted for this candidate");
  }
  let valid = false;
  try { valid = verifySignature(null, Buffer.from(payload, "utf8"), trust.publicKey, Buffer.from(signature.value, "base64")); } catch { valid = false; }
  if (!valid) fail("model_signature_verification_failed", "signature", "Ed25519 model signature verification failed");
}

function bundleManifest(bundle, candidate) {
  exact(bundle, ["packageVersion", "manifest", "bundleSignature", "openChunk"], ["close"], "bundle", "bundle");
  if (bundle.packageVersion !== "teamaibox.model-bundle/v1" || typeof bundle.openChunk !== "function") {
    fail("model_bundle_invalid", "bundle", "offline model bundle format is unsupported");
  }
  const manifest = exact(bundle.manifest,
    ["schemaVersion", "candidateId", "artifactName", "digest", "sizeBytes", "mediaType", "chunkSizeBytes", "source", "chunks"],
    [], "bundle", "bundle.manifest");
  if (manifest.schemaVersion !== 1 || manifest.candidateId !== candidate.candidateId) fail("model_bundle_invalid", "bundle", "offline bundle candidate identity is invalid");
  exact(manifest.source, ["uri", "revision"], [], "bundle", "bundle.manifest.source");
  if (manifest.source.revision !== candidate.source.revision) fail("model_bundle_invalid", "bundle", "offline bundle source revision is not pinned to the candidate");
  const descriptor = descriptorFor(candidate, {
    artifactName: manifest.artifactName, sizeBytes: manifest.sizeBytes, digest: manifest.digest,
    mediaType: manifest.mediaType, chunkSizeBytes: manifest.chunkSizeBytes,
    sourceUri: manifest.source.uri, signature: null,
  });
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length < 1 || manifest.chunks.length > 1_000_000) {
    fail("model_bundle_invalid", "bundle", "offline bundle chunk index is invalid");
  }
  let offset = 0;
  const chunks = manifest.chunks.map((item, ordinal) => {
    exact(item, ["ordinal", "offset", "sizeBytes", "digest"], [], "bundle", `bundle.manifest.chunks[${ordinal}]`);
    const expectedSize = Math.min(descriptor.chunkSizeBytes, descriptor.sizeBytes - offset);
    if (item.ordinal !== ordinal || item.offset !== offset || item.sizeBytes !== expectedSize || !DIGEST.test(item.digest)) {
      fail("model_bundle_invalid", "bundle", "offline bundle chunk index is not contiguous and canonical");
    }
    offset += item.sizeBytes;
    return { ordinal, offset: item.offset, sizeBytes: item.sizeBytes, digest: item.digest };
  });
  if (offset !== descriptor.sizeBytes) fail("model_bundle_invalid", "bundle", "offline bundle chunk index does not cover the artifact");
  return { manifest: structuredClone(manifest), descriptor, chunks, signature: signatureDeclaration(bundle.bundleSignature, { required: true }) };
}

export class ModelArtifactImportService {
  #repository;
  #chunkStore;
  #sourceTransport;
  #trustStore;
  #candidates;
  #audit;

  constructor({ repository, chunkStore, sourceTransport, trustStore, candidateCatalog, audit = async () => {} }) {
    for (const method of ["beginImport", "getImport", "nextChunk", "recordChunk", "listImportChunks", "finalizeImport", "failImport", "getArtifact", "setPinned", "changeLease", "evictLeastRecentlyUsed", "usage"]) {
      if (typeof repository?.[method] !== "function") throw new TypeError(`model artifact repository.${method} is required`);
    }
    if (chunkStore?.readonlyProtection !== "content-addressed-envelope-encrypted"
      || !chunkStore?.putChunk || !chunkStore?.readChunk || !chunkStore?.deleteChunk) {
      throw new TypeError("protected content-addressed model chunk store is required");
    }
    if (!sourceTransport?.fetchRange) throw new TypeError("model range source transport is required");
    this.#repository = repository;
    this.#chunkStore = chunkStore;
    this.#sourceTransport = sourceTransport;
    this.#trustStore = trustStore;
    this.#candidates = candidateMap(candidateCatalog);
    this.#audit = audit;
  }

  #authorize(context) {
    if (!context?.permissions?.includes("model:manage")) fail("model_manager_required", "authorization", "model management permission is required");
    return context;
  }

  #candidate(candidateId) {
    const candidate = this.#candidates.get(candidateId);
    if (!candidate) fail("model_candidate_not_found", "candidate", "model candidate was not found");
    if (candidate.artifactDecision?.status !== "allowed" || candidate.selection?.status !== "planned"
      || !Number.isSafeInteger(candidate.artifactDecision.maximumDownloadBytes)) {
      fail("model_candidate_blocked", "candidate", "model candidate is not approved for artifact import");
    }
    return candidate;
  }

  async beginOnlineImport({ context, candidateId, descriptor, operationKey }) {
    this.#authorize(context);
    string(operationKey, "operationKey", { pattern: OPERATION_KEY, maximum: 128 });
    const candidate = this.#candidate(candidateId);
    const normalized = descriptorFor(candidate, descriptor);
    const result = await this.#repository.beginImport({
      candidateId, sourceKind: "online", operationKey, requestedBy: context.identityId ?? null,
      ...normalized,
    });
    await this.#audit({ event: "model_artifact.import_started", actorId: context.identityId ?? null, importId: result.import.importId, candidateId, sourceKind: "online", digest: normalized.digest, sizeBytes: normalized.sizeBytes, deduplicated: result.import.deduplicated });
    return { ...result, import: visibleImport(result.import) };
  }

  async #cleanup(failure) {
    for (const chunk of failure.deleteChunks) await this.#chunkStore.deleteChunk(chunk);
  }

  async #failIntegrity(importId, error) {
    const failure = await this.#repository.failImport(importId, error.code ?? "model_import_failed");
    await this.#cleanup(failure);
    return error;
  }

  async resumeOnlineImport({ context, importId, maximumChunks = 1 }) {
    this.#authorize(context);
    integer(maximumChunks, "maximumChunks", { maximum: 1024 });
    let record = await this.#repository.getImport(importId);
    if (!record) fail("model_import_not_found", "state", "model import was not found");
    if (record.sourceKind !== "online") fail("model_import_source_mismatch", "state", "model import is not an online transfer");
    if (record.state !== "active") return visibleImport(record);
    for (let count = 0; count < maximumChunks && record.state === "active"; count += 1) {
      const next = await this.#repository.nextChunk(importId);
      if (!next) break;
      let response;
      try {
        response = await this.#sourceTransport.fetchRange({
          uri: record.sourceUri, start: next.offset, end: next.offset + next.sizeBytes - 1,
          etag: record.etag, lastModified: record.lastModified,
        });
      } catch {
        fail("model_source_unavailable", "transfer", "model source range request failed", { retryable: true });
      }
      try {
        if (!isRecord(response) || !(response.bytes instanceof Uint8Array)
          || response.bytes.byteLength !== next.sizeBytes || response.totalSize !== record.sizeBytes
          || ![200, 206].includes(response.status)
          || (response.status === 200 && (next.offset !== 0 || next.sizeBytes !== record.sizeBytes))) {
          fail("model_source_range_invalid", "transfer", "model source returned an invalid byte range");
        }
        if ((record.etag && response.etag !== record.etag)
          || (record.lastModified && response.lastModified !== record.lastModified)) {
          fail("model_source_changed", "transfer", "model source validator changed during resume");
        }
        if (!record.etag && !record.lastModified && !response.etag && !response.lastModified
          && record.sizeBytes > record.chunkSizeBytes) {
          fail("model_source_validator_required", "transfer", "resumable model source must expose ETag or Last-Modified");
        }
        const chunkDigest = sha256(response.bytes);
        const stored = await this.#chunkStore.putChunk({ digest: chunkDigest, content: response.bytes });
        record = (await this.#repository.recordChunk({
          importId, ...next, digest: chunkDigest, blobKey: stored.blobKey,
          etag: response.etag ?? null, lastModified: response.lastModified ?? null,
        })).import;
      } catch (error) {
        if (new Set(["model_source_changed", "model_source_validator_required", "model_source_range_invalid", "model_chunk_checksum_failed"]).has(error?.code)) {
          throw await this.#failIntegrity(importId, error);
        }
        throw error;
      } finally {
        response?.bytes?.fill(0);
      }
    }
    return visibleImport(record);
  }

  async #verifyComplete(record) {
    const chunks = await this.#repository.listImportChunks(record.importId);
    const hash = createHash("sha256");
    let offset = 0;
    for (const chunk of chunks) {
      if (chunk.ordinal < 0 || chunk.offset !== offset) fail("model_import_sequence_conflict", "checksum", "model chunk map is not contiguous");
      const content = await this.#chunkStore.readChunk(chunk);
      try { hash.update(content); } finally { content.fill(0); }
      offset += chunk.sizeBytes;
    }
    if (offset !== record.sizeBytes || `sha256:${hash.digest("hex")}` !== record.digest) {
      fail("model_artifact_checksum_failed", "checksum", "model artifact does not match its SHA-256 descriptor");
    }
    if (record.signature) {
      await verifyEd25519({
        trustStore: this.#trustStore, signature: record.signature, candidateId: record.candidateId,
        payload: modelArtifactSignaturePayload(record),
      });
    }
  }

  async finalizeImport({ context, importId }) {
    this.#authorize(context);
    const record = await this.#repository.getImport(importId);
    if (!record) fail("model_import_not_found", "state", "model import was not found");
    if (record.state === "ready") return { import: visibleImport(record), artifact: await this.#repository.getArtifact(record.digest) };
    if (record.state !== "active" || record.receivedBytes !== record.sizeBytes) fail("model_import_incomplete", "state", "model import is incomplete");
    try {
      await this.#verifyComplete(record);
    } catch (error) {
      throw await this.#failIntegrity(importId, error);
    }
    const result = await this.#repository.finalizeImport(importId);
    await this.#audit({ event: "model_artifact.import_completed", actorId: context.identityId ?? null, importId, candidateId: record.candidateId, digest: record.digest, sizeBytes: record.sizeBytes, signatureVerified: Boolean(record.signature || record.bundleSignatureVerified), deduplicated: !result.created });
    return { ...result, import: visibleImport(result.import) };
  }

  async importOfflineBundle({ context, bundle, operationKey }) {
    this.#authorize(context);
    string(operationKey, "operationKey", { pattern: OPERATION_KEY, maximum: 128 });
    try {
      const candidateId = bundle?.manifest?.candidateId;
      const candidate = this.#candidate(candidateId);
      const parsed = bundleManifest(bundle, candidate);
      await verifyEd25519({ trustStore: this.#trustStore, signature: parsed.signature, candidateId, payload: offlineModelBundleSignaturePayload(parsed.manifest) });
      const started = await this.#repository.beginImport({
        candidateId, sourceKind: "offline-bundle", operationKey, requestedBy: context.identityId ?? null,
        ...parsed.descriptor, signature: null, bundleSignatureVerified: true,
      });
      if (started.import.state === "ready") return { ...started, import: visibleImport(started.import), artifact: await this.#repository.getArtifact(started.import.digest) };
      let next = await this.#repository.nextChunk(started.import.importId);
      try {
        while (next) {
          const declared = parsed.chunks[next.ordinal];
          if (!declared || declared.offset !== next.offset || declared.sizeBytes !== next.sizeBytes) fail("model_bundle_invalid", "bundle", "offline bundle does not match resumed import state");
          let content;
          try { content = await bundle.openChunk(next.ordinal); } catch {
            fail("model_bundle_read_failed", "transfer", "offline model chunk could not be read", { retryable: true });
          }
          if (!(content instanceof Uint8Array) || content.byteLength !== declared.sizeBytes || sha256(content) !== declared.digest) {
            content?.fill?.(0);
            fail("model_bundle_checksum_failed", "checksum", "offline model chunk does not match its signed index");
          }
          try {
            const stored = await this.#chunkStore.putChunk({ digest: declared.digest, content });
            await this.#repository.recordChunk({
              importId: started.import.importId, ...next, digest: declared.digest,
              blobKey: stored.blobKey, etag: `offline:${sha256(Buffer.from(offlineModelBundleSignaturePayload(parsed.manifest)))}`,
              lastModified: null,
            });
          } finally { content.fill(0); }
          next = await this.#repository.nextChunk(started.import.importId);
        }
        return await this.finalizeImport({ context, importId: started.import.importId });
      } catch (error) {
        if (!error.retryable) throw await this.#failIntegrity(started.import.importId, error);
        throw error;
      }
    } finally {
      try { await bundle?.close?.(); } catch { /* Source cleanup cannot change verified import state. */ }
    }
  }

  async setPinned({ context, digest, pinned }) {
    this.#authorize(context);
    if (!DIGEST.test(digest) || typeof pinned !== "boolean") fail("model_import_invalid", "cache", "model pin request is invalid");
    return this.#repository.setPinned(digest, pinned);
  }

  async acquireLease({ context, digest }) { this.#authorize(context); return this.#repository.changeLease(digest, 1); }
  async releaseLease({ context, digest }) { this.#authorize(context); return this.#repository.changeLease(digest, -1); }

  async evict({ context, bytesRequired }) {
    this.#authorize(context);
    const plan = await this.#repository.evictLeastRecentlyUsed({ bytesRequired });
    for (const chunk of plan.deleteChunks) await this.#chunkStore.deleteChunk(chunk);
    await this.#audit({ event: "model_cache.evicted", actorId: context.identityId ?? null, evictedDigests: plan.evicted, reclaimedBytes: plan.reclaimedBytes });
    return { evicted: plan.evicted, reclaimedBytes: plan.reclaimedBytes };
  }

  async usage({ context }) { this.#authorize(context); return this.#repository.usage(); }
}
