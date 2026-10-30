import { CredentialRepositoryError } from "./memory-credential-repository.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL credential query result is invalid");
  return result.rows;
}

function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}

function digestBytes(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("credential digest must be a lowercase SHA-256 hex value");
  }
  return Buffer.from(value, "hex");
}

function digestHex(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("PostgreSQL credential digest is invalid");
  }
  return Buffer.from(value).toString("hex");
}

function credential(row) {
  if (!row) return null;
  return {
    id: row.id,
    subjectIdentityId: row.subject_identity_id,
    kind: row.credential_kind,
    displayName: row.display_name,
    hint: row.token_hint,
    tokenHash: digestHex(row.token_hash),
    scopes: structuredClone(row.scopes),
    createdByIdentityId: row.created_by_identity_id,
    createdAt: date(row.created_at),
    expiresAt: date(row.expires_at),
    lastUsedAt: date(row.last_used_at),
    revokedAt: date(row.revoked_at),
    revokeReason: row.revoke_reason,
  };
}

function principal(row) {
  if (!row) return null;
  return {
    id: row.id,
    identityKind: row.identity_kind,
    status: row.status,
    roleBindings: (row.role_bindings ?? []).map((value) => ({
      roleKey: value.roleKey,
      scopeKind: value.scopeKind,
      scopeKey: value.scopeKey,
      grantedAt: date(value.grantedAt),
      expiresAt: date(value.expiresAt),
      revokedAt: null,
    })),
    serviceGrants: (row.service_grants ?? []).map((value) => ({
      permissionKey: value.permissionKey,
      resourceKind: value.resourceKind,
      resourceKey: value.resourceKey,
      grantedAt: date(value.grantedAt),
      expiresAt: date(value.expiresAt),
      revokedAt: date(value.revokedAt),
    })),
  };
}

const CREDENTIAL_SELECT = `SELECT id,subject_identity_id,credential_kind,display_name,token_hint,
  token_hash,scopes,created_by_identity_id,created_at,expires_at,last_used_at,revoked_at,revoke_reason
  FROM iam.api_credentials`;

export class PostgresCredentialRepository {
  #database;

  constructor({ database }) {
    if (!database || typeof database.query !== "function") throw new TypeError("PostgreSQL database is required");
    this.#database = database;
  }

  async loadPrincipalAccess(identityId) {
    const result = await this.#database.query(`SELECT identity.id,identity.identity_kind,identity.status,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'roleKey',role.role_key,'scopeKind',binding.scope_kind,'scopeKey',binding.scope_key,
        'grantedAt',binding.granted_at,'expiresAt',binding.expires_at) ORDER BY role.role_key,binding.scope_kind,binding.scope_key)
        FROM iam.role_bindings binding JOIN iam.roles role ON role.id=binding.role_id
        WHERE binding.identity_id=identity.id), '[]'::jsonb) AS role_bindings,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'permissionKey',service.permission_key,'resourceKind',service.resource_kind,'resourceKey',service.resource_key,
        'grantedAt',service.granted_at,'expiresAt',service.expires_at,'revokedAt',service.revoked_at)
        ORDER BY service.permission_key,service.resource_kind,service.resource_key)
        FROM iam.service_account_grants service WHERE service.identity_id=identity.id), '[]'::jsonb) AS service_grants
      FROM iam.identities identity WHERE identity.id=$1`, [identityId]);
    return principal(rows(result)[0]);
  }

  async insertCredential(value) {
    try {
      const result = await this.#database.query(`INSERT INTO iam.api_credentials
        (subject_identity_id,credential_kind,display_name,token_hint,token_hash,scopes,
         created_by_identity_id,created_at,expires_at,last_used_at,revoked_at,revoke_reason)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
        RETURNING *`, [value.subjectIdentityId, value.kind, value.displayName, value.hint,
        digestBytes(value.tokenHash), JSON.stringify(value.scopes), value.createdByIdentityId,
        value.createdAt, value.expiresAt, value.lastUsedAt, value.revokedAt, value.revokeReason]);
      return credential(rows(result)[0]);
    } catch (error) {
      if (error?.code === "23505") throw new CredentialRepositoryError("credential_collision", "Credential collision");
      throw error;
    }
  }

  async findCredentialByHash(tokenHash) {
    const result = await this.#database.query(`${CREDENTIAL_SELECT} WHERE token_hash=$1`, [digestBytes(tokenHash)]);
    return credential(rows(result)[0]);
  }

  async findCredentialById(credentialId) {
    const result = await this.#database.query(`${CREDENTIAL_SELECT} WHERE id=$1`, [credentialId]);
    return credential(rows(result)[0]);
  }

  async listCredentialsForSubject(subjectIdentityId) {
    const result = await this.#database.query(`${CREDENTIAL_SELECT} WHERE subject_identity_id=$1 ORDER BY created_at DESC,id DESC`, [subjectIdentityId]);
    return rows(result).map(credential);
  }

  async touchCredential(credentialId, at) {
    const result = await this.#database.query(`UPDATE iam.api_credentials SET last_used_at=$2
      WHERE id=$1 AND revoked_at IS NULL AND expires_at>$2 RETURNING id`, [credentialId, at]);
    return rows(result).length === 1;
  }

  async revokeCredential(credentialId, at, reason) {
    const result = await this.#database.query(`UPDATE iam.api_credentials SET revoked_at=$2,revoke_reason=$3
      WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [credentialId, at, reason]);
    return rows(result).length === 1;
  }
}
