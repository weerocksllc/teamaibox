import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { MemoryObjectGrantRepository } from "./memory-grant-repository.mjs";
import { ObjectRepositoryError } from "./memory-repository.mjs";
import {reserveBufferedMedia} from './buffered-media-budget.mjs';

const NAMESPACE = /^(?:tenant|user|team):[a-z0-9][a-z0-9._-]{0,184}$/;
const AUDIENCE = /^[a-z][a-z0-9:._-]{2,190}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/i;
const ALLOWED_REFERENCE_OPERATIONS = new Set(["head", "read", "range"]);
const DEFAULT_POLICY = Object.freeze({
  maximumOneShotBytes: null,
  maximumPartBytes: null,
  maximumParts: null,
  multipartLifetimeMs: 24 * 60 * 60 * 1000,
  deletedRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maximumReferenceLifetimeMs: 15 * 60 * 1000,
  uncommittedBlobLifetimeMs: 60 * 60 * 1000,
  orphanDiscoveryGraceMs: 5 * 60 * 1000,
});

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function contentBytes(value, maximum) {
  if (!(value instanceof Uint8Array)) {
    throw new PlatformError("invalid_object_content", "Object content must be bytes", { status: 400 });
  }
  if (value.byteLength < 1 || (maximum != null && value.byteLength > maximum)) {
    throw new PlatformError("invalid_object_size", "Object size is outside the allowed range", { status: 413 });
  }
  return Buffer.from(value);
}

function safeNamespace(value) {
  if (typeof value !== "string" || !NAMESPACE.test(value)) {
    throw new PlatformError("invalid_namespace", "Object namespace is invalid", { status: 400 });
  }
  return value;
}

function safeObjectKey(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024
    || value.startsWith("/") || value.endsWith("/") || value.includes("\0")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new PlatformError("invalid_object_key", "Object key is invalid", { status: 400 });
  }
  return value.normalize("NFC");
}

function safePrefix(value) {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > 1024 || value.startsWith("/") || value.includes("\0")) {
    throw new PlatformError("invalid_object_key", "Object prefix is invalid", { status: 400 });
  }
  const segments = value.split("/");
  if (segments.some((segment, index) => (segment === "" && index !== segments.length - 1)
    || segment === "." || segment === "..")) {
    throw new PlatformError("invalid_object_key", "Object prefix is invalid", { status: 400 });
  }
  return value.normalize("NFC");
}

function safeContentType(value) {
  if (typeof value !== "string" || value.length > 255 || !CONTENT_TYPE.test(value)) {
    throw new PlatformError("invalid_content_type", "Content type is invalid", { status: 400 });
  }
  return value.toLocaleLowerCase("en-US");
}

function safeDigest(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new PlatformError("invalid_integrity", "SHA-256 digest is required", { status: 400 });
  }
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new PlatformError("invalid_integrity", "SHA-256 digest is invalid", { status: 400 });
  }
  return value;
}

function safePositiveInteger(value, code = "invalid_object_size") {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PlatformError(code, "A positive safe integer is required", { status: 400 });
  }
  return value;
}

function publicVersion(object, version) {
  return Object.freeze({
    objectId: object.id,
    namespaceKey: object.namespaceKey,
    objectKey: object.objectKey,
    version: version.version,
    size: version.size,
    contentType: version.contentType,
    integrity: Object.freeze({ algorithm: "sha256", digest: version.sha256 }),
    createdAt: new Date(version.createdAt).toISOString(),
    deletedAt: object.deletedAt ? new Date(object.deletedAt).toISOString() : null,
  });
}

function publicUpload(upload) {
  return Object.freeze({
    uploadId: upload.id,
    namespaceKey: upload.namespaceKey,
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    expectedSize: upload.expectedSize,
    expectedIntegrity: Object.freeze({ algorithm: "sha256", digest: upload.expectedSha256 }),
    createdAt: new Date(upload.createdAt).toISOString(),
    expiresAt: new Date(upload.expiresAt).toISOString(),
  });
}

function repositoryError(error) {
  if (!(error instanceof ObjectRepositoryError)) return error;
  if (error.code === "quota_exceeded") {
    return new PlatformError("object_quota_exceeded", "Object quota exceeded", { status: 409 });
  }
  if (error.code === "upload_not_found") {
    return new PlatformError("upload_not_found", "Multipart upload was not found", { status: 404 });
  }
  return new PlatformError(error.code, error.message, { status: 409 });
}

function requestedVersion(object, versionNumber) {
  if (!object) return null;
  if (versionNumber === undefined || versionNumber === null) return object.versions.at(-1) ?? null;
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    throw new PlatformError("invalid_object_version", "Object version is invalid", { status: 400 });
  }
  return object.versions.find((version) => version.version === versionNumber) ?? null;
}

export class ProtectedObjectService {
  #repository;
  #blobStore;
  #audit;
  #clock;
  #policy;
  #reserveUploadMemory;
  #referenceKey;
  #grantRepository;
  #authorizedGrantContexts = new WeakSet();
  #allowTestLegacyNamespaceContext;

  constructor({
    repository,
    blobStore,
    referenceSigningKey,
    grantRepository = new MemoryObjectGrantRepository(),
    audit = async () => {},
    clock = () => new Date(),
    policy = {},
    reserveUploadMemory = reserveBufferedMedia,
    allowTestPlaintextBlobStore = false,
    allowTestLegacyNamespaceContext = false,
  }) {
    if (!repository || !blobStore) throw new TypeError("object repository and blob store are required");
    if (blobStore.readonlyProtection !== "envelope-encrypted"
      && !(allowTestPlaintextBlobStore && blobStore.readonlyProtection === "test-only-plaintext")) {
      throw new TypeError("object blob store must enforce envelope encryption");
    }
    if (!(referenceSigningKey instanceof Uint8Array) || referenceSigningKey.byteLength < 32) {
      throw new TypeError("object reference signing key must contain at least 32 bytes");
    }
    if (!grantRepository?.create || !grantRepository?.find
      || !grantRepository?.revoke || !grantRepository?.recordUse) {
      throw new TypeError("object grant repository is incomplete");
    }
    this.#repository = repository;
    this.#blobStore = blobStore;
    this.#referenceKey = Buffer.from(referenceSigningKey);
    this.#grantRepository = grantRepository;
    this.#allowTestLegacyNamespaceContext = allowTestLegacyNamespaceContext === true;
    this.#audit = audit;
    this.#clock = clock;
    this.#policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
    if (typeof reserveUploadMemory !== 'function') throw new TypeError('upload memory admission is required');
    this.#reserveUploadMemory = reserveUploadMemory;
  }

  async #authorize(context, namespaceKey, operation = "read") {
    const namespace = safeNamespace(namespaceKey);
    if (context && this.#authorizedGrantContexts.has(context)
      && context.namespaceKey === namespace) {
      return namespace;
    }
    if (!context?.identityId || context.status === "disabled"
      || ["worker", "plugin", "service_account", "reference_grant"].includes(context.identityKind)) {
      await this.#emit("object.access_denied", {
        actorIdentityId: context?.identityId ?? null,
        identityKind: context?.identityKind ?? null,
        namespaceKey: namespace,
        operation,
        reason: "principal_denied",
        success: false,
      });
      throw new PlatformError("object_access_denied", "Object access denied", { status: 403 });
    }
    const access = Array.isArray(context.namespaceAccess)
      ? context.namespaceAccess.find((candidate) => candidate?.namespaceKey === namespace)
      : null;
    const allowed = access
      ? (access.operations?.includes(operation) || access.operations?.includes("manage"))
      : this.#allowTestLegacyNamespaceContext && context.namespaceKey === namespace;
    if (!allowed) {
      await this.#emit("object.access_denied", {
        actorIdentityId: context.identityId,
        identityKind: context.identityKind ?? "local_user",
        namespaceKey: namespace,
        operation,
        reason: "namespace_operation_denied",
        success: false,
      });
      throw new PlatformError("object_access_denied", "Object access denied", { status: 403 });
    }
    if (typeof this.#repository.ensureNamespaceAccess === "function") {
      await this.#repository.ensureNamespaceAccess({
        namespaceKey: namespace,
        identityId: context.identityId,
        operations: access.operations,
      });
    }
    return namespace;
  }

  async #emit(action, fields = {}) {
    await this.#audit({ action, occurredAt: this.#clock().toISOString(), ...fields });
  }

  async #reclaimBlob(blobKey) {
    try {
      if (this.#repository.readonlyReclamationOrder === "claim-first") {
        await this.#repository.markBlobReclaimed(blobKey);
        await this.#blobStore.delete(blobKey);
      } else {
        await this.#blobStore.delete(blobKey);
        await this.#repository.markBlobReclaimed(blobKey);
      }
      return true;
    } catch {
      return false;
    }
  }

  async #storeVerifiedBlob({
    blobKey,
    namespaceKey,
    claimKind,
    ownerUploadId = null,
    body,
    digest,
    chunks,
    size = body?.byteLength,
  }) {
    const now = this.#clock();
    if(chunks)await this.#blobStore.putStream(blobKey,chunks,{plaintextSize:size,plaintextSha256:digest});
    else await this.#blobStore.put(blobKey, body);
    let staged = false;
    try {
      await this.#repository.stageBlob({
        blobKey,
        namespaceKey,
        claimKind,
        ownerUploadId,
        size,
        sha256: digest,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.#policy.uncommittedBlobLifetimeMs),
      });
      staged = true;
      if(typeof this.#blobStore.verify==='function')await this.#blobStore.verify(blobKey,{size,sha256:digest});
      else {
        const stored = await this.#blobStore.get(blobKey);
        try {
          if (!stored || stored.byteLength !== size || sha256(stored) !== digest) {
            throw new PlatformError("object_corrupt", "Stored object integrity verification failed", { status: 500 });
          }
        }finally{stored?.fill(0);}
      }
      await this.#repository.verifyBlob(blobKey, {
        size,
        sha256: digest,
        verifiedAt: this.#clock(),
      });
    } catch (error) {
      if (staged) {
        await this.#repository.markBlobReclaimable(blobKey, { reclaimAfter: this.#clock() });
      }
      await this.#reclaimBlob(blobKey);
      throw repositoryError(error);
    }
  }

  async upload({ context, namespaceKey, objectKey, contentType, content, expectedSha256 }) {
    const namespace = await this.#authorize(context, namespaceKey, "write");
    const key = safeObjectKey(objectKey);
    const type = safeContentType(contentType);
    const release = this.#reserveUploadMemory(content?.byteLength);
    let body;
    try {
    body = contentBytes(content, this.#policy.maximumOneShotBytes);
    const digest = sha256(body);
    const expected = safeDigest(expectedSha256);
    if (expected && expected !== digest) {
      throw new PlatformError("integrity_mismatch", "Object SHA-256 does not match", { status: 422 });
    }
    const blobKey = `objects/${randomUUID()}`;
    await this.#storeVerifiedBlob({
      blobKey,
      namespaceKey: namespace,
      claimKind: "object_candidate",
      body,
      digest,
    });
    try {
      const committed = await this.#repository.commitOneShot({
        namespaceKey: namespace,
        objectKey: key,
        blobKey,
        size: body.byteLength,
        sha256: digest,
        contentType: type,
        createdAt: this.#clock(),
        createdByIdentityId: context.identityId,
      });
      await this.#emit("object.version_committed", {
        actorIdentityId: context.identityId,
        namespaceKey: namespace,
        objectId: committed.object.id,
        objectVersion: committed.version.version,
        size: committed.version.size,
        success: true,
      });
      return publicVersion(committed.object, committed.version);
    } catch (error) {
      await this.#repository.markBlobReclaimable(blobKey, { reclaimAfter: this.#clock() });
      await this.#reclaimBlob(blobKey);
      throw repositoryError(error);
    }
    } finally { body?.fill(0); release(); }
  }

  async beginMultipart({ context, namespaceKey, objectKey, contentType, expectedSize, expectedSha256 }) {
    const namespace = await this.#authorize(context, namespaceKey, "write");
    const size = safePositiveInteger(expectedSize);
    const now = this.#clock();
    try {
      const upload = await this.#repository.createUpload({
        namespaceKey: namespace,
        objectKey: safeObjectKey(objectKey),
        contentType: safeContentType(contentType),
        expectedSize: size,
        expectedSha256: safeDigest(expectedSha256, { required: true }),
        createdByIdentityId: context.identityId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.#policy.multipartLifetimeMs),
      });
      await this.#emit("object.multipart_started", {
        actorIdentityId: context.identityId,
        namespaceKey: namespace,
        uploadId: upload.id,
        expectedSize: size,
        success: true,
      });
      return publicUpload(upload);
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async #ownedUpload(context, uploadId) {
    const upload = await this.#repository.findUpload(uploadId);
    if (!upload || !context?.identityId || upload.createdByIdentityId !== context.identityId) {
      throw new PlatformError("upload_not_found", "Multipart upload was not found", { status: 404 });
    }
    try {
      await this.#authorize(context, upload.namespaceKey, "write");
    } catch (error) {
      if (error?.code !== "object_access_denied") throw error;
      throw new PlatformError("upload_not_found", "Multipart upload was not found", { status: 404 });
    }
    if (new Date(upload.expiresAt) <= this.#clock()) {
      throw new PlatformError("upload_expired", "Multipart upload has expired", { status: 410 });
    }
    return upload;
  }

  async uploadPart({ context, uploadId, partNumber, content, expectedSha256 }) {
    const upload = await this.#ownedUpload(context, uploadId);
    const number = safePositiveInteger(partNumber, "invalid_part_number");
    if (this.#policy.maximumParts != null && number > this.#policy.maximumParts) {
      throw new PlatformError("invalid_part_number", "Multipart part number is invalid", { status: 400 });
    }
    const release = this.#reserveUploadMemory(content?.byteLength);
    let body;
    try {
    body = contentBytes(content, this.#policy.maximumPartBytes);
    const digest = sha256(body);
    const expected = safeDigest(expectedSha256, { required: true });
    if (expected !== digest) throw new PlatformError("integrity_mismatch", "Part SHA-256 does not match", { status: 422 });
    const existing = upload.parts.find((part) => part.partNumber === number);
    if (existing && existing.sha256 === digest && existing.size === body.byteLength) {
      return Object.freeze({ partNumber: number, size: existing.size, integrity: { algorithm: "sha256", digest } });
    }
    const partsSize = upload.parts
      .filter((part) => part.partNumber !== number)
      .reduce((sum, part) => sum + part.size, 0) + body.byteLength;
    if (partsSize > upload.expectedSize) {
      throw new PlatformError("invalid_object_size", "Multipart parts exceed expected size", { status: 409 });
    }
    const blobKey = `multipart/${upload.id}/${number}/${randomUUID()}`;
    await this.#storeVerifiedBlob({
      blobKey,
      namespaceKey: upload.namespaceKey,
      claimKind: "multipart_part",
      ownerUploadId: upload.id,
      body,
      digest,
    });
    let storedPart;
    try {
      storedPart = await this.#repository.upsertPart(upload.id, {
        partNumber: number,
        blobKey,
        size: body.byteLength,
        sha256: digest,
        createdAt: this.#clock(),
      });
    } catch (error) {
      await this.#repository.markBlobReclaimable(blobKey, { reclaimAfter: this.#clock() });
      await this.#reclaimBlob(blobKey);
      throw repositoryError(error);
    }
    if (storedPart.replaced) await this.#reclaimBlob(storedPart.replaced.blobKey);
    await this.#emit("object.multipart_part_stored", {
      actorIdentityId: context.identityId,
      uploadId: upload.id,
      partNumber: number,
      size: body.byteLength,
      success: true,
    });
    return Object.freeze({ partNumber: number, size: body.byteLength, integrity: { algorithm: "sha256", digest } });
    } finally { body?.fill(0); release(); }
  }

  async listUploadParts({ context, uploadId }) {
    const upload = await this.#ownedUpload(context, uploadId);
    return Object.freeze(upload.parts
      .sort((left, right) => left.partNumber - right.partNumber)
      .map((part) => Object.freeze({
        partNumber: part.partNumber,
        size: part.size,
        integrity: Object.freeze({ algorithm: "sha256", digest: part.sha256 }),
      })));
  }

  async completeMultipart({ context, uploadId, parts }) {
    const upload = await this.#ownedUpload(context, uploadId);
    if (!Array.isArray(parts) || parts.length < 1 || parts.length !== upload.parts.length) {
      throw new PlatformError("invalid_part_manifest", "Multipart completion manifest is incomplete", { status: 400 });
    }
    const stored = [...upload.parts].sort((left, right) => left.partNumber - right.partNumber);
    for (let index = 0; index < stored.length; index += 1) {
      const requested = parts[index];
      if (stored[index].partNumber !== index + 1
        || requested?.partNumber !== stored[index].partNumber
        || requested?.sha256 !== stored[index].sha256) {
        throw new PlatformError("invalid_part_manifest", "Multipart completion manifest does not match stored parts", { status: 409 });
      }
    }
    const store=this.#blobStore;
    let consumed=false;
    const chunks=(async function*(){
      const hash=createHash('sha256');let size=0;
      for (const part of stored) {
        const body=await store.get(part.blobKey);
        try {
          if(!body||body.byteLength!==part.size||sha256(body)!==part.sha256) {
            throw new PlatformError('object_corrupt','Multipart part integrity check failed',{status:500});
          }
          size+=body.byteLength;
          if(size>upload.expectedSize)throw new PlatformError('integrity_mismatch','Multipart size mismatch',{status:422});
          hash.update(body);yield body;
        }finally{body?.fill(0);}
      }
      if(size!==upload.expectedSize||hash.digest('hex')!==upload.expectedSha256) {
        throw new PlatformError('integrity_mismatch','Completed object does not match expected size or SHA-256',{status:422});
      }
      consumed=true;
    })();
    const digest=upload.expectedSha256;
    const blobKey = `objects/${randomUUID()}`;
    try {
      await this.#storeVerifiedBlob({
        blobKey,
        namespaceKey: upload.namespaceKey,
        claimKind: "object_candidate",
        ownerUploadId: upload.id,
        chunks,
        size:upload.expectedSize,
        digest,
      });
      if(!consumed)throw new PlatformError('object_corrupt','Multipart stream was not consumed',{status:500});
      const committed = await this.#repository.commitUpload(upload.id, {
        namespaceKey: upload.namespaceKey,
        objectKey: upload.objectKey,
        blobKey,
        size: upload.expectedSize,
        sha256: digest,
        contentType: upload.contentType,
        createdAt: this.#clock(),
        createdByIdentityId: context.identityId,
      });
      for (const part of stored) await this.#reclaimBlob(part.blobKey);
      await this.#emit("object.multipart_completed", {
        actorIdentityId: context.identityId,
        uploadId: upload.id,
        objectId: committed.object.id,
        objectVersion: committed.version.version,
        success: true,
      });
      return publicVersion(committed.object, committed.version);
    } catch (error) {
      await this.#repository.markBlobReclaimable(blobKey, { reclaimAfter: this.#clock() });
      await this.#reclaimBlob(blobKey);
      throw repositoryError(error);
    } finally { await chunks.return(); }
  }

  async abortMultipart({ context, uploadId, reason = "client_aborted" }) {
    const upload = await this.#ownedUpload(context, uploadId);
    const aborted = await this.#repository.abortUpload(upload.id, { reclaimAfter: this.#clock() });
    for (const part of aborted.parts) await this.#reclaimBlob(part.blobKey);
    await this.#emit("object.multipart_aborted", {
      actorIdentityId: context.identityId,
      uploadId: upload.id,
      reason,
      success: true,
    });
    return Object.freeze({ uploadId: upload.id, aborted: true });
  }

  async #objectFor(context, {
    namespaceKey,
    objectId,
    objectKey,
    version,
    includeDeleted = false,
    operation = "read",
  }) {
    const namespace = await this.#authorize(context, namespaceKey, operation);
    const object = objectId
      ? await this.#repository.findObject(namespace, objectId)
      : await this.#repository.findObjectByKey(namespace, safeObjectKey(objectKey));
    if (!object || (object.deletedAt && !includeDeleted)) {
      throw new PlatformError("object_not_found", "Object was not found", { status: 404 });
    }
    const selected = requestedVersion(object, version);
    if (!selected) throw new PlatformError("object_not_found", "Object was not found", { status: 404 });
    return { object, version: selected };
  }

  async head(input) {
    const record = await this.#objectFor(input.context, input);
    const result = publicVersion(record.object, record.version);
    await this.#emit("object.accessed", {
      actorIdentityId: input.context.identityId,
      namespaceKey: record.object.namespaceKey,
      objectId: record.object.id,
      objectVersion: record.version.version,
      operation: "head",
      success: true,
    });
    return result;
  }

  async downloadStream(input) {
    const record=await this.#objectFor(input.context,input);
    const metadata=publicVersion(record.object,record.version);
    if(typeof this.#blobStore.read!=='function') {
      // Test-only memory stores keep their existing representation.
      const loaded=await this.download(input);
      return {metadata,chunks:(async function*(){try{yield loaded.content;}finally{loaded.content.fill(0);}})()};
    }
    const chunks=await this.#blobStore.read(record.version.blobKey);
    if(!chunks)throw new PlatformError('object_corrupt','Object integrity check failed',{status:500});
    return {metadata,chunks};
  }

  async download({ range, ...input }) {
    const record = await this.#objectFor(input.context, input);
    let start = 0;
    let end = record.version.size - 1;
    if (range) {
      start = Number(range.start);
      end = range.endInclusive === undefined ? end : Number(range.endInclusive);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= record.version.size) {
        throw new PlatformError("range_not_satisfiable", "Object byte range is not satisfiable", {
          status: 416,
          details: { size: record.version.size },
        });
      }
    }
    let body;
    if (range && typeof this.#blobStore.getRange === "function") {
      body = await this.#blobStore.getRange(record.version.blobKey, { start, endInclusive: end });
    } else {
      const full = await this.#blobStore.get(record.version.blobKey);
      if (!full || full.byteLength !== record.version.size || sha256(full) !== record.version.sha256) {
        full?.fill?.(0);
        throw new PlatformError("object_corrupt", "Object integrity check failed", { status: 500 });
      }
      if (range) {
        body = Buffer.from(full.subarray(start, end + 1));
        full.fill(0);
      } else body = full;
    }
    if (!body || body.byteLength !== end - start + 1
        || (!range && sha256(body) !== record.version.sha256)) {
      body?.fill?.(0);
      throw new PlatformError("object_corrupt", "Object integrity check failed", { status: 500 });
    }
    const result = Object.freeze({
      metadata: publicVersion(record.object, record.version),
      content: range ? body : Buffer.from(body),
      range: Object.freeze({ start, endInclusive: end, total: record.version.size }),
      partial: Boolean(range),
    });
    if (!range) body.fill(0);
    await this.#emit("object.accessed", {
      actorIdentityId: input.context.identityId,
      namespaceKey: record.object.namespaceKey,
      objectId: record.object.id,
      objectVersion: record.version.version,
      operation: range ? "range" : "read",
      bytesReturned: result.content.byteLength,
      success: true,
    });
    return result;
  }

  async list({ context, namespaceKey, prefix = "", cursor = null, limit = 100 }) {
    const namespace = await this.#authorize(context, namespaceKey, "list");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new PlatformError("invalid_page", "Object list limit is invalid", { status: 400 });
    }
    const normalizedPrefix = safePrefix(prefix);
    let after = "";
    if (cursor !== null) {
      try {
        if (typeof cursor !== "string" || cursor.length > 6000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const bytes = Buffer.from(cursor, "base64url");
        after = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (bytes.toString("base64url") !== cursor || safeObjectKey(after) !== after) throw new Error();
      } catch {
        throw new PlatformError("invalid_page", "Object list cursor is invalid", { status: 400 });
      }
    }
    // Fetch one extra row to decide whether another page exists. The repository
    // applies the cursor before loading metadata; history belongs to listVersions.
    const objects = await this.#repository.listObjects(namespace, { prefix: normalizedPrefix, after, limit: limit + 1 });
    const page = objects.slice(0, limit);
    const items = page.map((object) => publicVersion(object, object.versions.at(-1)));
    const result = Object.freeze({
      items: Object.freeze(items),
      nextCursor: objects.length > limit
        ? Buffer.from(page.at(-1).objectKey, "utf8").toString("base64url")
        : null,
    });
    await this.#emit("object.list_accessed", {
      actorIdentityId: context.identityId,
      namespaceKey: namespace,
      prefix: normalizedPrefix,
      resultCount: result.items.length,
      success: true,
    });
    return result;
  }

  async listVersions({ context, namespaceKey, objectId, objectKey }) {
    const record = await this.#objectFor(context, { namespaceKey, objectId, objectKey, includeDeleted: true });
    const result = Object.freeze([...record.object.versions]
      .reverse()
      .map((version) => publicVersion(record.object, version)));
    await this.#emit("object.versions_accessed", {
      actorIdentityId: context.identityId,
      namespaceKey: record.object.namespaceKey,
      objectId: record.object.id,
      resultCount: result.length,
      success: true,
    });
    return result;
  }

  async delete({ context, namespaceKey, objectId, objectKey }) {
    const record = await this.#objectFor(context, {
      namespaceKey,
      objectId,
      objectKey,
      operation: "delete",
    });
    const now = this.#clock();
    await this.#repository.deleteObject(record.object.namespaceKey, record.object.id, {
      deletedAt: now,
      purgeAfter: new Date(now.getTime() + this.#policy.deletedRetentionMs),
    });
    await this.#emit("object.deleted", {
      actorIdentityId: context.identityId,
      namespaceKey: record.object.namespaceKey,
      objectId: record.object.id,
      success: true,
    });
    return Object.freeze({ objectId: record.object.id, deleted: true });
  }

  async quota({ context, namespaceKey }) {
    const namespace = await this.#authorize(context, namespaceKey, "read");
    return this.#repository.quota(namespace);
  }

  async runLifecycle({ now = this.#clock(), limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("lifecycle limit is invalid");
    const candidates = await this.#repository.lifecycleCandidates(now, limit);
    let uploadsReclaimed = 0;
    let objectsPurged = 0;
    for (const upload of candidates.expiredUploads) {
      const aborted = await this.#repository.abortUpload(upload.id, { reclaimAfter: now });
      if (!aborted) continue;
      for (const part of aborted.parts) await this.#reclaimBlob(part.blobKey);
      uploadsReclaimed += 1;
    }
    for (const object of candidates.deletedObjects) {
      const purged = await this.#repository.purgeDeletedObject(
        object.namespaceKey,
        object.id,
        { reclaimAfter: now },
      );
      if (!purged) continue;
      for (const version of purged.versions) await this.#reclaimBlob(version.blobKey);
      objectsPurged += 1;
    }
    if (uploadsReclaimed || objectsPurged) {
      await this.#emit("object.lifecycle_reclaimed", { uploadsReclaimed, objectsPurged, success: true });
    }
    return Object.freeze({ uploadsReclaimed, objectsPurged });
  }

  async reconcileOrphans({ now = this.#clock(), limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("orphan reconciliation limit is invalid");
    }
    let registeredReclaimed = 0;
    let untrackedReclaimed = 0;
    let deferred = 0;
    const registered = await this.#repository.blobReclamationCandidates(now, limit);
    for (const claim of registered) {
      if (await this.#reclaimBlob(claim.blobKey)) registeredReclaimed += 1;
      else deferred += 1;
    }
    const remaining = limit - registered.length;
    if (remaining > 0 && typeof this.#blobStore.list === "function") {
      let cursor = "";
      let scanned = 0;
      const cutoff = now.getTime() - this.#policy.orphanDiscoveryGraceMs;
      while (scanned < remaining) {
        const page = await this.#blobStore.list({ cursor, limit: Math.min(100, remaining - scanned) });
        if (page.length === 0) break;
        for (const blob of page) {
          cursor = blob.blobKey;
          scanned += 1;
          if (await this.#repository.isBlobKnown(blob.blobKey)) continue;
          const createdAt = new Date(blob.createdAt);
          if (!Number.isFinite(createdAt.getTime()) || createdAt.getTime() > cutoff) {
            deferred += 1;
            continue;
          }
          if (await this.#reclaimBlob(blob.blobKey)) untrackedReclaimed += 1;
          else deferred += 1;
        }
      }
    }
    if (registeredReclaimed || untrackedReclaimed || deferred) {
      await this.#emit("object.orphans_reconciled", {
        registeredReclaimed,
        untrackedReclaimed,
        deferred,
        success: true,
      });
    }
    return Object.freeze({ registeredReclaimed, untrackedReclaimed, deferred });
  }

  #sign(encodedPayload) {
    return createHmac("sha256", this.#referenceKey).update(encodedPayload, "utf8").digest("base64url");
  }

  async createScopedReference({ context, namespaceKey, objectId, objectKey, version, audience, operations, expiresAt }) {
    const record = await this.#objectFor(context, {
      namespaceKey,
      objectId,
      objectKey,
      version,
      operation: "reference:create",
    });
    if (typeof audience !== "string" || !AUDIENCE.test(audience)) {
      throw new PlatformError("invalid_reference", "Object reference audience is invalid", { status: 400 });
    }
    if (!Array.isArray(operations) || operations.length < 1
      || new Set(operations).size !== operations.length
      || operations.some((operation) => !ALLOWED_REFERENCE_OPERATIONS.has(operation))) {
      throw new PlatformError("invalid_reference", "Object reference operations are invalid", { status: 400 });
    }
    const now = this.#clock();
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry <= now
      || expiry.getTime() - now.getTime() > this.#policy.maximumReferenceLifetimeMs) {
      throw new PlatformError("invalid_reference", "Object reference expiry is invalid", { status: 400 });
    }
    const reference = {
      referenceVersion: 1,
      referenceId: randomUUID(),
      objectId: record.object.id,
      objectVersion: record.version.version,
      namespaceKey: record.object.namespaceKey,
      audience,
      operations: [...operations].sort(),
      expiresAt: expiry.toISOString(),
      integrity: { algorithm: "sha256", digest: record.version.sha256 },
    };
    await this.#grantRepository.create({
      referenceId: reference.referenceId,
      namespaceKey: reference.namespaceKey,
      objectId: reference.objectId,
      objectVersion: reference.objectVersion,
      audience: reference.audience,
      operations: reference.operations,
      integritySha256: reference.integrity.digest,
      issuedByIdentityId: context.identityId,
      createdAt: now,
      expiresAt: expiry,
      revokedAt: null,
      revokedByIdentityId: null,
      revokeReason: null,
      lastUsedAt: null,
      useCount: 0,
    });
    const encoded = Buffer.from(JSON.stringify(reference), "utf8").toString("base64url");
    const token = `${encoded}.${this.#sign(encoded)}`;
    await this.#emit("object.reference_issued", {
      actorIdentityId: context.identityId,
      referenceId: reference.referenceId,
      objectId: reference.objectId,
      objectVersion: reference.objectVersion,
      audience,
      operations: reference.operations,
      expiresAt: reference.expiresAt,
      success: true,
    });
    const { namespaceKey: _internalNamespace, ...contractReference } = reference;
    return Object.freeze({ reference: Object.freeze(contractReference), token });
  }

  createTeamDriveObjectReferences() {
    if (typeof this.#repository.findObjectById !== "function") {
      throw new TypeError("object repository cannot resolve globally unique object identities");
    }
    return Object.freeze({
      resolve: async ({ actorIdentityId, referenceId, audience, requiredOperation }) => {
        if (typeof actorIdentityId !== "string" || typeof referenceId !== "string"
          || typeof audience !== "string" || typeof requiredOperation !== "string") {
          throw new PlatformError("file_object_reference_invalid", "File object reference is invalid", { status: 400 });
        }
        const grant = await this.#grantRepository.find(referenceId);
        if (!grant || grant.issuedByIdentityId !== actorIdentityId || grant.audience !== audience
          || !grant.operations.includes(requiredOperation) || grant.revokedAt
          || new Date(grant.expiresAt) <= this.#clock()) {
          throw new PlatformError("file_object_reference_invalid", "File object reference is invalid or expired", { status: 401 });
        }
        const object = await this.#repository.findObject(grant.namespaceKey, grant.objectId);
        const selected = requestedVersion(object, grant.objectVersion);
        if (!object || object.deletedAt || !selected || selected.sha256 !== grant.integritySha256) {
          throw new PlatformError("file_object_unavailable", "Referenced object version is unavailable", { status: 409 });
        }
        await this.#grantRepository.recordUse(referenceId, { usedAt: this.#clock() });
        return Object.freeze({
          objectId: object.id,
          objectVersion: selected.version,
          size: selected.size,
          mediaType: selected.contentType,
          sha256: `sha256:${selected.sha256}`,
        });
      },
      issueReadReference: async ({ actorIdentityId, objectId, objectVersion, audience, expiresInSeconds }) => {
        if (typeof actorIdentityId !== "string" || typeof objectId !== "string"
          || !Number.isSafeInteger(objectVersion) || objectVersion < 1
          || !new Set(["team-drive.preview", "team-drive.download"]).has(audience)
          || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) {
          throw new PlatformError("file_reference_invalid", "File read reference request is invalid", { status: 400 });
        }
        const object = await this.#repository.findObjectById(objectId);
        const selected = requestedVersion(object, objectVersion);
        if (!object || object.deletedAt || !selected) throw new PlatformError("file_object_unavailable", "Referenced object version is unavailable", { status: 409 });
        const context = {
          identityId: actorIdentityId,
          identityKind: "local_user",
          permissions: ["file:read"],
          namespaceAccess: [{ namespaceKey: object.namespaceKey, operations: ["read", "reference:create"] }],
        };
        const created = await this.createScopedReference({
          context,
          namespaceKey: object.namespaceKey,
          objectId,
          version: objectVersion,
          audience,
          operations: ["head", "read", "range"],
          expiresAt: new Date(this.#clock().getTime() + expiresInSeconds * 1000),
        });
        return Object.freeze({ referenceId: created.reference.referenceId, expiresAt: created.reference.expiresAt });
      },
    });
  }

  createObjectHandoffGateway() {
    if (typeof this.#repository.findObjectById !== "function") {
      throw new TypeError("object repository cannot resolve globally unique object identities");
    }
    const authorizedReference = async ({ actorIdentityId, referenceId, audience, requiredOperation }) => {
      if (typeof actorIdentityId !== "string" || typeof referenceId !== "string"
        || typeof audience !== "string" || typeof requiredOperation !== "string") {
        throw new PlatformError("artifact_reference_invalid", "Artifact object reference is invalid", { status: 400 });
      }
      const grant = await this.#grantRepository.find(referenceId);
      if (!grant || grant.issuedByIdentityId !== actorIdentityId || grant.audience !== audience
        || !grant.operations.includes(requiredOperation) || grant.revokedAt
        || new Date(grant.expiresAt) <= this.#clock()) {
        throw new PlatformError("artifact_reference_invalid", "Artifact object reference is invalid or expired", { status: 401 });
      }
      const object = await this.#repository.findObject(grant.namespaceKey, grant.objectId);
      const selected = requestedVersion(object, grant.objectVersion);
      if (!object || object.deletedAt || !selected || selected.sha256 !== grant.integritySha256) {
        throw new PlatformError("artifact_object_unavailable", "Referenced artifact object version is unavailable", { status: 409 });
      }
      await this.#grantRepository.recordUse(referenceId, { usedAt: this.#clock() });
      return { grant, object, selected };
    };
    const grantContext = (grant) => {
      const context = {
        identityId: `reference:${grant.referenceId}`,
        identityKind: "reference_grant",
        namespaceKey: grant.namespaceKey,
      };
      this.#authorizedGrantContexts.add(context);
      return context;
    };
    return Object.freeze({
      resolve: async ({ actorIdentityId, referenceId, audience, requiredOperation }) => {
        const { object, selected } = await authorizedReference({
          actorIdentityId, referenceId, audience, requiredOperation,
        });
        return Object.freeze({
          objectId: object.id, objectVersion: selected.version, objectKey: object.objectKey,
          size: selected.size, mediaType: selected.contentType, sha256: `sha256:${selected.sha256}`,
        });
      },
      head: async ({ actorIdentityId, referenceId, audience }) => {
        const { grant } = await authorizedReference({
          actorIdentityId, referenceId, audience, requiredOperation: "head",
        });
        return this.head({
          context: grantContext(grant), namespaceKey: grant.namespaceKey,
          objectId: grant.objectId, version: grant.objectVersion,
        });
      },
      download: async ({ actorIdentityId, referenceId, audience, range = null }) => {
        const { grant, selected } = await authorizedReference({
          actorIdentityId, referenceId, audience, requiredOperation: range ? "range" : "read",
        });
        const release=range?()=>{}:reserveBufferedMedia(selected.size);
        try{return await this.download({
          context: grantContext(grant), namespaceKey: grant.namespaceKey,
          objectId: grant.objectId, version: grant.objectVersion, range,
        });}finally{release();}
      },
      downloadStream: async ({actorIdentityId,referenceId,audience}) => {
        const {grant}=await authorizedReference({actorIdentityId,referenceId,audience,requiredOperation:'read'});
        return this.downloadStream({context:grantContext(grant),namespaceKey:grant.namespaceKey,
          objectId:grant.objectId,version:grant.objectVersion});
      },
      storeOutput: async ({ actorIdentityId, objectKey, contentType, content, expectedSha256 }) => {
        if (typeof actorIdentityId !== "string") {
          throw new PlatformError("artifact_output_invalid", "Artifact output owner is invalid", { status: 400 });
        }
        const namespaceKey = `user:${actorIdentityId}`;
        return this.upload({
          context: {
            identityId: actorIdentityId,
            identityKind: "local_user",
            namespaceAccess: [{ namespaceKey, operations: ["write"] }],
          },
          namespaceKey, objectKey, contentType, content, expectedSha256,
        });
      },
      beginOutput: async ({ actorIdentityId, objectKey, contentType, expectedSize, expectedSha256 }) => {
        if (typeof actorIdentityId !== "string") {
          throw new PlatformError("artifact_output_invalid", "Artifact output owner is invalid", { status: 400 });
        }
        const namespaceKey = `user:${actorIdentityId}`;
        return this.beginMultipart({
          context: { identityId: actorIdentityId, identityKind: "local_user",
            namespaceAccess: [{ namespaceKey, operations: ["write"] }] },
          namespaceKey, objectKey, contentType, expectedSize, expectedSha256,
        });
      },
      storeOutputPart: async ({ actorIdentityId, uploadId, partNumber, content, expectedSha256 }) => {
        const namespaceKey = `user:${actorIdentityId}`;
        return this.uploadPart({ context: { identityId: actorIdentityId, identityKind: "local_user",
          namespaceAccess: [{ namespaceKey, operations: ["write"] }] }, uploadId, partNumber, content, expectedSha256 });
      },
      completeOutput: async ({ actorIdentityId, uploadId, parts }) => {
        const namespaceKey = `user:${actorIdentityId}`;
        return this.completeMultipart({ context: { identityId: actorIdentityId, identityKind: "local_user",
          namespaceAccess: [{ namespaceKey, operations: ["write"] }] }, uploadId, parts });
      },
      abortOutput: async ({ actorIdentityId, uploadId, reason = "artifact_output_aborted" }) => {
        const namespaceKey = `user:${actorIdentityId}`;
        return this.abortMultipart({ context: { identityId: actorIdentityId, identityKind: "local_user",
          namespaceAccess: [{ namespaceKey, operations: ["write"] }] }, uploadId, reason });
      },
      issue: async ({ actorIdentityId, objectId, objectVersion, audience, operations, expiresInSeconds }) => {
        if (typeof actorIdentityId !== "string" || typeof objectId !== "string"
          || !Number.isSafeInteger(objectVersion) || objectVersion < 1
          || typeof audience !== "string" || !Array.isArray(operations)
          || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) {
          throw new PlatformError("artifact_reference_invalid", "Artifact object reference request is invalid", { status: 400 });
        }
        const object = await this.#repository.findObjectById(objectId);
        const selected = requestedVersion(object, objectVersion);
        if (!object || object.deletedAt || !selected) throw new PlatformError("artifact_object_unavailable", "Artifact object is unavailable", { status: 409 });
        const serviceContext = {
          identityId: actorIdentityId,
          identityKind: "local_user",
          namespaceAccess: [{ namespaceKey: object.namespaceKey, operations: ["read", "reference:create"] }],
        };
        const created = await this.createScopedReference({
          context: serviceContext, namespaceKey: object.namespaceKey, objectId,
          version: objectVersion, audience, operations,
          expiresAt: new Date(this.#clock().getTime() + expiresInSeconds * 1000),
        });
        return Object.freeze({
          referenceId: created.reference.referenceId,
          expiresAt: created.reference.expiresAt,
          token: created.token,
        });
      },
      revoke: async ({ actorIdentityId, referenceId, reason = "compute_attempt_finished" }) => {
        if (typeof actorIdentityId !== "string" || typeof referenceId !== "string") {
          throw new PlatformError("artifact_reference_invalid", "Artifact object reference revocation is invalid", { status: 400 });
        }
        const grant = await this.#grantRepository.find(referenceId);
        if (!grant || grant.issuedByIdentityId !== actorIdentityId) {
          throw new PlatformError("artifact_reference_invalid", "Artifact object reference is unavailable", { status: 404 });
        }
        return this.revokeScopedReference({
          context: {
            identityId: actorIdentityId,
            identityKind: "local_user",
            permissions: ["object_reference:revoke:any"],
            namespaceAccess: [{ namespaceKey: grant.namespaceKey, operations: ["reference:revoke"] }],
          },
          referenceId,
          reason,
        });
      },
    });
  }

  async authorizeScopedReference({ token, audience, operation }) {
    if (typeof token !== "string" || token.length > 4096 || !token.includes(".")) {
      await this.#emit("object.reference_accessed", {
        referenceId: null, audience, operation, success: false, reason: "malformed",
      });
      throw new PlatformError("invalid_reference", "Object reference is invalid or expired", { status: 401 });
    }
    const [encoded, signature, ...extra] = token.split(".");
    const expected = Buffer.from(this.#sign(encoded), "utf8");
    const actual = Buffer.from(signature ?? "", "utf8");
    const validSignature = extra.length === 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!validSignature) {
      await this.#emit("object.reference_accessed", {
        referenceId: null, audience, operation, success: false, reason: "invalid_signature",
      });
      throw new PlatformError("invalid_reference", "Object reference is invalid or expired", { status: 401 });
    }
    let reference;
    try {
      reference = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      await this.#emit("object.reference_accessed", {
        referenceId: null, audience, operation, success: false, reason: "invalid_payload",
      });
      throw new PlatformError("invalid_reference", "Object reference is invalid or expired", { status: 401 });
    }
    const grant = await this.#grantRepository.find(reference.referenceId);
    const matchingGrant = grant
      && grant.namespaceKey === reference.namespaceKey
      && grant.objectId === reference.objectId
      && grant.objectVersion === reference.objectVersion
      && grant.audience === reference.audience
      && grant.integritySha256 === reference.integrity?.digest
      && JSON.stringify(grant.operations) === JSON.stringify(reference.operations)
      && new Date(grant.expiresAt).toISOString() === reference.expiresAt;
    if (reference.referenceVersion !== 1 || reference.audience !== audience
      || !reference.operations?.includes(operation) || new Date(reference.expiresAt) <= this.#clock()
      || !matchingGrant || grant.revokedAt) {
      await this.#emit("object.reference_accessed", {
        referenceId: reference.referenceId ?? null,
        audience,
        operation,
        success: false,
        reason: grant?.revokedAt ? "revoked" : "invalid_or_expired",
      });
      throw new PlatformError("invalid_reference", "Object reference is invalid or expired", { status: 401 });
    }
    const object = await this.#repository.findObject(reference.namespaceKey, reference.objectId);
    const version = requestedVersion(object, reference.objectVersion);
    if (!object || object.deletedAt || !version || version.sha256 !== reference.integrity?.digest) {
      await this.#emit("object.reference_accessed", {
        referenceId: reference.referenceId,
        audience,
        operation,
        success: false,
        reason: "object_unavailable",
      });
      throw new PlatformError("invalid_reference", "Object reference is invalid or expired", { status: 401 });
    }
    await this.#grantRepository.recordUse(reference.referenceId, { usedAt: this.#clock() });
    await this.#emit("object.reference_authorized", {
      referenceId: reference.referenceId,
      objectId: reference.objectId,
      objectVersion: reference.objectVersion,
      audience,
      operation,
      success: true,
    });
    await this.#emit("object.reference_accessed", {
      referenceId: reference.referenceId,
      audience,
      operation,
      objectId: reference.objectId,
      objectVersion: reference.objectVersion,
      success: true,
    });
    return Object.freeze({
      referenceId: reference.referenceId,
      namespaceKey: reference.namespaceKey,
      objectId: reference.objectId,
      objectVersion: reference.objectVersion,
      audience,
      operation,
    });
  }

  async revokeScopedReference({ context, referenceId, reason = "issuer_revoked" }) {
    if (typeof referenceId !== "string" || !/^[0-9a-f-]{36}$/i.test(referenceId)
      || typeof reason !== "string" || reason.length < 1 || reason.length > 128) {
      throw new PlatformError("invalid_reference", "Object reference is invalid", { status: 400 });
    }
    const grant = await this.#grantRepository.find(referenceId);
    if (!grant) {
      throw new PlatformError("invalid_reference", "Object reference is invalid", { status: 404 });
    }
    await this.#authorize(context, grant.namespaceKey, "reference:revoke");
    if (grant.issuedByIdentityId !== context.identityId
      && !context.permissions?.includes("object_reference:revoke:any")) {
      throw new PlatformError("object_access_denied", "Object access denied", { status: 403 });
    }
    const revoked = await this.#grantRepository.revoke(referenceId, {
      revokedAt: this.#clock(),
      revokedByIdentityId: context.identityId,
      reason,
    });
    await this.#emit("object.reference_revoked", {
      actorIdentityId: context.identityId,
      referenceId,
      objectId: grant.objectId,
      objectVersion: grant.objectVersion,
      reason,
      success: true,
    });
    return Object.freeze({
      referenceId,
      revoked: true,
      revokedAt: new Date(revoked.revokedAt).toISOString(),
    });
  }

  async headByReferenceId({ context, referenceId }) {
    const grant = await this.#issuedGrant(context, referenceId, "read");
    const accessContext = this.#issuedGrantContext(context, grant);
    return this.head({
      context: accessContext,
      namespaceKey: grant.namespaceKey,
      objectId: grant.objectId,
      version: grant.objectVersion,
    });
  }

  async downloadByReferenceId({ context, referenceId, range = null }) {
    const grant = await this.#issuedGrant(context, referenceId, "read");
    const accessContext = this.#issuedGrantContext(context, grant);
    return this.download({
      context: accessContext,
      namespaceKey: grant.namespaceKey,
      objectId: grant.objectId,
      version: grant.objectVersion,
      range,
    });
  }

  async downloadStreamByReferenceId({ context, referenceId }) {
    const grant = await this.#issuedGrant(context, referenceId, "read");
    return this.downloadStream({
      context: this.#issuedGrantContext(context, grant),
      namespaceKey: grant.namespaceKey,
      objectId: grant.objectId,
      version: grant.objectVersion,
    });
  }

  async #issuedGrant(context, referenceId, operation) {
    if (typeof referenceId !== "string" || !/^[0-9a-f-]{36}$/i.test(referenceId)) {
      throw new PlatformError("invalid_reference", "Object reference is invalid", { status: 400 });
    }
    const grant = await this.#grantRepository.find(referenceId);
    if (!grant || grant.revokedAt || new Date(grant.expiresAt) <= this.#clock()) {
      throw new PlatformError("invalid_reference", "Object reference is invalid or expired", { status: 404 });
    }
    const delegatedRead = new Set(["team-drive.preview", "team-drive.download", "messaging.download"]).has(grant.audience)
      && grant.issuedByIdentityId === context?.identityId;
    if (!delegatedRead) await this.#authorize(context, grant.namespaceKey, operation);
    return grant;
  }

  #issuedGrantContext(context, grant) {
    if (!new Set(["team-drive.preview", "team-drive.download", "messaging.download"]).has(grant.audience)
      || grant.issuedByIdentityId !== context?.identityId) return context;
    const delegated = { identityId: `reference:${grant.referenceId}`, identityKind: "reference_grant", namespaceKey: grant.namespaceKey };
    this.#authorizedGrantContexts.add(delegated);
    return delegated;
  }

  async headWithScopedReference({ token, audience }) {
    const grant = await this.authorizeScopedReference({ token, audience, operation: "head" });
    const grantContext = {
      identityId: `reference:${grant.referenceId}`,
      identityKind: "reference_grant",
      namespaceKey: grant.namespaceKey,
    };
    this.#authorizedGrantContexts.add(grantContext);
    return this.head({
      context: grantContext,
      namespaceKey: grant.namespaceKey,
      objectId: grant.objectId,
      version: grant.objectVersion,
    });
  }

  async downloadWithScopedReference({ token, audience, range }) {
    const grant = await this.authorizeScopedReference({
      token,
      audience,
      operation: range ? "range" : "read",
    });
    const grantContext = {
      identityId: `reference:${grant.referenceId}`,
      identityKind: "reference_grant",
      namespaceKey: grant.namespaceKey,
    };
    this.#authorizedGrantContexts.add(grantContext);
    return this.download({
      context: grantContext,
      namespaceKey: grant.namespaceKey,
      objectId: grant.objectId,
      version: grant.objectVersion,
      range,
    });
  }
}

export const objectServicePolicyDefaults = DEFAULT_POLICY;
