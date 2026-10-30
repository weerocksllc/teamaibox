import assert from "node:assert/strict";
import { test } from "node:test";

import { ArtifactProvenanceService } from "../src/artifact-provenance-service.mjs";
import { MemoryArtifactProvenanceRepository } from "../src/memory-artifact-provenance-repository.mjs";
import { MemoryBlobStore } from "../src/memory-blob-store.mjs";
import { MemoryFileRepository } from "../src/memory-file-repository.mjs";
import { MemoryObjectRepository } from "../src/memory-repository.mjs";
import { ProtectedObjectService } from "../src/object-service.mjs";
import { TeamDriveArtifactHandoff } from "../src/team-drive-artifact-handoff.mjs";
import { TeamDriveService } from "../src/team-drive-service.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NAMESPACE = `user:${OWNER}`;

test("Team Drive converts scoped AI output references into immutable trusted file provenance", async () => {
  const clock = () => new Date("2026-08-11T08:00:00.000Z");
  const objects = new ProtectedObjectService({
    repository: new MemoryObjectRepository(), blobStore: new MemoryBlobStore(),
    referenceSigningKey: Buffer.alloc(32, 101), clock, allowTestPlaintextBlobStore: true,
  });
  const provenance = new ArtifactProvenanceService({
    repository: new MemoryArtifactProvenanceRepository(),
    objectGateway: objects.createObjectHandoffGateway(), clock,
  });
  const objectContext = {
    identityId: OWNER, identityKind: "local_user",
    namespaceAccess: [{ namespaceKey: NAMESPACE, operations: ["write", "read", "reference:create"] }],
  };
  const stored = await objects.upload({
    context: objectContext, namespaceKey: NAMESPACE,
    objectKey: "ai-results/generated.png", contentType: "image/png", content: Buffer.from("generated-image"),
  });
  const computeReference = await objects.createScopedReference({
    context: objectContext, namespaceKey: NAMESPACE, objectId: stored.objectId,
    audience: "compute.user-result", operations: ["head", "read", "range"],
    expiresAt: new Date(clock().getTime() + 600_000),
  });
  const aiResult = (await provenance.register({
    context: { identityId: OWNER }, referenceId: computeReference.reference.referenceId,
    audience: "compute.user-result", artifactKind: "ai-result",
    producer: { kind: "compute-job", key: "compute.image", jobId: "22222222-2222-4222-8222-222222222222", applicationKey: "official.image" },
  })).record;
  const driveReference = await provenance.issue({
    context: { identityId: OWNER }, artifactId: aiResult.id,
    audience: "team-drive.file", expiresInSeconds: 600,
  });
  const drive = new TeamDriveService({
    repository: new MemoryFileRepository(),
    objectReferences: objects.createTeamDriveObjectReferences(),
    artifactHandoff: new TeamDriveArtifactHandoff({ provenanceService: provenance }),
    clock, defaultQuotaBytes: 1024,
  });
  const context = {
    actorIdentityId: OWNER,
    permissions: ["file:read", "file:write", "file:share", "file:manage"],
    teamRoles: { "team.default": "owner" },
  };
  const root = await drive.createRoot(context, { scopeKind: "team", scopeKey: "team.default" });
  const created = await drive.createFile(context, root.id, {
    name: "generated.png", objectReferenceId: driveReference.referenceId,
    provenance: { source: "client-claimed", artifactId: "not-trusted" },
  });
  assert.equal(created.version.objectId, stored.objectId);
  assert.equal(created.version.provenance.artifactKind, "drive-file");
  assert.deepEqual(created.version.provenance.sourceArtifactIds, [aiResult.id]);
  assert.deepEqual(created.version.provenance.clientAnnotations, { source: "client-claimed", artifactId: "not-trusted" });
  assert.equal(JSON.stringify(created).includes(driveReference.referenceId), false);
  const lineage = await provenance.lineage({ context: { identityId: OWNER }, artifactId: created.version.provenance.artifactId });
  assert.deepEqual(lineage.records.map((item) => item.artifactKind), ["drive-file", "ai-result"]);
});
