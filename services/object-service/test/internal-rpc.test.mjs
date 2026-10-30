import assert from "node:assert/strict";
import { test } from "node:test";

import { ArtifactProvenanceService } from "../src/artifact-provenance-service.mjs";
import { createObjectRpcServer, startStorageObservationLoop } from "../src/internal-rpc-server.mjs";
import { RemoteProtectedObjectService } from "../src/internal-rpc-client.mjs";
import { MemoryArtifactProvenanceRepository } from "../src/memory-artifact-provenance-repository.mjs";
import { MemoryBlobStore } from "../src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../src/memory-repository.mjs";
import { ProtectedObjectService } from "../src/object-service.mjs";


const OWNER = "11111111-1111-4111-8111-111111111111";
const TOKEN = Buffer.alloc(32, 91).toString("base64url");


async function fixture() {
  const objects = new ProtectedObjectService({
    repository: new MemoryObjectRepository(), blobStore: new MemoryBlobStore(),
    referenceSigningKey: Buffer.alloc(32, 17), allowTestPlaintextBlobStore: true,
  });
  const provenance = new ArtifactProvenanceService({
    repository: new MemoryArtifactProvenanceRepository(), objectGateway: objects.createObjectHandoffGateway(),
  });
  const server = createObjectRpcServer({ token: TOKEN, objectService: objects, provenanceService: provenance });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const fetchImplementation = (_url, options) => fetch(`http://127.0.0.1:${address.port}/internal/v1/call`, options);
  const client = new RemoteProtectedObjectService({
    endpoint: "http://object-service:8080/internal/v1/call", token: TOKEN, fetchImplementation,
  });
  return { server, client, fetchImplementation, objects };
}


test("storage observation loop refreshes mounted pools immediately and periodically without overlapping", async () => {
  const callbacks = [];
  const cleared = [];
  const errors = [];
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const storageAdministration = {
    async refresh({ context }) {
      assert.deepEqual(context.permissions, ["storage:view", "storage:manage"]);
      calls += 1;
      if (calls === 2) await pending;
      if (calls === 3) throw Object.assign(new Error("mount unavailable"), { code: "storage_mount_unavailable" });
    },
  };
  const timer = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
  const loop = await startStorageObservationLoop({ storageAdministration,
    context: { identityId: OWNER, permissions: ["storage:view", "storage:manage"] }, intervalMilliseconds: 1_000,
    setIntervalImplementation(callback) { callbacks.push(callback); return timer; },
    clearIntervalImplementation(value) { cleared.push(value); }, onError(error) { errors.push(error.code); } });
  assert.equal(calls, 1);
  assert.equal(timer.unrefCalls, 1);
  callbacks[0]();
  callbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "overlapping refresh was not suppressed");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  callbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  assert.deepEqual(errors, ["storage_mount_unavailable"]);
  loop.stop();
  loop.stop();
  assert.deepEqual(cleared, [timer]);
});


test("internal object RPC carries encrypted-service operations and messaging attachment resolution without content retention", async () => {
  const { server, client } = await fixture();
  try {
    const namespaceKey = `user:${OWNER}`;
    const context = {
      identityId: OWNER, identityKind: "local_user",
      namespaceAccess: [{ namespaceKey, operations: ["read", "write", "delete", "list", "reference:create", "reference:revoke"] }],
    };
    const content = Buffer.from("rpc attachment");
    const uploaded = await client.upload({
      context, namespaceKey, objectKey: "messaging/rpc.txt", contentType: "text/plain", content,
    });
    const scoped = await client.createScopedReference({
      context, namespaceKey, objectId: uploaded.objectId, audience: "messaging.attachment",
      operations: ["head", "read", "range"], expiresAt: new Date(Date.now() + 60_000),
    });
    const attachment = await client.createMessagingAttachmentVerifier().resolveAttachment({
      actorIdentityId: OWNER, referenceId: scoped.reference.referenceId,
      audience: "messaging.attachment", requiredOperation: "read",
    });
    assert.equal(attachment.filename, "rpc.txt");
    assert.equal(attachment.byteSize, content.byteLength);
    const member = "22222222-2222-4222-8222-222222222222";
    const delegated = await client.createMessagingAttachmentVerifier().issueDownloadReference({
      actorIdentityId: member, objectId: uploaded.objectId, objectVersion: uploaded.version, expiresInSeconds: 300,
    });
    const memberContext = { identityId: member, identityKind: "local_user", namespaceAccess: [] };
    const delegatedDownload = await client.downloadByReferenceId({ context: memberContext, referenceId: delegated.referenceId });
    assert.deepEqual(delegatedDownload.content, content);
    await assert.rejects(client.downloadByReferenceId({
      context: { identityId: "33333333-3333-4333-8333-333333333333", identityKind: "local_user", namespaceAccess: [] },
      referenceId: delegated.referenceId,
    }), { code: "object_access_denied" });
    const downloaded = await client.downloadByReferenceId({ context, referenceId: scoped.reference.referenceId });
    assert.deepEqual(downloaded.content, content);
    const referenceStream = await client.downloadStreamByReferenceId({context,referenceId:scoped.reference.referenceId});
    const referenceChunks=[];
    for await(const chunk of referenceStream.chunks)referenceChunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(referenceChunks),content);
    await assert.rejects(client.downloadStreamByReferenceId({context:memberContext,referenceId:scoped.reference.referenceId}),{code:'object_access_denied'});
    const handoff=client.createObjectHandoffGateway();
    const handoffInput={actorIdentityId:OWNER,referenceId:scoped.reference.referenceId,audience:'messaging.attachment'};
    assert.deepEqual((await handoff.download(handoffInput)).content,content);
    const streamed=await handoff.downloadStream(handoffInput),received=[];
    for await(const chunk of streamed.chunks)received.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(received),content);
    await assert.rejects(handoff.downloadStream({...handoffInput,actorIdentityId:member}),{code:'artifact_reference_invalid'});
    const scopedGateway = client.createScopedTransferGateway();
    assert.equal((await scopedGateway.head({ token: scoped.token, audience: "messaging.attachment" })).size, content.byteLength);
    assert.deepEqual((await scopedGateway.download({ token: scoped.token, audience: "messaging.attachment" })).content, content);
    await client.revokeScopedReference({ context, referenceId: scoped.reference.referenceId, reason: "rpc_test_finished" });
    await assert.rejects(client.downloadStreamByReferenceId({context,referenceId:scoped.reference.referenceId}),{code:'invalid_reference'});
    await assert.rejects(handoff.downloadStream(handoffInput));
    await assert.rejects(scopedGateway.download({ token: scoped.token, audience: "messaging.attachment" }), {
      code: "invalid_reference", status: 401,
    });
    const directDownload = await client.download({ context, namespaceKey, objectId: uploaded.objectId, version: uploaded.version });
    assert.deepEqual(directDownload.content, content);
    const deleted = await client.delete({ context, namespaceKey, objectId: uploaded.objectId });
    assert.deepEqual(deleted, { objectId: uploaded.objectId, deleted: true });
    await assert.rejects(client.download({ context, namespaceKey, objectId: uploaded.objectId }), { code: "object_not_found" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("internal object RPC denies an untrusted service token before executing a method", async () => {
  const { server, fetchImplementation } = await fixture();
  try {
    const client = new RemoteProtectedObjectService({
      endpoint: "http://object-service:8080/internal/v1/call",
      token: Buffer.alloc(32, 92).toString("base64url"), fetchImplementation,
    });
    await assert.rejects(() => client.list({}), { code: "object_rpc_unauthorized", status: 401 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("internal object RPC gives bounded encrypted artifact transfers more time than control calls", async () => {
  const elapsed = [];
  const client = new RemoteProtectedObjectService({
    endpoint: "http://object-service:8080/internal/v1/call", token: TOKEN,
    requestTimeoutMilliseconds: 20, transferTimeoutMilliseconds: 120,
    retryDelaysMilliseconds: [],
    fetchImplementation: async (_url, options) => {
      const started = Date.now();
      await new Promise((resolve, reject) => {
        const aborted = () => reject(options.signal.reason);
        if (options.signal.aborted) aborted();
        else options.signal.addEventListener("abort", aborted, { once: true });
      }).finally(() => elapsed.push(Date.now() - started));
    },
  });
  await assert.rejects(client.list({}), { code: "object_service_unavailable", retryable: true });
  await assert.rejects(client.createObjectHandoffGateway().storeOutput({}), {
    code: "object_service_unavailable", retryable: true,
  });
  assert.ok(elapsed[0] >= 10 && elapsed[0] < 100, `control timeout drifted: ${elapsed[0]}ms`);
  assert.ok(elapsed[1] >= 90 && elapsed[1] > elapsed[0] * 2, `transfer timeout drifted: ${elapsed[1]}ms`);
});


test("internal object RPC retries replay-safe reads and digest-bound parts but not final commits", async () => {
  const calls = [];
  const client = new RemoteProtectedObjectService({
    endpoint: "http://object-service:8080/internal/v1/call", token: TOKEN,
    retryDelaysMilliseconds: [0],
    fetchImplementation: async (_url, options) => {
      const method = JSON.parse(Buffer.from(options.body).toString("utf8")).method;
      calls.push(method);
      if (calls.filter((item) => item === method).length === 1) throw new Error("service restarting");
      return new Response(JSON.stringify({ ok: true, result: method === "headByReferenceId"
        ? { size: 1 } : { partNumber: 1, integrity: { digest: "a".repeat(64) } } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await client.headByReferenceId({}), { size: 1 });
  assert.equal((await client.createScopedTransferGateway().head({})).partNumber, 1);
  assert.equal((await client.createObjectHandoffGateway().storeOutputPart({})).partNumber, 1);
  await assert.rejects(client.createObjectHandoffGateway().completeOutput({}), {
    code: "object_service_unavailable", retryable: true,
  });
  assert.deepEqual(calls, ["headByReferenceId", "headByReferenceId", "scoped.head", "scoped.head", "handoff.storeOutputPart",
    "handoff.storeOutputPart", "handoff.completeOutput"]);
});
