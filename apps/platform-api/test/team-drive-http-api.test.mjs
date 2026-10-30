import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFileRepository } from "../../../services/object-service/src/memory-file-repository.mjs";
import { TeamDriveService } from "../../../services/object-service/src/team-drive-service.mjs";
import { TeamDriveHttpApi, matchesTeamDriveHttpRoute } from "../src/files/team-drive-http-api.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c0174199501";
const REFERENCE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const OBJECT = "018f6f18-24d7-7c21-9b62-8c0174199503";
const READ_REFERENCE = "018f6f18-24d7-7c21-9b62-8c0174199504";

function fixture() {
  const service = new TeamDriveService({
    repository: new MemoryFileRepository(),
    objectReferences: {
      async resolve() { return { objectId: OBJECT, objectVersion: 1, size: 12, mediaType: "text/plain", sha256: `sha256:${"a".repeat(64)}` }; },
      async issueReadReference() { return { referenceId: READ_REFERENCE, expiresAt: "2026-08-11T08:05:00.000Z" }; },
    },
    clock: () => new Date("2026-08-11T08:00:00.000Z"),
  });
  return {
    api: new TeamDriveHttpApi({ service }),
    context: { identityId: OWNER, roles: ["owner"], teamRoles: { "team.default": "owner" }, permissions: ["file:read", "file:write", "file:share", "file:manage"] },
  };
}

test("route matcher keeps Team Drive endpoints inside one authenticated API family", () => {
  assert.equal(matchesTeamDriveHttpRoute("GET", "/api/v1/files/bootstrap"), true);
  assert.equal(matchesTeamDriveHttpRoute("POST", `/api/v1/files/entries/${OWNER}/copy`), true);
  assert.equal(matchesTeamDriveHttpRoute("DELETE", `/api/v1/files/shares/${OWNER}`), true);
  assert.equal(matchesTeamDriveHttpRoute("GET", "/api/v1/objects"), false);
});

test("bootstrap, folders, upload attachment, rename, copy, versions, preview, search, trash and restore use stable contracts", async () => {
  const { api, context } = fixture();
  const bootstrap = await api.handle({ method: "GET", pathname: "/api/v1/files/bootstrap", context });
  assert.equal(bootstrap.body.data.length, 2);
  assert.deepEqual(bootstrap.body.data.map((value) => value.scope_kind), ["user", "team"]);
  const root = bootstrap.body.data[1];
  const folder = await api.handle({ method: "POST", pathname: `/api/v1/files/roots/${root.id}/folders`, context, body: { name: "资料", parent_id: null } });
  const file = await api.handle({ method: "POST", pathname: `/api/v1/files/roots/${root.id}/files`, context, body: { parent_id: folder.body.id, name: "notes.txt", object_reference_id: REFERENCE, provenance: { source: "upload" } } });
  assert.equal(file.body.entry.object, "files.entry");
  assert.equal(file.body.version.object, "files.version");
  assert.equal(file.body.entry.byte_size, 12);
  assert.equal(file.body.entry.media_type, "text/plain");
  assert.equal(folder.body.byte_size, null);
  assert.equal(folder.body.media_type, null);
  const listing = await api.handle({ method: "GET", pathname: `/api/v1/files/roots/${root.id}/entries`, context, query: new URLSearchParams({ parent_id: folder.body.id }) });
  assert.equal(listing.body.data[0].byte_size, 12);
  assert.equal(listing.body.data[0].media_type, "text/plain");
  const renamed = await api.handle({ method: "PATCH", pathname: `/api/v1/files/entries/${file.body.entry.id}`, context, body: { parent_id: folder.body.id, name: "release-notes.txt", expected_revision: 1 } });
  const copied = await api.handle({ method: "POST", pathname: `/api/v1/files/entries/${renamed.body.id}/copy`, context, body: { parent_id: folder.body.id, name: "release-notes-copy.txt", expected_revision: 2 } });
  assert.equal(copied.body.version_count, 1);
  const versions = await api.handle({ method: "GET", pathname: `/api/v1/files/entries/${copied.body.entry.id}/versions`, context });
  assert.equal(versions.body.data[0].provenance.copiedFrom.fileId, renamed.body.id);
  const preview = await api.handle({ method: "GET", pathname: `/api/v1/files/entries/${copied.body.entry.id}/preview`, context });
  assert.equal(preview.body.reference_id, READ_REFERENCE);
  const search = await api.handle({ method: "GET", pathname: `/api/v1/files/roots/${root.id}/search`, context, query: new URLSearchParams("q=release") });
  assert.equal(search.body.data.length, 2);
  assert.ok(search.body.data.every((entry) => entry.byte_size === 12 && entry.media_type === "text/plain"));
  const trashed = await api.handle({ method: "POST", pathname: `/api/v1/files/entries/${copied.body.entry.id}/trash`, context, body: { expected_revision: 1 } });
  const restored = await api.handle({ method: "POST", pathname: `/api/v1/files/entries/${copied.body.entry.id}/restore`, context, body: { parent_id: folder.body.id, expected_revision: trashed.body.revision } });
  assert.equal(restored.body.trashed_at, null);
  assert.equal(restored.body.byte_size, 12);
});

test("bootstrap omits the team root when current team membership is absent", async () => {
  const { api } = fixture();
  const result = await api.handle({ method: "GET", pathname: "/api/v1/files/bootstrap", context: { identityId: OWNER, roles: ["member"], teamRoles: {}, permissions: ["file:read", "file:write"] } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.map((root) => root.scope_kind), ["user"]);
});

test("bootstrap initializes the shared root when a member is the first team-drive visitor", async () => {
  const { api } = fixture();
  const result = await api.handle({
    method: "GET", pathname: "/api/v1/files/bootstrap",
    context: {
      identityId: "018f6f18-24d7-7c21-9b62-8c0174199510",
      roles: ["member"], teamRoles: { "team.default": "member" },
      permissions: ["file:read", "file:write"],
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.map((root) => root.scope_kind), ["user", "team"]);
  assert.equal(result.body.data[1].scope_key, "team.default");
});

test("ordinary team members can list, search and restore their recycle bin through HTTP", async () => {
  const { api } = fixture();
  const context = { identityId: OWNER, roles: ["member"], teamRoles: { "team.default": "member" }, permissions: ["file:read", "file:write"] };
  const roots = (await api.handle({ method: "GET", pathname: "/api/v1/files/bootstrap", context })).body.data;
  for (const root of roots) {
    const file = await api.handle({ method: "POST", pathname: `/api/v1/files/roots/${root.id}/files`, context, body: { name: "回收验收.txt", object_reference_id: REFERENCE } });
    const trashed = await api.handle({ method: "POST", pathname: `/api/v1/files/entries/${file.body.entry.id}/trash`, context, body: { expected_revision: 1 } });
    const listed = await api.handle({ method: "GET", pathname: `/api/v1/files/roots/${root.id}/entries`, context, query: new URLSearchParams("trashed=1") });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.find(entry => entry.id === file.body.entry.id).byte_size, 12);
    const searched = await api.handle({ method: "GET", pathname: `/api/v1/files/roots/${root.id}/search`, context, query: new URLSearchParams("q=回收&trashed=1") });
    assert.equal(searched.body.data[0].id, file.body.entry.id);
    const restored = await api.handle({ method: "POST", pathname: `/api/v1/files/entries/${file.body.entry.id}/restore`, context, body: { expected_revision: trashed.body.revision } });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.trashed_at, null);
  }
});

test("sharing remains manager-only and returns no object credential", async () => {
  const { api, context } = fixture();
  const roots = (await api.handle({ method: "GET", pathname: "/api/v1/files/bootstrap", context })).body.data;
  const root = roots[1];
  const folder = await api.handle({ method: "POST", pathname: `/api/v1/files/roots/${root.id}/folders`, context, body: { name: "shared" } });
  const share = await api.handle({ method: "POST", pathname: `/api/v1/files/entries/${folder.body.id}/shares`, context, body: { principal_kind: "identity", principal_key: "018f6f18-24d7-7c21-9b62-8c0174199510", role: "viewer" } });
  assert.equal(share.body.object, "files.share");
  assert.equal(JSON.stringify(share.body).includes("token"), false);
  assert.equal((await api.handle({ method: "GET", pathname: `/api/v1/files/entries/${folder.body.id}/shares`, context })).body.data.length, 1);
  const recipient = { ...context, identityId: "018f6f18-24d7-7c21-9b62-8c0174199510", teamRoles: {}, roles: ["member"] };
  assert.equal(matchesTeamDriveHttpRoute("GET", "/api/v1/files/shared"), true);
  assert.equal(matchesTeamDriveHttpRoute("POST", "/api/v1/files/shared"), false);
  const received = await api.handle({ method: "GET", pathname: "/api/v1/files/shared", context: recipient });
  assert.equal(received.status, 200);
  assert.equal(received.body.data[0].entry.id, folder.body.id);
  assert.equal(received.body.data[0].access_role, "viewer");
  assert.deepEqual((await api.handle({ method: "GET", pathname: "/api/v1/files/shared", context })).body.data, []);
  await api.handle({ method: "DELETE", pathname: `/api/v1/files/shares/${share.body.id}`, context });
  assert.deepEqual((await api.handle({ method: "GET", pathname: "/api/v1/files/shared", context: recipient })).body.data, []);
});
