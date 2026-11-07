/** Atomic consumption for the existing native call and editor delivery boundaries.
 * No raw proofs, tickets, generated code or tool results are stored here.
 */
function hash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Invalid design digest");
  return Buffer.from(value, "hex");
}

function date(value) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new TypeError("Invalid design context time");
  }
  return new Date(value);
}

function database(value) {
  if (!value?.query) throw new TypeError("PostgreSQL database is required");
  return value;
}

export class PostgresPenpotCallRepository {
  #database;
  constructor({ database: connection }) { this.#database = database(connection); }

  async insert(record) {
    await this.#database.query(`INSERT INTO design.call_proofs
      (proof_hash, native_call, binding, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [hash(record.proofHash), record.call, record.binding, date(record.issuedAt), date(record.expiresAt)]);
  }

  async consume({ proofHash, identityId, runtimeId, now }) {
    const { rows } = await this.#database.query(`DELETE FROM design.call_proofs
      WHERE proof_hash=$1 AND binding->>'identityId'=$2 AND binding->>'runtimeId'=$3
        AND issued_at <= $4 AND expires_at > $4
      RETURNING native_call, binding, issued_at, expires_at`,
    [hash(proofHash), identityId, runtimeId, date(now)]);
    const row = rows[0];
    return row ? { call: row.native_call, binding: row.binding,
      issuedAt: new Date(row.issued_at).getTime(), expiresAt: new Date(row.expires_at).getTime() } : null;
  }

  async discardExpired(now) {
    const result = await this.#database.query('DELETE FROM design.call_proofs WHERE expires_at <= $1', [date(now)]);
    return result.rowCount;
  }
}

export class PostgresPenpotEditorRepository {
  #database;
  constructor({ database: connection }) { this.#database = database(connection); }

  async insert(record) {
    await this.#database.query(`INSERT INTO design.editor_deliveries
      (ticket_hash, request_hash, binding, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [hash(record.ticketHash), hash(record.requestHash), record.binding, date(record.issuedAt), date(record.expiresAt)]);
  }

  async consume({ ticketHash, requestHash, identityId, platformSessionId, profileId, now, reviewId, workspace }) {
    const { rows } = await this.#database.query(`UPDATE design.editor_deliveries
      SET claimed_at=$6,review_id=$7,review_workspace=$8
      WHERE ticket_hash=$1 AND request_hash=$2 AND binding->>'identityId'=$3
        AND binding->>'platformSessionId'=$4 AND binding->>'profileId'=$5
        AND issued_at <= $6 AND expires_at > $6 AND claimed_at IS NULL
      RETURNING binding, expires_at`,
    [hash(ticketHash), hash(requestHash), identityId, platformSessionId, profileId, date(now), reviewId, workspace]);
    const row = rows[0];
    return row ? { binding: row.binding, expiresAt: new Date(row.expires_at).getTime() } : null;
  }

  async discardExpired(now) {
    const result = await this.#database.query('DELETE FROM design.editor_deliveries WHERE claimed_at IS NULL AND expires_at <= $1', [date(now)]);
    return result.rowCount;
  }

  async settle(ticketHash, uncertain, now) {
    if (!uncertain) {
      const removed=await this.#database.query(`DELETE FROM design.editor_deliveries d
        WHERE d.ticket_hash=$1 AND d.claimed_at IS NOT NULL AND NOT d.outcome_uncertain
          AND EXISTS (SELECT 1 FROM design.editor_connections c
            WHERE c.identity_id=(d.binding->>'identityId')::uuid
              AND c.generation=(d.binding->>'generation')::bigint
              AND c.binding->>'connectionId'=d.binding->>'connectionId'
              AND c.disconnected_at IS NULL AND c.heartbeat_at > $2::timestamptz-interval '12 seconds')`,
        [hash(ticketHash),date(now)]);
      return removed.rowCount===1;
    }
    // Do not retire another tab's newer binding. Once an uncertain result
    // has been recorded, a late receipt cannot clear the review barrier.
    await this.#database.query(`WITH pending AS (
      UPDATE design.editor_deliveries SET outcome_uncertain=true
      WHERE ticket_hash=$1 AND claimed_at IS NOT NULL RETURNING binding
    )
    UPDATE design.editor_connections c SET disconnected_at=$2 FROM pending p
      WHERE c.identity_id=(p.binding->>'identityId')::uuid
        AND c.binding->>'connectionId'=p.binding->>'connectionId'
        AND c.generation=(p.binding->>'generation')::bigint`, [hash(ticketHash), date(now)]);
    return true;
  }

  async pending(identityId, now) {
    const {rows:[row]}=await this.#database.query(`SELECT d.review_id,d.binding,d.review_workspace,
      (d.outcome_uncertain OR d.claimed_at <= $2::timestamptz-interval '65 seconds'
        OR c.disconnected_at IS NOT NULL OR c.identity_id IS NULL
        OR c.heartbeat_at <= $2::timestamptz-interval '12 seconds') AS uncertain
      FROM design.editor_deliveries d
      LEFT JOIN design.editor_connections c ON c.identity_id=$1
        AND c.generation=(d.binding->>'generation')::bigint AND c.binding->>'connectionId'=d.binding->>'connectionId'
      WHERE d.binding->>'identityId'=$1::uuid::text AND d.claimed_at IS NOT NULL`, [identityId,date(now)]);
    return row ? {reviewId:row.review_id,binding:row.binding,workspace:row.review_workspace,uncertain:row.uncertain} : null;
  }

  async reviewed({identityId,profileId,reviewId,now}) {
    const {rows}=await this.#database.query(`WITH checked AS (
      DELETE FROM design.editor_deliveries d WHERE d.review_id=$1 AND d.binding->>'identityId'=$2::uuid::text
        AND d.binding->>'profileId'=$3 AND d.claimed_at IS NOT NULL
        AND (d.outcome_uncertain OR d.claimed_at <= $4::timestamptz-interval '65 seconds'
          OR NOT EXISTS (SELECT 1 FROM design.editor_connections c WHERE c.identity_id=$2
            AND c.generation=(d.binding->>'generation')::bigint AND c.binding->>'connectionId'=d.binding->>'connectionId'
            AND c.disconnected_at IS NULL AND c.heartbeat_at > $4::timestamptz-interval '12 seconds'))
      RETURNING binding
    ), retired AS (
      UPDATE design.editor_connections c SET disconnected_at=$4 FROM checked k
      WHERE c.identity_id=$2 AND c.generation=(k.binding->>'generation')::bigint
        AND c.binding->>'connectionId'=k.binding->>'connectionId'
    )
    SELECT 1 FROM checked`, [reviewId,identityId,profileId,date(now)]);
    return rows.length===1;
  }
}
