import { IdentityRepositoryError } from "./repository-error.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}

function digestBytes(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("identity digest must be a lowercase SHA-256 hex value");
  }
  return Buffer.from(value, "hex");
}

function digestHex(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("PostgreSQL identity digest is invalid");
  }
  return Buffer.from(value).toString("hex");
}

function identity(row) {
  if (!row) return null;
  return {
    id: row.id,
    identityKind: row.identity_kind,
    loginName: row.login_name,
    normalizedLoginName: row.normalized_login_name,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    passwordVersion: Number(row.password_version),
    status: row.status,
    disabledAt: date(row.disabled_at),
    preferredLocale: row.preferred_locale,
    preferredLocaleExplicit: row.preferred_locale_explicit === true,
    preferredTheme: row.preferred_theme,
    roles: Array.isArray(row.roles) ? [...row.roles] : [],
    lastAuthenticatedAt: date(row.last_authenticated_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function failureState(row) {
  if (!row) return null;
  return {
    failures: Number(row.failed_attempts),
    windowStartedAt: date(row.window_started_at ?? row.failure_window_started_at),
    blockedUntil: date(row.blocked_until ?? row.locked_until),
  };
}

function advancedCounter(state, now, windowMs) {
  if (!state || !state.windowStartedAt
    || now.getTime() - state.windowStartedAt.getTime() >= windowMs) {
    return { failures: 0, windowStartedAt: new Date(now), blockedUntil: null };
  }
  return { ...state };
}

function session(row) {
  if (!row) return null;
  return {
    id: row.session_id ?? row.id,
    identityId: row.identity_id,
    tokenHash: digestHex(row.token_hash),
    csrfHash: digestHex(row.csrf_hash),
    passwordVersion: Number(row.session_password_version ?? row.password_version),
    userAgentHash: digestHex(row.user_agent_hash),
    networkHash: digestHex(row.network_hash),
    createdAt: date(row.session_created_at ?? row.created_at),
    lastSeenAt: date(row.last_seen_at),
    idleExpiresAt: date(row.idle_expires_at),
    expiresAt: date(row.expires_at),
    revokedAt: date(row.revoked_at),
    revokeReason: row.revoke_reason,
  };
}

const IDENTITY_SELECT = `
  SELECT identity.*,
         authentication.last_authenticated_at,
         COALESCE(
           array_agg(DISTINCT role.role_key ORDER BY role.role_key)
             FILTER (WHERE role.role_key IS NOT NULL),
           ARRAY[]::text[]
         ) AS roles
  FROM iam.identities identity
  LEFT JOIN iam.authentication_states authentication
    ON authentication.identity_id = identity.id
  LEFT JOIN iam.role_bindings binding
    ON binding.identity_id = identity.id
   AND binding.scope_kind = 'appliance'
   AND binding.scope_key = '*'
   AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
  LEFT JOIN iam.roles role ON role.id = binding.role_id`;

async function findIdentity(executor, clause, parameters) {
  const result = await executor.query(`${IDENTITY_SELECT}
    WHERE ${clause}
    GROUP BY identity.id, authentication.identity_id`, parameters);
  return identity(rows(result)[0]);
}

async function insertRole(executor, identityId, roleKey, grantedAt) {
  const roleRows = rows(await executor.query(
    "SELECT id FROM iam.roles WHERE role_key = $1",
    [roleKey],
  ));
  if (roleRows.length !== 1) {
    throw new IdentityRepositoryError("authorization_schema_incomplete", `Required role is missing: ${roleKey}`);
  }
  const roleId = roleRows[0].id;
  await executor.query(`
    INSERT INTO iam.identity_roles (identity_id, role_id, granted_at)
    VALUES ($1, $2, $3)`, [identityId, roleId, grantedAt]);
  await executor.query(`
    INSERT INTO iam.role_bindings (
      identity_id, role_id, scope_kind, scope_key, granted_at
    ) VALUES ($1, $2, 'appliance', '*', $3)`, [identityId, roleId, grantedAt]);
}

async function insertRecoveryCodes(executor, identityId, hashes, generation, now) {
  for (const hash of hashes) {
    await executor.query(`
      INSERT INTO iam.owner_recovery_codes (
        identity_id, code_hash, generation, created_at
      ) VALUES ($1, $2, $3, $4)`, [identityId, digestBytes(hash), generation, now]);
  }
}

async function listTeams(executor) {
  const result = await executor.query(`
    SELECT team.id AS team_id, team.team_key, team.display_name, team.status,
           team.system_team, team.created_at, team.updated_at,
           identity.id AS identity_id, identity.identity_kind, identity.login_name,
           identity.normalized_login_name, identity.display_name AS identity_display_name,
           identity.status AS identity_status, identity.disabled_at,
           identity.preferred_locale, identity.preferred_theme,
           identity.created_at AS identity_created_at, identity.updated_at AS identity_updated_at,
           role.role_key
    FROM iam.teams team
    LEFT JOIN iam.role_bindings binding
      ON binding.scope_kind = 'team' AND binding.scope_key = team.team_key
     AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
    LEFT JOIN iam.roles role ON role.id = binding.role_id
    LEFT JOIN iam.identities identity ON identity.id = binding.identity_id
    ORDER BY team.system_team DESC, team.display_name, team.id, identity.display_name, identity.id`);
  const teams = new Map();
  for (const row of rows(result)) {
    if (!teams.has(row.team_id)) teams.set(row.team_id, {
      id: row.team_id, teamKey: row.team_key, displayName: row.display_name,
      status: row.status, systemTeam: row.system_team, createdAt: date(row.created_at),
      updatedAt: date(row.updated_at), members: [],
    });
    if (row.identity_id) teams.get(row.team_id).members.push({
      identity: {
        id: row.identity_id, identityKind: row.identity_kind, loginName: row.login_name,
        normalizedLoginName: row.normalized_login_name, displayName: row.identity_display_name,
        status: row.identity_status, disabledAt: date(row.disabled_at),
        preferredLocale: row.preferred_locale, preferredTheme: row.preferred_theme,
        roles: [], createdAt: date(row.identity_created_at), updatedAt: date(row.identity_updated_at),
      },
      roleKey: row.role_key,
    });
  }
  return [...teams.values()];
}

export class PostgresIdentityRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL identity repository requires query and transaction");
    }
    this.#database = database;
  }

  async bootstrapState() {
    const result = await this.#database.query(`
      SELECT owner_identity_id
      FROM iam.appliance_bootstrap
      WHERE singleton = true`);
    const row = rows(result)[0];
    return {
      complete: Boolean(row),
      ownerIdentityId: row?.owner_identity_id ?? null,
    };
  }

  async bootstrapOwner({ loginName, normalizedLoginName, displayName, passwordHash, recoveryCodeHashes, now }) {
    try {
      return await this.#database.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["identity:appliance-bootstrap"]);
        const bootstrap = rows(await transaction.query(
          "SELECT owner_identity_id FROM iam.appliance_bootstrap WHERE singleton = true FOR UPDATE",
        ));
        if (bootstrap.length !== 0) {
          throw new IdentityRepositoryError("bootstrap_complete", "Appliance owner bootstrap is complete");
        }
        const present = rows(await transaction.query("SELECT count(*)::bigint AS count FROM iam.identities"));
        if (Number(present[0]?.count ?? 0) !== 0) {
          throw new IdentityRepositoryError(
            "bootstrap_inconsistent",
            "Identity records exist without an appliance owner bootstrap record",
          );
        }
        const inserted = rows(await transaction.query(`
          INSERT INTO iam.identities (
            identity_kind, login_name, normalized_login_name, display_name,
            password_hash, preferred_locale, preferred_theme, created_at, updated_at
          ) VALUES ('local_user', $1, $2, $3, $4, 'zh-CN', 'system', $5, $5)
          RETURNING id`, [loginName, normalizedLoginName, displayName, passwordHash, now]));
        const identityId = inserted[0].id;
        await transaction.query(`
          INSERT INTO iam.authentication_states (
            identity_id, password_changed_at
          ) VALUES ($1, $2)`, [identityId, now]);
        await insertRole(transaction, identityId, "owner", now);
        await transaction.query(`
          INSERT INTO iam.role_bindings (identity_id, role_id, scope_kind, scope_key, granted_at)
          SELECT $1, role.id, 'team', team.team_key, $2
          FROM iam.teams team JOIN iam.roles role ON role.role_key = 'team_admin'
          WHERE team.system_team = true
          ON CONFLICT (identity_id, role_id, scope_kind, scope_key) DO NOTHING`, [identityId, now]);
        await transaction.query(`
          INSERT INTO iam.appliance_bootstrap (
            singleton, owner_identity_id, completed_at
          ) VALUES (true, $1, $2)`, [identityId, now]);
        await insertRecoveryCodes(transaction, identityId, recoveryCodeHashes, 1, now);
        return findIdentity(transaction, "identity.id = $1", [identityId]);
      });
    } catch (error) {
      if (error instanceof IdentityRepositoryError) throw error;
      if (error?.code === "23505") {
        throw new IdentityRepositoryError("bootstrap_complete", "Appliance owner bootstrap is complete");
      }
      throw error;
    }
  }

  async insertIdentity(value) {
    try {
      return await this.#database.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `identity:login:${value.normalizedLoginName}`,
        ]);
        const inserted = rows(await transaction.query(`
          INSERT INTO iam.identities (
            id, identity_kind, login_name, normalized_login_name, display_name,
            password_hash, password_version, status, preferred_locale,
            preferred_theme, disabled_at, created_at, updated_at
          ) VALUES (
            COALESCE($1::uuid, uuidv7()), $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12, $12
          ) RETURNING id`, [
          value.id ?? null,
          value.identityKind ?? "local_user",
          value.loginName,
          value.normalizedLoginName,
          value.displayName,
          value.passwordHash,
          value.passwordVersion ?? 1,
          value.status ?? "active",
          value.preferredLocale ?? "zh-CN",
          value.preferredTheme ?? "system",
          value.disabledAt ?? null,
          value.createdAt ?? new Date(),
        ]));
        const identityId = inserted[0].id;
        await transaction.query(`
          INSERT INTO iam.authentication_states (
            identity_id, password_changed_at
          ) VALUES ($1, $2)`, [identityId, value.createdAt ?? new Date()]);
        const roleKeys = value.roles?.length ? [...new Set(value.roles)] : ["member"];
        for (const roleKey of roleKeys) {
          await insertRole(transaction, identityId, roleKey, value.createdAt ?? new Date());
        }
        if ((value.identityKind ?? "local_user") === "local_user") {
          const teamRole = roleKeys.includes("owner") ? "team_admin" : "member";
          await transaction.query(`
            INSERT INTO iam.role_bindings (identity_id, role_id, scope_kind, scope_key, granted_at)
            SELECT $1, role.id, 'team', team.team_key, $2
            FROM iam.teams team JOIN iam.roles role ON role.role_key = $3
            WHERE team.system_team = true
            ON CONFLICT (identity_id, role_id, scope_kind, scope_key) DO NOTHING`,
          [identityId, value.createdAt ?? new Date(), teamRole]);
        }
        return findIdentity(transaction, "identity.id = $1", [identityId]);
      });
    } catch (error) {
      if (error instanceof IdentityRepositoryError) throw error;
      if (error?.code === "23505") {
        throw new IdentityRepositoryError("identity_exists", "Identity already exists");
      }
      throw error;
    }
  }

  async findByNormalizedLogin(loginName) {
    return findIdentity(this.#database, "identity.normalized_login_name = $1", [loginName]);
  }

  async findIdentity(identityId) {
    return findIdentity(this.#database, "identity.id = $1", [identityId]);
  }

  async listIdentities(limit, { offset = 0, query = "" } = {}) {
    const result = await this.#database.query(`${IDENTITY_SELECT}
      WHERE identity.identity_kind = 'local_user'
        AND strpos(lower(identity.login_name || E'\\n' || identity.display_name), lower($3)) > 0
      GROUP BY identity.id, authentication.identity_id
      ORDER BY identity.created_at DESC, identity.login_name ASC
      LIMIT $1 OFFSET $2`, [limit, offset, query]);
    return rows(result).map(identity);
  }

  async identitySummary(query = "") {
    const result = await this.#database.query(`
      SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE identity.status = 'active')::integer AS active,
        count(*) FILTER (WHERE identity.status = 'active' AND EXISTS (
          SELECT 1 FROM iam.role_bindings binding JOIN iam.roles role ON role.id = binding.role_id
          WHERE binding.identity_id = identity.id AND role.role_key = 'owner'
            AND binding.scope_kind = 'appliance' AND binding.scope_key = '*'
            AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
        ))::integer AS owners,
        count(*) FILTER (WHERE strpos(lower(identity.login_name || E'\\n' || identity.display_name), lower($1)) > 0)::integer AS matching
      FROM iam.identities identity WHERE identity.identity_kind = 'local_user'`, [query]);
    return rows(result)[0];
  }

  async listAuthorizationRoles() {
    return rows(await this.#database.query(`
      SELECT role.role_key,
             role.display_name_key,
             role.description_key,
             role.system_role,
             COALESCE(array_agg(DISTINCT scope.scope_kind ORDER BY scope.scope_kind)
               FILTER (WHERE scope.scope_kind IS NOT NULL), ARRAY[]::text[]) AS allowed_scopes,
             COALESCE(array_agg(DISTINCT permission.permission_key ORDER BY permission.permission_key)
               FILTER (WHERE permission.permission_key IS NOT NULL), ARRAY[]::text[]) AS permissions,
             count(DISTINCT binding.identity_id)::bigint AS binding_count
      FROM iam.roles role
      LEFT JOIN iam.role_scopes scope ON scope.role_id = role.id
      LEFT JOIN iam.role_permissions permission ON permission.role_id = role.id
      LEFT JOIN iam.role_bindings binding
        ON binding.role_id = role.id
       AND binding.scope_kind = 'appliance'
       AND binding.scope_key = '*'
       AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
      WHERE role.system_role = true
      GROUP BY role.id
      ORDER BY role.role_key`)).map((row) => ({
      roleKey: row.role_key,
      displayNameKey: row.display_name_key,
      descriptionKey: row.description_key,
      systemRole: row.system_role,
      allowedScopes: [...row.allowed_scopes],
      permissions: [...row.permissions],
      bindingCount: Number(row.binding_count),
    }));
  }

  async setRoleBinding({ identityId, roleKey, granted, actorIdentityId, at }) {
    try {
      return await this.#database.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["identity:active-owners"]);
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["identity:role-bindings"]);
        const current = await findIdentity(transaction, "identity.id = $1", [identityId]);
        if (!current) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
        const roleRows = rows(await transaction.query(`
          SELECT id FROM iam.roles WHERE role_key = $1 AND system_role = true`, [roleKey]));
        if (roleRows.length !== 1) throw new IdentityRepositoryError("role_not_found", "Role not found");
        const roleId = roleRows[0].id;
        const bindingRows = rows(await transaction.query(`
          SELECT id FROM iam.role_bindings
          WHERE identity_id = $1 AND role_id = $2 AND scope_kind = 'appliance' AND scope_key = '*'
            AND (expires_at IS NULL OR expires_at > $3)
          FOR UPDATE`, [identityId, roleId, at]));
        const present = bindingRows.length > 0;
        if (present === granted) return { identity: current, changed: false };
        if (!granted && current.roles.length <= 1) {
          throw new IdentityRepositoryError("role_last_binding", "An identity must retain at least one role");
        }
        if (!granted && roleKey === "owner" && current.status === "active") {
          const ownerRows = rows(await transaction.query(`
            SELECT count(DISTINCT identity.id)::bigint AS count
            FROM iam.identities identity
            JOIN iam.role_bindings binding ON binding.identity_id = identity.id
            JOIN iam.roles role ON role.id = binding.role_id
            WHERE identity.status = 'active' AND role.role_key = 'owner'
              AND binding.scope_kind = 'appliance' AND binding.scope_key = '*'
              AND (binding.expires_at IS NULL OR binding.expires_at > $1)`, [at]));
          if (Number(ownerRows[0]?.count ?? 0) <= 1) {
            throw new IdentityRepositoryError("last_owner", "The last active owner role cannot be revoked");
          }
        }
        if (granted) {
          await transaction.query(`
            INSERT INTO iam.identity_roles (identity_id, role_id, granted_by, granted_at, expires_at)
            VALUES ($1, $2, $3, $4, NULL)
            ON CONFLICT (identity_id, role_id) DO UPDATE SET
              granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at, expires_at = NULL`,
          [identityId, roleId, actorIdentityId, at]);
          await transaction.query(`
            INSERT INTO iam.role_bindings (identity_id, role_id, scope_kind, scope_key, granted_by, granted_at, expires_at)
            VALUES ($1, $2, 'appliance', '*', $3, $4, NULL)
            ON CONFLICT (identity_id, role_id, scope_kind, scope_key) DO UPDATE SET
              granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at, expires_at = NULL`,
          [identityId, roleId, actorIdentityId, at]);
        } else {
          await transaction.query(`DELETE FROM iam.role_bindings
            WHERE identity_id = $1 AND role_id = $2 AND scope_kind = 'appliance' AND scope_key = '*'`, [identityId, roleId]);
          await transaction.query(`DELETE FROM iam.identity_roles WHERE identity_id = $1 AND role_id = $2`, [identityId, roleId]);
        }
        await transaction.query(`UPDATE iam.identities SET updated_at = $2 WHERE id = $1`, [identityId, at]);
        return { identity: await findIdentity(transaction, "identity.id = $1", [identityId]), changed: true };
      });
    } catch (error) {
      if (error instanceof IdentityRepositoryError) throw error;
      if (error?.code === "23505") throw new IdentityRepositoryError("role_binding_conflict", "Role binding changed concurrently");
      throw error;
    }
  }

  async listTeams() {
    return listTeams(this.#database);
  }

  async listTeamMemberships(identityId) {
    return rows(await this.#database.query(`
      SELECT team.id AS team_id,team.team_key,team.display_name AS team_display_name,role.role_key
      FROM iam.role_bindings binding
      JOIN iam.teams team ON team.team_key=binding.scope_key AND team.status='active'
      JOIN iam.roles role ON role.id=binding.role_id
      WHERE binding.identity_id=$1 AND binding.scope_kind='team'
        AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
      ORDER BY team.team_key`, [identityId])).map((row) => ({
      teamId: row.team_id, teamKey: row.team_key, teamDisplayName: row.team_display_name, roleKey: row.role_key,
    }));
  }

  async setTeamMembership({ teamId, identityId, roleKey, granted, actorIdentityId, at }) {
    try {
      return await this.#database.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`identity:team:${teamId}`]);
        const teamRows = rows(await transaction.query("SELECT id,team_key FROM iam.teams WHERE id=$1 AND status='active' FOR UPDATE", [teamId]));
        if (teamRows.length !== 1) throw new IdentityRepositoryError("team_not_found", "Team not found");
        const identityRows = rows(await transaction.query("SELECT id FROM iam.identities WHERE id=$1 AND identity_kind='local_user'", [identityId]));
        if (identityRows.length !== 1) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
        const roleRows = rows(await transaction.query("SELECT id FROM iam.roles WHERE role_key=$1 AND system_role=true", [roleKey]));
        if (roleRows.length !== 1) throw new IdentityRepositoryError("role_not_found", "Role not found");
        const teamKey = teamRows[0].team_key;
        const present = rows(await transaction.query(`SELECT binding.id,role.role_key FROM iam.role_bindings binding
          JOIN iam.roles role ON role.id=binding.role_id
          WHERE binding.identity_id=$1 AND binding.scope_kind='team' AND binding.scope_key=$2 FOR UPDATE`, [identityId, teamKey]));
        if ((!granted && present.length === 0) || (granted && present[0]?.role_key === roleKey)) {
          return { team: (await listTeams(transaction)).find((item) => item.id === teamId), changed: false };
        }
        if (present[0]?.role_key === "team_admin" && (!granted || roleKey !== "team_admin")) {
          const adminCount = rows(await transaction.query(`SELECT count(*)::bigint AS count FROM iam.role_bindings binding
            JOIN iam.roles role ON role.id=binding.role_id
            WHERE binding.scope_kind='team' AND binding.scope_key=$1 AND role.role_key='team_admin'
              AND (binding.expires_at IS NULL OR binding.expires_at > $2)`, [teamKey, at]));
          if (Number(adminCount[0]?.count ?? 0) <= 1) throw new IdentityRepositoryError("last_team_admin", "The last team administrator cannot be removed");
        }
        await transaction.query("DELETE FROM iam.role_bindings WHERE identity_id=$1 AND scope_kind='team' AND scope_key=$2", [identityId, teamKey]);
        if (granted) await transaction.query(`INSERT INTO iam.role_bindings
          (identity_id,role_id,scope_kind,scope_key,granted_by,granted_at,expires_at)
          VALUES ($1,$2,'team',$3,$4,$5,NULL)`, [identityId, roleRows[0].id, teamKey, actorIdentityId, at]);
        await transaction.query("UPDATE iam.teams SET updated_at=$2 WHERE id=$1", [teamId, at]);
        return { team: (await listTeams(transaction)).find((item) => item.id === teamId), changed: true };
      });
    } catch (error) {
      if (error instanceof IdentityRepositoryError) throw error;
      if (error?.code === "23505") throw new IdentityRepositoryError("team_membership_conflict", "Team membership changed concurrently");
      throw error;
    }
  }

  async publicIdentitiesByIds(identityIds) {
    if (identityIds.length === 0) return [];
    return rows(await this.#database.query(`
      SELECT id,login_name,display_name
      FROM iam.identities
      WHERE id=ANY($1::uuid[]) AND identity_kind='local_user' AND status='active'
      ORDER BY display_name,id`, [identityIds])).map((row) => ({
      id: row.id, loginName: row.login_name, displayName: row.display_name,
    }));
  }

  async listPublicIdentities(limit, after = 0) {
    return rows(await this.#database.query(`
      SELECT id,login_name,display_name
      FROM iam.identities
      WHERE identity_kind='local_user' AND status='active'
        AND lower(login_name) NOT LIKE 'catalog-%'
      ORDER BY display_name,id LIMIT $1 OFFSET $2`, [limit, after])).map((row) => ({
      id: row.id, loginName: row.login_name, displayName: row.display_name,
    }));
  }

  async searchPublicIdentities(query, limit) {
    return rows(await this.#database.query(`
      SELECT id,login_name,display_name
      FROM iam.identities
      WHERE identity_kind='local_user' AND status='active'
        AND (display_name ILIKE '%' || $1 || '%' OR login_name ILIKE '%' || $1 || '%')
      ORDER BY display_name,id LIMIT $2`, [query, limit])).map((row) => ({
      id: row.id, loginName: row.login_name, displayName: row.display_name,
    }));
  }

  async networkThrottle(networkHash, now) {
    const result = await this.#database.query(`
      SELECT * FROM iam.login_rate_limits
      WHERE network_hash = $1 AND blocked_until > $2`, [digestBytes(networkHash), now]);
    return failureState(rows(result)[0]);
  }

  async accountThrottle(identityId, now) {
    const result = await this.#database.query(`
      SELECT * FROM iam.authentication_states
      WHERE identity_id = $1 AND locked_until > $2`, [identityId, now]);
    return failureState(rows(result)[0]);
  }

  async recordFailedLogin(identityId, networkHash, now, policy) {
    return this.#database.transaction(async (transaction) => {
      const networkKey = `identity:network-throttle:${networkHash}`;
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [networkKey]);
      if (identityId) {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `identity:account-throttle:${identityId}`,
        ]);
      }
      const networkCurrent = failureState(rows(await transaction.query(`
        SELECT * FROM iam.login_rate_limits
        WHERE network_hash = $1 FOR UPDATE`, [digestBytes(networkHash)]))[0]);
      const network = advancedCounter(networkCurrent, now, policy.failureWindowMs);
      network.failures += 1;
      if (network.failures >= policy.networkFailureLimit) {
        network.blockedUntil = new Date(now.getTime() + policy.networkBlockMs);
      }
      await transaction.query(`
        INSERT INTO iam.login_rate_limits (
          network_hash, failed_attempts, window_started_at, blocked_until, last_failed_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (network_hash) DO UPDATE SET
          failed_attempts = EXCLUDED.failed_attempts,
          window_started_at = EXCLUDED.window_started_at,
          blocked_until = EXCLUDED.blocked_until,
          last_failed_at = EXCLUDED.last_failed_at`, [
        digestBytes(networkHash), network.failures, network.windowStartedAt, network.blockedUntil, now,
      ]);

      let account = null;
      if (identityId) {
        const accountCurrent = failureState(rows(await transaction.query(`
          SELECT * FROM iam.authentication_states
          WHERE identity_id = $1 FOR UPDATE`, [identityId]))[0]);
        account = advancedCounter(accountCurrent, now, policy.failureWindowMs);
        account.failures += 1;
        if (account.failures >= policy.accountFailureLimit) {
          account.blockedUntil = new Date(now.getTime() + policy.accountLockMs);
        }
        await transaction.query(`
          UPDATE iam.authentication_states SET
            failed_attempts = $2,
            failure_window_started_at = $3,
            locked_until = $4,
            last_failed_at = $5
          WHERE identity_id = $1`, [
          identityId, account.failures, account.windowStartedAt, account.blockedUntil, now,
        ]);
      }
      return { network, account };
    });
  }

  async clearFailedLogins(identityId, networkHash, now) {
    await this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `identity:network-throttle:${networkHash}`,
      ]);
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `identity:account-throttle:${identityId}`,
      ]);
      await transaction.query(`
        UPDATE iam.authentication_states SET
          failed_attempts = 0,
          failure_window_started_at = NULL,
          locked_until = NULL,
          last_authenticated_at = $2
        WHERE identity_id = $1`, [identityId, now]);
      await transaction.query(`
        INSERT INTO iam.login_rate_limits (
          network_hash, failed_attempts, window_started_at, blocked_until, last_failed_at
        ) VALUES ($1, 0, $2, NULL, $2)
        ON CONFLICT (network_hash) DO UPDATE SET
          failed_attempts = 0,
          window_started_at = EXCLUDED.window_started_at,
          blocked_until = NULL`, [digestBytes(networkHash), now]);
    });
  }

  async createSession(value) {
    try {
      await this.#database.query(`
        INSERT INTO iam.sessions (
          id, identity_id, token_hash, csrf_hash, password_version,
          user_agent_hash, network_hash, created_at, last_seen_at,
          idle_expires_at, expires_at, revoked_at, revoke_reason
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )`, [
        value.id,
        value.identityId,
        digestBytes(value.tokenHash),
        digestBytes(value.csrfHash),
        value.passwordVersion,
        digestBytes(value.userAgentHash),
        digestBytes(value.networkHash),
        value.createdAt,
        value.lastSeenAt,
        value.idleExpiresAt,
        value.expiresAt,
        value.revokedAt,
        value.revokeReason,
      ]);
    } catch (error) {
      if (error?.code === "23505") {
        throw new IdentityRepositoryError("session_collision", "Session collision");
      }
      throw error;
    }
  }

  async findSession(tokenHash) {
    const result = await this.#database.query(`
      SELECT session.id AS session_id,
             session.identity_id,
             session.token_hash,
             session.csrf_hash,
             session.password_version AS session_password_version,
             session.user_agent_hash,
             session.network_hash,
             session.created_at AS session_created_at,
             session.last_seen_at,
             session.idle_expires_at,
             session.expires_at,
             session.revoked_at,
             session.revoke_reason,
             identity.*,
             authentication.last_authenticated_at,
             COALESCE(
               array_agg(DISTINCT role.role_key ORDER BY role.role_key)
                 FILTER (WHERE role.role_key IS NOT NULL),
               ARRAY[]::text[]
             ) AS roles
      FROM iam.sessions session
      JOIN iam.identities identity ON identity.id = session.identity_id
      LEFT JOIN iam.authentication_states authentication
        ON authentication.identity_id = identity.id
      LEFT JOIN iam.role_bindings binding
        ON binding.identity_id = identity.id
       AND binding.scope_kind = 'appliance'
       AND binding.scope_key = '*'
       AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
      LEFT JOIN iam.roles role ON role.id = binding.role_id
      WHERE session.token_hash = $1
      GROUP BY session.id, identity.id, authentication.identity_id`, [digestBytes(tokenHash)]);
    const row = rows(result)[0];
    return row ? { session: session(row), identity: identity(row) } : null;
  }

  async touchSession(tokenHash, at, idleExpiresAt) {
    const result = await this.#database.query(`
      UPDATE iam.sessions SET last_seen_at = $2, idle_expires_at = $3
      WHERE token_hash = $1 AND revoked_at IS NULL`, [digestBytes(tokenHash), at, idleExpiresAt]);
    return Number(result.rowCount ?? 0) === 1;
  }

  async revokeSession(tokenHash, at, reason) {
    const result = await this.#database.query(`
      UPDATE iam.sessions SET revoked_at = $2, revoke_reason = $3
      WHERE token_hash = $1 AND revoked_at IS NULL`, [digestBytes(tokenHash), at, reason]);
    return Number(result.rowCount ?? 0) === 1;
  }

  async revokeIdentitySessions(identityId, at, reason) {
    const result = await this.#database.query(`
      UPDATE iam.sessions SET revoked_at = $2, revoke_reason = $3
      WHERE identity_id = $1 AND revoked_at IS NULL`, [identityId, at, reason]);
    return Number(result.rowCount ?? 0);
  }

  async disableIdentity(identityId, at) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["identity:active-owners"]);
      const current = await findIdentity(transaction, "identity.id = $1", [identityId]);
      if (!current) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
      if (current.roles.includes("owner")) {
        const ownerCount = rows(await transaction.query(`
          SELECT count(DISTINCT identity.id)::bigint AS count
          FROM iam.identities identity
          JOIN iam.role_bindings binding ON binding.identity_id = identity.id
          JOIN iam.roles role ON role.id = binding.role_id
          WHERE identity.status = 'active'
            AND role.role_key = 'owner'
            AND binding.scope_kind = 'appliance'
            AND binding.scope_key = '*'
            AND (binding.expires_at IS NULL OR binding.expires_at > $1)`, [at]));
        if (Number(ownerCount[0]?.count ?? 0) <= 1) {
          throw new IdentityRepositoryError("last_owner", "The last active owner cannot be disabled");
        }
      }
      await transaction.query(`
        UPDATE iam.identities SET status = 'disabled', disabled_at = $2, updated_at = $2
        WHERE id = $1`, [identityId, at]);
      await transaction.query(`
        UPDATE iam.sessions SET revoked_at = $2, revoke_reason = 'account_disabled'
        WHERE identity_id = $1 AND revoked_at IS NULL`, [identityId, at]);
      return findIdentity(transaction, "identity.id = $1", [identityId]);
    });
  }

  async enableIdentity(identityId, at) {
    return this.#database.transaction(async (transaction) => {
      const current = await findIdentity(transaction, "identity.id = $1", [identityId]);
      if (!current) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
      await transaction.query(`
        UPDATE iam.identities SET status = 'active', disabled_at = NULL, updated_at = $2
        WHERE id = $1`, [identityId, at]);
      await transaction.query(`
        UPDATE iam.authentication_states SET
          failed_attempts = 0, failure_window_started_at = NULL, locked_until = NULL
        WHERE identity_id = $1`, [identityId]);
      return findIdentity(transaction, "identity.id = $1", [identityId]);
    });
  }

  async resetIdentityPassword(identityId, passwordHash, at) {
    return this.#database.transaction(async (transaction) => {
      const current = await findIdentity(transaction, "identity.id = $1", [identityId]);
      if (!current) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
      await transaction.query(`
        UPDATE iam.identities SET
          password_hash = $2, password_version = password_version + 1, updated_at = $3
        WHERE id = $1`, [identityId, passwordHash, at]);
      await transaction.query(`
        UPDATE iam.authentication_states SET
          failed_attempts = 0,
          failure_window_started_at = NULL,
          locked_until = NULL,
          password_changed_at = $2
        WHERE identity_id = $1`, [identityId, at]);
      await transaction.query(`
        UPDATE iam.sessions SET revoked_at = $2, revoke_reason = 'administrator_password_reset'
        WHERE identity_id = $1 AND revoked_at IS NULL`, [identityId, at]);
      return findIdentity(transaction, "identity.id = $1", [identityId]);
    });
  }

  async updatePreferredLocale(identityId, preferredLocale, at) {
    const result = await this.#database.query(`
      UPDATE iam.identities SET preferred_locale = $2, preferred_locale_explicit = true, updated_at = $3
      WHERE id = $1 RETURNING id`, [identityId, preferredLocale, at]);
    if (rows(result).length === 0) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    return this.findIdentity(identityId);
  }

  async updatePreferredTheme(identityId, preferredTheme, at) {
    const result = await this.#database.query(`
      UPDATE iam.identities SET preferred_theme = $2, updated_at = $3
      WHERE id = $1 RETURNING id`, [identityId, preferredTheme, at]);
    if (rows(result).length === 0) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    return this.findIdentity(identityId);
  }

  async replaceRecoveryCodes(identityId, recoveryCodeHashes, now) {
    await this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `identity:owner-recovery:${identityId}`,
      ]);
      const current = await findIdentity(transaction, "identity.id = $1", [identityId]);
      if (!current?.roles.includes("owner")) {
        throw new IdentityRepositoryError("owner_required", "Recovery codes require an owner");
      }
      const generationRows = rows(await transaction.query(`
        SELECT COALESCE(max(generation), 0)::integer AS generation
        FROM iam.owner_recovery_codes WHERE identity_id = $1`, [identityId]));
      const generation = Number(generationRows[0].generation) + 1;
      await transaction.query(`
        UPDATE iam.owner_recovery_codes SET invalidated_at = $2
        WHERE identity_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`, [identityId, now]);
      await insertRecoveryCodes(transaction, identityId, recoveryCodeHashes, generation, now);
    });
  }

  async recoverOwner({ codeHash, passwordHash, replacementCodeHashes, now }) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `identity:recovery-code:${codeHash}`,
      ]);
      const records = rows(await transaction.query(`
        SELECT recovery.id AS recovery_id,
               recovery.identity_id,
               recovery.generation
        FROM iam.owner_recovery_codes recovery
        JOIN iam.identities identity ON identity.id = recovery.identity_id
        JOIN iam.role_bindings binding ON binding.identity_id = identity.id
        JOIN iam.roles role ON role.id = binding.role_id
        WHERE recovery.code_hash = $1
          AND recovery.used_at IS NULL
          AND recovery.invalidated_at IS NULL
          AND role.role_key = 'owner'
          AND binding.scope_kind = 'appliance'
          AND binding.scope_key = '*'
          AND (binding.expires_at IS NULL OR binding.expires_at > $2)
        FOR UPDATE OF recovery, identity`, [digestBytes(codeHash), now]));
      const record = records[0];
      if (!record) {
        throw new IdentityRepositoryError("invalid_recovery_code", "Recovery code is invalid");
      }
      await transaction.query(`
        UPDATE iam.owner_recovery_codes SET used_at = $2
        WHERE id = $1`, [record.recovery_id, now]);
      await transaction.query(`
        UPDATE iam.owner_recovery_codes SET invalidated_at = $2
        WHERE identity_id = $1 AND id <> $3
          AND used_at IS NULL AND invalidated_at IS NULL`, [record.identity_id, now, record.recovery_id]);
      await transaction.query(`
        UPDATE iam.identities SET
          password_hash = $2,
          password_version = password_version + 1,
          status = 'active',
          disabled_at = NULL,
          updated_at = $3
        WHERE id = $1`, [record.identity_id, passwordHash, now]);
      await transaction.query(`
        UPDATE iam.authentication_states SET
          failed_attempts = 0,
          failure_window_started_at = NULL,
          locked_until = NULL,
          password_changed_at = $2
        WHERE identity_id = $1`, [record.identity_id, now]);
      await transaction.query(`
        UPDATE iam.sessions SET revoked_at = $2, revoke_reason = 'owner_recovery'
        WHERE identity_id = $1 AND revoked_at IS NULL`, [record.identity_id, now]);
      await insertRecoveryCodes(
        transaction,
        record.identity_id,
        replacementCodeHashes,
        Number(record.generation) + 1,
        now,
      );
      return findIdentity(transaction, "identity.id = $1", [record.identity_id]);
    });
  }
}
