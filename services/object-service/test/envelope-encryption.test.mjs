import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  EncryptedSecretStore,
  MemoryCiphertextBackend,
} from "../../../packages/secrets/src/index.mjs";
import { EnvelopeEncryptedBlobStore } from "../src/envelope-encrypted-blob-store.mjs";
import {
  MemoryVersionedEnvelopeKeyring,
  ProtectedSecretEnvelopeKeyring,
} from "../src/envelope-keyring.mjs";
import { MemoryEnvelopeMetadataRepository } from "../src/envelope-metadata-repository.mjs";
import { MemoryBlobStore } from "../src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../src/memory-repository.mjs";
import { ProtectedObjectService } from "../src/object-service.mjs";

function fixture({ dataKeyGenerator, onKeyReleased } = {}) {
  const rawStore = new MemoryBlobStore();
  const metadataRepository = new MemoryEnvelopeMetadataRepository();
  const keyring = new MemoryVersionedEnvelopeKeyring(Buffer.alloc(32, 1));
  const blobStore = new EnvelopeEncryptedBlobStore({
    rawStore,
    metadataRepository,
    keyring,
    dataKeyGenerator,
    onKeyReleased,
  });
  return { blobStore, keyring, metadataRepository, rawStore };
}

test("encrypts every blob with an independently wrapped data key and never stores plaintext", async (t) => {
  const { blobStore, keyring, rawStore } = fixture();
  t.after(() => keyring.close());
  const plaintext = Buffer.from("same confidential object bytes");

  await blobStore.put("objects/one", plaintext);
  await blobStore.put("objects/two", plaintext);
  const rawOne = await rawStore.get("objects/one");
  const rawTwo = await rawStore.get("objects/two");
  const metadataOne = await blobStore.metadata("objects/one");
  const metadataTwo = await blobStore.metadata("objects/two");

  assert.notDeepEqual(rawOne, plaintext);
  assert.notDeepEqual(rawTwo, plaintext);
  assert.notDeepEqual(rawOne, rawTwo);
  assert.equal(rawOne.indexOf(plaintext), -1);
  assert.equal(rawTwo.indexOf(plaintext), -1);
  assert.notEqual(metadataOne.keyEnvelope.ciphertext, metadataTwo.keyEnvelope.ciphertext);
  assert.equal(JSON.stringify(metadataOne).includes(plaintext.toString("utf8")), false);
  assert.equal("dataKey" in metadataOne, false);
  assert.equal(metadataOne.keyEnvelope.keyVersion, 1);
  assert.deepEqual(await blobStore.get("objects/one"), plaintext);
  assert.deepEqual(await blobStore.get("objects/two"), plaintext);
});

test("fails closed when ciphertext, authenticated metadata, or wrapped keys are changed", async (t) => {
  const first = fixture();
  t.after(() => first.keyring.close());
  await first.blobStore.put("objects/ciphertext", Buffer.from("protected"));
  const changed = await first.rawStore.get("objects/ciphertext");
  changed[0] ^= 0xff;
  await first.rawStore.put("objects/ciphertext", changed);
  await assert.rejects(first.blobStore.get("objects/ciphertext"),
    (error) => error.code === "object_authentication_failed");

  const second = fixture();
  t.after(() => second.keyring.close());
  await second.blobStore.put("objects/envelope", Buffer.from("protected"));
  const metadata = await second.metadataRepository.load("objects/envelope");
  const wrapped = Buffer.from(metadata.keyEnvelope.ciphertext, "base64");
  wrapped[0] ^= 0xff;
  metadata.keyEnvelope.ciphertext = wrapped.toString("base64");
  metadata.revision += 1;
  assert.equal(await second.metadataRepository.compareAndSwap(
    "objects/envelope",
    metadata.revision - 1,
    metadata,
  ), true);
  await assert.rejects(second.blobStore.get("objects/envelope"),
    (error) => error.code === "object_authentication_failed");

  const third = fixture();
  t.after(() => third.keyring.close());
  await third.blobStore.put("objects/metadata", Buffer.from("protected"));
  const changedMetadata = await third.metadataRepository.load("objects/metadata");
  changedMetadata.plaintextSize += 1;
  changedMetadata.revision += 1;
  await third.metadataRepository.compareAndSwap(
    "objects/metadata",
    changedMetadata.revision - 1,
    changedMetadata,
  );
  await assert.rejects(third.blobStore.get("objects/metadata"),
    (error) => error.code === "object_authentication_failed");
});

test("rotates wrapping-key versions by rewrapping the DEK without rewriting object ciphertext", async (t) => {
  const { blobStore, keyring, rawStore } = fixture();
  t.after(() => keyring.close());
  await blobStore.put("objects/legacy", Buffer.from("large-object-ciphertext-stays-put"));
  const ciphertextBefore = await rawStore.get("objects/legacy");

  keyring.addVersion(2, Buffer.alloc(32, 2), { active: true });
  assert.equal((await blobStore.metadata("objects/legacy")).keyEnvelope.keyVersion, 1);
  assert.equal((await blobStore.get("objects/legacy")).toString(), "large-object-ciphertext-stays-put");
  assert.deepEqual(await blobStore.rewrapAll({ limit: 10 }), {
    activeKeyVersion: 2,
    scanned: 1,
    rewrapped: 1,
  });

  const ciphertextAfter = await rawStore.get("objects/legacy");
  const metadataAfter = await blobStore.metadata("objects/legacy");
  assert.deepEqual(ciphertextAfter, ciphertextBefore);
  assert.equal(metadataAfter.keyEnvelope.keyVersion, 2);
  assert.equal(metadataAfter.revision, 2);
  assert.equal(await blobStore.keyVersionUsage(1), 0);
  assert.equal(await blobStore.keyVersionUsage(2), 1);
  assert.equal((await blobStore.get("objects/legacy")).toString(), "large-object-ciphertext-stays-put");
  assert.deepEqual(await blobStore.rewrap("objects/legacy"), {
    blobKey: "objects/legacy",
    keyVersion: 2,
    rewrapped: false,
  });
});

test("zeroizes generated and unwrapped plaintext data keys at their callback boundaries", async (t) => {
  const generatedKey = Buffer.alloc(32, 9);
  const released = [];
  const { blobStore, keyring } = fixture({
    dataKeyGenerator: () => generatedKey,
    onKeyReleased: (event) => released.push(event),
  });
  t.after(() => keyring.close());

  await blobStore.put("objects/zeroized", Buffer.from("secret payload"));
  assert.deepEqual(generatedKey, Buffer.alloc(32));
  await blobStore.get("objects/zeroized");
  assert.deepEqual(released.map((event) => event.kind), [
    "data-key:generated",
    "data-key:unwrapped",
  ]);
  assert.ok(released.every((event) => event.byteLength === 32 && event.zeroized));
});

test("uses protected-secret KEK versions and keeps retired versions available for rewrap", async (t) => {
  const secretStore = new EncryptedSecretStore({
    masterKey: randomBytes(32),
    backend: new MemoryCiphertextBackend(),
  });
  t.after(() => secretStore.close());
  const administrator = {
    service: "platform-api",
    permissions: ["secrets:write", "secrets:rotate"],
  };
  const objectServiceContext = {
    service: "object-service",
    permissions: ["secrets:read", "secrets:metadata"],
  };
  await secretStore.putInitial(
    "object.envelope-kek",
    Buffer.alloc(32, 3),
    ["object-service"],
    administrator,
  );
  const rawStore = new MemoryBlobStore();
  const metadataRepository = new MemoryEnvelopeMetadataRepository();
  const blobStore = new EnvelopeEncryptedBlobStore({
    rawStore,
    metadataRepository,
    keyring: new ProtectedSecretEnvelopeKeyring({ secretStore, serviceContext: objectServiceContext }),
  });
  await blobStore.put("objects/protected-keyring", Buffer.from("versioned secret"));
  await secretStore.rotate(
    "object.envelope-kek",
    Buffer.alloc(32, 4),
    ["object-service"],
    administrator,
  );

  assert.equal((await blobStore.get("objects/protected-keyring")).toString(), "versioned secret");
  assert.equal((await blobStore.rewrap("objects/protected-keyring")).keyVersion, 2);
  assert.equal((await blobStore.get("objects/protected-keyring")).toString(), "versioned secret");
});

test("is accepted as the production data plane by the protected object API", async (t) => {
  const { blobStore, keyring } = fixture();
  t.after(() => keyring.close());
  const service = new ProtectedObjectService({
    repository: new MemoryObjectRepository(),
    blobStore,
    referenceSigningKey: randomBytes(32),
  });
  const context = { identityId: "user-one", namespaceKey: "user:one" };
  context.identityKind = "local_user";
  context.namespaceAccess = [{ namespaceKey: "user:one", operations: ["manage"] }];
  const uploaded = await service.upload({
    context,
    namespaceKey: "user:one",
    objectKey: "documents/confidential.txt",
    contentType: "text/plain",
    content: Buffer.from("encrypted end to end"),
  });

  assert.equal((await service.download({
    context,
    namespaceKey: "user:one",
    objectId: uploaded.objectId,
  })).content.toString(), "encrypted end to end");
});
