import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  grantedPermissions,
  principalFromRoleKeys,
} from "../../../packages/authorization/src/index.mjs";
import { ApiCredentialService } from "../src/identity/api-credential-service.mjs";
import { MemoryCredentialRepository } from "../src/identity/memory-credential-repository.mjs";

const NOW = new Date("2026-08-10T00:00:00.000Z");

function localPrincipal(id, roleKeys) {
  return principalFromRoleKeys({ id, status: "active", identityKind: "local_user" }, roleKeys);
}

function contextFor(principal) {
  return {
    identityId: principal.id,
    permissions: grantedPermissions({ principal, now: NOW }),
  };
}

function fixture(principals, options = {}) {
  const audit = [];
  const repository = new MemoryCredentialRepository(principals);
  const service = new ApiCredentialService({
    repository,
    credentialPepper: randomBytes(32),
    audit: async (event) => audit.push(event),
    clock: options.clock ?? (() => new Date(NOW)),
  });
  return { audit, repository, service };
}

test("ordinary members cannot create personal API credentials", async () => {
  const member = localPrincipal("member", ["member"]);
  const { service } = fixture([member]);
  await assert.rejects(service.issueDeveloperCredential({
    context: contextFor(member),
    displayName: "Personal key",
    scopes: [{ permissionKey: "ai:invoke" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  }), (error) => error.code === "access_denied" && error.status === 403);
});

test("developer credential is shown once, redacted at rest, scoped, expiring, and audited", async () => {
  const developer = localPrincipal("developer", ["developer"]);
  const { audit, repository, service } = fixture([developer]);
  const issued = await service.issueDeveloperCredential({
    context: contextFor(developer),
    displayName: "Local CLI",
    scopes: [{ permissionKey: "ai:invoke", resourceKind: "team", resourceKey: "alpha" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  });

  assert.match(issued.secret, /^taib_sk_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.credential.hint, issued.secret.slice(0, 16));
  assert.equal("secret" in issued.credential, false);
  assert.equal("tokenHash" in issued.credential, false);

  const stored = await repository.findCredentialById(issued.credential.id);
  assert.notEqual(stored.tokenHash, issued.secret);
  assert.equal(stored.tokenHash.length, 64);
  assert.equal(JSON.stringify(audit).includes(issued.secret), false);
  assert.equal(JSON.stringify(audit).includes(stored.tokenHash), false);

  const listed = await service.listCredentials({ context: contextFor(developer) });
  assert.equal(listed.length, 1);
  assert.equal("secret" in listed[0], false);
  assert.equal("tokenHash" in listed[0], false);

  const authenticated = await service.authenticate({
    secret: issued.secret,
    permission: "ai:invoke",
    resource: { kind: "team", key: "alpha" },
  });
  assert.equal(authenticated.identityId, developer.id);
  await assert.rejects(service.authenticate({
    secret: issued.secret,
    permission: "ai:invoke",
    resource: { kind: "team", key: "beta" },
  }), (error) => error.code === "access_denied" && error.status === 403);
});

test("developer credentials cannot contain administrative or duplicate scopes", async () => {
  const owner = localPrincipal("owner", ["owner"]);
  const { service } = fixture([owner]);
  await assert.rejects(service.issueDeveloperCredential({
    context: contextFor(owner),
    displayName: "Escalation",
    scopes: [{ permissionKey: "identity:manage" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  }), (error) => error.code === "access_denied");
  await assert.rejects(service.issueDeveloperCredential({
    context: contextFor(owner),
    displayName: "Duplicates",
    scopes: [{ permissionKey: "ai:invoke" }, { permissionKey: "ai:invoke" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  }), (error) => error.code === "invalid_credential_scope");
});

test("service credentials require administrator authority and remain inside active grants", async () => {
  const owner = localPrincipal("owner", ["owner"]);
  const applicationAdmin = localPrincipal("apps", ["application_admin"]);
  const worker = {
    id: "worker",
    status: "active",
    identityKind: "service_account",
    roleBindings: [],
    serviceGrants: [{
      permissionKey: "ai:invoke",
      resourceKind: "team",
      resourceKey: "alpha",
      expiresAt: "2026-08-12T00:00:00.000Z",
      revokedAt: null,
    }],
  };
  const { service } = fixture([owner, applicationAdmin, worker]);
  await assert.rejects(service.issueServiceCredential({
    context: contextFor(applicationAdmin),
    serviceIdentityId: worker.id,
    displayName: "Worker",
    scopes: [{ permissionKey: "ai:invoke", resourceKind: "team", resourceKey: "alpha" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  }), (error) => error.code === "access_denied");

  const issued = await service.issueServiceCredential({
    context: contextFor(owner),
    serviceIdentityId: worker.id,
    displayName: "Worker",
    scopes: [{ permissionKey: "ai:invoke", resourceKind: "team", resourceKey: "alpha" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  });
  assert.equal((await service.authenticate({
    secret: issued.secret,
    permission: "ai:invoke",
    resource: { kind: "team", key: "alpha" },
  })).identityKind, "service_account");

  await assert.rejects(service.issueServiceCredential({
    context: contextFor(owner),
    serviceIdentityId: worker.id,
    displayName: "Too broad",
    scopes: [{ permissionKey: "ai:invoke", resourceKind: "team", resourceKey: "beta" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  }), (error) => error.code === "access_denied");
  await assert.rejects(service.issueServiceCredential({
    context: contextFor(owner),
    serviceIdentityId: worker.id,
    displayName: "Outlives grant",
    scopes: [{ permissionKey: "ai:invoke", resourceKind: "team", resourceKey: "alpha" }],
    expiresAt: "2026-08-13T00:00:00.000Z",
  }), (error) => error.code === "access_denied");
});

test("credential authentication re-checks account, grant, expiry, and revocation state", async () => {
  let current = new Date(NOW);
  const developer = localPrincipal("developer", ["developer"]);
  const { repository, service } = fixture([developer], { clock: () => new Date(current) });
  const issued = await service.issueDeveloperCredential({
    context: contextFor(developer),
    displayName: "Short lived",
    scopes: [{ permissionKey: "ai:invoke" }],
    expiresAt: "2026-08-10T00:10:00.000Z",
  });

  current = new Date("2026-08-10T00:10:00.000Z");
  await assert.rejects(service.authenticate({ secret: issued.secret, permission: "ai:invoke" }),
    (error) => error.code === "invalid_credential" && error.status === 401);

  current = new Date(NOW);
  const second = await service.issueDeveloperCredential({
    context: contextFor(developer),
    displayName: "Revocable",
    scopes: [{ permissionKey: "ai:invoke" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  });
  await service.revokeCredential({
    context: contextFor(developer),
    credentialId: second.credential.id,
    reason: "device_lost",
  });
  await assert.rejects(service.authenticate({ secret: second.secret, permission: "ai:invoke" }),
    (error) => error.code === "invalid_credential");

  const third = await service.issueDeveloperCredential({
    context: contextFor(developer),
    displayName: "Disabled owner",
    scopes: [{ permissionKey: "ai:invoke" }],
    expiresAt: "2026-08-11T00:00:00.000Z",
  });
  repository.upsertPrincipal({ ...developer, status: "disabled" });
  await assert.rejects(service.authenticate({ secret: third.secret, permission: "ai:invoke" }),
    (error) => error.code === "access_denied");
});

test("malformed credential values fail without repository details", async () => {
  const developer = localPrincipal("developer", ["developer"]);
  const { audit, service } = fixture([developer]);
  await assert.rejects(service.authenticate({ secret: "not-a-key", permission: "ai:invoke" }),
    (error) => error.code === "invalid_credential" && error.status === 401);
  assert.equal(audit.at(-1).reason, "malformed");
  assert.equal("credentialId" in audit.at(-1), false);
});
