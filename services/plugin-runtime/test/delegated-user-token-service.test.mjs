import assert from "node:assert/strict";
import test from "node:test";

import {
  DelegatedUserTokenError,
  DelegatedUserTokenService,
} from "../src/delegated-user-token-service.mjs";
import { MemoryPluginAccessRepository } from "../src/memory-plugin-access-repository.mjs";

const identityId = "00000000-0000-7000-8000-000000000801";
const sessionId = "00000000-0000-7000-8000-000000000802";
const pluginId = "example.team-notes";
const fixedNow = new Date("2026-08-11T02:00:00.000Z");

function plugin() {
  return {
    pluginId,
    pluginType: "ApplicationPlugin",
    lifecycleState: "enabled",
    currentVersion: "1.2.3",
    generation: 4,
    manifest: {
      permissions: {
        delegatedUserToken: true,
        platformApiScopes: ["files:read", "files:write"],
      },
    },
  };
}

function fixture() {
  const repository = new MemoryPluginAccessRepository();
  repository.seedPlugin(plugin());
  const audits = [];
  const state = { sessionActive: true, allowed: new Set(["file:read", "file:write"]) };
  const accessControl = {
    async resolveSession(context) {
      if (context?.sessionId !== sessionId || !state.sessionActive) return null;
      return { identityId, sessionId, identityKind: "local_user", status: "active", principal: { id: identityId } };
    },
    async loadSession(requestedIdentity, requestedSession) {
      if (!state.sessionActive || requestedIdentity !== identityId || requestedSession !== sessionId) return null;
      return { identityId, sessionId, identityKind: "local_user", status: "active", principal: { id: identityId } };
    },
    async authorize({ permission }) { return state.allowed.has(permission); },
  };
  let tokenSequence = 7;
  const service = new DelegatedUserTokenService({
    repository,
    accessControl,
    authorityVerifier: {
      async verify(authority, request) {
        if (authority !== "internal-authority") throw new Error("unverified authority");
        return request;
      },
    },
    auditSink: { async record(event) { audits.push(event); } },
    tokenPepper: Buffer.alloc(32, 9),
    tokenFactory: () => Buffer.alloc(32, tokenSequence++).toString("base64url"),
    clock: () => fixedNow,
  });
  return { repository, service, state, audits };
}

function grants() {
  return [
    { scope: "files:read", resource: { kind: "team", key: "team-alpha" } },
    { scope: "files:write", resource: { kind: "team", key: "team-alpha" } },
  ];
}

test("ApplicationPlugin receives a short-lived opaque user delegation shown only once", async () => {
  const { repository, service, audits } = fixture();
  const issued = await service.issue({ context: { sessionId }, pluginId, grants: grants() });
  assert.match(issued.token, /^taibp_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.delegation.audience, `plugin:${pluginId}`);
  assert.equal(issued.delegation.pluginGeneration, 4);
  assert.deepEqual(issued.delegation.grants.map(({ scope }) => scope), ["files:read", "files:write"]);
  assert.equal(new Date(issued.delegation.expiresAt) - fixedNow, 120_000);
  const stored = await repository.getDelegation(issued.delegation.delegationId);
  assert.equal(stored.tokenHash.length, 64);
  assert.equal(JSON.stringify(stored).includes(issued.token), false);
  assert.equal(JSON.stringify(audits).includes(issued.token), false);
  assert.equal(audits[0].action, "plugin.delegation.issued");
});

test("delegated authentication binds user session, plugin generation, exact scope, and live authorization", async () => {
  const { repository, service, state } = fixture();
  const issued = await service.issue({ context: { sessionId }, pluginId, grants: grants() });
  const context = await service.authenticate({
    token: issued.token,
    pluginId,
    requiredScope: "files:read",
    resource: { kind: "team", key: "team-alpha" },
  });
  assert.deepEqual(context, {
    identityId,
    identityKind: "local_user",
    delegatedBySessionId: sessionId,
    submittedByPluginId: pluginId,
    delegationId: issued.delegation.delegationId,
    permission: "file:read",
    resource: { kind: "team", key: "team-alpha" },
  });
  state.allowed.delete("file:read");
  await assert.rejects(
    service.authenticate({ token: issued.token, pluginId, requiredScope: "files:read", resource: { kind: "team", key: "team-alpha" } }),
    (error) => error.code === "plugin_delegation_scope_revoked",
  );
  state.allowed.add("file:read");
  const upgraded = plugin();
  upgraded.generation = 5;
  upgraded.currentVersion = "1.3.0";
  repository.seedPlugin(upgraded);
  await assert.rejects(
    service.authenticate({ token: issued.token, pluginId, requiredScope: "files:read", resource: { kind: "team", key: "team-alpha" } }),
    (error) => error.code === "plugin_delegation_stale",
  );
});

test("undeclared, unsupported, unauthorized, duplicate, and cross-team grants fail closed", async () => {
  const { service, state } = fixture();
  for (const grantSet of [
    [{ scope: "admin:root", resource: { kind: "appliance", key: "*" } }],
    [{ scope: "files:delete", resource: { kind: "team", key: "team-alpha" } }],
    [grants()[0], grants()[0]],
  ]) {
    await assert.rejects(service.issue({ context: { sessionId }, pluginId, grants: grantSet }), DelegatedUserTokenError);
  }
  state.allowed.delete("file:write");
  await assert.rejects(
    service.issue({ context: { sessionId }, pluginId, grants: grants() }),
    (error) => error.code === "plugin_delegation_scope_denied",
  );
  state.allowed.add("file:write");
  const issued = await service.issue({ context: { sessionId }, pluginId, grants: grants() });
  await assert.rejects(
    service.authenticate({ token: issued.token, pluginId, requiredScope: "files:read", resource: { kind: "team", key: "team-other" } }),
    (error) => error.code === "plugin_delegation_scope_denied",
  );
});

test("user, identity service, and plugin lifecycle revocation are immediate and audited without token material", async () => {
  const { service, audits } = fixture();
  const first = await service.issue({ context: { sessionId }, pluginId, grants: grants() });
  assert.equal((await service.revoke({ context: { sessionId }, delegationId: first.delegation.delegationId })).revoked, true);
  await assert.rejects(
    service.authenticate({ token: first.token, pluginId, requiredScope: "files:read", resource: { kind: "team", key: "team-alpha" } }),
    (error) => error.code === "plugin_delegation_invalid",
  );
  await service.issue({ context: { sessionId }, pluginId, grants: grants() });
  assert.equal((await service.revokeForSession({ authority: "internal-authority", identityId, sessionId })).count, 1);
  await service.issue({ context: { sessionId }, pluginId, grants: grants() });
  assert.equal((await service.revokeForPlugin({ authority: "internal-authority", pluginId })).count, 1);
  assert.equal(JSON.stringify(audits).includes(first.token), false);
});

test("ComputePlugin can never obtain a delegated user token", async () => {
  const { repository, service } = fixture();
  const compute = plugin();
  compute.pluginType = "ComputePlugin";
  compute.manifest.permissions.delegatedUserToken = false;
  repository.seedPlugin(compute);
  await assert.rejects(
    service.issue({ context: { sessionId }, pluginId, grants: grants() }),
    (error) => error.code === "plugin_delegation_unavailable",
  );
});
