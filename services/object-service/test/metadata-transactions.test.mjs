import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

import { MemoryBlobStore } from "../src/memory-blob-store.mjs";
import {
  MemoryObjectRepository,
  ObjectRepositoryError,
} from "../src/memory-repository.mjs";
import { ProtectedObjectService } from "../src/object-service.mjs";

const context = { identityId: "metadata-user", namespaceKey: "user:metadata" };

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function serviceWith({ repository, blobStore, clock = () => new Date("2026-08-10T00:00:00.000Z") }) {
  return new ProtectedObjectService({
    repository,
    blobStore,
    referenceSigningKey: randomBytes(32),
    clock,
    allowTestPlaintextBlobStore: true,
    allowTestLegacyNamespaceContext: true,
    policy: {
      uncommittedBlobLifetimeMs: 1_000,
      orphanDiscoveryGraceMs: 1_000,
    },
  });
}

test("repository transaction refuses to expose an object version without a verified blob claim", async () => {
  const repository = new MemoryObjectRepository();
  const record = {
    namespaceKey: "user:metadata",
    objectKey: "unverified.txt",
    blobKey: "objects/unverified",
    size: 10,
    sha256: "1".repeat(64),
    contentType: "text/plain",
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    createdByIdentityId: "metadata-user",
  };

  await assert.rejects(repository.commitOneShot(record),
    (error) => error instanceof ObjectRepositoryError && error.code === "unverified_blob");
  assert.equal(await repository.findObjectByKey("user:metadata", "unverified.txt"), null);

  await repository.stageBlob({
    ...record,
    claimKind: "object_candidate",
    expiresAt: new Date("2026-08-10T01:00:00.000Z"),
  });
  await assert.rejects(repository.commitOneShot(record),
    (error) => error.code === "unverified_blob");
  assert.equal(await repository.findObjectByKey("user:metadata", "unverified.txt"), null);
});

test("stored bytes are read back and verified before their object version becomes visible", async () => {
  class CorruptingBlobStore extends MemoryBlobStore {
    async get(blobKey) {
      const content = await super.get(blobKey);
      if (content) content[0] ^= 0xff;
      return content;
    }
  }
  const repository = new MemoryObjectRepository();
  const blobStore = new CorruptingBlobStore();
  const service = serviceWith({ repository, blobStore });

  await assert.rejects(service.upload({
    context,
    namespaceKey: context.namespaceKey,
    objectKey: "corrupt.txt",
    contentType: "text/plain",
    content: Buffer.from("verify me"),
  }), (error) => error.code === "object_corrupt");
  assert.equal(await repository.findObjectByKey(context.namespaceKey, "corrupt.txt"), null);
  assert.equal(blobStore.size, 0);
});

test("failed metadata commit remains invisible and a later reconciliation reclaims the registered blob", async () => {
  class FailingCommitRepository extends MemoryObjectRepository {
    async commitOneShot() {
      throw new ObjectRepositoryError("injected_commit_failure", "Injected transaction failure");
    }
  }
  class OnceFailingDeleteBlobStore extends MemoryBlobStore {
    failDelete = true;

    async delete(blobKey) {
      if (this.failDelete) {
        this.failDelete = false;
        throw new Error("injected delete failure");
      }
      return super.delete(blobKey);
    }
  }
  const repository = new FailingCommitRepository();
  const blobStore = new OnceFailingDeleteBlobStore();
  const service = serviceWith({ repository, blobStore });

  await assert.rejects(service.upload({
    context,
    namespaceKey: context.namespaceKey,
    objectKey: "never-visible.txt",
    contentType: "text/plain",
    content: Buffer.from("orphan candidate"),
  }), (error) => error.code === "injected_commit_failure");
  assert.equal(await repository.findObjectByKey(context.namespaceKey, "never-visible.txt"), null);
  assert.equal(blobStore.size, 1);

  assert.deepEqual(await service.reconcileOrphans({
    now: new Date("2026-08-10T00:00:01.000Z"),
  }), { registeredReclaimed: 1, untrackedReclaimed: 0, deferred: 0 });
  assert.equal(blobStore.size, 0);
});

test("reconciliation deletes old untracked physical blobs but defers the recent write window", async () => {
  let now = new Date("2026-08-10T00:00:00.000Z");
  const repository = new MemoryObjectRepository();
  const blobStore = new MemoryBlobStore({ clock: () => new Date(now) });
  const service = serviceWith({ repository, blobStore, clock: () => new Date(now) });
  await blobStore.put("objects/a-old-untracked", Buffer.from("old"));
  now = new Date("2026-08-10T00:00:10.000Z");
  await blobStore.put("objects/z-recent-untracked", Buffer.from("recent"));

  assert.deepEqual(await service.reconcileOrphans({ now }), {
    registeredReclaimed: 0,
    untrackedReclaimed: 1,
    deferred: 1,
  });
  assert.equal(await blobStore.has("objects/a-old-untracked"), false);
  assert.equal(await blobStore.has("objects/z-recent-untracked"), true);
});

test("multipart replacement and abort atomically detach claims before physical cleanup", async () => {
  const repository = new MemoryObjectRepository();
  const blobStore = new MemoryBlobStore();
  const service = serviceWith({ repository, blobStore });
  const first = Buffer.from("first");
  const second = Buffer.from("other");
  const upload = await service.beginMultipart({
    context,
    namespaceKey: context.namespaceKey,
    objectKey: "replace.bin",
    contentType: "application/octet-stream",
    expectedSize: second.byteLength,
    expectedSha256: digest(second),
  });
  await service.uploadPart({
    context,
    uploadId: upload.uploadId,
    partNumber: 1,
    content: first,
    expectedSha256: digest(first),
  });
  await service.uploadPart({
    context,
    uploadId: upload.uploadId,
    partNumber: 1,
    content: second,
    expectedSha256: digest(second),
  });
  assert.equal(blobStore.size, 1);
  await service.abortMultipart({ context, uploadId: upload.uploadId });
  assert.equal(blobStore.size, 0);
  assert.deepEqual(await repository.blobReclamationCandidates(
    new Date("2026-08-10T00:00:01.000Z"),
  ), []);
});
