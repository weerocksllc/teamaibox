import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { MemoryBlobStore } from "../../../services/object-service/src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../../../services/object-service/src/memory-repository.mjs";
import { MemoryObjectGrantRepository } from "../../../services/object-service/src/memory-grant-repository.mjs";
import { MemoryFileRepository } from "../../../services/object-service/src/memory-file-repository.mjs";
import { ProtectedObjectService } from "../../../services/object-service/src/object-service.mjs";
import { TeamDriveService } from "../../../services/object-service/src/team-drive-service.mjs";
import { ObjectHttpApi } from "../src/objects/object-http-api.mjs";
import { teamDriveReferenceAccess } from "../src/objects/team-drive-reference-access.mjs";

test("shared preview/download URLs stop serving GET, HEAD and ranges immediately after revocation", async () => {
  const grants = new MemoryObjectGrantRepository();
  const service = new ProtectedObjectService({ repository: new MemoryObjectRepository(), blobStore: new MemoryBlobStore(),
    grantRepository: grants, referenceSigningKey: randomBytes(32), allowTestPlaintextBlobStore: true });
  const gateway = service.createObjectHandoffGateway();
  const teamDrive = new TeamDriveService({ repository: new MemoryFileRepository(), objectReferences: {
    resolve: input => gateway.resolve(input),
    issueReadReference: input => gateway.issue({ ...input, operations: ["head", "read", "range"] }),
  } });
  const authorizeReference = teamDriveReferenceAccess({ grants, teamDrive });
  const api = new ObjectHttpApi({ service, authorizeReference });
  const owner = { identityId: "11111111-1111-4111-8111-111111111111", identity: { identityKind: "local_user" },
    permissions: ["file:read", "file:write", "file:share"], teamRoles: {} };
  const member = { ...owner, identityId: "22222222-2222-4222-8222-222222222222", permissions: ["file:read"] };
  const driveActor = context => ({ actorIdentityId: context.identityId, permissions: context.permissions, teamRoles: context.teamRoles });
  const content = Buffer.from("shared-file-revocation");
  const uploaded = await api.handle({ method: "POST", pathname: "/api/v1/objects/uploads", context: owner, body: content,
    headers: { "content-type": "text/plain", "x-content-sha256": createHash("sha256").update(content).digest("hex"), "x-teamaibox-object-name": "shared.txt" }, query: new URLSearchParams("capability=team_drive") });
  const root = await teamDrive.createRoot(driveActor(owner), { scopeKind: "user", scopeKey: owner.identityId });
  const file = await teamDrive.createFile(driveActor(owner), root.id, { name: "shared.txt", objectReferenceId: uploaded.body.reference_id, provenance: { source: "manual" } });
  const share = await teamDrive.share(driveActor(owner), file.entry.id, { principalKind: "identity", principalKey: member.identityId, role: "viewer" });
  const references = await Promise.all([teamDrive.download(driveActor(member), file.entry.id), teamDrive.preview(driveActor(member), file.entry.id)]);
  for (const ref of references) {
    const pathname = `/api/v1/objects/references/${ref.referenceId}/content`;
    assert.deepEqual((await api.handle({ method: "GET", pathname, context: member })).body, content);
    assert.equal((await api.handle({ method: "HEAD", pathname, context: member })).status, 200);
    assert.equal((await api.handle({ method: "GET", pathname, context: member, headers: { range: "bytes=0-2" } })).status, 206);
    await assert.rejects(api.handle({ method: "GET", pathname, context: owner }), { code: "file_not_found" });
  }
  await teamDrive.revokeShare(driveActor(owner), share.id);
  for (const ref of references) {
    const pathname = `/api/v1/objects/references/${ref.referenceId}/content`;
    for (const request of [{ method: "GET" }, { method: "HEAD" }, { method: "GET", headers: { range: "bytes=0-2" } }]) {
      await assert.rejects(api.handle({ ...request, pathname, context: member }), { code: "file_not_found" });
    }
  }
  const ownerRef = await teamDrive.download(driveActor(owner), file.entry.id);
  assert.deepEqual((await api.handle({ method: "GET", pathname: `/api/v1/objects/references/${ownerRef.referenceId}/content`, context: owner })).body, content);
  // An ordinary owner upload is not incorrectly routed through the Drive ACL.
  assert.deepEqual((await api.handle({ method: "GET", pathname: `/api/v1/objects/references/${uploaded.body.reference_id}/content`, context: owner })).body, content);
});

test("reference permission lookup errors fail closed", async () => {
  const check = teamDriveReferenceAccess({ grants: { async find() { throw Error("database unavailable"); } }, teamDrive: { async authorizeObjectRead() { assert.fail(); } } });
  await assert.rejects(check({ context: {}, referenceId: "test" }), /database unavailable/);
});
