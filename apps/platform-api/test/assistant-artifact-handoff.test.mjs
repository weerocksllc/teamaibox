import assert from "node:assert/strict";
import { test } from "node:test";

import { AssistantArtifactHandoff } from "../src/assistant/artifact-handoff.mjs";
import { AssistantService } from "../src/assistant/assistant-service.mjs";
import { MemoryAssistantRepository } from "../src/assistant/memory-repository.mjs";
import { ArtifactProvenanceService } from "../../../services/object-service/src/artifact-provenance-service.mjs";
import { MemoryArtifactProvenanceRepository } from "../../../services/object-service/src/memory-artifact-provenance-repository.mjs";
import { MemoryBlobStore } from "../../../services/object-service/src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../../../services/object-service/src/memory-repository.mjs";
import { ProtectedObjectService } from "../../../services/object-service/src/object-service.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NAMESPACE = `user:${OWNER}`;

async function fixture() {
  const clock = () => new Date("2026-08-11T08:00:00.000Z");
  const objects = new ProtectedObjectService({
    repository: new MemoryObjectRepository(), blobStore: new MemoryBlobStore(),
    referenceSigningKey: Buffer.alloc(32, 81), clock, allowTestPlaintextBlobStore: true,
  });
  const provenanceRepository = new MemoryArtifactProvenanceRepository();
  const provenance = new ArtifactProvenanceService({ repository: provenanceRepository, objectGateway: objects.createObjectHandoffGateway(), clock });
  const artifactHandoff = new AssistantArtifactHandoff({ provenanceService: provenance });
  const objectContext = { identityId: OWNER, identityKind: "local_user", namespaceAccess: [{ namespaceKey: NAMESPACE, operations: ["write", "read", "reference:create"] }] };
  const upload = async (objectKey, contentType, body, audience) => {
    const content = Buffer.from(body);
    const stored = await objects.upload({ context: objectContext, namespaceKey: NAMESPACE, objectKey, contentType, content });
    const reference = await objects.createScopedReference({
      context: objectContext, namespaceKey: NAMESPACE, objectId: stored.objectId,
      audience, operations: ["head", "read", "range"], expiresAt: new Date(clock().getTime() + 600_000),
    });
    return { stored, referenceId: reference.reference.referenceId, size: content.byteLength };
  };
  const input = await upload("assistant/input/spec.md", "text/markdown", "input spec", "assistant.input");
  const output = await upload("assistant/output/report.md", "text/markdown", "generated report", "assistant.artifact");
  const service = new AssistantService({
    repository: new MemoryAssistantRepository(), clock, artifactHandoff,
    answerRunner: { async run({ emit }) { await emit({ type: "text_delta", delta: "answer" }); } },
    agentRunner: {
      async run({ emit }) {
        await emit({ type: "artifact.created", artifact: { referenceId: output.referenceId, label: "report.md", mimeType: "text/markdown", sizeBytes: output.size } });
        await emit({ type: "text_delta", delta: "完成" });
      },
    },
  });
  return { artifactHandoff, input, objects, objectContext, output, provenance, provenanceRepository, service, upload };
}

test("Assistant resolves input references, registers Agent output lineage, and refreshes download access", async () => {
  const state = await fixture();
  const conversation = await state.service.createConversation(OWNER);
  const submitted = await state.service.submitMessage(OWNER, conversation.id, {
    content: "根据附件生成报告", mode: "agent", idempotencyKey: "assistant-artifact-1",
    inputReferenceIds: [state.input.referenceId],
  });
  assert.equal((await state.service.waitForRun(submitted.run.id)).status, "completed");
  const detail = await state.service.getConversation(OWNER, conversation.id);
  const inputArtifact = detail.messages[0].artifacts[0];
  const outputArtifact = detail.messages[1].artifacts[0];
  assert.equal(inputArtifact.role, "input");
  assert.equal(outputArtifact.role, "output");
  assert.equal(outputArtifact.referenceId, outputArtifact.artifactId);
  assert.equal(JSON.stringify(detail).includes(state.input.referenceId), false);
  assert.equal(JSON.stringify(detail).includes(state.output.referenceId), false);
  const lineage = await state.provenance.lineage({ context: { identityId: OWNER }, artifactId: outputArtifact.artifactId });
  assert.deepEqual(lineage.records.map((item) => item.artifactKind), ["agent-artifact", "ai-input"]);
  const download = await state.service.artifactDownload(OWNER, outputArtifact.artifactId);
  assert.notEqual(download.referenceId, state.output.referenceId);
  const metadata = await state.objects.headByReferenceId({
    context: { identityId: OWNER, identityKind: "local_user", namespaceAccess: [{ namespaceKey: NAMESPACE, operations: ["read"] }] },
    referenceId: download.referenceId,
  });
  assert.equal(metadata.objectId, state.output.stored.objectId);
  await assert.rejects(state.service.artifactDownload(OTHER, outputArtifact.artifactId), { code: "artifact_not_found" });
});

test("Assistant rejects runner-declared artifact facts that differ from protected object facts", async () => {
  const state = await fixture();
  const service = new AssistantService({
    repository: new MemoryAssistantRepository(), artifactHandoff: state.artifactHandoff,
    answerRunner: { async run() {} },
    agentRunner: { async run({ emit }) { await emit({ type: "artifact.created", artifact: { referenceId: state.output.referenceId, label: "report.md", mimeType: "text/markdown", sizeBytes: state.output.size + 1 } }); } },
  });
  const conversation = await service.createConversation(OWNER);
  const submitted = await service.submitMessage(OWNER, conversation.id, { content: "生成", mode: "agent", idempotencyKey: "assistant-artifact-mismatch" });
  assert.equal((await service.waitForRun(submitted.run.id)).status, "failed");
});

test("Assistant handles seventy attachments and preserves every output source", async () => {
  const state = await fixture();
  const references = [];
  for (let index = 0; index < 70; index++) {
    references.push((await state.upload(`assistant/input/${index}.txt`, "text/plain", `input ${index}`, "assistant.input")).referenceId);
  }
  const conversation = await state.service.createConversation(OWNER);
  const submitted = await state.service.submitMessage(OWNER, conversation.id, {
    content: "根据附件生成报告", mode: "agent", inputReferenceIds: references,
  });
  assert.equal((await state.service.waitForRun(submitted.run.id)).status, "completed");
  const detail = await state.service.getConversation(OWNER, conversation.id);
  assert.equal(detail.messages[0].artifacts.length, 70);
  const output = await state.provenanceRepository.findById(detail.messages[1].artifacts[0].artifactId);
  assert.equal(output.sources.length, 70);
  assert.deepEqual(output.sources.map(source => source.ordinal), Array.from({length: 70}, (_, index) => index));
  await assert.rejects(state.service.submitMessage(OWNER, conversation.id, {
    content: "重复引用仍然无效", inputReferenceIds: [references[0], references[0]],
  }), {code: "assistant_artifact_input_invalid"});
});
