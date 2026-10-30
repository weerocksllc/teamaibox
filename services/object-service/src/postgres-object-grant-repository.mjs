import { Buffer } from "node:buffer";

import { ObjectGrantRepositoryError } from "./memory-grant-repository.mjs";


function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL object grant result is invalid");
  return result.rows;
}


function grant(row) {
  if (!row) return null;
  if (!(row.integrity_sha256 instanceof Uint8Array) || row.integrity_sha256.byteLength !== 32) {
    throw new ObjectGrantRepositoryError("grant_corrupt", "Object grant integrity is corrupt");
  }
  return {
    referenceId: row.reference_id,
    namespaceKey: row.namespace_key,
    objectId: row.object_id,
    objectVersion: Number(row.object_version),
    audience: row.audience,
    operations: typeof row.operations === "string" ? JSON.parse(row.operations) : structuredClone(row.operations),
    integritySha256: Buffer.from(row.integrity_sha256).toString("hex"),
    issuedByIdentityId: row.issued_by_identity_id,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    revokedByIdentityId: row.revoked_by_identity_id,
    revokeReason: row.revoke_reason,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    useCount: Number(row.use_count),
  };
}


export class PostgresObjectGrantRepository {
  #database;

  constructor({ database }) {
    if (!database?.query) throw new TypeError("PostgreSQL object grant repository requires query");
    this.#database = database;
  }

  async create(value) {
    try {
      return grant(rows(await this.#database.query(`
        INSERT INTO objects.access_grants (
          reference_id,namespace_key,object_id,object_version,audience,operations,integrity_sha256,
          issued_by_identity_id,created_at,expires_at,revoked_at,revoked_by_identity_id,revoke_reason,last_used_at,use_count
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *`, [
        value.referenceId, value.namespaceKey, value.objectId, value.objectVersion,
        value.audience, JSON.stringify(value.operations), Buffer.from(value.integritySha256, "hex"),
        value.issuedByIdentityId, value.createdAt, value.expiresAt, value.revokedAt,
        value.revokedByIdentityId, value.revokeReason, value.lastUsedAt, value.useCount,
      ]))[0]);
    } catch (error) {
      if (error?.code === "23505") throw new ObjectGrantRepositoryError("grant_exists", "Object grant already exists");
      throw error;
    }
  }

  async find(referenceId) {
    return grant(rows(await this.#database.query(
      "SELECT * FROM objects.access_grants WHERE reference_id=$1",
      [referenceId],
    ))[0]);
  }

  async revoke(referenceId, { revokedAt, revokedByIdentityId, reason }) {
    return grant(rows(await this.#database.query(`
      UPDATE objects.access_grants
      SET revoked_at=COALESCE(revoked_at,$2),
          revoked_by_identity_id=CASE WHEN revoked_at IS NULL THEN $3 ELSE revoked_by_identity_id END,
          revoke_reason=CASE WHEN revoked_at IS NULL THEN $4 ELSE revoke_reason END
      WHERE reference_id=$1 RETURNING *`, [referenceId, revokedAt, revokedByIdentityId, reason]))[0]);
  }

  async recordUse(referenceId, { usedAt }) {
    return grant(rows(await this.#database.query(`
      UPDATE objects.access_grants SET last_used_at=$2,use_count=use_count+1
      WHERE reference_id=$1 RETURNING *`, [referenceId, usedAt]))[0]);
  }
}
