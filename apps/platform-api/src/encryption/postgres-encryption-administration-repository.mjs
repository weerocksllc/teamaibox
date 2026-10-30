function rows(result) { return Array.isArray(result?.rows) ? result.rows : []; }
function mapped(row) {
  if (!row) return null;
  return Object.freeze({
    planId: row.plan_id,
    mode: row.mode,
    state: row.state,
    revision: row.revision,
    preparedAt: new Date(row.prepared_at),
    expiresAt: new Date(row.expires_at),
    enabledAt: row.enabled_at == null ? null : new Date(row.enabled_at),
    rollbackPassed: row.rollback_passed,
    failureCode: row.failure_code,
  });
}

export class PostgresEncryptionAdministrationRepository {
  #database;
  constructor({ database }) {
    if (!database?.query) throw new TypeError("encryption administration database is invalid");
    this.#database = database;
  }
  async latest() {
    return mapped(rows(await this.#database.query(`SELECT plan_id,mode,state,revision,prepared_at,expires_at,enabled_at,rollback_passed,failure_code
      FROM security.unlock_protection_transitions ORDER BY prepared_at DESC,plan_id DESC LIMIT 1`))[0]);
  }
  async listRecent(limit = 8) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError("encryption transition list limit is invalid");
    return rows(await this.#database.query(`SELECT plan_id,mode,state,revision,prepared_at,expires_at,enabled_at,rollback_passed,failure_code
      FROM security.unlock_protection_transitions ORDER BY prepared_at DESC,plan_id DESC LIMIT $1`, [limit])).map(mapped);
  }
}
