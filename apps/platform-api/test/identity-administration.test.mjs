import assert from "node:assert/strict";
import { test } from "node:test";

import { IdentityAdministrationHttpApi, matchesIdentityAdministrationHttpRoute } from "../src/identity/identity-administration-http-api.mjs";
import { IdentityAdministrationService } from "../src/identity/identity-administration-service.mjs";
import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { PasswordHasher } from "../src/identity/password.mjs";
import { roles } from "../../../packages/authorization/src/index.mjs";

const ownerPassword = "correct horse battery staple";
const initialPassword = "member starts with a secure passphrase";
const replacementPassword = "member receives another secure passphrase";

function testHasher() {
  return new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 });
}

async function fixture() {
  const repository = new MemoryIdentityRepository();
  const hasher = testHasher();
  const audit = [];
  const authentication = await LocalAuthentication.create({ repository, hasher });
  const owner = await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password: ownerPassword });
  const service = new IdentityAdministrationService({ repository, hasher, audit: async (event) => audit.push(event) });
  const ownerContext = { identityId: owner.identity.id, permissions: [...roles.owner.permissions], roles: ["owner"] };
  return { repository, authentication, service, api: new IdentityAdministrationHttpApi({ service }), audit, ownerContext, owner };
}

test("matches only the bounded identity administration routes", () => {
  assert.equal(matchesIdentityAdministrationHttpRoute("GET", "/api/v1/admin/users"), true);
  assert.equal(matchesIdentityAdministrationHttpRoute("POST", "/api/v1/admin/users"), true);
  assert.equal(matchesIdentityAdministrationHttpRoute("POST", "/api/v1/admin/users/018f6f18-24d7-7c21-9b62-8c0174199591/reset-password"), true);
  assert.equal(matchesIdentityAdministrationHttpRoute("GET", "/api/v1/admin/roles"), true);
  assert.equal(matchesIdentityAdministrationHttpRoute("POST", "/api/v1/admin/roles/developer/grants"), true);
  assert.equal(matchesIdentityAdministrationHttpRoute("GET", "/api/v1/admin/teams"), true);
  assert.equal(matchesIdentityAdministrationHttpRoute("POST", "/api/v1/admin/teams/018f6f18-24d7-7c21-9b62-8c0174199591/members"), true);
  assert.equal(matchesIdentityAdministrationHttpRoute("DELETE", "/api/v1/admin/users/018f6f18-24d7-7c21-9b62-8c0174199591"), false);
});

test("creates, lists, disables, enables, and resets a durable local member with audit", async () => {
  const { service, authentication, ownerContext, audit } = await fixture();
  const created = await service.createLocalMember({ context: ownerContext, loginName: "MEI", displayName: "Mei", password: initialPassword });
  assert.equal(created.loginName, "mei");
  assert.deepEqual(created.roles, ["member"]);
  const memberSession = await authentication.signIn({ loginName: "mei", password: initialPassword, networkIdentifier: "member-browser" });

  const listed = await service.list({ context: ownerContext });
  assert.deepEqual(listed.map((identity) => identity.loginName).sort(), ["mei", "owner"]);

  await service.setStatus({ context: ownerContext, identityId: created.id, status: "disabled" });
  await assert.rejects(authentication.authenticateSession({ sessionToken: memberSession.sessionToken }), (error) => error.code === "invalid_session");
  await assert.rejects(authentication.signIn({ loginName: "mei", password: initialPassword, networkIdentifier: "member-browser" }), (error) => error.code === "invalid_credentials");

  await service.setStatus({ context: ownerContext, identityId: created.id, status: "active" });
  const enabledSession = await authentication.signIn({ loginName: "mei", password: initialPassword, networkIdentifier: "member-browser" });
  await service.resetPassword({ context: ownerContext, identityId: created.id, password: replacementPassword });
  await assert.rejects(authentication.authenticateSession({ sessionToken: enabledSession.sessionToken }), (error) => error.code === "invalid_session");
  await assert.rejects(authentication.signIn({ loginName: "mei", password: initialPassword, networkIdentifier: "member-browser-2" }), (error) => error.code === "invalid_credentials");
  assert.equal((await authentication.signIn({ loginName: "mei", password: replacementPassword, networkIdentifier: "member-browser-3" })).identity.loginName, "mei");

  assert.deepEqual(audit.map((event) => event.action), [
    "identity.local_member_created",
    "identity.account_disabled",
    "identity.account_enabled",
    "identity.password_reset_by_administrator",
  ]);
  assert.equal(JSON.stringify(audit).includes(initialPassword), false);
  assert.equal(JSON.stringify(audit).includes(replacementPassword), false);
});

test("denies member administration, self-disable, final-owner disable, and weak passwords", async () => {
  const { service, ownerContext, owner, audit } = await fixture();
  await assert.rejects(service.list({ context: { identityId: "018f6f18-24d7-7c21-9b62-8c0174199594", permissions: [] } }), (error) => error.code === "access_denied");
  await assert.rejects(service.createLocalMember({ context: ownerContext, loginName: "bad", displayName: "Bad", password: "too short" }), (error) => error.code === "password_too_short");
  await assert.rejects(service.setStatus({ context: ownerContext, identityId: owner.identity.id, status: "disabled" }), (error) => error.code === "identity_self_disable_forbidden");
  assert.ok(audit.some((event) => event.action === "identity.accounts_listed" && event.outcome === "denied"));
  assert.ok(audit.some((event) => event.action === "identity.account_disabled" && event.outcome === "failed"));
});

test("serves list and mutations through the HTTP adapter", async () => {
  const { api, ownerContext } = await fixture();
  const created = await api.handle({ method: "POST", pathname: "/api/v1/admin/users", context: ownerContext, body: { loginName: "lin", displayName: "Lin", password: initialPassword } });
  assert.equal(created.status, 201);
  const listed = await api.handle({ method: "GET", pathname: "/api/v1/admin/users", context: ownerContext, query: new URLSearchParams("limit=20") });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 2);
});

test("account pages reach older owners beyond 200 without page-local totals or private fields", async () => {
  const { repository, api, ownerContext } = await fixture();
  for (let i = 0; i < 205; i++) {
    const name = `member-${String(i).padStart(3, "0")}`;
    await repository.insertIdentity({ loginName: name, normalizedLoginName: name,
      displayName: `Member ${i}`, passwordHash: "never-public", status: "disabled",
      createdAt: new Date(Date.now() + 1000 + i) });
  }
  const page = async (q) => (await api.handle({ method: "GET", pathname: "/api/v1/admin/users",
    context: ownerContext, query: new URLSearchParams(q) })).body;
  const first = await page("limit=50");
  assert.equal(first.data.length, 50);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.summary, { total: 206, active: 1, owners: 1, matching: 206 });
  const last = await page("limit=50&offset=200");
  assert.equal(last.data.length, 6);
  assert.equal(last.hasMore, false);
  assert.equal(last.data.at(-1).loginName, "owner");
  assert.equal(JSON.stringify(last).includes("never-public"), false);
  const search = await page("limit=50&q=OwNeR");
  assert.equal(search.data[0].loginName, "owner");
  assert.equal(search.summary.matching, 1);
  assert.equal(search.summary.total, 206);
  assert.equal((await page("q=%25")).data.length, 0, "search wildcard is literal");
  const beyond = await page("offset=9999");
  assert.equal(beyond.data.length, 0);
  assert.equal(beyond.summary.total, 206);
  for (const offset of ["-1", "1.5", "9007199254740992", "1e2"]) {
    await assert.rejects(page(`offset=${offset}`), { code: "identity_query_invalid" });
  }
  for (const resource of ["roles", "teams"]) {
    const directory = async (query) => (await api.handle({ method: "GET",
      pathname: `/api/v1/admin/${resource}`, context: ownerContext,
      query: new URLSearchParams(query) })).body;
    const last = await directory("limit=50&offset=200");
    assert.equal(last.identities.at(-1).loginName, "owner");
    assert.deepEqual(last.identityPage, { offset: 200, limit: 50, hasMore: false, total: 206 });
    const matched = await directory("q=OwNeR");
    assert.equal(matched.identities.length, 1);
    assert.equal(matched.identities[0].loginName, "owner");
    assert.equal(JSON.stringify(matched).includes("never-public"), false);
    assert.equal((await directory("q=%25")).identityPage.total, 0);
    await assert.rejects(directory("offset=-1"), { code: "identity_query_invalid" });
  }
});

test("ordinary members cannot access paginated account summaries", async () => {
  const { service } = await fixture();
  await assert.rejects(service.listPage({ context: { identityId: "test-member", permissions: [] } }),
    { code: "access_denied" });
});

test("lists fixed roles and applies durable grants and revocations to an existing session immediately", async () => {
  const { service, authentication, ownerContext, audit } = await fixture();
  const member = await service.createLocalMember({ context: ownerContext, loginName: "rui", displayName: "Rui", password: initialPassword });
  const signedIn = await authentication.signIn({ loginName: "rui", password: initialPassword, networkIdentifier: "rui-browser" });
  const listed = await service.listRoles({ context: ownerContext });
  assert.deepEqual(listed.roles.map((role) => role.roleKey).sort(), Object.keys(roles).sort());
  assert.equal(listed.roles.every((role) => role.systemRole && role.permissions.length > 0), true);

  const granted = await service.setRole({ context: ownerContext, identityId: member.id, roleKey: "developer", granted: true });
  assert.equal(granted.changed, true);
  assert.deepEqual(granted.identity.roles, ["developer", "member"]);
  const elevated = await authentication.authenticateSession({ sessionToken: signedIn.sessionToken });
  assert.equal(elevated.permissions.includes("developer_credential:create"), true);

  const revoked = await service.setRole({ context: ownerContext, identityId: member.id, roleKey: "developer", granted: false });
  assert.equal(revoked.changed, true);
  assert.deepEqual(revoked.identity.roles, ["member"]);
  const reduced = await authentication.authenticateSession({ sessionToken: signedIn.sessionToken });
  assert.equal(reduced.permissions.includes("developer_credential:create"), false);
  assert.deepEqual(audit.slice(-2).map((event) => event.action), ["authorization.role_granted", "authorization.role_revoked"]);
});

test("role changes deny escalation, owner mutation by non-owner, self lockout, and removal of the final binding", async () => {
  const { service, ownerContext, owner } = await fixture();
  const member = await service.createLocalMember({ context: ownerContext, loginName: "yan", displayName: "Yan", password: initialPassword });
  const limited = { identityId: member.id, roles: ["system_admin"], permissions: [...roles.system_admin.permissions] };
  await assert.rejects(service.setRole({ context: limited, identityId: member.id, roleKey: "owner", granted: true }), (error) => error.code === "role_escalation_forbidden");
  await assert.rejects(service.setRole({ context: limited, identityId: owner.identity.id, roleKey: "owner", granted: false }), (error) => error.code === "role_escalation_forbidden");
  await assert.rejects(service.setRole({ context: ownerContext, identityId: owner.identity.id, roleKey: "owner", granted: false }), (error) => error.code === "role_self_lockout_forbidden");
  await assert.rejects(service.setRole({ context: ownerContext, identityId: member.id, roleKey: "member", granted: false }), (error) => error.code === "role_last_binding");
});

test("serves role inventory and one exact grant mutation through the HTTP adapter", async () => {
  const { api, service, ownerContext } = await fixture();
  const member = await service.createLocalMember({ context: ownerContext, loginName: "tao", displayName: "Tao", password: initialPassword });
  const listed = await api.handle({ method: "GET", pathname: "/api/v1/admin/roles", context: ownerContext, query: new URLSearchParams("limit=20") });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.roles.length, Object.keys(roles).length);
  const grant = await api.handle({ method: "POST", pathname: "/api/v1/admin/roles/compute_admin/grants", context: ownerContext, body: { identityId: member.id, granted: true } });
  assert.equal(grant.status, 200);
  assert.deepEqual(grant.body.identity.roles, ["compute_admin", "member"]);
});

test("fails closed before listing or mutating when durable role policy drifts from runtime authorization", async () => {
  const { service, repository, ownerContext } = await fixture();
  const member = await service.createLocalMember({ context: ownerContext, loginName: "drift", displayName: "Drift", password: initialPassword });
  const original = repository.listAuthorizationRoles.bind(repository);
  repository.listAuthorizationRoles = async () => (await original()).map((role) => role.roleKey === "developer"
    ? { ...role, permissions: role.permissions.filter((permission) => permission !== "developer_credential:create") }
    : role);

  await assert.rejects(service.listRoles({ context: ownerContext }), (error) => error.code === "role_policy_drift" && error.status === 503);
  await assert.rejects(
    service.setRole({ context: ownerContext, identityId: member.id, roleKey: "developer", granted: true }),
    (error) => error.code === "role_policy_drift" && error.status === 503,
  );
  assert.deepEqual((await repository.findIdentity(member.id)).roles, ["member"]);
});

test("rejects appliance role bindings for non-user identities", async () => {
  const { service, repository, ownerContext } = await fixture();
  const serviceIdentity = await repository.insertIdentity({
    id: "018f6f18-24d7-7c21-9b62-8c0174199598",
    identityKind: "service_account",
    loginName: "worker-service",
    normalizedLoginName: "worker-service",
    displayName: "Worker service",
    passwordHash: "not-used",
    roles: ["member"],
  });
  await assert.rejects(
    service.setRole({ context: ownerContext, identityId: serviceIdentity.id, roleKey: "developer", granted: true }),
    (error) => error.code === "role_binding_invalid" && error.status === 400,
  );
});

test("lists the durable default team and confirms member add and remove with audit", async () => {
  const { service, authentication, ownerContext, audit } = await fixture();
  const member = await service.createLocalMember({ context: ownerContext, loginName: "team-member", displayName: "Team Member", password: initialPassword });
  const signedIn = await authentication.signIn({ loginName: "team-member", password: initialPassword, networkIdentifier: "team-member-browser" });
  const initial = await service.listTeams({ context: ownerContext });
  assert.equal(initial.teams.length, 1);
  assert.equal(initial.teams[0].teamKey, "team.default");
  assert.equal(initial.teams[0].members.some((item) => item.identity.id === member.id), true);
  const removed = await service.setTeamMembership({ context: ownerContext, teamId: initial.teams[0].id, identityId: member.id, roleKey: "member", granted: false });
  assert.equal(removed.changed, true);
  assert.equal(removed.team.members.some((item) => item.identity.id === member.id), false);
  assert.equal(Object.hasOwn((await authentication.authenticateSession({ sessionToken: signedIn.sessionToken })).teamRoles, "team.default"), false);
  const added = await service.setTeamMembership({ context: ownerContext, teamId: initial.teams[0].id, identityId: member.id, roleKey: "guest", granted: true });
  assert.equal(added.changed, true);
  assert.equal(added.team.members.find((item) => item.identity.id === member.id).roleKey, "guest");
  assert.equal((await authentication.authenticateSession({ sessionToken: signedIn.sessionToken })).teamRoles["team.default"], "guest");
  assert.deepEqual(audit.slice(-2).map((event) => event.action), ["team.member_removed", "team.member_added"]);
});

test("team membership denies ordinary users, escalation, and removal of the final team administrator", async () => {
  const { service, ownerContext, owner } = await fixture();
  const overview = await service.listTeams({ context: ownerContext });
  const teamId = overview.teams[0].id;
  await assert.rejects(service.listTeams({ context: { identityId: "018f6f18-24d7-7c21-9b62-8c0174199594", permissions: [] } }), (error) => error.code === "access_denied");
  await assert.rejects(service.setTeamMembership({ context: ownerContext, teamId, identityId: owner.identity.id, roleKey: "team_admin", granted: false }), (error) => error.code === "last_team_admin");
  await assert.rejects(service.setTeamMembership({ context: ownerContext, teamId, identityId: owner.identity.id, roleKey: "guest", granted: true }), (error) => error.code === "last_team_admin");
  const member = await service.createLocalMember({ context: ownerContext, loginName: "team-limited", displayName: "Team Limited", password: initialPassword });
  const limited = { identityId: member.id, roles: ["team_admin"], permissions: ["team:view", "team:manage"] };
  await assert.rejects(service.setTeamMembership({ context: limited, teamId, identityId: member.id, roleKey: "team_admin", granted: true }), (error) => error.code === "role_escalation_forbidden");
});

test("serves the team inventory and an exact membership mutation through the HTTP adapter", async () => {
  const { api, service, ownerContext } = await fixture();
  const member = await service.createLocalMember({ context: ownerContext, loginName: "team-http", displayName: "Team HTTP", password: initialPassword });
  const listed = await api.handle({ method: "GET", pathname: "/api/v1/admin/teams", context: ownerContext, query: new URLSearchParams("limit=20") });
  assert.equal(listed.status, 200);
  const team = listed.body.teams[0];
  const changed = await api.handle({ method: "POST", pathname: `/api/v1/admin/teams/${team.id}/members`, context: ownerContext, body: { identityId: member.id, roleKey: "member", granted: false } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.changed, true);
});
