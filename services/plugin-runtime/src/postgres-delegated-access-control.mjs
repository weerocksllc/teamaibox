const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PERMISSION = /^[a-z][a-z0-9_.-]{1,63}:[a-z][a-z0-9_.-]{1,63}$/;

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("access-control timestamp is invalid");
  return date;
}

function resource(value) {
  if (!value || typeof value.kind !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(value.kind)
    || typeof value.key !== "string" || value.key.length < 1 || value.key.length > 256
    || (value.kind === "appliance" && value.key !== "*")) return null;
  return value;
}

export class PostgresDelegatedAccessControl {
  #database;
  constructor({ database }) {
    if (!database?.query) throw new TypeError("PostgreSQL database is required");
    this.#database = database;
  }

  async #session(identityId, sessionId, now) {
    if (!UUID.test(identityId ?? "") || !UUID.test(sessionId ?? "")) return null;
    const row = rows(await this.#database.query(`
      SELECT identity.id AS identity_id, identity.identity_kind, identity.status
      FROM iam.sessions session
      JOIN iam.identities identity ON identity.id = session.identity_id
      WHERE session.id = $1 AND session.identity_id = $2
        AND session.revoked_at IS NULL
        AND session.expires_at > $3 AND session.idle_expires_at > $3
        AND session.password_version = identity.password_version
        AND identity.identity_kind = 'local_user' AND identity.status = 'active'`,
    [sessionId, identityId, validDate(now)]))[0];
    return row ? Object.freeze({ identityId: row.identity_id, sessionId, identityKind: row.identity_kind,
      status: row.status, principal: Object.freeze({ id: row.identity_id, identityKind: row.identity_kind }) }) : null;
  }

  async resolveSession(context, now) {
    const identityId = context?.identityId ?? context?.identity?.id;
    return this.#session(identityId, context?.sessionId, now);
  }

  async loadSession(identityId, sessionId, now) {
    return this.#session(identityId, sessionId, now);
  }

  async authorize({ identityId, sessionId, permission, resource: target, now }) {
    const selected = resource(target);
    if (!UUID.test(identityId ?? "") || !UUID.test(sessionId ?? "") || !PERMISSION.test(permission ?? "") || !selected) return false;
    const result = rows(await this.#database.query(`
      SELECT EXISTS (
        SELECT 1
        FROM iam.sessions session
        JOIN iam.identities identity ON identity.id = session.identity_id
        JOIN iam.role_bindings binding ON binding.identity_id = identity.id
        JOIN iam.role_permissions role_permission ON role_permission.role_id = binding.role_id
        WHERE session.id = $1 AND session.identity_id = $2
          AND session.revoked_at IS NULL
          AND session.expires_at > $6 AND session.idle_expires_at > $6
          AND session.password_version = identity.password_version
          AND identity.identity_kind = 'local_user' AND identity.status = 'active'
          AND role_permission.permission_key = $3
          AND (binding.expires_at IS NULL OR binding.expires_at > $6)
          AND ((binding.scope_kind = 'appliance' AND binding.scope_key = '*')
            OR (binding.scope_kind = $4 AND binding.scope_key = $5))
      ) AS allowed`, [sessionId, identityId, permission, selected.kind, selected.key, validDate(now)]));
    return result[0]?.allowed === true;
  }
}
