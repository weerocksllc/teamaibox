function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}
function digestBytes(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("SHA-256 value is invalid");
  return Buffer.from(value.slice(7), "hex");
}
function digest(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("PostgreSQL SHA-256 value is invalid");
  return `sha256:${Buffer.from(value).toString("hex")}`;
}
function json(value) { return value === null ? null : (typeof value === "string" ? JSON.parse(value) : structuredClone(value)); }
function timestamp(value) { return new Date(value).toISOString(); }
function mappedImport(row) {
  if (!row) return null;
  return {
    importId: row.id, accountKey: row.account_key, candidateId: row.candidate_key,
    sourceKind: row.source_kind, artifactName: row.artifact_name,
    digest: digest(row.artifact_sha256), sizeBytes: Number(row.size_bytes),
    mediaType: row.media_type, chunkSizeBytes: Number(row.chunk_size_bytes),
    sourceUri: row.source_uri, sourceRevision: row.source_revision,
    signature: json(row.signature), bundleSignatureVerified: row.bundle_signature_verified,
    state: row.state, receivedBytes: Number(row.received_bytes),
    nextOrdinal: Number(row.next_ordinal),
    etag: row.source_etag, lastModified: row.source_last_modified,
    deduplicated: row.deduplicated, errorCode: row.error_code,
    requestedBy: row.requested_by, operationKey: row.operation_key,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}
function mappedArtifact(row) {
  if (!row) return null;
  return {
    digest: digest(row.artifact_sha256), candidateId: row.candidate_key,
    artifactName: row.artifact_name, sizeBytes: Number(row.size_bytes),
    mediaType: row.media_type, sourceUri: row.source_uri,
    sourceRevision: row.source_revision, signatureVerified: row.signature_verified,
    chunkCount: Number(row.chunk_count), state: row.state, pinned: row.pinned,
    leaseCount: Number(row.lease_count), createdAt: timestamp(row.created_at),
    lastAccessedAt: timestamp(row.last_accessed_at),
  };
}
function mappedChunk(row) {
  return {
    ordinal: Number(row.ordinal), offset: Number(row.byte_offset),
    digest: digest(row.chunk_sha256), sizeBytes: Number(row.size_bytes), blobKey: row.blob_key,
  };
}
function repositoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class PostgresModelArtifactRepository {
  #database;
  #accountKey;
  #quotaBytes;

  constructor({ database, accountKey = "model-cache", quotaBytes }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL transactional adapter is required");
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new TypeError("model cache quota must be positive");
    this.#database = database;
    this.#accountKey = accountKey;
    this.#quotaBytes = quotaBytes;
  }

  async beginImport(input) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.operationKey]);
      const previous = mappedImport(rows(await transaction.query(`
        SELECT * FROM compute.model_artifact_imports
        WHERE operation_key = $1 FOR UPDATE`, [input.operationKey]))[0]);
      if (previous) {
        if (previous.candidateId !== input.candidateId || previous.digest !== input.digest
          || previous.sourceKind !== input.sourceKind || previous.artifactName !== input.artifactName
          || previous.sizeBytes !== input.sizeBytes || previous.sourceUri !== input.sourceUri) {
          throw repositoryError("model_import_conflict", "operation key was already used for another model import");
        }
        return { import: previous, created: false };
      }
      await transaction.query(`
        INSERT INTO compute.model_cache_accounts (account_key, quota_bytes)
        VALUES ($1,$2) ON CONFLICT (account_key) DO NOTHING`, [this.#accountKey, this.#quotaBytes]);
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.digest]);
      const ready = mappedArtifact(rows(await transaction.query(`
        SELECT * FROM compute.model_artifacts
        WHERE artifact_sha256 = $1 AND state = 'ready' AND size_bytes = $2
        FOR SHARE`, [digestBytes(input.digest), input.sizeBytes]))[0]);
      let inserted;
      const common = [
        this.#accountKey, input.candidateId, input.sourceKind, input.artifactName,
        digestBytes(input.digest), input.sizeBytes, input.mediaType, input.chunkSizeBytes,
        input.sourceUri, input.sourceRevision, input.signature ? JSON.stringify(input.signature) : null,
        Boolean(input.bundleSignatureVerified), input.requestedBy, input.operationKey,
      ];
      if (ready) {
        inserted = rows(await transaction.query(`
          INSERT INTO compute.model_artifact_imports (
            account_key,candidate_key,source_kind,artifact_name,artifact_sha256,
            size_bytes,media_type,chunk_size_bytes,source_uri,source_revision,
            signature,bundle_signature_verified,requested_by,operation_key,
            state,received_bytes,next_ordinal,deduplicated
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,
                    'ready',$6,$15,true)
          RETURNING *`, [...common, ready.chunkCount]))[0];
        await transaction.query(`
          UPDATE compute.model_artifacts SET last_accessed_at = clock_timestamp()
          WHERE artifact_sha256 = $1`, [digestBytes(input.digest)]);
      } else {
        inserted = rows(await transaction.query(`
          INSERT INTO compute.model_artifact_imports (
            account_key,candidate_key,source_kind,artifact_name,artifact_sha256,
            size_bytes,media_type,chunk_size_bytes,source_uri,source_revision,
            signature,bundle_signature_verified,requested_by,operation_key
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
          RETURNING *`, common))[0];
      }
      return { import: mappedImport(inserted), created: true };
    });
  }

  async getImport(importId) {
    return mappedImport(rows(await this.#database.query(`
      SELECT * FROM compute.model_artifact_imports WHERE id = $1`, [importId]))[0]);
  }

  async nextChunk(importId) {
    const record = await this.getImport(importId);
    if (!record) throw repositoryError("model_import_not_found", "model import was not found");
    if (record.state !== "active" || record.receivedBytes === record.sizeBytes) return null;
    return {
      ordinal: record.nextOrdinal, offset: record.receivedBytes,
      sizeBytes: Math.min(record.chunkSizeBytes, record.sizeBytes - record.receivedBytes),
    };
  }

  async recordChunk({ importId, ordinal, offset, digest: chunkDigest, sizeBytes, blobKey, etag, lastModified }) {
    try { return await this.#database.transaction(async (transaction) => {
      const called = rows(await transaction.query(`
        SELECT compute.record_model_import_chunk($1,$2,$3,$4,$5,$6,$7,$8) AS chunk_created`, [
        importId, ordinal, offset, digestBytes(chunkDigest), sizeBytes, blobKey, etag, lastModified,
      ]))[0];
      const record = mappedImport(rows(await transaction.query(`
        SELECT * FROM compute.model_artifact_imports WHERE id = $1`, [importId]))[0]);
      return { import: record, chunkCreated: called.chunk_created };
    }); } catch (error) {
      if (error?.code === '53100') throw repositoryError('model_cache_quota_exceeded', 'actual model cache writes reached the configured storage limit');
      throw error;
    }
  }

  async listImportChunks(importId) {
    return rows(await this.#database.query(`
      SELECT mapping.ordinal, mapping.byte_offset, mapping.size_bytes,
             mapping.chunk_sha256, chunk.blob_key
      FROM compute.model_artifact_import_chunks mapping
      JOIN compute.model_cache_chunks chunk USING (chunk_sha256)
      WHERE mapping.import_id = $1 ORDER BY mapping.ordinal`, [importId])).map(mappedChunk);
  }

  async finalizeImport(importId) {
    return this.#database.transaction(async (transaction) => {
      const before = mappedImport(rows(await transaction.query(`
        SELECT * FROM compute.model_artifact_imports WHERE id = $1 FOR UPDATE`, [importId]))[0]);
      if (!before) throw repositoryError("model_import_not_found", "model import was not found");
      if (before.state === "ready") {
        const artifact = mappedArtifact(rows(await transaction.query(`
          SELECT * FROM compute.model_artifacts WHERE artifact_sha256 = $1`, [digestBytes(before.digest)]))[0]);
        return { import: before, artifact, created: false };
      }
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [before.digest]);
      const finalized = rows(await transaction.query(`
        SELECT compute.finalize_model_artifact_import($1) AS created`, [importId]))[0];
      const record = mappedImport(rows(await transaction.query(`
        SELECT * FROM compute.model_artifact_imports WHERE id = $1`, [importId]))[0]);
      const artifact = mappedArtifact(rows(await transaction.query(`
        SELECT * FROM compute.model_artifacts WHERE artifact_sha256 = $1`, [digestBytes(before.digest)]))[0]);
      return { import: record, artifact, created: finalized.created };
    });
  }

  async failImport(importId, errorCode) {
    return this.#database.transaction(async (transaction) => {
      const deleted = rows(await transaction.query(`
        SELECT * FROM compute.fail_model_artifact_import($1,$2)`, [importId, errorCode]));
      const record = mappedImport(rows(await transaction.query(`
        SELECT * FROM compute.model_artifact_imports WHERE id = $1`, [importId]))[0]);
      return {
        import: record,
        deleteChunks: deleted.map((row) => ({ digest: digest(row.chunk_sha256), blobKey: row.blob_key })),
      };
    });
  }

  async getArtifact(artifactDigest, { touch = true } = {}) {
    const statement = touch ? `
      UPDATE compute.model_artifacts SET last_accessed_at = clock_timestamp()
      WHERE artifact_sha256 = $1 AND state = 'ready' RETURNING *` : `
      SELECT * FROM compute.model_artifacts
      WHERE artifact_sha256 = $1 AND state = 'ready'`;
    return mappedArtifact(rows(await this.#database.query(statement, [digestBytes(artifactDigest)]))[0]);
  }

  async setPinned(artifactDigest, pinned) {
    const artifact = mappedArtifact(rows(await this.#database.query(`
      UPDATE compute.model_artifacts SET pinned = $2
      WHERE artifact_sha256 = $1 AND state = 'ready' RETURNING *`, [digestBytes(artifactDigest), pinned]))[0]);
    if (!artifact) throw repositoryError("model_artifact_not_found", "ready model artifact was not found");
    return artifact;
  }

  async changeLease(artifactDigest, delta) {
    if (![-1, 1].includes(delta)) throw repositoryError("model_artifact_lease_invalid", "model artifact lease transition is invalid");
    const artifact = mappedArtifact(rows(await this.#database.query(`
      UPDATE compute.model_artifacts
      SET lease_count = lease_count + $2, last_accessed_at = clock_timestamp()
      WHERE artifact_sha256 = $1 AND state = 'ready' AND lease_count + $2 >= 0
      RETURNING *`, [digestBytes(artifactDigest), delta]))[0]);
    if (!artifact) throw repositoryError("model_artifact_lease_invalid", "model artifact lease transition is invalid");
    return artifact;
  }

  async evictLeastRecentlyUsed({ bytesRequired }) {
    return this.#database.transaction(async (transaction) => {
      const candidates = rows(await transaction.query(`
        SELECT artifact_sha256 FROM compute.model_artifacts
        WHERE state = 'ready' AND NOT pinned AND lease_count = 0
        ORDER BY last_accessed_at, artifact_sha256
        FOR UPDATE SKIP LOCKED LIMIT 1000`, []));
      const evicted = [];
      const deleteChunks = [];
      let reclaimedBytes = 0;
      for (const candidate of candidates) {
        if (reclaimedBytes >= bytesRequired) break;
        await transaction.query(`
          UPDATE compute.model_artifacts SET state = 'evicted'
          WHERE artifact_sha256 = $1`, [candidate.artifact_sha256]);
        await transaction.query(`
          DELETE FROM compute.model_artifact_chunk_map
          WHERE artifact_sha256 = $1`, [candidate.artifact_sha256]);
        const deleted = rows(await transaction.query(`
          DELETE FROM compute.model_cache_chunks chunk
          WHERE NOT EXISTS (
              SELECT 1 FROM compute.model_artifact_chunk_map artifact_ref
              WHERE artifact_ref.chunk_sha256 = chunk.chunk_sha256
          ) AND NOT EXISTS (
              SELECT 1 FROM compute.model_artifact_import_chunks import_ref
              WHERE import_ref.chunk_sha256 = chunk.chunk_sha256
          ) RETURNING chunk_sha256, blob_key, size_bytes`, []));
        evicted.push(digest(candidate.artifact_sha256));
        for (const item of deleted) {
          reclaimedBytes += Number(item.size_bytes);
          deleteChunks.push({ digest: digest(item.chunk_sha256), blobKey: item.blob_key });
        }
      }
      if (reclaimedBytes > 0) await transaction.query(`
        UPDATE compute.model_cache_accounts
        SET committed_bytes = committed_bytes - $2, updated_at = clock_timestamp()
        WHERE account_key = $1`, [this.#accountKey, reclaimedBytes]);
      return { evicted, reclaimedBytes, deleteChunks };
    });
  }

  async usage() {
    const row = rows(await this.#database.query(`
      SELECT account.quota_bytes, account.committed_bytes,
             account.quota_bytes - account.committed_bytes AS available_bytes,
             (SELECT count(*) FROM compute.model_artifacts WHERE state = 'ready') AS ready_artifacts,
             (SELECT count(*) FROM compute.model_cache_chunks) AS chunks
      FROM compute.model_cache_accounts account WHERE account.account_key = $1`, [this.#accountKey]))[0];
    if (!row) return { quotaBytes: this.#quotaBytes, committedBytes: 0, availableBytes: this.#quotaBytes, readyArtifacts: 0, chunks: 0 };
    return {
      quotaBytes: Number(row.quota_bytes), committedBytes: Number(row.committed_bytes),
      availableBytes: Number(row.available_bytes),
      readyArtifacts: Number(row.ready_artifacts), chunks: Number(row.chunks),
    };
  }
}
