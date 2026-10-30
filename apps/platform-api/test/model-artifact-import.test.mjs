import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { EnvelopeEncryptedBlobStore } from "../../../services/object-service/src/envelope-encrypted-blob-store.mjs";
import { MemoryVersionedEnvelopeKeyring } from "../../../services/object-service/src/envelope-keyring.mjs";
import { MemoryEnvelopeMetadataRepository } from "../../../services/object-service/src/envelope-metadata-repository.mjs";
import { MemoryBlobStore } from "../../../services/object-service/src/memory-blob-store.mjs";
import { EnvelopeModelChunkStore } from "../src/models/envelope-model-chunk-store.mjs";
import { MemoryModelArtifactRepository } from "../src/models/memory-model-artifact-repository.mjs";
import {
  ModelArtifactImportService,
  modelArtifactSignaturePayload,
  offlineModelBundleSignaturePayload,
} from "../src/models/model-artifact-import-service.mjs";

const context = { identityId: "00000000-0000-4000-8000-000000007301", permissions: ["model:manage"] };
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const code = (expected) => (error) => error?.code === expected;

function catalog() {
  return {
    schemaVersion: 1,
    candidates: [{
      candidateId: "example-nvfp4", selection: { status: "planned" },
      source: {
        revision: "revision-123", artifactSourceUri: "https://models.example.test/example/revision-123/",
      },
      artifactDecision: {
        status: "allowed", maximumDownloadBytes: 1024, allowPatterns: ["*.bin", "tokenizer/**"],
      },
    }, {
      candidateId: "blocked-model", selection: { status: "hold" },
      source: { revision: "revision-1", artifactSourceUri: "https://models.example.test/blocked/" },
      artifactDecision: { status: "blocked", maximumDownloadBytes: null, allowPatterns: [] },
    }],
  };
}

function descriptor(content, overrides = {}) {
  return {
    artifactName: "weights.bin", sizeBytes: content.byteLength, digest: sha256(content),
    mediaType: "application/octet-stream", chunkSizeBytes: 4,
    sourceUri: "https://models.example.test/example/revision-123/weights.bin",
    signature: null, ...overrides,
  };
}

function setup({ data = Buffer.from("abcdefghij"), quotaBytes = 1024, responses, trustStore } = {}) {
  const rawStore = new MemoryBlobStore();
  const blobStore = new EnvelopeEncryptedBlobStore({
    rawStore, metadataRepository: new MemoryEnvelopeMetadataRepository(),
    keyring: new MemoryVersionedEnvelopeKeyring(Buffer.alloc(32, 7)),
  });
  const chunkStore = new EnvelopeModelChunkStore({ blobStore });
  const repository = new MemoryModelArtifactRepository({
    quotaBytes,
    idFactory: (() => { let sequence = 0; return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`; })(),
  });
  let requests = 0;
  const sourceTransport = {
    async fetchRange({ start, end }) {
      requests += 1;
      if (responses) return responses({ start, end, request: requests });
      return { status: 206, bytes: Buffer.from(data.subarray(start, end + 1)), totalSize: data.byteLength, etag: '"stable-etag"', lastModified: null };
    },
  };
  const service = new ModelArtifactImportService({
    repository, chunkStore, sourceTransport, candidateCatalog: catalog(), trustStore,
  });
  return { rawStore, blobStore, chunkStore, repository, service, requests: () => requests };
}

async function importOnline(service, content, operationKey, overrides = {}) {
  const started = await service.beginOnlineImport({
    context, candidateId: "example-nvfp4", descriptor: descriptor(content, overrides), operationKey,
  });
  if (started.import.state === "active") {
    await service.resumeOnlineImport({ context, importId: started.import.importId, maximumChunks: 100 });
    return service.finalizeImport({ context, importId: started.import.importId });
  }
  return started;
}

test("model chunks reject plaintext storage and encrypted bytes never contain plaintext", async () => {
  assert.throws(() => new EnvelopeModelChunkStore({ blobStore: new MemoryBlobStore() }), code("protected_model_storage_required"));
  const data = Buffer.from("abcdefghij");
  const { service, rawStore } = setup({ data });
  const started = await service.beginOnlineImport({
    context, candidateId: "example-nvfp4", descriptor: descriptor(data), operationKey: "model-import-encryption-001",
  });
  await service.resumeOnlineImport({ context, importId: started.import.importId });
  const first = data.subarray(0, 4);
  const ciphertext = await rawStore.get(`models/chunks/sha256/${sha256(first).slice(7)}`);
  assert.ok(ciphertext);
  assert.equal(ciphertext.includes(first), false);
});

test("online range transfer resumes exactly and a ready digest deduplicates without network", async () => {
  const data = Buffer.from("abcdefghij");
  const { service, repository, requests } = setup({ data });
  const started = await service.beginOnlineImport({
    context, candidateId: "example-nvfp4", descriptor: descriptor(data), operationKey: "model-import-resume-001",
  });
  let progress = await service.resumeOnlineImport({ context, importId: started.import.importId });
  assert.equal(progress.receivedBytes, 4);
  assert.equal(progress.nextOrdinal, 1);
  progress = await service.resumeOnlineImport({ context, importId: started.import.importId, maximumChunks: 8 });
  assert.equal(progress.receivedBytes, 10);
  const completed = await service.finalizeImport({ context, importId: started.import.importId });
  assert.equal(completed.artifact.digest, sha256(data));
  assert.equal(completed.artifact.chunkCount, 3);
  assert.equal(completed.artifact.signatureVerified, false);
  assert.equal(requests(), 3);
  assert.deepEqual(await repository.usage(), {
    quotaBytes: 1024, committedBytes: 10, availableBytes: 1014,
    readyArtifacts: 1, chunks: 3,
  });

  const duplicate = await service.beginOnlineImport({
    context, candidateId: "example-nvfp4", descriptor: descriptor(data), operationKey: "model-import-resume-002",
  });
  assert.equal(duplicate.import.state, "ready");
  assert.equal(duplicate.import.deduplicated, true);
  assert.equal(requests(), 3);
  assert.equal("operationKey" in duplicate.import, false);
});

test("imports do not book declared size; only actual new bytes consume the cache", async () => {
  const data = Buffer.from("abcdefghij");
  const { service, repository, requests } = setup({ data, quotaBytes: 9 });
  const started=await service.beginOnlineImport({
    context, candidateId: "example-nvfp4", descriptor: descriptor(data), operationKey: "model-import-quota-001",
  });
  const second=await service.beginOnlineImport({context,candidateId:'example-nvfp4',descriptor:descriptor(data),operationKey:'model-import-concurrent-001'});
  assert.equal((await repository.usage()).committedBytes,0);
  assert.equal(requests(),0);
  await service.resumeOnlineImport({context,importId:started.import.importId,maximumChunks:2});
  await service.resumeOnlineImport({context,importId:second.import.importId,maximumChunks:2});
  assert.equal((await repository.usage()).committedBytes,8);
  await assert.rejects(service.resumeOnlineImport({context,importId:started.import.importId}),code('model_cache_quota_exceeded'));
  assert.equal((await repository.getImport(started.import.importId)).receivedBytes,8);
  assert.equal((await repository.usage()).committedBytes,8);
});

test('unreviewed candidates fail before opening the network',async()=>{
  const data=Buffer.from('abcdefghij');
  const {service,requests}=setup({data});
  await assert.rejects(service.beginOnlineImport({
    context, candidateId: "blocked-model", descriptor: descriptor(data), operationKey: "model-import-blocked-001",
  }), code("model_candidate_blocked"));
  assert.equal(requests(), 0);
});

test("full-artifact checksum mismatch fails closed and reclaims encrypted chunks", async () => {
  const data = Buffer.from("abcdefghij");
  const { service, repository, rawStore } = setup({ data });
  const started = await service.beginOnlineImport({
    context, candidateId: "example-nvfp4",
    descriptor: descriptor(data, { digest: sha256(Buffer.from("different")) }),
    operationKey: "model-import-checksum-001",
  });
  await service.resumeOnlineImport({ context, importId: started.import.importId, maximumChunks: 10 });
  await assert.rejects(service.finalizeImport({ context, importId: started.import.importId }), code("model_artifact_checksum_failed"));
  assert.equal((await repository.getImport(started.import.importId)).state, "failed");
  assert.equal((await repository.usage()).committedBytes, 0);
  assert.equal(rawStore.size, 0);
});

test("resumed online imports reject changing source validators", async () => {
  const data = Buffer.from("abcdefghij");
  const { service, repository } = setup({ data, responses: ({ start, end, request }) => ({
    status: 206, bytes: Buffer.from(data.subarray(start, end + 1)), totalSize: data.byteLength,
    etag: request === 1 ? '"one"' : '"two"', lastModified: null,
  }) });
  const started = await service.beginOnlineImport({
    context, candidateId: "example-nvfp4", descriptor: descriptor(data), operationKey: "model-import-validator-001",
  });
  await service.resumeOnlineImport({ context, importId: started.import.importId });
  await assert.rejects(service.resumeOnlineImport({ context, importId: started.import.importId }), code("model_source_changed"));
  assert.equal((await repository.getImport(started.import.importId)).state, "failed");
});

test("optional publisher artifact signatures are verified before promotion", async () => {
  const data = Buffer.from("signed-model");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const facts = { candidateId: "example-nvfp4", ...descriptor(data), sourceRevision: "revision-123" };
  delete facts.signature;
  const signature = sign(null, Buffer.from(modelArtifactSignaturePayload(facts)), privateKey).toString("base64");
  const trustStore = { async resolve(keyId) { return keyId === "publisher-key-1" ? { status: "active", publicKey, candidateIds: ["example-nvfp4"] } : null; } };
  const valid = setup({ data, trustStore });
  const result = await importOnline(valid.service, data, "model-import-signature-001", {
    signature: { algorithm: "Ed25519", keyId: "publisher-key-1", value: signature },
  });
  assert.equal(result.artifact.signatureVerified, true);

  const invalid = setup({ data, trustStore });
  const bad = Buffer.from(signature, "base64"); bad[0] ^= 1;
  const started = await invalid.service.beginOnlineImport({
    context, candidateId: "example-nvfp4", descriptor: descriptor(data, {
      signature: { algorithm: "Ed25519", keyId: "publisher-key-1", value: bad.toString("base64") },
    }), operationKey: "model-import-signature-002",
  });
  await invalid.service.resumeOnlineImport({ context, importId: started.import.importId, maximumChunks: 10 });
  await assert.rejects(invalid.service.finalizeImport({ context, importId: started.import.importId }), code("model_signature_verification_failed"));
});

function offlineBundle(data, privateKey, { tamperChunk = false } = {}) {
  const chunkSizeBytes = 4;
  const chunks = [];
  for (let offset = 0, ordinal = 0; offset < data.byteLength; offset += chunkSizeBytes, ordinal += 1) {
    const bytes = data.subarray(offset, Math.min(offset + chunkSizeBytes, data.byteLength));
    chunks.push({ ordinal, offset, sizeBytes: bytes.byteLength, digest: sha256(bytes) });
  }
  const manifest = {
    schemaVersion: 1, candidateId: "example-nvfp4", artifactName: "weights.bin",
    digest: sha256(data), sizeBytes: data.byteLength, mediaType: "application/octet-stream", chunkSizeBytes,
    source: { uri: "https://models.example.test/example/revision-123/weights.bin", revision: "revision-123" },
    chunks,
  };
  const signature = sign(null, Buffer.from(offlineModelBundleSignaturePayload(manifest)), privateKey).toString("base64");
  let closed = false;
  const bundle = {
    packageVersion: "teamaibox.model-bundle/v1", manifest,
    bundleSignature: { algorithm: "Ed25519", keyId: "offline-key-1", value: signature },
    async openChunk(ordinal) {
      const item = chunks[ordinal];
      const bytes = Buffer.from(data.subarray(item.offset, item.offset + item.sizeBytes));
      if (tamperChunk && ordinal === 1) bytes[0] ^= 1;
      return bytes;
    },
    async close() { closed = true; },
  };
  Object.defineProperty(bundle, "wasClosed", { value: () => closed, enumerable: false });
  return bundle;
}

test("signed offline bundles import without network and reject tampered chunks", async () => {
  const data = Buffer.from("offline-model");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustStore = { async resolve(keyId) { return keyId === "offline-key-1" ? { status: "active", publicKey } : null; } };
  const valid = setup({ data, trustStore });
  const bundle = offlineBundle(data, privateKey);
  const result = await valid.service.importOfflineBundle({ context, bundle, operationKey: "model-offline-import-001" });
  assert.equal(result.artifact.signatureVerified, true);
  assert.equal(valid.requests(), 0);
  assert.equal(bundle.wasClosed(), true);

  const invalid = setup({ data, trustStore });
  const tampered = offlineBundle(data, privateKey, { tamperChunk: true });
  await assert.rejects(invalid.service.importOfflineBundle({
    context, bundle: tampered, operationKey: "model-offline-import-002",
  }), code("model_bundle_checksum_failed"));
  assert.equal((await invalid.repository.usage()).committedBytes, 0);
  assert.equal(tampered.wasClosed(), true);
});

test("LRU eviction skips pinned and leased artifacts and preserves shared chunks", async () => {
  const first = Buffer.from("AAAABBBB");
  const second = Buffer.from("AAAACCCC");
  let active = first;
  const environment = setup({ data: active });
  await importOnline(environment.service, first, "model-import-eviction-001");
  active = second;
  environment.service = new ModelArtifactImportService({
    repository: environment.repository, chunkStore: environment.chunkStore,
    sourceTransport: { async fetchRange({ start, end }) { return { status: 206, bytes: Buffer.from(active.subarray(start, end + 1)), totalSize: active.byteLength, etag: '"second"', lastModified: null }; } },
    candidateCatalog: catalog(),
  });
  await importOnline(environment.service, second, "model-import-eviction-002");
  assert.equal((await environment.repository.usage()).committedBytes, 12);
  await environment.service.setPinned({ context, digest: sha256(first), pinned: true });
  await environment.service.acquireLease({ context, digest: sha256(second) });
  assert.equal((await environment.service.evict({ context, bytesRequired: 1 })).reclaimedBytes, 0);
  await environment.service.releaseLease({ context, digest: sha256(second) });
  assert.deepEqual(await environment.service.evict({ context, bytesRequired: 1 }), { evicted: [sha256(second)], reclaimedBytes: 4 });
  assert.equal((await environment.repository.usage()).committedBytes, 8);
  await environment.service.setPinned({ context, digest: sha256(first), pinned: false });
  assert.equal((await environment.service.evict({ context, bytesRequired: 8 })).reclaimedBytes, 8);
  assert.equal((await environment.repository.usage()).committedBytes, 0);
  active = first;
  const restored = await importOnline(environment.service, first, "model-import-eviction-003");
  assert.equal(restored.artifact.state, "ready");
  assert.equal((await environment.repository.usage()).committedBytes, 8);
});

test("model cache operations require administrator model permission", async () => {
  const { service } = setup();
  await assert.rejects(service.usage({ context: { permissions: [] } }), code("model_manager_required"));
});
