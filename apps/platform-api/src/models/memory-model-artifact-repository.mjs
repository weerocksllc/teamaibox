import { randomUUID } from "node:crypto";

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function publicImport(record) {
  return copy(record);
}

/**
 * Deterministic in-memory implementation of the model cache metadata plane.
 * The same invariants are independently enforced by migration 20 in PostgreSQL.
 */
export class MemoryModelArtifactRepository {
  #quotaBytes;
  #committedBytes = 0;
  #imports = new Map();
  #operations = new Map();
  #importChunks = new Map();
  #chunks = new Map();
  #artifacts = new Map();
  #clock;
  #idFactory;

  constructor({ quotaBytes, clock = () => new Date(), idFactory = randomUUID }) {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new TypeError("model cache quota must be positive");
    this.#quotaBytes = quotaBytes;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  #now() { return this.#clock().toISOString(); }

  async beginImport(input) {
    const previousId = this.#operations.get(input.operationKey);
    if (previousId) {
      const previous = this.#imports.get(previousId);
      if (previous.candidateId !== input.candidateId || previous.digest !== input.digest
        || previous.sourceKind !== input.sourceKind || previous.artifactName !== input.artifactName
        || previous.sizeBytes !== input.sizeBytes || previous.sourceUri !== input.sourceUri) {
        conflict("model_import_conflict", "operation key was already used for another model import");
      }
      return { import: publicImport(previous), created: false };
    }
    const ready = this.#artifacts.get(input.digest);
    if (ready?.state === "ready") {
      if (ready.sizeBytes !== input.sizeBytes) conflict("model_artifact_conflict", "model artifact digest has inconsistent size metadata");
      const now = this.#now();
      ready.lastAccessedAt = now;
      const record = {
        ...copy(input), importId: this.#idFactory(), state: "ready", receivedBytes: input.sizeBytes,
        nextOrdinal: ready.chunkCount, deduplicated: true,
        etag: null, lastModified: null, errorCode: null, createdAt: now, updatedAt: now,
      };
      this.#imports.set(record.importId, record);
      this.#operations.set(input.operationKey, record.importId);
      this.#importChunks.set(record.importId, new Map());
      return { import: publicImport(record), created: true };
    }
    const now = this.#now();
    const record = {
      ...copy(input), importId: this.#idFactory(), state: "active", receivedBytes: 0,
      nextOrdinal: 0, deduplicated: false,
      etag: null, lastModified: null, errorCode: null, createdAt: now, updatedAt: now,
    };
    this.#imports.set(record.importId, record);
    this.#operations.set(input.operationKey, record.importId);
    this.#importChunks.set(record.importId, new Map());
    return { import: publicImport(record), created: true };
  }

  async getImport(importId) {
    return publicImport(this.#imports.get(importId) ?? null);
  }

  async nextChunk(importId) {
    const record = this.#imports.get(importId);
    if (!record) conflict("model_import_not_found", "model import was not found");
    if (record.state !== "active" || record.receivedBytes === record.sizeBytes) return null;
    return {
      ordinal: record.nextOrdinal,
      offset: record.receivedBytes,
      sizeBytes: Math.min(record.chunkSizeBytes, record.sizeBytes - record.receivedBytes),
    };
  }

  async recordChunk({ importId, ordinal, offset, digest, sizeBytes, blobKey, etag, lastModified }) {
    const record = this.#imports.get(importId);
    if (!record) conflict("model_import_not_found", "model import was not found");
    if (record.state !== "active") conflict("model_import_not_active", "model import is not active");
    if (ordinal !== record.nextOrdinal || offset !== record.receivedBytes
      || sizeBytes !== Math.min(record.chunkSizeBytes, record.sizeBytes - record.receivedBytes)) {
      conflict("model_import_sequence_conflict", "model chunk is not the next exact range");
    }
    if (record.etag && etag !== record.etag) conflict("model_source_changed", "model source ETag changed during resume");
    if (record.lastModified && lastModified !== record.lastModified) conflict("model_source_changed", "model source modification time changed during resume");
    if (!record.etag && !record.lastModified && !etag && !lastModified && record.sizeBytes > record.chunkSizeBytes) {
      conflict("model_source_validator_required", "resumable model source must expose ETag or Last-Modified");
    }

    const chunkMap = this.#importChunks.get(importId);
    const existingAtOrdinal = chunkMap.get(ordinal);
    if (existingAtOrdinal) {
      if (existingAtOrdinal.digest !== digest) conflict("model_import_sequence_conflict", "model chunk ordinal changed");
      return { import: publicImport(record), chunkCreated: false };
    }
    let chunk = this.#chunks.get(digest);
    let chunkCreated = false;
    if (chunk) {
      if (chunk.sizeBytes !== sizeBytes || chunk.blobKey !== blobKey) conflict("model_chunk_conflict", "content digest has inconsistent metadata");
    } else {
      if (this.#committedBytes + sizeBytes > this.#quotaBytes) {
        conflict("model_cache_quota_exceeded", "actual model cache writes reached the configured storage limit");
      }
      chunk = { digest, sizeBytes, blobKey, importRefs: new Set(), artifactRefs: new Set(), createdAt: this.#now() };
      this.#chunks.set(digest, chunk);
      this.#committedBytes += sizeBytes;
      chunkCreated = true;
    }
    chunk.importRefs.add(importId);
    chunkMap.set(ordinal, { ordinal, offset, digest, sizeBytes, blobKey });
    record.receivedBytes += sizeBytes;
    record.nextOrdinal += 1;
    if (record.etag === null && etag) record.etag = etag;
    if (record.lastModified === null && lastModified) record.lastModified = lastModified;
    record.updatedAt = this.#now();
    return { import: publicImport(record), chunkCreated };
  }

  async listImportChunks(importId) {
    if (!this.#imports.has(importId)) conflict("model_import_not_found", "model import was not found");
    return [...this.#importChunks.get(importId).values()].sort((a, b) => a.ordinal - b.ordinal).map(copy);
  }

  async finalizeImport(importId) {
    const record = this.#imports.get(importId);
    if (!record) conflict("model_import_not_found", "model import was not found");
    if (record.state === "ready") return { import: publicImport(record), artifact: copy(this.#artifacts.get(record.digest)), created: false };
    if (record.state !== "active" || record.receivedBytes !== record.sizeBytes) {
      conflict("model_import_incomplete", "model import cannot be finalized before every byte is verified");
    }
    const ordered = [...this.#importChunks.get(importId).values()].sort((a, b) => a.ordinal - b.ordinal);
    const now = this.#now();
    let artifact = this.#artifacts.get(record.digest);
    const created = !artifact || artifact.state !== "ready";
    if (!artifact || artifact.state !== "ready") {
      artifact = {
        digest: record.digest, candidateId: record.candidateId, artifactName: record.artifactName,
        sizeBytes: record.sizeBytes, mediaType: record.mediaType, sourceUri: record.sourceUri,
        sourceRevision: record.sourceRevision,
        signatureVerified: Boolean(record.signature || record.bundleSignatureVerified),
        chunkCount: ordered.length, state: "ready", pinned: false, leaseCount: 0,
        createdAt: now, lastAccessedAt: now,
      };
      this.#artifacts.set(record.digest, artifact);
      for (const item of ordered) this.#chunks.get(item.digest).artifactRefs.add(record.digest);
    }
    for (const item of ordered) this.#chunks.get(item.digest).importRefs.delete(importId);
    record.state = "ready";
    record.updatedAt = now;
    return { import: publicImport(record), artifact: copy(artifact), created };
  }

  async failImport(importId, errorCode) {
    const record = this.#imports.get(importId);
    if (!record) conflict("model_import_not_found", "model import was not found");
    if (record.state === "ready") conflict("model_import_not_active", "ready model import cannot be failed");
    if (record.state === "failed") return { import: publicImport(record), deleteChunks: [] };
    record.state = "failed";
    record.errorCode = errorCode;
    record.updatedAt = this.#now();
    const deleteChunks = [];
    for (const item of this.#importChunks.get(importId).values()) {
      const chunk = this.#chunks.get(item.digest);
      chunk?.importRefs.delete(importId);
      if (chunk && chunk.importRefs.size === 0 && chunk.artifactRefs.size === 0) {
        this.#chunks.delete(item.digest);
        this.#committedBytes -= chunk.sizeBytes;
        deleteChunks.push({ digest: chunk.digest, blobKey: chunk.blobKey });
      }
    }
    return { import: publicImport(record), deleteChunks };
  }

  async getArtifact(digest, { touch = true } = {}) {
    const artifact = this.#artifacts.get(digest);
    if (!artifact || artifact.state !== "ready") return null;
    if (touch) artifact.lastAccessedAt = this.#now();
    return copy(artifact);
  }

  async setPinned(digest, pinned) {
    const artifact = this.#artifacts.get(digest);
    if (!artifact || artifact.state !== "ready") conflict("model_artifact_not_found", "ready model artifact was not found");
    artifact.pinned = Boolean(pinned);
    return copy(artifact);
  }

  async changeLease(digest, delta) {
    const artifact = this.#artifacts.get(digest);
    if (!artifact || artifact.state !== "ready") conflict("model_artifact_not_found", "ready model artifact was not found");
    if (!Number.isSafeInteger(delta) || ![-1, 1].includes(delta) || artifact.leaseCount + delta < 0) {
      conflict("model_artifact_lease_invalid", "model artifact lease transition is invalid");
    }
    artifact.leaseCount += delta;
    artifact.lastAccessedAt = this.#now();
    return copy(artifact);
  }

  async evictLeastRecentlyUsed({ bytesRequired }) {
    if (!Number.isSafeInteger(bytesRequired) || bytesRequired < 1) throw new TypeError("eviction target must be positive");
    const candidates = [...this.#artifacts.values()]
      .filter((artifact) => artifact.state === "ready" && !artifact.pinned && artifact.leaseCount === 0)
      .sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt) || left.digest.localeCompare(right.digest));
    const deleteChunks = [];
    const evicted = [];
    let reclaimedBytes = 0;
    for (const artifact of candidates) {
      if (reclaimedBytes >= bytesRequired) break;
      artifact.state = "evicted";
      evicted.push(artifact.digest);
      const imports = [...this.#imports.values()].filter((item) => item.digest === artifact.digest && item.state === "ready");
      const mappings = imports.flatMap((item) => [...this.#importChunks.get(item.importId).values()]);
      const seen = new Set();
      for (const item of mappings) {
        if (seen.has(item.digest)) continue;
        seen.add(item.digest);
        const chunk = this.#chunks.get(item.digest);
        chunk?.artifactRefs.delete(artifact.digest);
        if (chunk && chunk.importRefs.size === 0 && chunk.artifactRefs.size === 0) {
          this.#chunks.delete(item.digest);
          this.#committedBytes -= chunk.sizeBytes;
          reclaimedBytes += chunk.sizeBytes;
          deleteChunks.push({ digest: chunk.digest, blobKey: chunk.blobKey });
        }
      }
    }
    return { evicted, reclaimedBytes, deleteChunks };
  }

  async usage() {
    return {
      quotaBytes: this.#quotaBytes,
      committedBytes: this.#committedBytes,
      availableBytes: this.#quotaBytes - this.#committedBytes,
      readyArtifacts: [...this.#artifacts.values()].filter(({ state }) => state === "ready").length,
      chunks: this.#chunks.size,
    };
  }
}
