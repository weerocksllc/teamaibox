import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { MemoryBlobStore } from "../src/memory-blob-store.mjs";
import { MemoryObjectGrantRepository } from "../src/memory-grant-repository.mjs";
import { MemoryObjectRepository } from "../src/memory-repository.mjs";
import { ProtectedObjectService } from "../src/object-service.mjs";

function fixture() {
  let now = new Date("2026-08-10T00:00:00.000Z");
  const audit = [];
  const grantRepository = new MemoryObjectGrantRepository();
  const service = new ProtectedObjectService({
    repository: new MemoryObjectRepository(),
    blobStore: new MemoryBlobStore(),
    grantRepository,
    referenceSigningKey: randomBytes(32),
    allowTestPlaintextBlobStore: true,
    clock: () => new Date(now),
    audit: async (event) => audit.push(event),
    policy: { maximumReferenceLifetimeMs: 1_000 },
  });
  return {
    audit,
    grantRepository,
    service,
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
    now: () => new Date(now),
  };
}

function localContext(identityId, namespaceKey, operations = ["manage"]) {
  return {
    identityId,
    identityKind: "local_user",
    namespaceAccess: [{ namespaceKey, operations }],
  };
}

test("tenant, user, and team namespace grants enforce exact per-operation access", async () => {
  const { service } = fixture();
  const teamContext = {
    identityId: "team-user",
    identityKind: "local_user",
    namespaceAccess: [{
      namespaceKey: "team:design",
      operations: ["write", "read", "list", "reference:create", "reference:revoke"],
    }],
  };
  const uploaded = await service.upload({
    context: teamContext,
    namespaceKey: "team:design",
    objectKey: "brief.txt",
    contentType: "text/plain",
    content: Buffer.from("team protected"),
  });
  assert.equal((await service.head({
    context: teamContext,
    namespaceKey: "team:design",
    objectId: uploaded.objectId,
  })).objectId, uploaded.objectId);

  await assert.rejects(service.head({
    context: teamContext,
    namespaceKey: "tenant:other",
    objectId: uploaded.objectId,
  }), (error) => error.code === "object_access_denied");
  await assert.rejects(service.upload({
    context: {
      identityId: "read-only-user",
      identityKind: "local_user",
      namespaceAccess: [{ namespaceKey: "team:design", operations: ["read"] }],
    },
    namespaceKey: "team:design",
    objectKey: "denied.txt",
    contentType: "text/plain",
    content: Buffer.from("denied"),
  }), (error) => error.code === "object_access_denied");
});

test("workers and plugins cannot use direct namespace access even when they claim the exact key", async () => {
  const { service } = fixture();
  const owner = localContext("owner", "user:owner");
  const uploaded = await service.upload({
    context: owner,
    namespaceKey: "user:owner",
    objectKey: "input.bin",
    contentType: "application/octet-stream",
    content: Buffer.from("grant only"),
  });
  for (const identityKind of ["worker", "plugin", "service_account"]) {
    await assert.rejects(service.download({
      context: {
        identityId: `${identityKind}-one`,
        identityKind,
        namespaceKey: "user:owner",
        namespaceAccess: [{ namespaceKey: "user:owner", operations: ["manage"] }],
      },
      namespaceKey: "user:owner",
      objectId: uploaded.objectId,
    }), (error) => error.code === "object_access_denied");
  }
});

test("worker grants are short-lived, server-tracked, least-privilege, and immediately revocable", async () => {
  const { audit, grantRepository, now, service } = fixture();
  const owner = localContext("owner", "user:owner");
  const uploaded = await service.upload({
    context: owner,
    namespaceKey: "user:owner",
    objectKey: "ocr/input.png",
    contentType: "image/png",
    content: Buffer.from("image bytes"),
  });
  const issued = await service.createScopedReference({
    context: owner,
    namespaceKey: "user:owner",
    objectId: uploaded.objectId,
    audience: "worker:ocr-one",
    operations: ["head", "read"],
    expiresAt: new Date(now().getTime() + 900).toISOString(),
  });
  const stored = await grantRepository.find(issued.reference.referenceId);

  assert.equal(stored.audience, "worker:ocr-one");
  assert.deepEqual(stored.operations, ["head", "read"]);
  assert.equal(JSON.stringify(stored).includes(issued.token), false);
  assert.equal(/credential|accessKey|secretKey|password/i.test(JSON.stringify(stored)), false);
  assert.equal((await service.downloadWithScopedReference({
    token: issued.token,
    audience: "worker:ocr-one",
  })).content.toString(), "image bytes");
  await assert.rejects(service.downloadWithScopedReference({
    token: issued.token,
    audience: "worker:different",
  }), (error) => error.code === "invalid_reference");

  const revoked = await service.revokeScopedReference({
    context: owner,
    referenceId: issued.reference.referenceId,
    reason: "job_cancelled",
  });
  assert.equal(revoked.revoked, true);
  await assert.rejects(service.authorizeScopedReference({
    token: issued.token,
    audience: "worker:ocr-one",
    operation: "head",
  }), (error) => error.code === "invalid_reference");
  assert.equal(JSON.stringify(audit).includes(issued.token), false);
  assert.ok(audit.some((event) => event.action === "object.reference_accessed"
    && event.reason === "revoked" && event.success === false));
});

test("only the issuer or namespace administrator can revoke a worker grant", async () => {
  const { now, service } = fixture();
  const issuer = localContext("issuer", "tenant:acme");
  const object = await service.upload({
    context: issuer,
    namespaceKey: "tenant:acme",
    objectKey: "shared.txt",
    contentType: "text/plain",
    content: Buffer.from("shared"),
  });
  const issued = await service.createScopedReference({
    context: issuer,
    namespaceKey: "tenant:acme",
    objectId: object.objectId,
    audience: "worker:indexer",
    operations: ["head"],
    expiresAt: new Date(now().getTime() + 500).toISOString(),
  });
  await assert.rejects(service.revokeScopedReference({
    context: localContext("other", "tenant:acme"),
    referenceId: issued.reference.referenceId,
  }), (error) => error.code === "object_access_denied");
  assert.equal((await service.revokeScopedReference({
    context: {
      ...localContext("storage-admin", "tenant:acme"),
      permissions: ["object_reference:revoke:any"],
    },
    referenceId: issued.reference.referenceId,
    reason: "administrative_revoke",
  })).revoked, true);
});
