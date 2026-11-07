import { randomUUID } from "node:crypto";

export class PostgresPenpotHandoffRepository {
  #database;
  constructor({ database }) {
    if (!database?.query) throw new TypeError("PostgreSQL database is required");
    this.#database = database;
  }

  async insert(record) {
    await this.#database.query(`INSERT INTO design.login_handoffs
      (code_hash, installation_id, identity_id, session_id, app_version, app_generation, issued_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [record.codeHash, record.installationId,
      record.identityId, record.sessionId, record.version, record.generation, record.issuedAt, record.expiresAt]);
  }

  async consume({ codeHash, installationId, identityId, sessionId, now }) {
    const { rows } = await this.#database.query(`DELETE FROM design.login_handoffs
      WHERE code_hash=$1 AND installation_id=$2 AND identity_id=$3 AND session_id=$4
        AND issued_at <= $5 AND expires_at > $5
      RETURNING app_version, app_generation`, [codeHash, installationId, identityId, sessionId, now]);
    return rows[0] ? { version: rows[0].app_version, generation: Number(rows[0].app_generation) } : null;
  }

  async getOrCreateProfile(installationId, identityId) {
    const { rows } = await this.#database.query(`INSERT INTO design.profile_mappings
      (installation_id, identity_id, profile_id) VALUES ($1,$2,$3)
      ON CONFLICT (installation_id, identity_id)
      DO UPDATE SET identity_id=EXCLUDED.identity_id RETURNING profile_id`,
    [installationId, identityId, randomUUID()]);
    return rows[0]?.profile_id;
  }
}
