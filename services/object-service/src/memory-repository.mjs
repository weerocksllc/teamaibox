import { randomUUID } from "node:crypto";

function copy(value) {
  return value === null ? null : structuredClone(value);
}

function namespaceState(limitBytes) {
  return {
    limitBytes,
    committedBytes: 0,
    reservedBytes: 0,
    objectsById: new Map(),
    objectIdByKey: new Map(),
  };
}

export class ObjectRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ObjectRepositoryError";
    this.code = code;
  }
}

export class MemoryObjectRepository {
  #defaultQuotaBytes;
  #namespaces = new Map();
  #uploads = new Map();
  #blobClaims = new Map();

  constructor({ defaultQuotaBytes = 1024 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(defaultQuotaBytes) || defaultQuotaBytes < 1) {
      throw new TypeError("default object quota is invalid");
    }
    this.#defaultQuotaBytes = defaultQuotaBytes;
  }

  #namespace(namespaceKey) {
    if (!this.#namespaces.has(namespaceKey)) {
      this.#namespaces.set(namespaceKey, namespaceState(this.#defaultQuotaBytes));
    }
    return this.#namespaces.get(namespaceKey);
  }

  setQuota(namespaceKey, limitBytes) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new TypeError("object quota is invalid");
    const state = this.#namespace(namespaceKey);
    if (state.committedBytes + state.reservedBytes > limitBytes) {
      throw new ObjectRepositoryError("quota_below_usage", "Quota is below current usage");
    }
    state.limitBytes = limitBytes;
  }

  async quota(namespaceKey) {
    const state = this.#namespace(namespaceKey);
    return Object.freeze({
      namespaceKey,
      limitBytes: state.limitBytes,
      committedBytes: state.committedBytes,
      reservedBytes: state.reservedBytes,
      availableBytes: state.limitBytes - state.committedBytes - state.reservedBytes,
    });
  }

  async stageBlob(record) {
    if (this.#blobClaims.has(record.blobKey)) {
      throw new ObjectRepositoryError("blob_claim_exists", "Blob claim already exists");
    }
    const claim = {
      blobKey: record.blobKey,
      namespaceKey: record.namespaceKey,
      claimKind: record.claimKind,
      ownerUploadId: record.ownerUploadId ?? null,
      size: record.size,
      sha256: record.sha256,
      state: "staged",
      verifiedAt: null,
      createdAt: new Date(record.createdAt),
      expiresAt: new Date(record.expiresAt),
      reclaimAfter: null,
      objectId: null,
      objectVersion: null,
    };
    this.#blobClaims.set(claim.blobKey, claim);
    return copy(claim);
  }

  async verifyBlob(blobKey, { size, sha256, verifiedAt }) {
    const claim = this.#blobClaims.get(blobKey);
    if (!claim || claim.state !== "staged") {
      throw new ObjectRepositoryError("blob_claim_not_found", "Staged blob claim was not found");
    }
    if (claim.size !== size || claim.sha256 !== sha256) {
      throw new ObjectRepositoryError("blob_verification_mismatch", "Blob verification does not match claim");
    }
    claim.verifiedAt = new Date(verifiedAt);
    return copy(claim);
  }

  #verifiedClaim(record) {
    const claim = this.#blobClaims.get(record.blobKey);
    if (!claim || claim.state !== "staged" || !claim.verifiedAt
      || claim.namespaceKey !== record.namespaceKey
      || claim.size !== record.size || claim.sha256 !== record.sha256) {
      throw new ObjectRepositoryError(
        "unverified_blob",
        "Only a verified staged blob can become an object version",
      );
    }
    return claim;
  }

  #commitClaim(claim, committed) {
    claim.state = "committed";
    claim.objectId = committed.object.id;
    claim.objectVersion = committed.version.version;
    claim.expiresAt = null;
    claim.reclaimAfter = null;
  }

  async markBlobReclaimable(blobKey, { reclaimAfter = new Date() } = {}) {
    const claim = this.#blobClaims.get(blobKey);
    if (!claim) return null;
    if (claim.state === "committed") {
      throw new ObjectRepositoryError("blob_still_referenced", "Committed blob is still referenced");
    }
    claim.state = "reclaimable";
    claim.reclaimAfter = new Date(reclaimAfter);
    return copy(claim);
  }

  async markBlobReclaimed(blobKey) {
    const claim = this.#blobClaims.get(blobKey);
    if (!claim) return false;
    if (claim.state === "committed") {
      throw new ObjectRepositoryError("blob_still_referenced", "Committed blob is still referenced");
    }
    this.#blobClaims.delete(blobKey);
    return true;
  }

  async blobClaim(blobKey) {
    return copy(this.#blobClaims.get(blobKey) ?? null);
  }

  async isBlobKnown(blobKey) {
    return this.#blobClaims.has(blobKey);
  }

  async blobReclamationCandidates(now, limit = 100) {
    return [...this.#blobClaims.values()]
      .filter((claim) => (claim.state === "reclaimable" && claim.reclaimAfter <= now)
        || (claim.state === "staged" && claim.expiresAt <= now))
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit)
      .map(copy);
  }

  #requireCapacity(state, bytes) {
    if (state.committedBytes + state.reservedBytes + bytes > state.limitBytes) {
      throw new ObjectRepositoryError("quota_exceeded", "Object quota exceeded");
    }
  }

  async createUpload(upload) {
    const state = this.#namespace(upload.namespaceKey);
    this.#requireCapacity(state, upload.expectedSize);
    state.reservedBytes += upload.expectedSize;
    const value = {
      ...copy(upload),
      id: upload.id ?? randomUUID(),
      parts: new Map(),
    };
    this.#uploads.set(value.id, value);
    return copy({ ...value, parts: [] });
  }

  async findUpload(uploadId) {
    const upload = this.#uploads.get(uploadId);
    return copy(upload ? { ...upload, parts: [...upload.parts.values()] } : null);
  }

  async upsertPart(uploadId, part) {
    const upload = this.#uploads.get(uploadId);
    if (!upload) throw new ObjectRepositoryError("upload_not_found", "Multipart upload not found");
    const claim = this.#verifiedClaim({ ...part, namespaceKey: upload.namespaceKey });
    if (claim.ownerUploadId !== uploadId || claim.claimKind !== "multipart_part") {
      throw new ObjectRepositoryError("invalid_blob_claim", "Multipart blob claim owner is invalid");
    }
    const replaced = upload.parts.get(part.partNumber) ?? null;
    upload.parts.set(part.partNumber, copy(part));
    claim.state = "multipart_part";
    claim.expiresAt = null;
    if (replaced) {
      const replacedClaim = this.#blobClaims.get(replaced.blobKey);
      if (replacedClaim && replacedClaim.state !== "committed") {
        replacedClaim.state = "reclaimable";
        replacedClaim.reclaimAfter = new Date(part.createdAt);
      }
    }
    return copy({ part, replaced });
  }

  async abortUpload(uploadId, { reclaimAfter = new Date() } = {}) {
    const upload = this.#uploads.get(uploadId);
    if (!upload) return null;
    this.#uploads.delete(uploadId);
    const state = this.#namespace(upload.namespaceKey);
    state.reservedBytes -= upload.expectedSize;
    for (const part of upload.parts.values()) {
      const claim = this.#blobClaims.get(part.blobKey);
      if (claim && claim.state !== "committed") {
        claim.state = "reclaimable";
        claim.reclaimAfter = new Date(reclaimAfter);
      }
    }
    return copy({ ...upload, parts: [...upload.parts.values()] });
  }

  #commitVersion(state, record) {
    let object = state.objectsById.get(record.objectId ?? state.objectIdByKey.get(record.objectKey));
    if (!object) {
      object = {
        id: record.objectId ?? randomUUID(),
        namespaceKey: record.namespaceKey,
        objectKey: record.objectKey,
        versions: [],
        deletedAt: null,
        purgeAfter: null,
        createdAt: new Date(record.createdAt),
      };
      state.objectsById.set(object.id, object);
      state.objectIdByKey.set(object.objectKey, object.id);
    }
    const version = {
      objectId: object.id,
      version: object.versions.length + 1,
      blobKey: record.blobKey,
      size: record.size,
      sha256: record.sha256,
      contentType: record.contentType,
      createdAt: new Date(record.createdAt),
      createdByIdentityId: record.createdByIdentityId,
    };
    object.versions.push(version);
    object.deletedAt = null;
    object.purgeAfter = null;
    state.committedBytes += version.size;
    return copy({ object, version });
  }

  async commitOneShot(record) {
    const state = this.#namespace(record.namespaceKey);
    this.#requireCapacity(state, record.size);
    const claim = this.#verifiedClaim(record);
    const committed = this.#commitVersion(state, record);
    this.#commitClaim(claim, committed);
    return committed;
  }

  async commitUpload(uploadId, record) {
    const upload = this.#uploads.get(uploadId);
    if (!upload) throw new ObjectRepositoryError("upload_not_found", "Multipart upload not found");
    const state = this.#namespace(upload.namespaceKey);
    if (record.size > upload.expectedSize) {
      this.#requireCapacity(state, record.size - upload.expectedSize);
    }
    const claim = this.#verifiedClaim(record);
    if (claim.claimKind !== "object_candidate" || claim.ownerUploadId !== uploadId) {
      throw new ObjectRepositoryError("invalid_blob_claim", "Completed upload blob claim is invalid");
    }
    const committed = this.#commitVersion(state, record);
    this.#commitClaim(claim, committed);
    this.#uploads.delete(uploadId);
    state.reservedBytes -= upload.expectedSize;
    for (const part of upload.parts.values()) {
      const partClaim = this.#blobClaims.get(part.blobKey);
      if (partClaim && partClaim.state !== "committed") {
        partClaim.state = "reclaimable";
        partClaim.reclaimAfter = new Date(record.createdAt);
      }
    }
    return committed;
  }

  async findObject(namespaceKey, objectId) {
    return copy(this.#namespace(namespaceKey).objectsById.get(objectId) ?? null);
  }

  async findObjectById(objectId) {
    for (const state of this.#namespaces.values()) {
      const object = state.objectsById.get(objectId);
      if (object) return copy(object);
    }
    return null;
  }

  async findObjectByKey(namespaceKey, objectKey) {
    const state = this.#namespace(namespaceKey);
    const id = state.objectIdByKey.get(objectKey);
    return copy(id ? state.objectsById.get(id) : null);
  }

  async listObjects(namespaceKey, { prefix = "", after = "", limit = 101 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001) throw new TypeError("Object page limit is invalid");
    return [...this.#namespace(namespaceKey).objectsById.values()]
      .filter((object) => !object.deletedAt && object.objectKey.startsWith(prefix) && object.objectKey.localeCompare(after) > 0)
      .sort((left, right) => left.objectKey.localeCompare(right.objectKey))
      .slice(0, limit)
      .map((object) => copy({ ...object, versions: object.versions.slice(-1) }));
  }

  async deleteObject(namespaceKey, objectId, { deletedAt, purgeAfter }) {
    const object = this.#namespace(namespaceKey).objectsById.get(objectId);
    if (!object || object.deletedAt) return null;
    object.deletedAt = new Date(deletedAt);
    object.purgeAfter = new Date(purgeAfter);
    return copy(object);
  }

  async lifecycleCandidates(now, limit) {
    const expiredUploads = [...this.#uploads.values()]
      .filter((upload) => upload.expiresAt <= now)
      .slice(0, limit)
      .map((upload) => copy({ ...upload, parts: [...upload.parts.values()] }));
    const remaining = Math.max(0, limit - expiredUploads.length);
    const deletedObjects = [];
    if (remaining > 0) {
      for (const state of this.#namespaces.values()) {
        for (const object of state.objectsById.values()) {
          if (object.deletedAt && object.purgeAfter <= now) deletedObjects.push(copy(object));
          if (deletedObjects.length >= remaining) break;
        }
        if (deletedObjects.length >= remaining) break;
      }
    }
    return { expiredUploads, deletedObjects };
  }

  async purgeDeletedObject(namespaceKey, objectId, { reclaimAfter = new Date() } = {}) {
    const state = this.#namespace(namespaceKey);
    const object = state.objectsById.get(objectId);
    if (!object || !object.deletedAt) return null;
    state.objectsById.delete(objectId);
    state.objectIdByKey.delete(object.objectKey);
    state.committedBytes -= object.versions.reduce((sum, version) => sum + version.size, 0);
    for (const version of object.versions) {
      const claim = this.#blobClaims.get(version.blobKey);
      if (claim) {
        claim.state = "reclaimable";
        claim.reclaimAfter = new Date(reclaimAfter);
        claim.objectId = null;
        claim.objectVersion = null;
      }
    }
    return copy(object);
  }
}
