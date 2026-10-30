import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adminControls,
  requireAdminControl,
} from "../src/authorization/admin-control-guard.mjs";
import { AuthorizationService } from "../src/authorization/authorization-service.mjs";
import { MemoryAuthorizationRepository } from "../src/authorization/memory-repository.mjs";

function principal(id, roleKey) {
  return {
    id,
    status: "active",
    identityKind: "local_user",
    roleBindings: [{ roleKey, scopeKind: "appliance", scopeKey: "*" }],
    serviceGrants: [],
  };
}

function fixture(roleKey) {
  const repository = new MemoryAuthorizationRepository([principal(roleKey, roleKey)]);
  return new AuthorizationService({ repository });
}

test("owner can view and manage every registered administrator control", async () => {
  const authorization = fixture("owner");
  for (const control of Object.keys(adminControls)) {
    await requireAdminControl(authorization, { identityId: "owner", control, access: "view" });
    await requireAdminControl(authorization, { identityId: "owner", control, access: "manage" });
  }
});

test("ordinary member is denied every administrator control", async () => {
  const authorization = fixture("member");
  for (const control of Object.keys(adminControls)) {
    await assert.rejects(
      requireAdminControl(authorization, { identityId: "member", control }),
      (error) => error.code === "access_denied" && error.status === 403,
    );
  }
});

test("administrative roles remain confined to their domains", async () => {
  const compute = fixture("compute_admin");
  for (const control of ["nodes", "models", "queues", "providers", "operations"]) {
    await requireAdminControl(compute, { identityId: "compute_admin", control });
  }
  await assert.rejects(
    requireAdminControl(compute, { identityId: "compute_admin", control: "plugins" }),
    (error) => error.code === "access_denied",
  );

  const applications = fixture("application_admin");
  await requireAdminControl(applications, { identityId: "application_admin", control: "plugins" });
  await assert.rejects(
    requireAdminControl(applications, { identityId: "application_admin", control: "models" }),
    (error) => error.code === "access_denied",
  );

  const system = fixture("system_admin");
  for (const control of ["storage", "sources", "backups", "updates", "encryption"]) {
    await requireAdminControl(system, { identityId: "system_admin", control });
  }
  await assert.rejects(
    requireAdminControl(system, { identityId: "system_admin", control: "queues" }),
    (error) => error.code === "access_denied",
  );
});

test("unknown administrator controls fail as programming errors", async () => {
  await assert.rejects(
    requireAdminControl(fixture("owner"), { identityId: "owner", control: "shell" }),
    /unknown administrator control/,
  );
});
