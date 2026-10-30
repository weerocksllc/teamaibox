import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { principalFromRoleKeys } from "../../../packages/authorization/src/index.mjs";
import { EnvelopeEncryptedBlobStore } from "../src/envelope-encrypted-blob-store.mjs";
import { MemoryVersionedEnvelopeKeyring } from "../src/envelope-keyring.mjs";
import { MemoryEnvelopeMetadataRepository } from "../src/envelope-metadata-repository.mjs";
import { FilesystemStoragePoolDataPlane } from "../src/filesystem-storage-pool-data-plane.mjs";
import { MemoryStoragePoolRepository } from "../src/memory-storage-pool-repository.mjs";
import { PooledFilesystemBlobStore } from "../src/pooled-filesystem-blob-store.mjs";
import { StoragePoolService } from "../src/storage-pool-service.mjs";

class InspectableMetadataRepository extends MemoryEnvelopeMetadataRepository {
  records = new Map();
  async putIfAbsent(value) { const result = await super.putIfAbsent(value); if (result) this.records.set(value.blobKey, structuredClone(value)); return result; }
  async delete(blobKey) { this.records.delete(blobKey); return super.delete(blobKey); }
}

async function healthy(service, principal, poolId, failureDomain, availableBytes) {
  await service.registerPool({ principal, poolId, displayName: poolId, backendKind: "local-filesystem",
    nodeId: `node-${poolId}`, failureDomain, safetyReserveBytes: 0, dataClasses: ["team-file"] });
  const now = new Date();
  await service.recordObservation({ principal, poolId, healthState: "healthy", totalBytes: availableBytes,
    availableBytes, encryptionMode: "luks2", encryptionStatus: "verified", encryptionVerifiedAt: now,
    compatibilityStatus: "verified", compatibilityVerifiedAt: now, observedAt: now });
}

test("production pooled blob store prefers its configured default despite lower capacity and drain migrates the only live copy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-pools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source"), targetRoot = join(root, "target");
  const metadata = new InspectableMetadataRepository();
  const database = { async query(_sql, values) { const value = metadata.records.get(values[0]); return { rows: value ? [{
    plaintext_size: value.plaintextSize, plaintext_sha256: value.plaintextSha256,
    ciphertext_size: value.ciphertextSize, ciphertext_sha256: value.ciphertextSha256,
  }] : [] }; } };
  const repository = new MemoryStoragePoolRepository();
  const dataPlane = new FilesystemStoragePoolDataPlane({ database, pools: [
    { poolId: "pool-source", root: sourceRoot }, { poolId: "pool-target", root: targetRoot },
  ] });
  const service = new StoragePoolService({ repository, dataPlane });
  const principal = principalFromRoleKeys({ id: "018f0000-0000-7000-8000-000000000001", status: "active" }, ["owner"]);
  await healthy(service, principal, "pool-source", "spark-source", 5_000);
  await healthy(service, principal, "pool-target", "spark-target", 10_000);
  const raw = new PooledFilesystemBlobStore({ repository, storagePoolService: service, dataPlane, principal,
    defaultPoolId: "pool-source" });
  const keyring = new MemoryVersionedEnvelopeKeyring(Buffer.alloc(32, 9));
  t.after(() => keyring.close());
  const blobs = new EnvelopeEncryptedBlobStore({ rawStore: raw, metadataRepository: metadata, keyring });
  const key = "objects/018f0000-0000-7000-8000-000000000111", plaintext = Buffer.from("encrypted pool migration payload");
  await blobs.put(key, plaintext, { dataClass: "team-file" });
  assert.equal((await repository.allocations({ poolId: "pool-source" })).length, 1);
  assert.equal(await dataPlane.has({ poolId: "pool-source", blobKey: key }), true);
  assert.notDeepEqual(await dataPlane.get({ poolId: "pool-source", blobKey: key }), plaintext);

  const drained = await service.drainPool({ principal, poolId: "pool-source" });
  assert.equal(drained.lifecycleState, "drained");
  assert.equal(await dataPlane.has({ poolId: "pool-source", blobKey: key }), false);
  assert.equal(await dataPlane.has({ poolId: "pool-target", blobKey: key }), true);
  assert.deepEqual(await blobs.get(key), plaintext);
  assert.equal((await repository.allocations({ poolId: "pool-target" })).length, 1);
  assert.equal((await service.removePool({ principal, poolId: "pool-source" })).lifecycleState, "removed");
});
