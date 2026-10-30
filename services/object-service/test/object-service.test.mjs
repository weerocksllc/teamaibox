import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

import { MemoryBlobStore } from "../src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../src/memory-repository.mjs";
import { ProtectedObjectService } from "../src/object-service.mjs";
import { InternalS3Adapter } from "../src/s3-adapter.mjs";
import { reserveBufferedMedia } from '../src/buffered-media-budget.mjs';

const NAMESPACE = "user:alpha";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function fixture({ quota = 1024, current = "2026-08-10T00:00:00.000Z", policy = {}, reserveUploadMemory } = {}) {
  let now = new Date(current);
  const audit = [];
  const blobStore = new MemoryBlobStore();
  const repository = new MemoryObjectRepository({ defaultQuotaBytes: quota });
  const service = new ProtectedObjectService({
    repository,
    blobStore,
    reserveUploadMemory,
    referenceSigningKey: randomBytes(32),
    audit: async (event) => audit.push(event),
    clock: () => new Date(now),
    allowTestPlaintextBlobStore: true,
    allowTestLegacyNamespaceContext: true,
    policy: {
      multipartLifetimeMs: 1_000,
      deletedRetentionMs: 1_000,
      maximumReferenceLifetimeMs: 1_000,
      ...policy,
    },
  });
  return {
    audit,
    blobStore,
    repository,
    service,
    context: { identityId: "user-alpha", namespaceKey: NAMESPACE },
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
    now: () => new Date(now),
  };
}

test('object uploads and multipart parts no longer impose the old 64 MiB product limit', async () => {
  const { context, service } = fixture({ quota: 200 * 1024 ** 2,
    reserveUploadMemory:size=>reserveBufferedMedia(size,{available:()=>2*1024**3,heap:()=>2*1024**3}) });
  const content = Buffer.alloc(65 * 1024 ** 2, 7), hash = digest(content);
  const stored = await service.upload({context, namespaceKey:NAMESPACE, objectKey:'large.bin',
    contentType:'application/octet-stream', content, expectedSha256:hash});
  assert.equal(stored.size, content.length); assert.equal(stored.integrity.digest, hash);
  assert.equal(digest(content),hash,'the caller-owned input must not be cleared');
  const upload = await service.beginMultipart({context,namespaceKey:NAMESPACE,objectKey:'large-parts.bin',
    contentType:'application/octet-stream',expectedSize:content.length,expectedSha256:hash});
  const part = await service.uploadPart({context,uploadId:upload.uploadId,partNumber:10001,content,expectedSha256:hash});
  assert.equal(part.partNumber,10001); assert.equal(part.size,content.length);
  await service.abortMultipart({context,uploadId:upload.uploadId});
});

test('actual upload memory shortage is rejected before storing any blob', async () => {
  const { context,service,blobStore }=fixture({reserveUploadMemory:size=>reserveBufferedMedia(size,{available:()=>0,heap:()=>0})});
  let writes=0;blobStore.put=async()=>{writes++;};
  await assert.rejects(service.upload({context,namespaceKey:NAMESPACE,objectKey:'shortage.txt',
    contentType:'text/plain',content:Buffer.from('123')}),{code:'media_memory_unavailable'});
  assert.equal(writes,0);
});

test('an explicitly configured object byte policy remains effective', async () => {
  const { context, service } = fixture({policy:{maximumOneShotBytes:2}});
  await assert.rejects(service.upload({context,namespaceKey:NAMESPACE,objectKey:'policy.txt',
    contentType:'text/plain',content:Buffer.from('123')}),{code:'invalid_object_size'});
  const stored=await service.upload({context,namespaceKey:NAMESPACE,objectKey:'okay.txt',contentType:'text/plain',content:Buffer.from('12')});
  assert.equal(stored.size,2);
});

test("one-shot object API verifies integrity, versions, list paging, head, download, and ranges", async () => {
  const { context, service } = fixture();
  const firstBody = Buffer.from("first version", "utf8");
  const first = await service.upload({
    context,
    namespaceKey: NAMESPACE,
    objectKey: "reports/quarter.txt",
    contentType: "text/plain; charset=utf-8",
    content: firstBody,
    expectedSha256: digest(firstBody),
  });
  assert.equal(first.version, 1);
  assert.equal((await service.head({ context, namespaceKey: NAMESPACE, objectId: first.objectId })).integrity.digest, digest(firstBody));
  assert.equal((await service.download({ context, namespaceKey: NAMESPACE, objectId: first.objectId })).content.toString(), "first version");
  const partial = await service.download({
    context,
    namespaceKey: NAMESPACE,
    objectId: first.objectId,
    range: { start: 6, endInclusive: 12 },
  });
  assert.equal(partial.content.toString(), "version");
  assert.deepEqual(partial.range, { start: 6, endInclusive: 12, total: 13 });

  const secondBody = Buffer.from("second", "utf8");
  const second = await service.upload({
    context,
    namespaceKey: NAMESPACE,
    objectKey: "reports/quarter.txt",
    contentType: "text/plain",
    content: secondBody,
  });
  assert.equal(second.objectId, first.objectId);
  assert.equal(second.version, 2);
  assert.deepEqual((await service.listVersions({
    context, namespaceKey: NAMESPACE, objectId: first.objectId,
  })).map((version) => version.version), [2, 1]);
  assert.equal((await service.download({
    context, namespaceKey: NAMESPACE, objectId: first.objectId, version: 1,
  })).content.toString(), "first version");

  for (const key of ["reports/a.txt", "reports/z.txt"]) {
    await service.upload({ context, namespaceKey: NAMESPACE, objectKey: key, contentType: "text/plain", content: Buffer.from(key) });
  }
  const page1 = await service.list({ context, namespaceKey: NAMESPACE, prefix: "reports/", limit: 2 });
  const page2 = await service.list({ context, namespaceKey: NAMESPACE, prefix: "reports/", cursor: page1.nextCursor, limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items.length, 1);
  await assert.rejects(service.download({
    context, namespaceKey: NAMESPACE, objectId: first.objectId, range: { start: 99 },
  }), (error) => error.code === "range_not_satisfiable" && error.status === 416);
  await assert.rejects(service.upload({
    context, namespaceKey: NAMESPACE, objectKey: "bad.txt", contentType: "text/plain",
    content: Buffer.from("bad"), expectedSha256: "0".repeat(64),
  }), (error) => error.code === "integrity_mismatch");
});

test('object pagination forwards a bounded cursor and preserves complete, latest-only Unicode results', async () => {
  const { repository, service, context } = fixture({ quota: 100000 });
  const keys = ['reports/a.txt', 'reports/A.txt', 'reports/中.txt', 'reports/😀.txt', 'reports/é.txt', 'reports/z.txt', 'reports/9.txt'];
  for (const key of keys) {
    for (let i = 0; i < 3; i++) await service.upload({ context, namespaceKey: NAMESPACE, objectKey: key,
      contentType: 'text/plain', content: Buffer.from('version ' + i) });
  }
  await service.upload({ context, namespaceKey: NAMESPACE, objectKey: 'unrelated.txt', contentType: 'text/plain', content: Buffer.from('excluded') });
  const original = repository.listObjects.bind(repository), calls = [], observed = [];
  repository.listObjects = async (namespace, options) => {
    calls.push(options); const page = await original(namespace, options);
    assert(page.length <= 3); assert(page.every(row => row.versions.length === 1)); return page;
  };
  let cursor = null;
  do {
    const page = await service.list({ context, namespaceKey: NAMESPACE, prefix: 'reports/', cursor, limit: 2 });
    assert(page.items.every(row => row.version === 3)); observed.push(...page.items.map(row => row.objectKey));
    cursor = page.nextCursor;
    assert(calls.length <= 4, 'cursor must advance');
  } while (cursor);
  assert.deepEqual(observed, [...keys].sort((a, b) => a.localeCompare(b)));
  assert.equal(new Set(observed).size, keys.length);
  assert(calls.every(options => options.limit === 3 && options.prefix === 'reports/'));
  assert.equal(calls[0].after, ''); assert.equal(calls[1].after, observed[1]);
  assert.equal((await service.listVersions({ context, namespaceKey: NAMESPACE, objectKey: keys[0] })).length, 3);
});

test('invalid cursor and foreign namespace are rejected before listing metadata', async () => {
  const { repository, service, context } = fixture();
  repository.listObjects = async () => assert.fail('metadata must not be read');
  for (const cursor of ['', 'bad=', '*', 5, 'A'.repeat(6001), Buffer.from([255]).toString('base64url'), Buffer.from('../other').toString('base64url')]) {
    await assert.rejects(service.list({ context, namespaceKey: NAMESPACE, cursor }), { code: 'invalid_page' });
  }
  await assert.rejects(service.list({ context, namespaceKey: 'user:beta' }));
});

test("multipart upload resumes parts, validates the completion manifest, and aborts cleanly", async () => {
  const { blobStore, context, service } = fixture();
  const left = Buffer.from("hello ");
  const right = Buffer.from("world");
  const complete = Buffer.concat([left, right]);
  const upload = await service.beginMultipart({
    context,
    namespaceKey: NAMESPACE,
    objectKey: "media/interview.bin",
    contentType: "application/octet-stream",
    expectedSize: complete.byteLength,
    expectedSha256: digest(complete),
  });
  await service.uploadPart({ context, uploadId: upload.uploadId, partNumber: 2, content: right, expectedSha256: digest(right) });
  assert.deepEqual((await service.listUploadParts({ context, uploadId: upload.uploadId })).map((part) => part.partNumber), [2]);
  await service.uploadPart({ context, uploadId: upload.uploadId, partNumber: 1, content: left, expectedSha256: digest(left) });
  await assert.rejects(service.completeMultipart({
    context,
    uploadId: upload.uploadId,
    parts: [{ partNumber: 1, sha256: digest(left) }],
  }), (error) => error.code === "invalid_part_manifest");
  const committed = await service.completeMultipart({
    context,
    uploadId: upload.uploadId,
    parts: [
      { partNumber: 1, sha256: digest(left) },
      { partNumber: 2, sha256: digest(right) },
    ],
  });
  assert.equal((await service.download({ context, namespaceKey: NAMESPACE, objectId: committed.objectId })).content.toString(), "hello world");

  const aborted = await service.beginMultipart({
    context, namespaceKey: NAMESPACE, objectKey: "media/abort.bin",
    contentType: "application/octet-stream", expectedSize: 3,
    expectedSha256: digest(Buffer.from("bye")),
  });
  await service.uploadPart({
    context, uploadId: aborted.uploadId, partNumber: 1,
    content: Buffer.from("bye"), expectedSha256: digest(Buffer.from("bye")),
  });
  const beforeAbort = blobStore.size;
  assert.deepEqual(await service.abortMultipart({ context, uploadId: aborted.uploadId }), {
    uploadId: aborted.uploadId,
    aborted: true,
  });
  assert.equal(blobStore.size, beforeAbort - 1);
  await assert.rejects(service.listUploadParts({ context, uploadId: aborted.uploadId }),
    (error) => error.code === "upload_not_found");
});

test("an interrupted multipart upload expires, releases quota, reclaims parts, and cannot resume", async () => {
  const { blobStore, context, now, service, advance } = fixture({ quota: 16 });
  const part = Buffer.from("half");
  const upload = await service.beginMultipart({
    context,
    namespaceKey: NAMESPACE,
    objectKey: "media/interrupted.bin",
    contentType: "application/octet-stream",
    expectedSize: 8,
    expectedSha256: digest(Buffer.from("halfdone")),
  });
  await service.uploadPart({
    context,
    uploadId: upload.uploadId,
    partNumber: 1,
    content: part,
    expectedSha256: digest(part),
  });
  assert.equal(blobStore.size, 1);
  assert.equal((await service.quota({ context, namespaceKey: NAMESPACE })).reservedBytes, 8);

  advance(1_001);
  assert.deepEqual(await service.runLifecycle({ now: now() }), {
    uploadsReclaimed: 1,
    objectsPurged: 0,
  });
  assert.equal(blobStore.size, 0);
  assert.deepEqual(await service.quota({ context, namespaceKey: NAMESPACE }), {
    namespaceKey: NAMESPACE,
    limitBytes: 16,
    committedBytes: 0,
    reservedBytes: 0,
    availableBytes: 16,
  });
  await assert.rejects(service.uploadPart({
    context,
    uploadId: upload.uploadId,
    partNumber: 2,
    content: Buffer.from("done"),
    expectedSha256: digest(Buffer.from("done")),
  }), (error) => error.code === "upload_not_found");
});

test("concurrent writers publish one object with a gap-free immutable version chain", async () => {
  const { audit, context, service } = fixture({ quota: 4_096 });
  const writes = Array.from({ length: 16 }, (_, index) => Buffer.from(`version-${index}`));
  const committed = await Promise.all(writes.map((content) => service.upload({
    context,
    namespaceKey: NAMESPACE,
    objectKey: "reports/concurrent.txt",
    contentType: "text/plain",
    content,
    expectedSha256: digest(content),
  })));
  assert.equal(new Set(committed.map((version) => version.objectId)).size, 1);
  assert.deepEqual(committed.map((version) => version.version).sort((left, right) => left - right),
    Array.from({ length: 16 }, (_, index) => index + 1));
  const versions = await service.listVersions({
    context,
    namespaceKey: NAMESPACE,
    objectId: committed[0].objectId,
  });
  assert.deepEqual(versions.map((version) => version.version),
    Array.from({ length: 16 }, (_, index) => 16 - index));
  assert.equal(audit.filter((event) => event.action === "object.version_committed").length, 16);
});

test("quota accounts for committed versions and multipart reservations", async () => {
  const { context, service } = fixture({ quota: 10 });
  const upload = await service.beginMultipart({
    context, namespaceKey: NAMESPACE, objectKey: "reserved.bin", contentType: "application/octet-stream",
    expectedSize: 8, expectedSha256: digest(Buffer.alloc(8)),
  });
  assert.deepEqual(await service.quota({ context, namespaceKey: NAMESPACE }), {
    namespaceKey: NAMESPACE,
    limitBytes: 10,
    committedBytes: 0,
    reservedBytes: 8,
    availableBytes: 2,
  });
  await assert.rejects(service.upload({
    context, namespaceKey: NAMESPACE, objectKey: "too-large.bin",
    contentType: "application/octet-stream", content: Buffer.alloc(3),
  }), (error) => error.code === "object_quota_exceeded");
  await service.abortMultipart({ context, uploadId: upload.uploadId });
  await service.upload({
    context, namespaceKey: NAMESPACE, objectKey: "fits.bin",
    contentType: "application/octet-stream", content: Buffer.alloc(10),
  });
  assert.equal((await service.quota({ context, namespaceKey: NAMESPACE })).availableBytes, 0);
});

test("scoped references bind immutable version, audience, operations, expiry, and signature", async () => {
  const { audit, context, now, service, advance } = fixture();
  const object = await service.upload({
    context, namespaceKey: NAMESPACE, objectKey: "input/scan.png",
    contentType: "image/png", content: Buffer.from("png-data"),
  });
  const issued = await service.createScopedReference({
    context,
    namespaceKey: NAMESPACE,
    objectId: object.objectId,
    audience: "worker:ocr-1",
    operations: ["range", "head"],
    expiresAt: new Date(now().getTime() + 900).toISOString(),
  });
  assert.equal("namespaceKey" in issued.reference, false);
  assert.deepEqual(issued.reference.operations, ["head", "range"]);
  const grant = await service.authorizeScopedReference({
    token: issued.token, audience: "worker:ocr-1", operation: "head",
  });
  assert.equal(grant.objectId, object.objectId);
  assert.equal((await service.headWithScopedReference({
    token: issued.token, audience: "worker:ocr-1",
  })).objectId, object.objectId);
  assert.equal((await service.downloadWithScopedReference({
    token: issued.token, audience: "worker:ocr-1", range: { start: 0, endInclusive: 2 },
  })).content.toString(), "png");
  await assert.rejects(service.authorizeScopedReference({
    token: issued.token, audience: "worker:ocr-2", operation: "head",
  }), (error) => error.code === "invalid_reference");
  await assert.rejects(service.authorizeScopedReference({
    token: issued.token, audience: "worker:ocr-1", operation: "read",
  }), (error) => error.code === "invalid_reference");
  await assert.rejects(service.authorizeScopedReference({
    token: issued.token.slice(0, -1) + "x", audience: "worker:ocr-1", operation: "head",
  }), (error) => error.code === "invalid_reference");
  advance(901);
  await assert.rejects(service.authorizeScopedReference({
    token: issued.token, audience: "worker:ocr-1", operation: "head",
  }), (error) => error.code === "invalid_reference");
  assert.equal(JSON.stringify(audit).includes(issued.token), false);
});

test("Team Drive adapter binds ingestion to the issuer and delegates cross-user read by short reference", async () => {
  const { context, now, service } = fixture();
  const content = Buffer.from("shared file bytes");
  const object = await service.upload({
    context, namespaceKey: NAMESPACE, objectKey: "drive/shared.txt",
    contentType: "text/plain", content,
  });
  const incoming = await service.createScopedReference({
    context,
    namespaceKey: NAMESPACE,
    objectId: object.objectId,
    audience: "team-drive.file",
    operations: ["read"],
    expiresAt: new Date(now().getTime() + 900),
  });
  const adapter = service.createTeamDriveObjectReferences();
  const facts = await adapter.resolve({
    actorIdentityId: "user-alpha",
    referenceId: incoming.reference.referenceId,
    audience: "team-drive.file",
    requiredOperation: "read",
  });
  assert.deepEqual(facts, {
    objectId: object.objectId,
    objectVersion: 1,
    size: content.byteLength,
    mediaType: "text/plain",
    sha256: `sha256:${digest(content)}`,
  });
  await assert.rejects(adapter.resolve({
    actorIdentityId: "user-beta",
    referenceId: incoming.reference.referenceId,
    audience: "team-drive.file",
    requiredOperation: "read",
  }), { code: "file_object_reference_invalid" });

  const delegated = await adapter.issueReadReference({
    actorIdentityId: "user-beta",
    objectId: object.objectId,
    objectVersion: 1,
    audience: "team-drive.download",
    expiresInSeconds: 1,
  });
  const downloaded = await service.downloadByReferenceId({
    context: { identityId: "user-beta", namespaceKey: "user:beta" },
    referenceId: delegated.referenceId,
  });
  assert.equal(downloaded.content.toString(), content.toString());
  await assert.rejects(service.downloadByReferenceId({
    context: { identityId: "user-gamma", namespaceKey: "user:gamma" },
    referenceId: delegated.referenceId,
  }), { code: "object_access_denied" });
});

test("delete retention and lifecycle reclaim expired uploads and object versions", async () => {
  const { blobStore, context, service, advance, now } = fixture();
  const object = await service.upload({
    context, namespaceKey: NAMESPACE, objectKey: "temporary.txt",
    contentType: "text/plain", content: Buffer.from("temporary"),
  });
  const upload = await service.beginMultipart({
    context, namespaceKey: NAMESPACE, objectKey: "orphan.bin",
    contentType: "application/octet-stream", expectedSize: 4,
    expectedSha256: digest(Buffer.from("part")),
  });
  await service.uploadPart({
    context, uploadId: upload.uploadId, partNumber: 1,
    content: Buffer.from("part"), expectedSha256: digest(Buffer.from("part")),
  });
  await service.delete({ context, namespaceKey: NAMESPACE, objectId: object.objectId });
  await assert.rejects(service.head({ context, namespaceKey: NAMESPACE, objectId: object.objectId }),
    (error) => error.code === "object_not_found");
  assert.equal((await service.listVersions({ context, namespaceKey: NAMESPACE, objectId: object.objectId })).length, 1);
  advance(1_001);
  const before = blobStore.size;
  assert.deepEqual(await service.runLifecycle({ now: now() }), { uploadsReclaimed: 1, objectsPurged: 1 });
  assert.equal(blobStore.size, before - 2);
  assert.equal((await service.quota({ context, namespaceKey: NAMESPACE })).committedBytes, 0);
});

test("namespace isolation and the internal S3 compatibility adapter fail closed", async () => {
  const { context, service } = fixture();
  const s3 = new InternalS3Adapter({ objectService: service });
  const body = Buffer.from("s3-compatible");
  const object = await s3.putObject({
    context, bucket: NAMESPACE, key: "s3/object.txt", body,
    contentType: "text/plain", checksumSha256: digest(body),
  });
  assert.equal((await s3.getObject({ context, bucket: NAMESPACE, key: "s3/object.txt" })).content.toString(), "s3-compatible");
  assert.equal((await s3.headObject({ context, bucket: NAMESPACE, key: "s3/object.txt" })).objectId, object.objectId);
  assert.equal((await s3.listObjectsV2({ context, bucket: NAMESPACE, prefix: "s3/", maxKeys: 10 })).items.length, 1);
  await assert.rejects(service.head({
    context: { identityId: "user-alpha", namespaceKey: "user:beta" },
    namespaceKey: NAMESPACE,
    objectId: object.objectId,
  }), (error) => error.code === "object_access_denied" && error.status === 403);
});

test("production construction rejects a plaintext blob adapter by default", () => {
  assert.throws(() => new ProtectedObjectService({
    repository: new MemoryObjectRepository(),
    blobStore: new MemoryBlobStore(),
    referenceSigningKey: randomBytes(32),
  }), /must enforce envelope encryption/);
});
