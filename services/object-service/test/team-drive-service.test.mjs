import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFileRepository } from "../src/memory-file-repository.mjs";
import { TeamDriveService } from "../src/team-drive-service.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c0174199501";
const MEMBER = "018f6f18-24d7-7c21-9b62-8c0174199502";
const OTHER = "018f6f18-24d7-7c21-9b62-8c0174199503";
const REF_ONE = "018f6f18-24d7-7c21-9b62-8c0174199511";
const REF_TWO = "018f6f18-24d7-7c21-9b62-8c0174199512";
const REF_UNSUPPORTED = "018f6f18-24d7-7c21-9b62-8c0174199513";
const OBJECT_ONE = "018f6f18-24d7-7c21-9b62-8c0174199521";
const OBJECT_TWO = "018f6f18-24d7-7c21-9b62-8c0174199522";
const OBJECT_TEXT = "018f6f18-24d7-7c21-9b62-8c0174199523";
const REF_TEXT = "018f6f18-24d7-7c21-9b62-8c0174199514";
const PREVIEW_REF = "018f6f18-24d7-7c21-9b62-8c0174199531";

function context(actorIdentityId, permissions, teamRoles = {}) {
  return { actorIdentityId, permissions, teamRoles };
}

const owner = context(OWNER, ["file:read", "file:write", "file:share", "file:manage"], { "team.product": "owner" });
const member = context(MEMBER, ["file:read"], {});
const other = context(OTHER, ["file:read"], {});

function fixture({ quota = 1000, retentionMs = 1000 } = {}) {
  let now = new Date("2026-08-11T06:00:00.000Z");
  const audits = [], resolutions = [], issued = [];
  const facts = new Map([
    [REF_ONE, { objectId: OBJECT_ONE, objectVersion: 3, size: 20, mediaType: "image/png", sha256: `sha256:${"a".repeat(64)}` }],
    [REF_TWO, { objectId: OBJECT_TWO, objectVersion: 1, size: 25, mediaType: "application/pdf", sha256: `sha256:${"b".repeat(64)}` }],
    [REF_UNSUPPORTED, { objectId: OBJECT_TWO, objectVersion: 2, size: 4, mediaType: "application/x-custom", sha256: `sha256:${"c".repeat(64)}` }],
    [REF_TEXT, { objectId: OBJECT_TEXT, objectVersion: 1, size: 12, mediaType: "text/plain; charset=utf-8", sha256: `sha256:${"d".repeat(64)}` }],
  ]);
  const repository = new MemoryFileRepository();
  const service = new TeamDriveService({
    repository,
    defaultQuotaBytes: quota,
    retentionMs,
    clock: () => new Date(now),
    audit: async (event) => audits.push(structuredClone(event)),
    objectReferences: {
      async resolve(input) { resolutions.push(structuredClone(input)); return structuredClone(facts.get(input.referenceId) ?? null); },
      async issueReadReference(input) { issued.push(structuredClone(input)); return { referenceId: PREVIEW_REF, expiresAt: new Date(now.getTime() + 300000).toISOString() }; },
    },
  });
  return { service, repository, audits, resolutions, issued, advance: (milliseconds) => { now = new Date(now.getTime() + milliseconds); } };
}

async function rootAndFile(value) {
  const root = await value.service.createRoot(owner, { scopeKind: "team", scopeKey: "team.product" });
  const folder = await value.service.createFolder(owner, root.id, { name: "发布资料" });
  const created = await value.service.createFile(owner, root.id, {
    parentId: folder.id,
    name: "封面.png",
    objectReferenceId: REF_ONE,
    provenance: { source: "drawing", jobId: "job-digest-only" },
  });
  return { root, folder, created };
}

test("object reads follow current shares, team membership, expiry and recycled parents", async () => {
  const value = fixture(), { folder, created } = await rootAndFile(value);
  const object = { objectId: OBJECT_ONE, objectVersion: 3 };
  await value.service.authorizeObjectRead(owner, object);
  await assert.rejects(value.service.authorizeObjectRead(member, object), { code: "file_not_found" });
  const share = await value.service.share(owner, folder.id, { principalKind: "identity", principalKey: MEMBER, role: "viewer" });
  await value.service.authorizeObjectRead(member, object);
  await assert.rejects(value.service.authorizeObjectRead(member, { ...object, objectVersion: 4 }), { code: "file_not_found" });
  await value.service.revokeShare(owner, share.id);
  await assert.rejects(value.service.authorizeObjectRead(member, object), { code: "file_not_found" });
  await value.service.authorizeObjectRead(owner, object);
  const temporary = await value.service.share(owner, created.entry.id, { principalKind: "identity", principalKey: MEMBER, role: "viewer", expiresAt: "2026-08-11T06:00:01.000Z" });
  await value.service.authorizeObjectRead(member, object);
  value.advance(1001);
  await assert.rejects(value.service.authorizeObjectRead(member, object), { code: "file_not_found" });
  await value.service.revokeShare(owner, temporary.id);
  const teamMember = { ...member, teamRoles: { "team.product": "member" } };
  await value.service.authorizeObjectRead(teamMember, object);
  await assert.rejects(value.service.authorizeObjectRead(member, object), { code: "file_not_found" });
  await value.service.trash(owner, folder.id, { expectedRevision: folder.revision });
  await assert.rejects(value.service.authorizeObjectRead(owner, object), { code: "file_not_found" });
  await assert.rejects(value.service.authorizeObjectRead(teamMember, object), { code: "file_not_found" });
});

test("folders and immutable file versions are separate from protected object bytes", async () => {
  const value = fixture(), { root, folder, created } = await rootAndFile(value);
  assert.equal(created.version.objectId, OBJECT_ONE);
  assert.equal(created.version.objectVersion, 3);
  assert.equal(created.entry.size, 20);
  assert.equal(created.entry.mediaType, "image/png");
  assert.equal(folder.size, null);
  assert.deepEqual(value.resolutions[0], { actorIdentityId: OWNER, referenceId: REF_ONE, audience: "team-drive.file", requiredOperation: "read" });
  assert.equal((await value.service.list(owner, root.id, { parentId: folder.id }))[0].id, created.entry.id);
  const second = await value.service.addVersion(owner, created.entry.id, { objectReferenceId: REF_TWO, expectedRevision: 1, provenance: { source: "manual" } });
  assert.equal(second.entry.currentVersion, 2);
  assert.equal(second.entry.size, 25);
  assert.equal(second.entry.mediaType, "application/pdf");
  const listed = (await value.service.list(owner, root.id, { parentId: folder.id }))[0];
  assert.equal(listed.size, 25);
  assert.equal(listed.mediaType, "application/pdf");
  assert.equal((await value.service.search(owner, root.id, { query: "封面" }))[0].size, 25);
  assert.equal((await value.service.versions(owner, created.entry.id)).length, 2);
  assert.deepEqual(await value.service.quota(owner, root.id), { rootId: root.id, quotaBytes: 1000, usedBytes: 45, availableBytes: 955 });
  assert.ok(!JSON.stringify(created).includes(REF_ONE));
  assert.ok(value.audits.every((event) => !JSON.stringify(event).includes(REF_ONE)));
});

test("current-version metadata survives rename, copy, recycle and restore without exposing object identities", async () => {
  const value = fixture(), { root, folder, created } = await rootAndFile(value);
  const renamed = await value.service.move(owner, created.entry.id, { parentId: folder.id, name: "新的封面.png", expectedRevision: 1 });
  const copied = await value.service.copy(owner, renamed.id, { parentId: folder.id, name: "复制的封面.png", expectedRevision: renamed.revision });
  const trashed = await value.service.trash(owner, copied.entry.id, { expectedRevision: copied.entry.revision });
  const restored = await value.service.restore(owner, trashed.id, { parentId: folder.id, expectedRevision: trashed.revision });
  for (const entry of [renamed, copied.entry, trashed, restored]) {
    assert.equal(entry.size, 20);
    assert.equal(entry.mediaType, "image/png");
    assert.equal(Object.hasOwn(entry, "objectId"), false);
  }
  assert.equal((await value.service.list(owner, root.id, { parentId: folder.id })).length, 2);
});

test("file authorization accepts a platform owner context with unrelated trusted permissions", async () => {
  const { service } = fixture();
  const platformOwner = { ...owner, permissions: [...owner.permissions, "audit:view", "plugin:manage", "ai:invoke"] };
  const root = await service.createRoot(platformOwner, { scopeKind: "user", scopeKey: OWNER, quotaBytes: 1000 });
  const folder = await service.createFolder(platformOwner, root.id, { name: "owner-files" });
  assert.equal(folder.name, "owner-files");
});

test("an existing team member can idempotently initialize only that team's shared root", async () => {
  const value = fixture();
  const teamMember = context(MEMBER, ["file:read", "file:write"], { "team.product": "member" });
  const first = await value.service.ensureTeamRoot(teamMember, "team.product");
  const second = await value.service.ensureTeamRoot(teamMember, "team.product");
  assert.equal(second.id, first.id);
  assert.equal(value.audits.filter((event) => event.action === "files.team_root_initialized").length, 1);
  await assert.rejects(value.service.ensureTeamRoot(teamMember, "team.other"), { code: "file_permission_denied" });
  await assert.rejects(value.service.ensureTeamRoot(member, "team.product"), { code: "file_permission_denied" });
});

test("ACLs are inherited, permission-scoped, and do not leak roots to unrelated users", async () => {
  const value = fixture(), { root, folder, created } = await rootAndFile(value);
  await assert.rejects(value.service.list(member, root.id, { parentId: folder.id }), { code: "file_not_found" });
  await value.service.grant(owner, root.id, { entryId: folder.id, principalKind: "identity", principalKey: MEMBER, role: "viewer", inherited: true });
  assert.equal((await value.service.list(member, root.id, { parentId: folder.id }))[0].id, created.entry.id);
  assert.equal((await value.service.versions(member, created.entry.id))[0].objectId, OBJECT_ONE);
  await assert.rejects(value.service.list(other, root.id, { parentId: folder.id }), { code: "file_not_found" });
  await assert.rejects(value.service.search(other, root.id, { query: "封面" }), { code: "file_not_found" });
});

test("internal shares expire and revoke without exposing a reusable object credential", async () => {
  const value = fixture(), { created } = await rootAndFile(value);
  const expiresAt = "2026-08-11T06:00:02.000Z";
  const share = await value.service.share(owner, created.entry.id, { principalKind: "identity", principalKey: MEMBER, expiresAt });
  const resolved = await value.service.sharedEntry(member, share.id);
  assert.equal(resolved.entry.id, created.entry.id);
  assert.ok(!JSON.stringify(resolved).includes("token"));
  value.advance(2100);
  await assert.rejects(value.service.sharedEntry(member, share.id), { code: "file_share_not_found" });

  const second = await value.service.share(owner, created.entry.id, { principalKind: "identity", principalKey: OTHER });
  await value.service.revokeShare(owner, second.id);
  await assert.rejects(value.service.sharedEntry(other, second.id), { code: "file_share_not_found" });
});

test("received shares are discoverable only by their current recipient and disappear on expiry or revocation", async () => {
  const value = fixture(), { created } = await rootAndFile(value);
  const share = await value.service.share(owner, created.entry.id, { principalKind: "identity", principalKey: MEMBER });
  const received = await value.service.receivedShares(member);
  assert.equal(received[0].entry.name, created.entry.name);
  assert.equal(received[0].share.id, share.id);
  assert.equal(received[0].accessRole, "viewer");
  assert.deepEqual(await value.service.receivedShares(other), []);
  await value.service.revokeShare(owner, share.id);
  assert.deepEqual(await value.service.receivedShares(member), []);
  await value.service.share(owner, created.entry.id, { principalKind: "identity", principalKey: MEMBER, expiresAt: "2026-08-11T06:00:01.000Z" });
  value.advance(1001);
  assert.deepEqual(await value.service.receivedShares(member), []);
});

test("received shares recheck team membership, ACL changes, and recycled ancestors", async () => {
  const value = fixture(), { root, folder, created } = await rootAndFile(value);
  const share = await value.service.share(owner, created.entry.id, { principalKind: "team", principalKey: "team.review" });
  const reviewer = { ...member, teamRoles: { "team.review": "member" } };
  assert.equal((await value.service.receivedShares(reviewer)).length, 1);
  assert.deepEqual(await value.service.receivedShares(member), []);
  await value.service.trash(owner, folder.id, { expectedRevision: folder.revision });
  assert.deepEqual(await value.service.receivedShares(reviewer), []);
  await assert.rejects(value.service.sharedEntry(reviewer, share.id), { code: "file_share_not_found" });
  await value.service.restore(owner, folder.id, { expectedRevision: folder.revision + 1 });
  await value.repository.removeAcl({ rootId: root.id, entryId: created.entry.id, principalKind: "team", principalKey: "team.review" });
  assert.deepEqual(await value.service.receivedShares(reviewer), []);
});

test("recycle retention supports restore and blocks early permanent deletion", async () => {
  const value = fixture(), { root, folder, created } = await rootAndFile(value);
  const trashed = await value.service.trash(owner, folder.id, { expectedRevision: 1 });
  assert.equal((await value.service.list(owner, root.id)).length, 0);
  assert.equal((await value.service.list(owner, root.id, { includeTrashed: true }))[0].id, folder.id);
  await assert.rejects(value.service.purge(owner, folder.id), { code: "file_retention_active" });
  const restored = await value.service.restore(owner, folder.id, { expectedRevision: trashed.revision });
  assert.equal(restored.trashedAt, null);
  const trashedAgain = await value.service.trash(owner, folder.id, { expectedRevision: restored.revision });
  value.advance(1100);
  const purged = await value.service.purge(owner, folder.id);
  assert.deepEqual(new Set(purged.entryIds), new Set([folder.id, created.entry.id]));
  assert.equal((await value.service.quota(owner, root.id)).usedBytes, 0);
  await assert.rejects(value.service.restore(owner, folder.id, { expectedRevision: trashedAgain.revision }), { code: "file_not_found" });
});

test("team editors can discover and restore recycled shared files without management access", async () => {
  const value = fixture(), { root, folder, created } = await rootAndFile(value);
  const editor = context(MEMBER, ["file:read", "file:write"], { "team.product": "member" });
  const viewer = context(OTHER, ["file:read"], { "team.product": "guest" });
  const trashed = await value.service.trash(editor, created.entry.id, { expectedRevision: created.entry.revision });
  const list = await value.service.list(editor, root.id, { parentId: folder.id, includeTrashed: true });
  assert.equal(list.find(entry => entry.id === created.entry.id).trashedAt, trashed.trashedAt);
  assert.equal((await value.service.search(editor, root.id, { query: "封面", includeTrashed: true }))[0].id, created.entry.id);
  await assert.rejects(value.service.list(viewer, root.id, { includeTrashed: true }), { code: "file_permission_denied" });
  await assert.rejects(value.service.search(viewer, root.id, { query: "封面", includeTrashed: true }), { code: "file_permission_denied" });
  await assert.rejects(value.service.purge(editor, trashed.id), { code: "file_permission_denied" });
  const restored = await value.service.restore(editor, trashed.id, { parentId: folder.id, expectedRevision: trashed.revision });
  assert.equal(restored.trashedAt, null);
  assert.equal(restored.size, 20);
  assert.equal((await value.service.list(editor, root.id, { parentId: folder.id }))[0].id, restored.id);
  await assert.rejects(value.service.list(other, root.id, { includeTrashed: true }), { code: "file_not_found" });
});

test("revision, sibling, hierarchy-cycle, and quota conflicts fail closed", async () => {
  const value = fixture({ quota: 40 }), root = await value.service.createRoot(owner, { scopeKind: "team", scopeKey: "team.product" });
  const first = await value.service.createFolder(owner, root.id, { name: "A" }), child = await value.service.createFolder(owner, root.id, { parentId: first.id, name: "B" });
  await assert.rejects(value.service.move(owner, first.id, { parentId: child.id, name: "A", expectedRevision: 1 }), { code: "file_hierarchy_cycle" });
  await value.service.createFolder(owner, root.id, { name: "Taken" });
  await assert.rejects(value.service.move(owner, first.id, { name: "Taken", expectedRevision: 1 }), { code: "file_name_conflict" });
  const file = await value.service.createFile(owner, root.id, { name: "one.png", objectReferenceId: REF_ONE });
  await assert.rejects(value.service.addVersion(owner, file.entry.id, { objectReferenceId: REF_TWO, expectedRevision: 1 }), { code: "file_quota_exceeded" });
  await assert.rejects(value.service.move(owner, file.entry.id, { name: "renamed.png", expectedRevision: 99 }), { code: "file_revision_conflict" });
});

test("concurrent team editors create exactly one next version and stale writer fails closed", async () => {
  const value = fixture(), root = await value.service.createRoot(owner, { scopeKind: "team", scopeKey: "team.product" });
  const file = await value.service.createFile(owner, root.id, { name: "shared.txt", objectReferenceId: REF_ONE });
  const editorOne = context(MEMBER, ["file:read", "file:write"], { "team.product": "member" });
  const editorTwo = context(OTHER, ["file:read", "file:write"], { "team.product": "member" });
  const settled = await Promise.allSettled([
    value.service.addVersion(editorOne, file.entry.id, { objectReferenceId: REF_TWO, expectedRevision: 1 }),
    value.service.addVersion(editorTwo, file.entry.id, { objectReferenceId: REF_UNSUPPORTED, expectedRevision: 1 }),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = settled.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "file_revision_conflict");
  const versions = await value.service.versions(owner, file.entry.id);
  assert.deepEqual(versions.map((item) => item.version), [1, 2]);
});

test("team roots isolate access, search results, and quota accounting", async () => {
  const value = fixture(), administrator = context(OWNER, ["file:read", "file:write", "file:share", "file:manage"], { "team.alpha": "owner", "team.beta": "owner" });
  const alpha = await value.service.createRoot(administrator, { scopeKind: "team", scopeKey: "team.alpha", quotaBytes: 20 });
  const beta = await value.service.createRoot(administrator, { scopeKind: "team", scopeKey: "team.beta", quotaBytes: 50 });
  await value.service.createFile(administrator, alpha.id, { name: "alpha-secret.png", objectReferenceId: REF_ONE });
  await value.service.createFile(administrator, beta.id, { name: "beta-secret.png", objectReferenceId: REF_ONE });
  const alphaMember = context(MEMBER, ["file:read", "file:write"], { "team.alpha": "member" });
  assert.equal((await value.service.search(alphaMember, alpha.id, { query: "secret" })).length, 1);
  await assert.rejects(value.service.search(alphaMember, beta.id, { query: "secret" }), { code: "file_not_found" });
  await assert.rejects(value.service.createFile(alphaMember, alpha.id, { name: "over-quota.bin", objectReferenceId: REF_UNSUPPORTED }), { code: "file_quota_exceeded" });
  await value.service.createFile(administrator, beta.id, { name: "within-beta-quota.bin", objectReferenceId: REF_UNSUPPORTED });
  assert.deepEqual(await value.service.quota(administrator, alpha.id), { rootId: alpha.id, quotaBytes: 20, usedBytes: 20, availableBytes: 0 });
  assert.deepEqual(await value.service.quota(administrator, beta.id), { rootId: beta.id, quotaBytes: 50, usedBytes: 24, availableBytes: 26 });
});

test("preview issues a five-minute scoped read reference only for supported media", async () => {
  const value = fixture(), { created } = await rootAndFile(value);
  const preview = await value.service.preview(owner, created.entry.id);
  assert.equal(preview.supported, true);
  assert.equal(preview.previewKind, "image");
  assert.equal(preview.referenceId, PREVIEW_REF);
  assert.deepEqual(value.issued[0], { actorIdentityId: OWNER, objectId: OBJECT_ONE, objectVersion: 3, audience: "team-drive.preview", expiresInSeconds: 300 });

  const root = await value.service.root(owner, created.entry.rootId);
  const unsupported = await value.service.createFile(owner, root.id, { name: "raw.bin", objectReferenceId: REF_UNSUPPORTED });
  assert.deepEqual((await value.service.preview(owner, unsupported.entry.id)).supported, false);
});

test("preview recognizes a supported MIME type while preserving its charset parameter", async () => {
  const value = fixture();
  const root = await value.service.createRoot(owner, { scopeKind: "user", scopeKey: OWNER });
  const created = await value.service.createFile(owner, root.id, { name: "notes.txt", objectReferenceId: REF_TEXT });
  const preview = await value.service.preview(owner, created.entry.id);
  assert.equal(preview.supported, true);
  assert.equal(preview.previewKind, "text");
  assert.equal(preview.version.mediaType, "text/plain; charset=utf-8");
});

test("copy clones a hierarchy and immutable versions without inheriting ACLs", async () => {
  const value = fixture(), { root, folder, created } = await rootAndFile(value);
  const copied = await value.service.copy(owner, folder.id, { name: "发布资料 副本", expectedRevision: 1 });
  assert.equal(copied.entry.name, "发布资料 副本");
  assert.equal(copied.entryIds.length, 2);
  assert.equal(copied.versionCount, 1);
  assert.equal(copied.copiedBytes, 20);
  const child = (await value.service.list(owner, root.id, { parentId: copied.entry.id }))[0];
  assert.equal(child.name, created.entry.name);
  const versions = await value.service.versions(owner, child.id);
  assert.equal(versions[0].objectId, OBJECT_ONE);
  assert.deepEqual(versions[0].provenance.copiedFrom, { fileId: created.entry.id, version: 1 });
  assert.equal((await value.service.quota(owner, root.id)).usedBytes, 40);
  await assert.rejects(value.service.copy(owner, folder.id, { name: "stale", expectedRevision: 99 }), { code: "file_revision_conflict" });
});

test("download issues a user-bound short reference independently of preview support", async () => {
  const value = fixture(), { created } = await rootAndFile(value);
  const download = await value.service.download(owner, created.entry.id);
  assert.equal(download.referenceId, PREVIEW_REF);
  assert.deepEqual(value.issued.at(-1), { actorIdentityId: OWNER, objectId: OBJECT_ONE, objectVersion: 3, audience: "team-drive.download", expiresInSeconds: 300 });
});
