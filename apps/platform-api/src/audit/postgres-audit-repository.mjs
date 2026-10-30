const SHA256 = /^sha256:([a-f0-9]{64})$/;
const SIGNATURE = /^hmac-sha256:([a-f0-9]{64})$/;
function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL audit result is invalid"); return result.rows; }
function digest(value, pattern, name) { const match = pattern.exec(value ?? ""); if (!match) throw new TypeError(`${name} is invalid`); return Buffer.from(match[1], "hex"); }
function encoded(value, prefix) { return value == null ? null : `${prefix}:${Buffer.from(value).toString("hex")}`; }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function mapped(row) {
  if (!row) return null;
  const canonicalEvent = json(row.canonical_payload);
  return { sequenceId: Number(row.sequence_id), ...canonicalEvent, previousEventHash: encoded(row.previous_event_hash, "sha256"), eventHash: encoded(row.event_hash, "sha256"),
    checkpoint: { algorithm: row.checkpoint_algorithm, keyId: row.checkpoint_key_id, signature: encoded(row.checkpoint_signature, "hmac-sha256") }, canonicalEvent };
}

export class PostgresAuditRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL audit storage requires query and transaction"); this.#database = database; }
  async head() {
    const row = rows(await this.#database.query("SELECT sequence_id,event_hash FROM audit.audit_references WHERE schema_version=1 ORDER BY sequence_id DESC LIMIT 1"))[0];
    return row ? { sequenceId: Number(row.sequence_id), eventHash: encoded(row.event_hash, "sha256") } : null;
  }
  async append(value) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(1415001)");
      const head = rows(await transaction.query("SELECT sequence_id,event_hash FROM audit.audit_references WHERE schema_version=1 ORDER BY sequence_id DESC LIMIT 1"))[0];
      const current = head ? encoded(head.event_hash, "sha256") : null;
      if (current !== value.previousEventHash) return null;
      const event = value.event;
      const row = rows(await transaction.query(`INSERT INTO audit.audit_references
        (event_id,occurred_at,actor_identity_id,actor_kind,action,resource_kind,resource_id,correlation_id,event_hash,previous_event_hash,metadata,
         schema_version,domain,outcome,correlation_key,canonical_payload,checkpoint_algorithm,checkpoint_key_id,checkpoint_signature)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,1,$12,$13,$14,$15::jsonb,$16,$17,$18) RETURNING *`,
      [event.eventId, event.occurredAt, event.actor.identityId, event.actor.kind, event.action, event.resource.kind, event.resource.id,
        /^[0-9a-f-]{36}$/i.test(event.correlationId) ? event.correlationId : null, digest(value.eventHash, SHA256, "eventHash"), value.previousEventHash == null ? null : digest(value.previousEventHash, SHA256, "previousEventHash"),
        JSON.stringify(event.metadata), event.domain, event.outcome, event.correlationId, JSON.stringify(event), value.checkpoint.algorithm,
        value.checkpoint.keyId, digest(value.checkpoint.signature, SIGNATURE, "checkpoint signature")]))[0];
      return mapped(row);
    });
  }
  async list({ domain = null, correlationId = null, afterSequence = null, limit = 100 }) {
    return rows(await this.#database.query(`SELECT * FROM audit.audit_references WHERE schema_version=1
      AND ($1::text IS NULL OR domain=$1) AND ($2::text IS NULL OR correlation_key=$2)
      AND ($3::bigint IS NULL OR sequence_id<$3) ORDER BY sequence_id DESC LIMIT $4`, [domain, correlationId, afterSequence, limit])).map(mapped);
  }
  async scan({ afterSequence = 0, throughSequence = null, limit = 1000 }) {
    return rows(await this.#database.query("SELECT * FROM audit.audit_references WHERE schema_version=1 AND sequence_id>$1 AND ($3::bigint IS NULL OR sequence_id<=$3) ORDER BY sequence_id ASC LIMIT $2", [afterSequence, limit, throughSequence])).map(mapped);
  }
}
