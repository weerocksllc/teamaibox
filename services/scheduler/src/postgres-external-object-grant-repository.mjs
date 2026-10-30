function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid"); return result.rows; }
function date(value) { return value == null ? null : new Date(value); }
function digest(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function digestBytes(value) { return value == null ? null : Buffer.from(value.replace(/^sha256:/, ""), "hex"); }
function operations(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }

function mapped(row) {
  if (!row) return null;
  return {
    grantId: row.id, ticketDigest: Buffer.from(row.ticket_digest).toString("hex"),
    ownerIdentityId: row.owner_identity_id, jobId: row.job_id, attemptId: row.attempt_id,
    providerId: row.provider_id, direction: row.direction, referenceId: row.reference_id,
    audience: row.audience, operations: operations(row.operations), expectedSha256: digest(row.expected_sha256),
    expectedSize: row.expected_size == null ? null : Number(row.expected_size), maximumBytes: Number(row.maximum_bytes),
    mediaType: row.media_type, destinationObjectKey: row.destination_object_key,
    maximumUses: Number(row.maximum_uses), useCount: Number(row.use_count), state: row.state,
    createdAt: date(row.created_at), expiresAt: date(row.expires_at), lastUsedAt: date(row.last_used_at),
    completedAt: date(row.completed_at), failedAt: date(row.failed_at), failureCode: row.failure_code,
    revokedAt: date(row.revoked_at), revokeReason: row.revoke_reason,
    completedObjectId: row.completed_object_id,
    completedObjectVersion: row.completed_object_version == null ? null : Number(row.completed_object_version),
    completedSha256: digest(row.completed_sha256),
  };
}

const SELECT = "SELECT * FROM compute.external_object_grants";

export class PostgresExternalObjectGrantRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    this.#database = database;
  }

  async create(value) {
    const row = rows(await this.#database.query(`
      INSERT INTO compute.external_object_grants (
        id,ticket_digest,owner_identity_id,job_id,attempt_id,provider_id,direction,reference_id,
        audience,operations,expected_sha256,expected_size,maximum_bytes,media_type,destination_object_key,
        maximum_uses,use_count,state,created_at,expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *`, [
      value.grantId, Buffer.from(value.ticketDigest, "hex"), value.ownerIdentityId, value.jobId,
      value.attemptId, value.providerId, value.direction, value.referenceId, value.audience,
      JSON.stringify(value.operations), digestBytes(value.expectedSha256), value.expectedSize,
      value.maximumBytes, value.mediaType, value.destinationObjectKey, value.maximumUses,
      value.useCount, value.state, value.createdAt, value.expiresAt,
    ]))[0];
    return mapped(row);
  }

  async findByTicketDigest(ticketDigest) {
    return mapped(rows(await this.#database.query(`${SELECT} WHERE ticket_digest=$1`, [Buffer.from(ticketDigest, "hex")]))[0]);
  }

  async authorize({ ticketDigest, operation, usedAt }) {
    return this.#database.transaction(async (transaction) => mapped(rows(await transaction.query(`
      UPDATE compute.external_object_grants
      SET use_count=use_count+1,last_used_at=$3,state=CASE WHEN $2='write' THEN 'consuming' ELSE state END
      WHERE ticket_digest=$1 AND state='active' AND expires_at>$3
        AND operations ? $2 AND use_count<maximum_uses
      RETURNING *`, [Buffer.from(ticketDigest, "hex"), operation, usedAt]))[0]));
  }

  async completeOutput(grantId, { completedAt, objectId, objectVersion, sha256 }) {
    return mapped(rows(await this.#database.query(`
      UPDATE compute.external_object_grants
      SET state='consumed',completed_at=$2,completed_object_id=$3,completed_object_version=$4,completed_sha256=$5
      WHERE id=$1 AND direction='output' AND state='consuming' RETURNING *`,
    [grantId, completedAt, objectId, objectVersion, digestBytes(sha256)]))[0]);
  }

  async failOutput(grantId, { failedAt, failureCode }) {
    return mapped(rows(await this.#database.query(`
      UPDATE compute.external_object_grants SET state='failed',failed_at=$2,failure_code=$3
      WHERE id=$1 AND state='consuming' RETURNING *`, [grantId, failedAt, failureCode]))[0]);
  }

  async revokeAttempt({ ownerIdentityId, attemptId, revokedAt, reason }) {
    return rows(await this.#database.query(`
      UPDATE compute.external_object_grants SET state='revoked',revoked_at=$3,revoke_reason=$4
      WHERE owner_identity_id=$1 AND attempt_id=$2 AND state IN ('active','consuming') RETURNING *`,
    [ownerIdentityId, attemptId, revokedAt, reason])).map(mapped);
  }
}
