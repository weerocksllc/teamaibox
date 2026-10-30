import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { ArtifactProvenanceService } from "../src/artifact-provenance-service.mjs";
import { MemoryArtifactProvenanceRepository } from "../src/memory-artifact-provenance-repository.mjs";
import { MemoryBlobStore } from "../src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../src/memory-repository.mjs";
import { ProtectedObjectService } from "../src/object-service.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const NAMESPACE = `user:${OWNER}`;

function fixture() {
  let now = new Date("2026-08-11T08:00:00.000Z");
  const repository = new MemoryObjectRepository();
  const events = [];
  const objects = new ProtectedObjectService({
    repository, blobStore: new MemoryBlobStore(), referenceSigningKey: Buffer.alloc(32, 51),
    clock: () => new Date(now), audit: async (event) => events.push(event),
    allowTestPlaintextBlobStore: true,
  });
  const provenanceRepository = new MemoryArtifactProvenanceRepository();
  const provenance = new ArtifactProvenanceService({
    repository: provenanceRepository, objectGateway: objects.createObjectHandoffGateway(),
    clock: () => new Date(now), audit: async (event) => events.push(event),
  });
  const context = {
    identityId: OWNER, identityKind: "local_user",
    namespaceAccess: [{ namespaceKey: NAMESPACE, operations: ["write", "read", "reference:create"] }],
  };
  const upload = async (name, body, audience) => {
    const content = Buffer.from(body);
    const object = await objects.upload({ context, namespaceKey: NAMESPACE, objectKey: name, contentType: "application/json", content });
    const reference = await objects.createScopedReference({
      context, namespaceKey: NAMESPACE, objectId: object.objectId, version: object.version,
      audience, operations: ["head", "read", "range"],
      expiresAt: new Date(now.getTime() + 600_000),
    });
    return { object, referenceId: reference.reference.referenceId, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` };
  };
  return { context, events, objects, provenance, provenanceRepository, upload, advance(ms) { now = new Date(now.getTime() + ms); } };
}

test("registers immutable cross-application provenance without persisting expiring reference identities", async () => {
  const state = fixture();
  const source = await state.upload("uploads/source.json", "source", "compute:ocr");
  const sourceRecord = await state.provenance.register({
    context: state.context, referenceId: source.referenceId, audience: "compute:ocr", artifactKind: "ai-input",
    producer: { kind: "user", key: "user.upload" }, metadata: { filename: "source.json" },
  });
  const result = await state.upload("results/ocr.json", "result", "compute.user-result");
  const derived = await state.provenance.register({
    context: state.context, referenceId: result.referenceId, audience: "compute.user-result", artifactKind: "ai-result",
    producer: { kind: "compute-job", key: "compute.ocr", jobId: JOB, applicationKey: "official.ocr" },
    sources: [{ referenceId: source.referenceId, audience: "compute:ocr", relationship: "derived-from" }],
    metadata: { schema: "teamaibox.ai.ocr-result.v1" },
  });
  assert.equal(derived.created, true);
  assert.equal(derived.record.sources[0].provenanceId, sourceRecord.record.id);
  assert.match(derived.record.provenanceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(derived).includes(result.referenceId), false);
  assert.equal(JSON.stringify(derived).includes(source.referenceId), false);
  const lineage = await state.provenance.lineage({ context: state.context, artifactId: derived.record.id });
  assert.deepEqual(lineage.records.map((item) => item.id), [derived.record.id, sourceRecord.record.id]);

  const replay = await state.provenance.register({
    context: state.context, referenceId: result.referenceId, audience: "compute.user-result", artifactKind: "ai-result",
    producer: { kind: "compute-job", key: "compute.ocr", jobId: JOB, applicationKey: "official.ocr" },
    sources: [{ referenceId: source.referenceId, audience: "compute:ocr", relationship: "derived-from" }],
    metadata: { schema: "teamaibox.ai.ocr-result.v1" },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.record.id, derived.record.id);
});

test("consumption requires the exact issuer, audience, live grant, and records a redacted handoff", async () => {
  const state = fixture();
  const value = await state.upload("agent/report.json", "artifact", "assistant.artifact");
  const registered = await state.provenance.register({
    context: state.context, referenceId: value.referenceId, audience: "assistant.artifact", artifactKind: "agent-artifact",
    producer: { kind: "agent", key: "agent.opencode", applicationKey: "official.assistant" },
  });
  const consumed = await state.provenance.consume({
    context: state.context, referenceId: value.referenceId, audience: "assistant.artifact",
    consumer: { kind: "application", key: "assistant.conversation", applicationKey: "official.assistant" },
  });
  assert.equal(consumed.provenance.id, registered.record.id);
  const handoffs = await state.provenanceRepository.handoffsForObject(value.object.objectId, 1);
  assert.equal(handoffs.length, 1);
  assert.equal(JSON.stringify(handoffs).includes(value.referenceId), false);
  await assert.rejects(state.provenance.consume({
    context: { identityId: OTHER }, referenceId: value.referenceId, audience: "assistant.artifact",
    consumer: { kind: "application", key: "assistant.conversation" },
  }), { code: "artifact_reference_invalid" });
  await assert.rejects(state.provenance.consume({
    context: state.context, referenceId: value.referenceId, audience: "team-drive.file",
    consumer: { kind: "team-drive", key: "team-drive.file" },
  }), { code: "artifact_reference_invalid" });
  state.advance(600_001);
  await assert.rejects(state.provenance.consume({
    context: state.context, referenceId: value.referenceId, audience: "assistant.artifact",
    consumer: { kind: "application", key: "assistant.conversation" },
  }), { code: "artifact_reference_invalid" });
});

test("issues a fresh audience-bound reference from a durable artifact and adapts messaging attachments", async () => {
  const state = fixture();
  const attachment = await state.upload("messaging/plan.pdf", "pdf", "messaging.attachment");
  const registered = await state.provenance.register({
    context: state.context, referenceId: attachment.referenceId, audience: "messaging.attachment", artifactKind: "chat-attachment",
    producer: { kind: "user", key: "messaging.upload", applicationKey: "official.messaging" },
  });
  const verifier = state.provenance.createMessagingAttachmentVerifier();
  const facts = await verifier.resolveAttachment({
    actorIdentityId: OWNER, referenceId: attachment.referenceId,
    audience: "messaging.attachment", requiredOperation: "read",
  });
  assert.equal(facts.filename, "plan.pdf");
  assert.equal(facts.objectId, attachment.object.objectId);
  const issued = await state.provenance.issue({
    context: state.context, artifactId: registered.record.id, audience: "team-drive.file", expiresInSeconds: 60,
  });
  const resolved = await state.objects.createObjectHandoffGateway().resolve({
    actorIdentityId: OWNER, referenceId: issued.referenceId,
    audience: "team-drive.file", requiredOperation: "read",
  });
  assert.equal(resolved.objectId, attachment.object.objectId);
  assert.equal("namespaceKey" in resolved, false);
  assert.equal(JSON.stringify(state.events).includes(issued.token), false);
});
