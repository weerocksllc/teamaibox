import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresIdentityRepository } from "../src/identity/postgres-repository.mjs";
import { IdentityRepositoryError } from "../src/identity/repository-error.mjs";

const identityId = "018f6f18-24d7-7c21-9b62-8c0174199591";
const roleId = "018f6f18-24d7-7c21-9b62-8c0174199592";
const sessionId = "018f6f18-24d7-7c21-9b62-8c0174199593";
const now = new Date("2026-08-12T00:00:00.000Z");
const hash = (character) => character.repeat(64);

test('locale preference marks explicit intent and retains it on repository reload', async () => {
  let explicit=false;
  const database=new Database((sql,parameters)=>{
    if(sql.startsWith('UPDATE iam.identities SET preferred_locale')){
      assert.match(sql,/preferred_locale_explicit = true/);
      assert.deepEqual(parameters,[identityId,'ja',now]);explicit=true;
      return {rows:[{id:identityId}]};
    }
    return {rows:[identityRow({preferred_locale:explicit?'ja':'zh-CN',preferred_locale_explicit:explicit})]};
  });
  const repository=new PostgresIdentityRepository({database});
  assert.equal((await repository.findIdentity(identityId)).preferredLocaleExplicit,false);
  assert.equal((await repository.updatePreferredLocale(identityId,'ja',now)).preferredLocaleExplicit,true);
  assert.equal((await new PostgresIdentityRepository({database}).findIdentity(identityId)).preferredLocale,'ja');
});

function compact(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function identityRow(overrides = {}) {
  return {
    id: identityId,
    identity_kind: "local_user",
    login_name: "owner",
    normalized_login_name: "owner",
    display_name: "Owner",
    password_hash: "encoded-password-hash",
    password_version: 1,
    status: "active",
    disabled_at: null,
    preferred_locale: "zh-CN",
    preferred_theme: "system",
    roles: ["owner"],
    last_authenticated_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

class Database {
  calls = [];
  transactions = 0;

  constructor(handler) {
    this.handler = handler;
  }

  async query(sql, parameters = []) {
    const normalized = compact(sql);
    this.calls.push({ sql: normalized, parameters });
    return this.handler(normalized, parameters);
  }

  async transaction(operation) {
    this.transactions += 1;
    return operation({ query: (sql, parameters = []) => this.query(sql, parameters) });
  }
}

test("requires a transactional PostgreSQL adapter", () => {
  assert.throws(() => new PostgresIdentityRepository({ database: {} }), /query and transaction/);
});

test("account page SQL binds offset and literal search separately from global summary", async () => {
  const database = new Database((sql, parameters) => {
    if (sql.includes("AS matching")) {
      assert.deepEqual(parameters, ["owner%"]);
      assert.match(sql, /binding\.scope_kind = 'appliance'/);
      assert.match(sql, /binding\.expires_at > clock_timestamp\(\)/);
      return { rows: [{ total: 206, active: 1, owners: 1, matching: 0 }] };
    }
    assert.match(sql, /LIMIT \$1 OFFSET \$2/);
    assert.match(sql, /strpos\(lower/);
    assert.deepEqual(parameters, [50, 200, "owner%"]);
    return { rows: [identityRow()] };
  });
  const repository = new PostgresIdentityRepository({ database });
  assert.equal((await repository.listIdentities(50, { offset: 200, query: "owner%" }))[0].loginName, "owner");
  assert.deepEqual(await repository.identitySummary("owner%"), { total: 206, active: 1, owners: 1, matching: 0 });
});

test("reports durable bootstrap state without loading bootstrap secrets", async () => {
  const database = new Database(() => ({ rows: [{ owner_identity_id: identityId }] }));
  const state = await new PostgresIdentityRepository({ database }).bootstrapState();
  assert.deepEqual(state, { complete: true, ownerIdentityId: identityId });
  assert.equal(database.calls.length, 1);
});

test("serializes and persists the one-time appliance owner bootstrap", async () => {
  const database = new Database((sql) => {
    if (sql.includes("FROM iam.appliance_bootstrap")) return { rows: [] };
    if (sql === "SELECT count(*)::bigint AS count FROM iam.identities") return { rows: [{ count: "0" }] };
    if (sql.startsWith("INSERT INTO iam.identities")) return { rows: [{ id: identityId }] };
    if (sql === "SELECT id FROM iam.roles WHERE role_key = $1") return { rows: [{ id: roleId }] };
    if (sql.startsWith("SELECT identity.*")) return { rows: [identityRow()] };
    return { rows: [], rowCount: 1 };
  });
  const repository = new PostgresIdentityRepository({ database });
  const owner = await repository.bootstrapOwner({
    loginName: "owner",
    normalizedLoginName: "owner",
    displayName: "Owner",
    passwordHash: "encoded-password-hash",
    recoveryCodeHashes: [hash("a"), hash("b")],
    now,
  });

  assert.equal(database.transactions, 1);
  assert.deepEqual(owner.roles, ["owner"]);
  assert.ok(database.calls[0].sql.includes("pg_advisory_xact_lock"));
  assert.ok(database.calls.some(({ sql }) => sql.startsWith("INSERT INTO iam.appliance_bootstrap")));
  assert.equal(database.calls.filter(({ sql }) => sql.startsWith("INSERT INTO iam.owner_recovery_codes")).length, 2);
  assert.ok(database.calls.every(({ parameters }) => !parameters.includes(hash("a"))));
});

test("rejects a repeated or inconsistent owner bootstrap without mutation", async () => {
  const complete = new Database((sql) => sql.includes("FROM iam.appliance_bootstrap")
    ? { rows: [{ owner_identity_id: identityId }] }
    : { rows: [] });
  await assert.rejects(
    new PostgresIdentityRepository({ database: complete }).bootstrapOwner({
      loginName: "owner", normalizedLoginName: "owner", displayName: "Owner",
      passwordHash: "hash", recoveryCodeHashes: [], now,
    }),
    (error) => error instanceof IdentityRepositoryError && error.code === "bootstrap_complete",
  );
  assert.equal(complete.calls.some(({ sql }) => sql.startsWith("INSERT INTO")), false);

  const inconsistent = new Database((sql) => {
    if (sql.includes("FROM iam.appliance_bootstrap")) return { rows: [] };
    if (sql === "SELECT count(*)::bigint AS count FROM iam.identities") return { rows: [{ count: "1" }] };
    return { rows: [] };
  });
  await assert.rejects(
    new PostgresIdentityRepository({ database: inconsistent }).bootstrapOwner({
      loginName: "owner", normalizedLoginName: "owner", displayName: "Owner",
      passwordHash: "hash", recoveryCodeHashes: [], now,
    }),
    (error) => error instanceof IdentityRepositoryError && error.code === "bootstrap_inconsistent",
  );
});

test("persists concurrent account and network throttles with bounded windows", async () => {
  const database = new Database((sql) => {
    if (sql.includes("FROM iam.login_rate_limits") && sql.includes("FOR UPDATE")) {
      return { rows: [{ failed_attempts: 19, window_started_at: now, blocked_until: null }] };
    }
    if (sql.includes("FROM iam.authentication_states") && sql.includes("FOR UPDATE")) {
      return { rows: [{ failed_attempts: 4, failure_window_started_at: now, locked_until: null }] };
    }
    return { rows: [], rowCount: 1 };
  });
  const repository = new PostgresIdentityRepository({ database });
  const outcome = await repository.recordFailedLogin(identityId, hash("c"), now, {
    failureWindowMs: 15 * 60_000,
    networkFailureLimit: 20,
    networkBlockMs: 20_000,
    accountFailureLimit: 5,
    accountLockMs: 10_000,
  });

  assert.equal(outcome.network.failures, 20);
  assert.equal(outcome.network.blockedUntil.toISOString(), "2026-08-12T00:00:20.000Z");
  assert.equal(outcome.account.failures, 5);
  assert.equal(outcome.account.blockedUntil.toISOString(), "2026-08-12T00:00:10.000Z");
  assert.equal(database.calls.filter(({ sql }) => sql.includes("pg_advisory_xact_lock")).length, 2);
  assert.ok(database.calls.some(({ sql }) => sql.startsWith("INSERT INTO iam.login_rate_limits")));
  assert.ok(database.calls.some(({ sql }) => sql.startsWith("UPDATE iam.authentication_states SET")));
});

test("round-trips only hashed session material and supports durable revocation", async () => {
  const database = new Database((sql) => {
    if (sql.includes("FROM iam.sessions session")) {
      return { rows: [{
        ...identityRow(),
        session_id: sessionId,
        identity_id: identityId,
        token_hash: Buffer.from(hash("d"), "hex"),
        csrf_hash: Buffer.from(hash("e"), "hex"),
        session_password_version: 1,
        user_agent_hash: Buffer.from(hash("f"), "hex"),
        network_hash: Buffer.from(hash("1"), "hex"),
        session_created_at: now,
        last_seen_at: now,
        idle_expires_at: new Date(now.getTime() + 30_000),
        expires_at: new Date(now.getTime() + 60_000),
        revoked_at: null,
        revoke_reason: null,
      }] };
    }
    if (sql.startsWith("UPDATE iam.sessions")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const repository = new PostgresIdentityRepository({ database });
  await repository.createSession({
    id: sessionId,
    identityId,
    tokenHash: hash("d"),
    csrfHash: hash("e"),
    passwordVersion: 1,
    userAgentHash: hash("f"),
    networkHash: hash("1"),
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: new Date(now.getTime() + 30_000),
    expiresAt: new Date(now.getTime() + 60_000),
    revokedAt: null,
    revokeReason: null,
  });
  const found = await repository.findSession(hash("d"));
  assert.equal(found.session.tokenHash, hash("d"));
  assert.equal(found.session.csrfHash, hash("e"));
  assert.equal(found.identity.passwordHash, "encoded-password-hash");
  assert.equal(await repository.revokeSession(hash("d"), now, "user_sign_out"), true);
  assert.ok(database.calls.every(({ parameters }) => !parameters.includes(hash("d"))));
  await assert.rejects(repository.findSession("not-a-digest"), /lowercase SHA-256/);
});

test("protects the last active owner and revokes disabled-account sessions atomically", async () => {
  const ownerDatabase = new Database((sql) => {
    if (sql.startsWith("SELECT identity.*")) return { rows: [identityRow()] };
    if (sql.includes("count(DISTINCT identity.id)")) return { rows: [{ count: "1" }] };
    return { rows: [], rowCount: 1 };
  });
  await assert.rejects(
    new PostgresIdentityRepository({ database: ownerDatabase }).disableIdentity(identityId, now),
    (error) => error instanceof IdentityRepositoryError && error.code === "last_owner",
  );
  assert.equal(ownerDatabase.calls.some(({ sql }) => sql.startsWith("UPDATE iam.identities SET status")), false);

  let identityReads = 0;
  const memberDatabase = new Database((sql) => {
    if (sql.startsWith("SELECT identity.*")) {
      identityReads += 1;
      return { rows: [identityRow({
        login_name: "member",
        normalized_login_name: "member",
        roles: ["member"],
        status: identityReads === 1 ? "active" : "disabled",
        disabled_at: identityReads === 1 ? null : now,
      })] };
    }
    return { rows: [], rowCount: 1 };
  });
  const disabled = await new PostgresIdentityRepository({ database: memberDatabase })
    .disableIdentity(identityId, now);
  assert.equal(disabled.status, "disabled");
  assert.ok(memberDatabase.calls.some(({ sql }) => sql.includes("revoke_reason = 'account_disabled'")));
});

test("lists the durable fixed-role policy and active appliance binding counts", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT role.role_key")) return { rows: [{
      role_key: "developer",
      display_name_key: "roles.developer.name",
      description_key: "roles.developer.description",
      system_role: true,
      allowed_scopes: ["appliance"],
      permissions: ["ai:invoke", "developer_credential:create"],
      binding_count: "3",
    }] };
    return { rows: [] };
  });
  const listed = await new PostgresIdentityRepository({ database }).listAuthorizationRoles();
  assert.deepEqual(listed, [{
    roleKey: "developer",
    displayNameKey: "roles.developer.name",
    descriptionKey: "roles.developer.description",
    systemRole: true,
    allowedScopes: ["appliance"],
    permissions: ["ai:invoke", "developer_credential:create"],
    bindingCount: 3,
  }]);
  assert.ok(database.calls[0].sql.includes("binding.scope_kind = 'appliance'"));
  assert.ok(database.calls[0].sql.includes("binding.expires_at > clock_timestamp()"));
});

test("grants and revokes synchronized durable role bindings in one serialized transaction", async () => {
  let roles = ["member"];
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT identity.*")) return { rows: [identityRow({ login_name: "member", normalized_login_name: "member", roles })] };
    if (sql.startsWith("SELECT id FROM iam.roles WHERE role_key = $1 AND system_role = true")) return { rows: [{ id: roleId }] };
    if (sql.startsWith("SELECT id FROM iam.role_bindings")) return { rows: roles.includes("developer") ? [{ id: sessionId }] : [] };
    if (sql.startsWith("INSERT INTO iam.role_bindings")) roles = ["developer", "member"];
    if (sql.startsWith("DELETE FROM iam.role_bindings")) roles = ["member"];
    return { rows: [], rowCount: 1 };
  });
  const repository = new PostgresIdentityRepository({ database });
  const granted = await repository.setRoleBinding({ identityId, roleKey: "developer", granted: true, actorIdentityId: identityId, at: now });
  assert.equal(granted.changed, true);
  assert.deepEqual(granted.identity.roles, ["developer", "member"]);
  assert.ok(database.calls.some(({ sql }) => sql.startsWith("INSERT INTO iam.identity_roles")));
  assert.ok(database.calls.some(({ sql }) => sql.startsWith("INSERT INTO iam.role_bindings")));

  const revoked = await repository.setRoleBinding({ identityId, roleKey: "developer", granted: false, actorIdentityId: identityId, at: now });
  assert.equal(revoked.changed, true);
  assert.deepEqual(revoked.identity.roles, ["member"]);
  assert.ok(database.calls.some(({ sql }) => sql.startsWith("DELETE FROM iam.role_bindings")));
  assert.ok(database.calls.some(({ sql }) => sql.startsWith("DELETE FROM iam.identity_roles")));
  assert.equal(database.transactions, 2);
  assert.equal(database.calls.filter(({ sql }) => sql.includes("pg_advisory_xact_lock")).length, 4);
  assert.equal(database.calls.filter(({ parameters }) => parameters[0] === "identity:active-owners").length, 2);
});

test("lists teams and serializes one scoped membership replacement", async () => {
  let membership = "member";
  const database = new Database((sql) => {
    if (sql.includes("FROM iam.teams team")) return { rows: [{
      team_id: "018f6f18-24d7-7c21-9b62-8c0174199595", team_key: "team.default", display_name: "Default team", status: "active", system_team: true,
      created_at: now, updated_at: now, identity_id: identityId, identity_kind: "local_user", login_name: "member", normalized_login_name: "member", identity_display_name: "Member", identity_status: "active", disabled_at: null, preferred_locale: "zh-CN", preferred_theme: "system", identity_created_at: now, identity_updated_at: now, role_key: membership,
    }] };
    if (sql.startsWith("SELECT id,team_key FROM iam.teams")) return { rows: [{ id: "018f6f18-24d7-7c21-9b62-8c0174199595", team_key: "team.default" }] };
    if (sql.startsWith("SELECT id FROM iam.identities")) return { rows: [{ id: identityId }] };
    if (sql.startsWith("SELECT id FROM iam.roles")) return { rows: [{ id: roleId }] };
    if (sql.startsWith("SELECT binding.id")) return { rows: membership ? [{ id: sessionId, role_key: membership }] : [] };
    if (sql.startsWith("DELETE FROM iam.role_bindings")) membership = null;
    if (sql.startsWith("INSERT INTO iam.role_bindings")) membership = "guest";
    return { rows: [], rowCount: 1 };
  });
  const repository = new PostgresIdentityRepository({ database });
  assert.equal((await repository.listTeams())[0].members[0].roleKey, "member");
  const changed = await repository.setTeamMembership({ teamId: "018f6f18-24d7-7c21-9b62-8c0174199595", identityId, roleKey: "guest", granted: true, actorIdentityId: identityId, at: now });
  assert.equal(changed.changed, true);
  assert.equal(changed.team.members[0].roleKey, "guest");
  assert.ok(database.calls.some(({ parameters }) => parameters[0] === "identity:team:018f6f18-24d7-7c21-9b62-8c0174199595"));
});

test("loads only active scoped team memberships for the authenticated session", async () => {
  const database = new Database((sql) => sql.includes("FROM iam.role_bindings binding") ? { rows: [{ team_id: sessionId, team_key: "team.default", team_display_name: "Default team", role_key: "guest" }] } : { rows: [] });
  const memberships = await new PostgresIdentityRepository({ database }).listTeamMemberships(identityId);
  assert.deepEqual(memberships, [{ teamId: sessionId, teamKey: "team.default", teamDisplayName: "Default team", roleKey: "guest" }]);
  assert.ok(database.calls[0].sql.includes("binding.expires_at > clock_timestamp()"));
});

test("consumes one owner recovery code and replaces its generation in one transaction", async () => {
  const database = new Database((sql) => {
    if (sql.includes("FROM iam.owner_recovery_codes recovery")) {
      return { rows: [{ recovery_id: sessionId, identity_id: identityId, generation: 3 }] };
    }
    if (sql.startsWith("SELECT identity.*")) return { rows: [identityRow({ password_version: 2 })] };
    return { rows: [], rowCount: 1 };
  });
  const repository = new PostgresIdentityRepository({ database });
  const recovered = await repository.recoverOwner({
    codeHash: hash("2"),
    passwordHash: "replacement-password-hash",
    replacementCodeHashes: [hash("3"), hash("4")],
    now,
  });
  assert.equal(recovered.passwordVersion, 2);
  assert.equal(database.transactions, 1);
  const recoveryInserts = database.calls.filter(({ sql }) => sql.startsWith("INSERT INTO iam.owner_recovery_codes"));
  assert.equal(recoveryInserts.length, 2);
  assert.ok(recoveryInserts.every(({ parameters }) => parameters[2] === 4));
  assert.ok(database.calls.some(({ sql }) => sql.includes("revoke_reason = 'owner_recovery'")));
});
