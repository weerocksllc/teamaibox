import { Buffer } from "node:buffer";

import { ObjectRepositoryError } from "./memory-repository.mjs";


function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL object result is invalid");
  return result.rows;
}


function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}


function digest(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new ObjectRepositoryError("object_metadata_corrupt", "Object digest is corrupt");
  }
  return Buffer.from(value).toString("hex");
}


function digestBytes(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("object digest is invalid");
  }
  return Buffer.from(value, "hex");
}


function version(row) {
  return {
    objectId: row.object_id,
    version: Number(row.version),
    blobKey: row.blob_key,
    size: Number(row.size),
    sha256: digest(row.sha256),
    contentType: row.content_type,
    createdAt: date(row.created_at),
    createdByIdentityId: row.created_by_identity_id,
  };
}


function object(row, versions = []) {
  if (!row) return null;
  return {
    id: row.id,
    namespaceKey: row.namespace_key,
    objectKey: row.object_key,
    versions,
    deletedAt: date(row.deleted_at),
    purgeAfter: date(row.purge_after),
    createdAt: date(row.created_at),
  };
}


function part(row) {
  return {
    partNumber: Number(row.part_number),
    blobKey: row.blob_key,
    size: Number(row.size),
    sha256: digest(row.sha256),
    createdAt: date(row.created_at),
  };
}


function upload(row, parts = []) {
  if (!row) return null;
  return {
    id: row.id,
    namespaceKey: row.namespace_key,
    objectKey: row.object_key,
    contentType: row.content_type,
    expectedSize: Number(row.expected_size),
    expectedSha256: digest(row.expected_sha256),
    createdByIdentityId: row.created_by_identity_id,
    createdAt: date(row.created_at),
    expiresAt: date(row.expires_at),
    parts,
  };
}


function claim(row) {
  if (!row) return null;
  return {
    blobKey: row.blob_key,
    namespaceKey: row.namespace_key,
    claimKind: row.claim_kind,
    state: row.claim_state,
    ownerUploadId: row.owner_upload_id,
    size: Number(row.expected_size),
    sha256: digest(row.expected_sha256),
    verifiedAt: date(row.verified_at),
    expiresAt: date(row.expires_at),
    reclaimAfter: date(row.reclaim_after),
    objectId: row.committed_object_id,
    objectVersion: row.committed_object_version === null ? null : Number(row.committed_object_version),
    createdAt: date(row.created_at),
  };
}


async function loadObject(executor, row) {
  if (!row) return null;
  const versions = rows(await executor.query(
    "SELECT * FROM objects.object_versions WHERE object_id=$1 ORDER BY version",
    [row.id],
  )).map(version);
  return object(row, versions);
}


async function loadUpload(executor, row) {
  if (!row) return null;
  const parts = rows(await executor.query(
    "SELECT * FROM objects.multipart_parts WHERE upload_id=$1 ORDER BY part_number",
    [row.id],
  )).map(part);
  return upload(row, parts);
}


function repositoryError(error) {
  if (error instanceof ObjectRepositoryError) return error;
  if (error?.code === "23505") return new ObjectRepositoryError("conflict", "Object metadata already exists");
  if (error?.code === "23514") return new ObjectRepositoryError("quota_exceeded", "Object quota exceeded or metadata boundary failed");
  return error;
}


export class PostgresObjectRepository {
  #database;
  #defaultQuotaBytes;

  constructor({ database, defaultQuotaBytes = 1024 * 1024 * 1024 * 1024 }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL object repository requires query and transactions");
    }
    if (!Number.isSafeInteger(defaultQuotaBytes) || defaultQuotaBytes < 1) {
      throw new TypeError("default object quota is invalid");
    }
    this.#database = database;
    this.#defaultQuotaBytes = defaultQuotaBytes;
  }

  readonlyReclamationOrder = "claim-first";

  async #ensureNamespace(executor, namespaceKey) {
    await executor.query(`
      INSERT INTO objects.namespaces (namespace_key,quota_bytes)
      VALUES ($1,$2) ON CONFLICT (namespace_key) DO NOTHING`, [namespaceKey, this.#defaultQuotaBytes]);
  }

  async ensureNamespaceAccess({ namespaceKey, identityId, operations }) {
    return this.#database.transaction(async (transaction) => {
      await this.#ensureNamespace(transaction, namespaceKey);
      await transaction.query(`
        INSERT INTO objects.namespace_bindings (
          namespace_key,identity_id,operations,granted_by_identity_id,created_at,expires_at,revoked_at,revoke_reason
        ) VALUES ($1,$2,$3::jsonb,$2,clock_timestamp(),NULL,NULL,NULL)
        ON CONFLICT (namespace_key,identity_id) DO UPDATE
        SET operations=EXCLUDED.operations,granted_by_identity_id=EXCLUDED.granted_by_identity_id,
            created_at=EXCLUDED.created_at,expires_at=NULL,revoked_at=NULL,revoke_reason=NULL`,
      [namespaceKey, identityId, JSON.stringify([...new Set(operations)].sort())]);
      return true;
    });
  }

  async setQuota(namespaceKey, limitBytes) {
    try {
      return await this.#database.transaction(async (transaction) => {
        await this.#ensureNamespace(transaction, namespaceKey);
        const value = rows(await transaction.query(`
          UPDATE objects.namespaces SET quota_bytes=$2
          WHERE namespace_key=$1 AND committed_bytes+reserved_bytes<=$2
          RETURNING *`, [namespaceKey, limitBytes]))[0];
        if (!value) throw new ObjectRepositoryError("quota_below_usage", "Quota is below current usage");
        return this.quota(namespaceKey);
      });
    } catch (error) { throw repositoryError(error); }
  }

  async quota(namespaceKey) {
    await this.#ensureNamespace(this.#database, namespaceKey);
    const row = rows(await this.#database.query(
      "SELECT * FROM objects.namespaces WHERE namespace_key=$1",
      [namespaceKey],
    ))[0];
    return {
      namespaceKey,
      limitBytes: Number(row.quota_bytes),
      committedBytes: Number(row.committed_bytes),
      reservedBytes: Number(row.reserved_bytes),
      availableBytes: Number(row.quota_bytes) - Number(row.committed_bytes) - Number(row.reserved_bytes),
    };
  }

  async stageBlob(value) {
    try {
      await this.#ensureNamespace(this.#database, value.namespaceKey);
      const inserted = rows(await this.#database.query(`
        INSERT INTO objects.blob_claims (
          blob_key,namespace_key,claim_kind,claim_state,owner_upload_id,expected_size,expected_sha256,
          verified_at,expires_at,reclaim_after,committed_object_id,committed_object_version,created_at
        ) VALUES ($1,$2,$3,'staged',$4,$5,$6,NULL,$7,NULL,NULL,NULL,$8)
        RETURNING *`, [
        value.blobKey, value.namespaceKey, value.claimKind, value.ownerUploadId,
        value.size, digestBytes(value.sha256), value.expiresAt, value.createdAt,
      ]))[0];
      return claim(inserted);
    } catch (error) { throw repositoryError(error); }
  }

  async verifyBlob(blobKey, { size, sha256, verifiedAt }) {
    const value = rows(await this.#database.query(`
      UPDATE objects.blob_claims SET claim_state='verified',verified_at=$4
      WHERE blob_key=$1 AND claim_state='staged' AND expected_size=$2 AND expected_sha256=$3
      RETURNING *`, [blobKey, size, digestBytes(sha256), verifiedAt]))[0];
    if (!value) throw new ObjectRepositoryError("blob_verification_mismatch", "Blob verification does not match claim");
    return claim(value);
  }

  async markBlobReclaimable(blobKey, { reclaimAfter = new Date() } = {}) {
    const value = rows(await this.#database.query(`
      UPDATE objects.blob_claims
      SET claim_state='reclaimable',owner_upload_id=NULL,reclaim_after=$2,expires_at=NULL,
          committed_object_id=NULL,committed_object_version=NULL
      WHERE blob_key=$1 AND claim_state<>'committed' RETURNING *`, [blobKey, reclaimAfter]))[0];
    return claim(value);
  }

  async markBlobReclaimed(blobKey) {
    const result = await this.#database.query(
      "DELETE FROM objects.blob_claims WHERE blob_key=$1 AND claim_state<>'committed'",
      [blobKey],
    );
    return result.rowCount === 1;
  }

  async blobClaim(blobKey) {
    return claim(rows(await this.#database.query(
      "SELECT * FROM objects.blob_claims WHERE blob_key=$1",
      [blobKey],
    ))[0]);
  }

  async isBlobKnown(blobKey) {
    return Boolean(rows(await this.#database.query(
      "SELECT 1 FROM objects.blob_claims WHERE blob_key=$1",
      [blobKey],
    ))[0]);
  }

  async blobReclamationCandidates(now, limit = 100) {
    return rows(await this.#database.query(`
      SELECT claim.* FROM objects.orphan_blob_candidates($1,$2) candidate
      JOIN objects.blob_claims claim USING (blob_key)
      ORDER BY claim.created_at,claim.blob_key`, [now, limit])).map(claim);
  }

  async createUpload(value) {
    try {
      return await this.#database.transaction(async (transaction) => {
        await this.#ensureNamespace(transaction, value.namespaceKey);
        const capacity = rows(await transaction.query(`
          UPDATE objects.namespaces SET reserved_bytes=reserved_bytes+$2
          WHERE namespace_key=$1 AND committed_bytes+reserved_bytes+$2<=quota_bytes
          RETURNING namespace_key`, [value.namespaceKey, value.expectedSize]))[0];
        if (!capacity) throw new ObjectRepositoryError("quota_exceeded", "Object quota exceeded");
        const inserted = rows(await transaction.query(`
          INSERT INTO objects.multipart_uploads (
            namespace_key,object_key,content_type,expected_size,expected_sha256,
            created_by_identity_id,created_at,expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [
          value.namespaceKey, value.objectKey, value.contentType, value.expectedSize,
          digestBytes(value.expectedSha256), value.createdByIdentityId, value.createdAt, value.expiresAt,
        ]))[0];
        return upload(inserted, []);
      });
    } catch (error) { throw repositoryError(error); }
  }

  async findUpload(uploadId) {
    const row = rows(await this.#database.query(
      "SELECT * FROM objects.multipart_uploads WHERE id=$1",
      [uploadId],
    ))[0];
    return loadUpload(this.#database, row);
  }

  async upsertPart(uploadId, value) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const uploadRow = rows(await transaction.query(
          "SELECT * FROM objects.multipart_uploads WHERE id=$1 FOR UPDATE",
          [uploadId],
        ))[0];
        if (!uploadRow) throw new ObjectRepositoryError("upload_not_found", "Multipart upload not found");
        const replacedRow = rows(await transaction.query(
          "SELECT * FROM objects.multipart_parts WHERE upload_id=$1 AND part_number=$2 FOR UPDATE",
          [uploadId, value.partNumber],
        ))[0];
        if (replacedRow) await transaction.query(
          "DELETE FROM objects.multipart_parts WHERE upload_id=$1 AND part_number=$2",
          [uploadId, value.partNumber],
        );
        const inserted = rows(await transaction.query(`
          INSERT INTO objects.multipart_parts (upload_id,part_number,blob_key,size,sha256,created_at)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
          uploadId, value.partNumber, value.blobKey, value.size, digestBytes(value.sha256), value.createdAt,
        ]))[0];
        return { part: part(inserted), replaced: replacedRow ? part(replacedRow) : null };
      });
    } catch (error) { throw repositoryError(error); }
  }

  async abortUpload(uploadId, { reclaimAfter = new Date() } = {}) {
    return this.#database.transaction(async (transaction) => {
      const row = rows(await transaction.query(
        "SELECT * FROM objects.multipart_uploads WHERE id=$1 FOR UPDATE",
        [uploadId],
      ))[0];
      if (!row) return null;
      const current = await loadUpload(transaction, row);
      await transaction.query(
        "UPDATE objects.blob_claims SET reclaim_after=$2 WHERE owner_upload_id=$1 AND claim_state<>'committed'",
        [uploadId, reclaimAfter],
      );
      await transaction.query("DELETE FROM objects.multipart_uploads WHERE id=$1", [uploadId]);
      await transaction.query(
        "UPDATE objects.namespaces SET reserved_bytes=reserved_bytes-$2 WHERE namespace_key=$1",
        [row.namespace_key, row.expected_size],
      );
      return current;
    });
  }

  async #commit(executor, value) {
    await this.#ensureNamespace(executor, value.namespaceKey);
    const entry = rows(await executor.query(`
      INSERT INTO objects.object_entries (namespace_key,object_key,current_version,created_at)
      VALUES ($1,$2,0,$3) ON CONFLICT (namespace_key,object_key) DO UPDATE SET object_key=EXCLUDED.object_key
      RETURNING *`, [value.namespaceKey, value.objectKey, value.createdAt]))[0];
    const locked = rows(await executor.query(
      "SELECT * FROM objects.object_entries WHERE id=$1 FOR UPDATE",
      [entry.id],
    ))[0];
    const nextVersion = Number(locked.current_version) + 1;
    const inserted = rows(await executor.query(`
      INSERT INTO objects.object_versions (
        object_id,version,blob_key,size,sha256,content_type,created_by_identity_id,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [
      locked.id, nextVersion, value.blobKey, value.size, digestBytes(value.sha256),
      value.contentType, value.createdByIdentityId, value.createdAt,
    ]))[0];
    return { entry: locked, inserted };
  }

  async commitOneShot(value) {
    try {
      return await this.#database.transaction(async (transaction) => {
        await this.#ensureNamespace(transaction, value.namespaceKey);
        const capacity = rows(await transaction.query(`
          UPDATE objects.namespaces SET committed_bytes=committed_bytes+$2
          WHERE namespace_key=$1 AND committed_bytes+reserved_bytes+$2<=quota_bytes
          RETURNING namespace_key`, [value.namespaceKey, value.size]))[0];
        if (!capacity) throw new ObjectRepositoryError("quota_exceeded", "Object quota exceeded");
        const { entry, inserted } = await this.#commit(transaction, value);
        return { object: await loadObject(transaction, { ...entry, current_version: inserted.version }), version: version(inserted) };
      });
    } catch (error) { throw repositoryError(error); }
  }

  async commitUpload(uploadId, value) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const uploadRow = rows(await transaction.query(
          "SELECT * FROM objects.multipart_uploads WHERE id=$1 FOR UPDATE",
          [uploadId],
        ))[0];
        if (!uploadRow) throw new ObjectRepositoryError("upload_not_found", "Multipart upload not found");
        const delta = value.size - Number(uploadRow.expected_size);
        const capacity = rows(await transaction.query(`
          UPDATE objects.namespaces
          SET reserved_bytes=reserved_bytes-$2,committed_bytes=committed_bytes+$3
          WHERE namespace_key=$1 AND committed_bytes+reserved_bytes+$4<=quota_bytes
          RETURNING namespace_key`, [value.namespaceKey, uploadRow.expected_size, value.size, Math.max(0, delta)]))[0];
        if (!capacity) throw new ObjectRepositoryError("quota_exceeded", "Object quota exceeded");
        const { entry, inserted } = await this.#commit(transaction, value);
        await transaction.query("DELETE FROM objects.multipart_uploads WHERE id=$1", [uploadId]);
        return { object: await loadObject(transaction, { ...entry, current_version: inserted.version }), version: version(inserted) };
      });
    } catch (error) { throw repositoryError(error); }
  }

  async findObject(namespaceKey, objectId) {
    const row = rows(await this.#database.query(
      "SELECT * FROM objects.object_entries WHERE namespace_key=$1 AND id=$2",
      [namespaceKey, objectId],
    ))[0];
    return loadObject(this.#database, row);
  }

  async findObjectById(objectId) {
    const row = rows(await this.#database.query(
      "SELECT * FROM objects.object_entries WHERE id=$1",
      [objectId],
    ))[0];
    return loadObject(this.#database, row);
  }

  async findObjectByKey(namespaceKey, objectKey) {
    const row = rows(await this.#database.query(
      "SELECT * FROM objects.object_entries WHERE namespace_key=$1 AND object_key=$2",
      [namespaceKey, objectKey],
    ))[0];
    return loadObject(this.#database, row);
  }

  async listObjects(namespaceKey, { prefix = "", after = "", limit = 101 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001) throw new TypeError("Object page limit is invalid");
    const entries = rows(await this.#database.query(`
      SELECT page.*, latest.object_id, latest.version, latest.blob_key, latest.size,
             latest.sha256, latest.content_type, latest.created_by_identity_id,
             latest.created_at AS version_created_at
      FROM (
        SELECT * FROM objects.object_entries
        WHERE namespace_key=$1 AND deleted_at IS NULL
          AND left(object_key,length($2))=$2 AND object_key>$3
        ORDER BY object_key LIMIT $4
      ) page
      LEFT JOIN LATERAL (
        SELECT * FROM objects.object_versions WHERE object_id=page.id
        ORDER BY version DESC LIMIT 1
      ) latest ON TRUE
      ORDER BY page.object_key`, [namespaceKey, prefix, after, limit]));
    return entries.map((entry) => {
      if (entry.version == null) throw new ObjectRepositoryError("object_metadata_corrupt", "Object version is missing");
      return object(entry, [version({ ...entry, created_at: entry.version_created_at })]);
    });
  }

  async deleteObject(namespaceKey, objectId, { deletedAt, purgeAfter }) {
    const row = rows(await this.#database.query(`
      UPDATE objects.object_entries SET deleted_at=$3,purge_after=$4
      WHERE namespace_key=$1 AND id=$2 AND deleted_at IS NULL RETURNING *`,
    [namespaceKey, objectId, deletedAt, purgeAfter]))[0];
    return loadObject(this.#database, row);
  }

  async lifecycleCandidates(now, limit) {
    const uploads = rows(await this.#database.query(`
      SELECT * FROM objects.multipart_uploads WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT $2`,
    [now, limit]));
    const expiredUploads = await Promise.all(uploads.map((row) => loadUpload(this.#database, row)));
    const remaining = Math.max(0, limit - expiredUploads.length);
    const deleted = remaining === 0 ? [] : rows(await this.#database.query(`
      SELECT * FROM objects.object_entries
      WHERE deleted_at IS NOT NULL AND purge_after<=$1 ORDER BY purge_after,id LIMIT $2`,
    [now, remaining]));
    const deletedObjects = await Promise.all(deleted.map((row) => loadObject(this.#database, row)));
    return { expiredUploads, deletedObjects };
  }

  async purgeDeletedObject(namespaceKey, objectId, { reclaimAfter = new Date() } = {}) {
    return this.#database.transaction(async (transaction) => {
      const row = rows(await transaction.query(`
        SELECT * FROM objects.object_entries
        WHERE namespace_key=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`,
      [namespaceKey, objectId]))[0];
      if (!row) return null;
      const current = await loadObject(transaction, row);
      const size = current.versions.reduce((total, item) => total + item.size, 0);
      await transaction.query(`
        UPDATE objects.blob_claims SET claim_state='reclaimable',reclaim_after=$2,
          committed_object_id=NULL,committed_object_version=NULL
        WHERE committed_object_id=$1`, [objectId, reclaimAfter]);
      await transaction.query("DELETE FROM objects.object_entries WHERE id=$1", [objectId]);
      await transaction.query(`
        UPDATE objects.namespaces SET committed_bytes=committed_bytes-$2 WHERE namespace_key=$1`,
      [namespaceKey, size]);
      return current;
    });
  }
}
