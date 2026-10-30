import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { MemoryBlobStore } from "../../object-service/src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../../object-service/src/memory-repository.mjs";
import { ProtectedObjectService } from "../../object-service/src/object-service.mjs";
import { ExternalObjectTransferService } from "../src/external-object-transfer-service.mjs";
import { MemoryExternalObjectGrantRepository } from "../src/memory-external-object-grant-repository.mjs";

const OWNER = "00000000-0000-4000-8000-000000000101";
const JOB = "00000000-0000-4000-8000-000000000201";
const ATTEMPT = "00000000-0000-4000-8000-000000000301";
const PROVIDER = "00000000-0000-4000-8000-000000000401";
const NAMESPACE = `user:${OWNER}`;

function sha(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

async function fixture() {
  let now = new Date("2026-08-11T08:00:00Z");
  let sequence = 500;
  const objectRepository = new MemoryObjectRepository();
  const objects = new ProtectedObjectService({
    repository: objectRepository, blobStore: new MemoryBlobStore(),
    referenceSigningKey: Buffer.alloc(32, 11), clock: () => new Date(now),
    allowTestPlaintextBlobStore: true,
  });
  const context = {
    identityId: OWNER, identityKind: "local_user",
    namespaceAccess: [{ namespaceKey: NAMESPACE, operations: ["write", "read", "list", "reference:create"] }],
  };
  const input = Buffer.from("protected image bytes");
  const stored = await objects.upload({ context, namespaceKey: NAMESPACE, objectKey: "input/scan.png", contentType: "image/png", content: input });
  const audit = [];
  const service = new ExternalObjectTransferService({
    repository: new MemoryExternalObjectGrantRepository(),
    objectGateway: objects.createObjectHandoffGateway(), publicOrigin: "https://box.example",
    clock: () => new Date(now),
    idFactory: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    audit: async (event) => audit.push(event),
  });
  const artifact = { role: "request.input", object: {
    objectId: stored.objectId, objectVersion: stored.version, sha256: `sha256:${stored.integrity.digest}`,
    size: stored.size, mediaType: stored.contentType,
  } };
  return { service, objects, context, artifact, input, audit, advance(ms) { now = new Date(now.getTime() + ms); } };
}

function tokenFrom(url) { return new URL(url).pathname.split("/").at(-2); }

test("output grants honor the caller's size contract above 64 MiB", async () => {
  const value = await fixture();
  const maximumBytes = 256 * 1024 * 1024;
  const grant = await value.service.issueOutput({ ownerIdentityId: OWNER, jobId: JOB,
    attemptId: ATTEMPT, providerId: PROVIDER, leaseExpiresAt: "2026-08-11T08:10:00Z",
    contentType: "application/octet-stream", maximumBytes });
  assert.equal(grant.maximumBytes, maximumBytes);
  await assert.rejects(value.service.issueOutput({ ownerIdentityId: OWNER, jobId: JOB,
    attemptId: ATTEMPT, providerId: PROVIDER, leaseExpiresAt: "2026-08-11T08:10:00Z",
    contentType: "application/octet-stream", maximumBytes, expectedSize: maximumBytes + 1 }),
    { code: "external_object_grant_invalid" });
});

test("70 external input grants remain readable and are all revoked", async () => {
  const value = await fixture();
  const grants = await value.service.issueInputs({ ownerIdentityId: OWNER, jobId: JOB,
    attemptId: ATTEMPT, providerId: PROVIDER, leaseExpiresAt: "2026-08-11T08:10:00Z",
    inputArtifacts: Array.from({ length: 70 }, () => structuredClone(value.artifact)) });
  assert.equal(grants.length, 70);
  assert.equal(new Set(grants.map((grant) => grant.url)).size, 70);
  for (const grant of grants) assert.deepEqual((await value.service.download({ ticket: tokenFrom(grant.url) })).content, value.input);
  await value.service.revokeAttempt({ ownerIdentityId: OWNER, attemptId: ATTEMPT });
  for (const grant of grants) await assert.rejects(value.service.head({ ticket: tokenFrom(grant.url) }), { code: "external_object_reference_invalid" });
});

test("external input URLs are opaque, exact, range-capable, expiring, and revocable", async () => {
  const value = await fixture();
  const grants = await value.service.issueInputs({
    ownerIdentityId: OWNER, jobId: JOB, attemptId: ATTEMPT, providerId: PROVIDER,
    leaseExpiresAt: "2026-08-11T08:10:00Z", inputArtifacts: [value.artifact],
  });
  assert.equal(grants.length, 1);
  assert.match(grants[0].url, /^https:\/\/box\.example\/api\/v1\/external-object-proxy\/[A-Za-z0-9_-]{43}\/content$/);
  for (const forbidden of [OWNER, JOB, ATTEMPT, PROVIDER, value.artifact.object.objectId, "input/scan.png", NAMESPACE]) {
    assert.equal(grants[0].url.includes(forbidden), false);
  }
  assert.equal("credential" in grants[0], false);
  assert.equal("referenceId" in grants[0], false);
  const ticket = tokenFrom(grants[0].url);
  assert.equal((await value.service.head({ ticket })).size, value.input.length);
  const partial = await value.service.download({ ticket, range: { start: 10, endInclusive: 14 } });
  assert.equal(partial.content.toString(), "image");
  assert.equal((await value.service.download({ ticket })).content.toString(), value.input.toString());
  await value.service.revokeAttempt({ ownerIdentityId: OWNER, attemptId: ATTEMPT });
  await assert.rejects(value.service.head({ ticket }), { code: "external_object_reference_invalid" });
  assert.equal(value.audit.some((event) => event.action === "external_object.attempt_revoked"), true);
});

test("external input reference cannot be used after its attempt lease expires", async () => {
  const value = await fixture();
  const [grant] = await value.service.issueInputs({
    ownerIdentityId: OWNER, jobId: JOB, attemptId: ATTEMPT, providerId: PROVIDER,
    leaseExpiresAt: "2026-08-11T08:00:02Z", inputArtifacts: [value.artifact],
  });
  value.advance(2_001);
  await assert.rejects(value.service.download({ ticket: tokenFrom(grant.url) }), { code: "external_object_reference_invalid", status: 404 });
});

test("input range access does not stop after 1024 requests, and expiry still applies", async () => {
  const value = await fixture();
  const [grant] = await value.service.issueInputs({ ownerIdentityId: OWNER, jobId: JOB,
    attemptId: ATTEMPT, providerId: PROVIDER, leaseExpiresAt: "2026-08-11T08:10:00Z", inputArtifacts: [value.artifact] });
  const ticket = tokenFrom(grant.url);
  for (let index = 0; index < 1030; index++) assert.equal((await value.service.head({ ticket })).size, value.input.length);
  value.advance(11 * 60_000);
  await assert.rejects(value.service.head({ ticket }), { code: "external_object_reference_invalid" });
});

test("external output uses one exact write, verifies integrity, and stores under the owner namespace", async () => {
  const value = await fixture();
  const output = Buffer.from("translated result");
  const grant = await value.service.issueOutput({
    ownerIdentityId: OWNER, jobId: JOB, attemptId: ATTEMPT, providerId: PROVIDER,
    leaseExpiresAt: "2026-08-11T08:10:00Z", contentType: "text/plain",
    maximumBytes: 1024, expectedSize: output.length, suffix: "txt",
  });
  const ticket = tokenFrom(grant.url);
  await assert.rejects(value.service.upload({
    ticket, contentType: "text/plain", content: output, sha256: `sha256:${"0".repeat(64)}`,
  }), { code: "external_object_upload_mismatch" });
  const stored = await value.service.upload({ ticket, contentType: "text/plain", content: output, sha256: sha(output) });
  assert.equal((await value.objects.download({ context: value.context, namespaceKey: NAMESPACE, objectId: stored.objectId })).content.toString(), output.toString());
  await assert.rejects(value.service.upload({ ticket, contentType: "text/plain", content: output, sha256: sha(output) }), { code: "external_object_reference_invalid" });
});

test("concurrent output writes have one winner and never overwrite", async () => {
  const value = await fixture();
  const output = Buffer.from("single result");
  const grant = await value.service.issueOutput({
    ownerIdentityId: OWNER, jobId: JOB, attemptId: ATTEMPT, providerId: PROVIDER,
    leaseExpiresAt: "2026-08-11T08:10:00Z", contentType: "application/octet-stream", maximumBytes: 1024,
  });
  const calls = [1, 2].map(() => value.service.upload({
    ticket: tokenFrom(grant.url), contentType: "application/octet-stream", content: output, sha256: sha(output),
  }));
  const settled = await Promise.allSettled(calls);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected" && item.reason.code === "external_object_reference_invalid").length, 1);
});

test("repository failure rolls back every already-issued underlying reference", async () => {
  const revoked = [];
  let issued = 0;
  const service = new ExternalObjectTransferService({
    repository: {
      async create() { throw new Error("database unavailable"); }, async findByTicketDigest() {}, async authorize() {},
      async completeOutput() {}, async failOutput() {}, async revokeAttempt() { return []; },
    },
    objectGateway: {
      async issue() { issued += 1; return { referenceId: "00000000-0000-4000-8000-000000000999" }; },
      async revoke({ referenceId }) { revoked.push(referenceId); }, async head() {}, async download() {}, async storeOutput() {},
    },
    publicOrigin: "https://box.example", clock: () => new Date("2026-08-11T08:00:00Z"),
  });
  const artifact = { role: "input", object: { objectId: OWNER, objectVersion: 1, sha256: `sha256:${"a".repeat(64)}`, size: 1, mediaType: "application/octet-stream" } };
  await assert.rejects(service.issueInputs({ ownerIdentityId: OWNER, jobId: JOB, attemptId: ATTEMPT, providerId: PROVIDER, leaseExpiresAt: "2026-08-11T08:01:00Z", inputArtifacts: [artifact] }), /database unavailable/);
  assert.equal(issued, 1);
  assert.deepEqual(revoked, ["00000000-0000-4000-8000-000000000999"]);
});
