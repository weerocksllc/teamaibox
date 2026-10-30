import assert from "node:assert/strict";
import { test } from "node:test";

import { ComputeArtifactHandoff } from "../src/compute/artifact-handoff.mjs";
import { ArtifactProvenanceService } from "../../../services/object-service/src/artifact-provenance-service.mjs";
import { MemoryArtifactProvenanceRepository } from "../../../services/object-service/src/memory-artifact-provenance-repository.mjs";
import { MemoryBlobStore } from "../../../services/object-service/src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../../../services/object-service/src/memory-repository.mjs";
import { ProtectedObjectService } from "../../../services/object-service/src/object-service.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const NAMESPACE = `user:${OWNER}`;

function fixture() {
  const clock = () => new Date("2026-08-11T08:00:00.000Z");
  const objects = new ProtectedObjectService({
    repository: new MemoryObjectRepository(), blobStore: new MemoryBlobStore(),
    referenceSigningKey: Buffer.alloc(32, 61), clock, allowTestPlaintextBlobStore: true,
  });
  const repository = new MemoryArtifactProvenanceRepository();
  const provenance = new ArtifactProvenanceService({ repository, objectGateway: objects.createObjectHandoffGateway(), clock });
  const handoff = new ComputeArtifactHandoff({ provenanceService: provenance });
  const context = { identityId: OWNER, identityKind: "local_user", namespaceAccess: [{ namespaceKey: NAMESPACE, operations: ["write", "read", "reference:create"] }] };
  const upload = async (key, audience) => {
    const stored = await objects.upload({ context, namespaceKey: NAMESPACE, objectKey: key, contentType: "application/json", content: Buffer.from(key) });
    const reference = await objects.createScopedReference({ context, namespaceKey: NAMESPACE, objectId: stored.objectId, audience, operations: ["head", "read", "range"], expiresAt: new Date(clock().getTime() + 600_000) });
    return { stored, referenceId: reference.reference.referenceId };
  };
  return { context, handoff, provenance, repository, upload };
}

test("compute submission resolves exact capability references and completion preserves source lineage", async () => {
  const state = fixture();
  const source = await state.upload("inputs/scan.png", "compute:ocr");
  const sourceProvenance = await state.provenance.register({
    context: state.context, referenceId: source.referenceId, audience: "compute:ocr",
    artifactKind: "ai-input", producer: { kind: "user", key: "user.upload" },
  });
  const inputs = await state.handoff.resolveInputs({
    ownerIdentityId: OWNER, jobId: JOB, capabilityKey: "ocr", operation: "ocr",
    request: { input: { referenceId: source.referenceId }, outputFormat: "json" },
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].provenanceId, sourceProvenance.record.id);
  assert.equal(JSON.stringify(inputs).includes(source.referenceId), false);

  const output = await state.upload("results/ocr.json", "compute.user-result");
  const registered = await state.handoff.registerResults({
    ownerIdentityId: OWNER, jobId: JOB, capabilityKey: "ocr", operation: "ocr",
    result: { schema: "teamaibox.ai.ocr-result.v1", artifact: { reference_id: output.referenceId } },
    inputArtifacts: inputs,
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].artifactKind, "ai-result");
  assert.equal(registered[0].sources[0].provenanceId, sourceProvenance.record.id);
  const lineage = await state.provenance.lineage({ context: state.context, artifactId: registered[0].id });
  assert.equal(lineage.records.length, 2);
});

test("compute handoff rejects cross-capability reuse and ignores text-only operations", async () => {
  const state = fixture();
  const source = await state.upload("inputs/scan.png", "compute:ocr");
  await assert.rejects(state.handoff.resolveInputs({
    ownerIdentityId: OWNER, jobId: JOB, capabilityKey: "asr", operation: "transcriptions",
    request: { input: { referenceId: source.referenceId } },
  }), { code: "artifact_reference_invalid" });
  assert.deepEqual(await state.handoff.resolveInputs({
    ownerIdentityId: OWNER, jobId: JOB, capabilityKey: "chat", operation: "responses",
    request: { input: "hello" },
  }), []);
});

test("image-generation uses the stable compute:image artifact audience", async () => {
  const state = fixture();
  const source = await state.upload("inputs/reference.png", "compute:image");
  const inputs = await state.handoff.resolveInputs({
    ownerIdentityId: OWNER, jobId: JOB, capabilityKey: "image-generation", operation: "images.edits",
    request: { input: { referenceId: source.referenceId } },
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].object.objectId, source.stored.objectId);
});
