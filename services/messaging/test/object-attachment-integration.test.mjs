import assert from "node:assert/strict";
import { test } from "node:test";

import { ArtifactProvenanceService } from "../../object-service/src/artifact-provenance-service.mjs";
import { MemoryArtifactProvenanceRepository } from "../../object-service/src/memory-artifact-provenance-repository.mjs";
import { MemoryBlobStore } from "../../object-service/src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../../object-service/src/memory-repository.mjs";
import { ProtectedObjectService } from "../../object-service/src/object-service.mjs";
import { MemoryMessagingRepository } from "../src/memory-repository.mjs";
import { MessagingService } from "../src/messaging-service.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const NAMESPACE = `user:${OWNER}`;
const NOW = new Date("2026-08-11T08:00:00.000Z");

test("messaging consumes a real audience-bound object reference and persists only immutable attachment facts", async () => {
  const objects = new ProtectedObjectService({
    repository: new MemoryObjectRepository(), blobStore: new MemoryBlobStore(),
    referenceSigningKey: Buffer.alloc(32, 71), clock: () => new Date(NOW), allowTestPlaintextBlobStore: true,
  });
  const objectContext = { identityId: OWNER, identityKind: "local_user", namespaceAccess: [{ namespaceKey: NAMESPACE, operations: ["write", "read", "reference:create"] }] };
  const stored = await objects.upload({ context: objectContext, namespaceKey: NAMESPACE, objectKey: "messaging/roadmap.pdf", contentType: "application/pdf", content: Buffer.from("roadmap") });
  const reference = await objects.createScopedReference({
    context: objectContext, namespaceKey: NAMESPACE, objectId: stored.objectId,
    audience: "messaging.attachment", operations: ["head", "read", "range"],
    expiresAt: new Date(NOW.getTime() + 600_000),
  });
  const provenanceRepository = new MemoryArtifactProvenanceRepository();
  const provenance = new ArtifactProvenanceService({ repository: provenanceRepository, objectGateway: objects.createObjectHandoffGateway(), clock: () => new Date(NOW) });
  const registered = await provenance.register({
    context: objectContext, referenceId: reference.reference.referenceId, audience: "messaging.attachment",
    artifactKind: "chat-attachment", producer: { kind: "user", key: "messaging.upload", applicationKey: "official.messaging" },
  });
  const service = new MessagingService({
    repository: new MemoryMessagingRepository(), attachmentVerifier: provenance.createMessagingAttachmentVerifier(),
    clock: () => new Date(NOW),
  });
  const context = (actorIdentityId) => ({ actorIdentityId, actorKind: "local_user", permissions: ["message:read", "message:write", "message:manage"] });
  const conversation = await service.createConversation(context(OWNER), { kind: "direct", participantIdentityIds: [OWNER, MEMBER] });
  const message = await service.sendMessage(context(OWNER), conversation.id, {
    idempotencyKey: "attachment-integration-1", content: "请查看", attachmentReferenceIds: [reference.reference.referenceId],
  });
  assert.equal(message.attachments[0].filename, "roadmap.pdf");
  assert.equal(message.attachments[0].objectId, stored.objectId);
  assert.equal(JSON.stringify(message).includes(reference.reference.referenceId), false);
  const handoffs = await provenanceRepository.handoffsForObject(stored.objectId, 1);
  assert.equal(handoffs[0].provenanceId, registered.record.id);
  assert.equal(handoffs[0].consumer.kind, "messaging");
  await assert.rejects(service.sendMessage(context(MEMBER), conversation.id, {
    idempotencyKey: "attachment-integration-2", content: "reuse", attachmentReferenceIds: [reference.reference.referenceId],
  }), { code: "artifact_reference_invalid" });
});
