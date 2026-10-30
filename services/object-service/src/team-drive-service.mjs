import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { FileRepositoryError } from "./memory-file-repository.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2, manager: 3, owner: 4 });
const PERMISSIONS = new Set(["file:read", "file:write", "file:share", "file:manage"]);
const PREVIEW = Object.freeze({
  "application/pdf": "document", "text/plain": "text", "text/markdown": "text", "application/json": "text",
  "image/png": "image", "image/jpeg": "image", "image/webp": "image", "image/gif": "image",
  "audio/mpeg": "audio", "audio/wav": "audio", "audio/ogg": "audio",
  "video/mp4": "video", "video/webm": "video",
});

function previewKind(mediaType) {
  if (typeof mediaType !== "string") return null;
  return PREVIEW[mediaType.split(";", 1)[0].trim().toLocaleLowerCase("en-US")] ?? null;
}

function actor(context, permission) {
  if (!context || !UUID.test(context.actorIdentityId ?? "") || !Array.isArray(context.permissions)
    || !PERMISSIONS.has(permission) || !context.permissions.includes(permission)
    || !context.teamRoles || typeof context.teamRoles !== "object" || Array.isArray(context.teamRoles)) {
    throw new PlatformError("file_permission_denied", "File permission is denied", { status: 403 });
  }
  return { actorIdentityId: context.actorIdentityId, teamRoles: structuredClone(context.teamRoles) };
}

function uuid(value, code = "file_invalid") {
  if (typeof value !== "string" || !UUID.test(value)) throw new PlatformError(code, "File identity is invalid", { status: 400 });
  return value;
}

function name(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 255 || /[\0/\\]/.test(value) || new Set([".", ".."]).has(value.trim())) {
    throw new PlatformError("file_name_invalid", "File name is invalid", { status: 400 });
  }
  return value.trim().normalize("NFC");
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new PlatformError("file_revision_invalid", "File revision is invalid", { status: 400 });
  return value;
}

function rootPublic(value) {
  return Object.freeze({ id: value.id, scopeKind: value.scopeKind, scopeKey: value.scopeKey, quotaBytes: value.quotaBytes, usedBytes: value.usedBytes, availableBytes: value.quotaBytes - value.usedBytes, revision: value.revision, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() });
}

function entryPublic(value) {
  return Object.freeze({ id: value.id, rootId: value.rootId, parentId: value.parentId, kind: value.kind, name: value.name, ownerIdentityId: value.ownerIdentityId, currentVersion: value.currentVersion, size: value.size ?? null, mediaType: value.mediaType ?? null, revision: value.revision, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), trashedAt: value.trashedAt?.toISOString() ?? null, retentionUntil: value.retentionUntil?.toISOString() ?? null });
}

function versionPublic(value) {
  return Object.freeze({ fileId: value.fileId, version: value.version, objectId: value.objectId, objectVersion: value.objectVersion, size: value.size, mediaType: value.mediaType, sha256: value.sha256, provenance: Object.freeze(structuredClone(value.provenance)), createdByIdentityId: value.createdByIdentityId, createdAt: value.createdAt.toISOString() });
}

function aclPublic(value) {
  return Object.freeze({ id: value.id, rootId: value.rootId, entryId: value.entryId, principalKind: value.principalKind, principalKey: value.principalKey, role: value.role, inherited: value.inherited, expiresAt: value.expiresAt?.toISOString() ?? null, revision: value.revision, createdByIdentityId: value.createdByIdentityId, createdAt: value.createdAt.toISOString() });
}

function sharePublic(value) {
  return Object.freeze({ id: value.id, rootId: value.rootId, entryId: value.entryId, principalKind: value.principalKind, principalKey: value.principalKey, role: value.role, expiresAt: value.expiresAt?.toISOString() ?? null, revokedAt: value.revokedAt?.toISOString() ?? null, revision: value.revision, createdByIdentityId: value.createdByIdentityId, createdAt: value.createdAt.toISOString() });
}

function translated(error) {
  if (!(error instanceof FileRepositoryError)) return error;
  const status = ({ file_not_found: 404, file_root_not_found: 404, file_parent_not_found: 404, file_name_conflict: 409, file_revision_conflict: 409, file_quota_exceeded: 409, file_hierarchy_cycle: 409 })[error.code] ?? 409;
  return new PlatformError(error.code, error.message, { status });
}

function objectFacts(value) {
  if (!value || !UUID.test(value.objectId ?? "") || !Number.isSafeInteger(value.objectVersion) || value.objectVersion < 1
    || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.mediaType !== "string" || value.mediaType.length > 256
    || !SHA256.test(value.sha256 ?? "")) throw new PlatformError("file_object_unavailable", "Referenced object version is unavailable", { status: 409 });
  return value;
}

function provenance(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 8192) throw new PlatformError("file_provenance_invalid", "File provenance is invalid", { status: 400 });
  return structuredClone(value);
}

export class TeamDriveService {
  #repository;
  #objects;
  #clock;
  #audit;
  #artifactHandoff;
  #defaultQuotaBytes;
  #retentionMs;

  constructor({ repository, objectReferences, artifactHandoff = null, clock = () => new Date(), audit = async () => {}, defaultQuotaBytes = 100 * 1024 * 1024 * 1024, retentionMs = 30 * 86400000 }) {
    const methods = ["createRoot", "findRoot", "findRootByScope", "findEntry", "createFolder", "createFile", "appendVersion", "listVersions", "listChildren", "moveEntry", "copyEntry", "trashEntry", "restoreEntry", "purgeEntry", "setAcl", "removeAcl", "listAcl", "accessRole", "createShare", "findShare", "listShares", "listReceivedShares", "revokeShare", "search", "quota"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function") || !objectReferences?.resolve || !objectReferences?.issueReadReference || (artifactHandoff !== null && typeof artifactHandoff?.ingest !== "function") || typeof clock !== "function" || typeof audit !== "function" || !Number.isSafeInteger(defaultQuotaBytes) || defaultQuotaBytes < 1 || !Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new TypeError("Team Drive dependencies are incomplete");
    this.#repository = repository; this.#objects = objectReferences; this.#artifactHandoff = artifactHandoff; this.#clock = clock; this.#audit = audit; this.#defaultQuotaBytes = defaultQuotaBytes; this.#retentionMs = retentionMs;
  }

  async #rootAccess(context, rootId, permission, requiredRole, entryId = null) {
    const owner = actor(context, permission), root = await this.#repository.findRoot(uuid(rootId, "file_root_invalid"));
    if (!root) throw new PlatformError("file_root_not_found", "File root is unavailable", { status: 404 });
    const role = await this.#repository.accessRole({ rootId, entryId, actorIdentityId: owner.actorIdentityId, teamRoles: owner.teamRoles, now: this.#clock() });
    if (!role || ROLE_RANK[role] < ROLE_RANK[requiredRole]) throw new PlatformError("file_not_found", "File resource is unavailable", { status: 404 });
    return { owner, root, role };
  }

  async createRoot(context, { scopeKind, scopeKey, quotaBytes = this.#defaultQuotaBytes }) {
    const owner = actor(context, scopeKind === "user" ? "file:write" : "file:manage");
    if (!new Set(["user", "team"]).has(scopeKind) || (scopeKind === "user" ? !UUID.test(scopeKey ?? "") : !KEY.test(scopeKey ?? "")) || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new PlatformError("file_root_invalid", "File root declaration is invalid", { status: 400 });
    const allowed = scopeKind === "user" ? scopeKey === owner.actorIdentityId : new Set(["owner", "manager"]).has(owner.teamRoles[scopeKey]);
    if (!allowed) throw new PlatformError("file_permission_denied", "File root creation is denied", { status: 403 });
    const now = this.#clock(), value = await this.#repository.createRoot({ scopeKind, scopeKey, quotaBytes, createdByIdentityId: owner.actorIdentityId, createdAt: now, updatedAt: now });
    await this.#audit({ action: "files.root_created", actorIdentityId: owner.actorIdentityId, rootId: value.id, scopeKind, scopeKey, occurredAt: now.toISOString() });
    return rootPublic(value);
  }

  async ensureTeamRoot(context, teamKey, { quotaBytes = this.#defaultQuotaBytes } = {}) {
    const owner = actor(context, "file:read");
    if (!KEY.test(teamKey ?? "") || !new Set(["owner", "manager", "member", "guest"]).has(owner.teamRoles[teamKey])
      || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1) {
      throw new PlatformError("file_permission_denied", "Team root initialization is denied", { status: 403 });
    }
    const existing = await this.#repository.findRootByScope("team", teamKey);
    if (existing) return rootPublic(existing);
    const now = this.#clock();
    const value = await this.#repository.createRoot({
      scopeKind: "team", scopeKey: teamKey, quotaBytes,
      createdByIdentityId: owner.actorIdentityId, createdAt: now, updatedAt: now,
    });
    await this.#audit({
      action: "files.team_root_initialized", actorIdentityId: owner.actorIdentityId,
      rootId: value.id, scopeKind: "team", scopeKey: teamKey, occurredAt: now.toISOString(),
    });
    return rootPublic(value);
  }

  async root(context, rootId) {
    const { root } = await this.#rootAccess(context, rootId, "file:read", "viewer"); return rootPublic(root);
  }

  async rootByScope(context, scopeKind, scopeKey) {
    actor(context, "file:read");
    const root = await this.#repository.findRootByScope(scopeKind, scopeKey);
    if (!root) return null;
    await this.#rootAccess(context, root.id, "file:read", "viewer");
    return rootPublic(root);
  }

  async list(context, rootId, { parentId = null, includeTrashed = false } = {}) {
    if (parentId !== null) uuid(parentId);
    const { role } = await this.#rootAccess(context, rootId, "file:read", "viewer", parentId);
    if (includeTrashed && ROLE_RANK[role] < ROLE_RANK.editor) throw new PlatformError("file_permission_denied", "Recycle-bin listing requires editing access", { status: 403 });
    return Object.freeze((await this.#repository.listChildren(rootId, parentId, { includeTrashed })).map(entryPublic));
  }

  async createFolder(context, rootId, { parentId = null, name: requestedName }) {
    if (parentId !== null) uuid(parentId);
    const { owner } = await this.#rootAccess(context, rootId, "file:write", "editor", parentId);
    const now = this.#clock();
    try { return entryPublic(await this.#repository.createFolder({ rootId, parentId, kind: "folder", name: name(requestedName), ownerIdentityId: owner.actorIdentityId, createdAt: now, updatedAt: now })); }
    catch (error) { throw translated(error); }
  }

  async #resolvedVersion(owner, referenceId, suppliedProvenance) {
    uuid(referenceId, "file_object_reference_invalid");
    const clientAnnotations = provenance(suppliedProvenance);
    const resolved = this.#artifactHandoff
      ? await this.#artifactHandoff.ingest({ ownerIdentityId: owner.actorIdentityId, referenceId, clientAnnotations })
      : { object: await this.#objects.resolve({ actorIdentityId: owner.actorIdentityId, referenceId, audience: "team-drive.file", requiredOperation: "read" }), provenance: clientAnnotations };
    const value = objectFacts(resolved.object);
    return { objectId: value.objectId, objectVersion: value.objectVersion, size: value.size, mediaType: value.mediaType, sha256: value.sha256, provenance: provenance(resolved.provenance), createdByIdentityId: owner.actorIdentityId, createdAt: this.#clock() };
  }

  async createFile(context, rootId, { parentId = null, name: requestedName, objectReferenceId, provenance: suppliedProvenance = {} }) {
    if (parentId !== null) uuid(parentId);
    const { owner } = await this.#rootAccess(context, rootId, "file:write", "editor", parentId), now = this.#clock();
    const version = await this.#resolvedVersion(owner, objectReferenceId, suppliedProvenance);
    try {
      const committed = await this.#repository.createFile({ entry: { rootId, parentId, kind: "file", name: name(requestedName), ownerIdentityId: owner.actorIdentityId, createdAt: now, updatedAt: now }, version });
      await this.#audit({ action: "files.file_created", actorIdentityId: owner.actorIdentityId, rootId, fileId: committed.entry.id, objectId: version.objectId, objectVersion: version.objectVersion, occurredAt: now.toISOString() });
      return Object.freeze({ entry: entryPublic(committed.entry), version: versionPublic(committed.version) });
    } catch (error) { throw translated(error); }
  }

  async addVersion(context, fileId, { objectReferenceId, expectedRevision, provenance: suppliedProvenance = {} }) {
    const entry = await this.#repository.findEntry(uuid(fileId));
    if (!entry || entry.kind !== "file") throw new PlatformError("file_not_found", "File is unavailable", { status: 404 });
    const { owner } = await this.#rootAccess(context, entry.rootId, "file:write", "editor", fileId), value = await this.#resolvedVersion(owner, objectReferenceId, suppliedProvenance);
    try { const committed = await this.#repository.appendVersion(fileId, value, revision(expectedRevision)); return Object.freeze({ entry: entryPublic(committed.entry), version: versionPublic(committed.version) }); }
    catch (error) { throw translated(error); }
  }

  async versions(context, fileId) {
    const entry = await this.#repository.findEntry(uuid(fileId));
    if (!entry || entry.kind !== "file") throw new PlatformError("file_not_found", "File is unavailable", { status: 404 });
    await this.#rootAccess(context, entry.rootId, "file:read", "viewer", fileId);
    return Object.freeze((await this.#repository.listVersions(fileId)).map(versionPublic));
  }

  async move(context, entryId, { parentId = null, name: requestedName, expectedRevision }) {
    const entry = await this.#repository.findEntry(uuid(entryId)); if (!entry) throw new PlatformError("file_not_found", "File entry is unavailable", { status: 404 });
    if (parentId !== null) uuid(parentId);
    await this.#rootAccess(context, entry.rootId, "file:write", "editor", entryId);
    if (parentId) await this.#rootAccess(context, entry.rootId, "file:write", "editor", parentId);
    try { return entryPublic(await this.#repository.moveEntry(entryId, { parentId, name: name(requestedName), expectedRevision: revision(expectedRevision), now: this.#clock() })); }
    catch (error) { throw translated(error); }
  }

  async copy(context, entryId, { parentId = null, name: requestedName, expectedRevision }) {
    const entry = await this.#repository.findEntry(uuid(entryId)); if (!entry) throw new PlatformError("file_not_found", "File entry is unavailable", { status: 404 });
    if (parentId !== null) uuid(parentId);
    const { owner } = await this.#rootAccess(context, entry.rootId, "file:write", "editor", entryId);
    if (parentId) await this.#rootAccess(context, entry.rootId, "file:write", "editor", parentId);
    try {
      const result = await this.#repository.copyEntry(entryId, { parentId, name: name(requestedName), expectedRevision: revision(expectedRevision), ownerIdentityId: owner.actorIdentityId, now: this.#clock() });
      return Object.freeze({ entry: entryPublic(result.entry), entryIds: Object.freeze(result.entryIds), versionCount: result.versionCount, copiedBytes: result.copiedBytes });
    } catch (error) { throw translated(error); }
  }

  async trash(context, entryId, { expectedRevision }) {
    const entry = await this.#repository.findEntry(uuid(entryId)); if (!entry) throw new PlatformError("file_not_found", "File entry is unavailable", { status: 404 });
    await this.#rootAccess(context, entry.rootId, "file:write", "editor", entryId);
    const now = this.#clock();
    try { return entryPublic(await this.#repository.trashEntry(entryId, { expectedRevision: revision(expectedRevision), trashedAt: now, retentionUntil: new Date(now.getTime() + this.#retentionMs) })); }
    catch (error) { throw translated(error); }
  }

  async restore(context, entryId, { parentId = null, expectedRevision }) {
    const entry = await this.#repository.findEntry(uuid(entryId)); if (!entry) throw new PlatformError("file_not_found", "File entry is unavailable", { status: 404 });
    if (parentId !== null) uuid(parentId);
    await this.#rootAccess(context, entry.rootId, "file:write", "editor", null);
    try { return entryPublic(await this.#repository.restoreEntry(entryId, { expectedRevision: revision(expectedRevision), parentId, now: this.#clock() })); }
    catch (error) { throw translated(error); }
  }

  async purge(context, entryId) {
    const entry = await this.#repository.findEntry(uuid(entryId)); if (!entry) throw new PlatformError("file_not_found", "File entry is unavailable", { status: 404 });
    const { owner } = await this.#rootAccess(context, entry.rootId, "file:manage", "manager", null), now = this.#clock();
    if (!entry.trashedAt || !entry.retentionUntil || entry.retentionUntil > now) throw new PlatformError("file_retention_active", "File retention has not expired", { status: 409 });
    try { const result = await this.#repository.purgeEntry(entryId, now); await this.#audit({ action: "files.entry_purged", actorIdentityId: owner.actorIdentityId, rootId: entry.rootId, entryId, releasedBytes: result.releasedBytes, occurredAt: now.toISOString() }); return Object.freeze({ entryIds: Object.freeze(result.entryIds), releasedBytes: result.releasedBytes }); }
    catch (error) { throw translated(error); }
  }

  async grant(context, rootId, { entryId = null, principalKind, principalKey, role, inherited = true }) {
    if (entryId !== null) uuid(entryId); const { owner } = await this.#rootAccess(context, rootId, "file:share", "manager", entryId);
    if (!new Set(["identity", "team"]).has(principalKind) || (principalKind === "identity" ? !UUID.test(principalKey ?? "") : !KEY.test(principalKey ?? "")) || !new Set(["viewer", "editor", "manager"]).has(role) || typeof inherited !== "boolean") throw new PlatformError("file_acl_invalid", "File ACL declaration is invalid", { status: 400 });
    const now = this.#clock();
    try { return aclPublic(await this.#repository.setAcl({ rootId, entryId, principalKind, principalKey, role, inherited, expiresAt: null, createdByIdentityId: owner.actorIdentityId, createdAt: now })); }
    catch (error) { throw translated(error); }
  }

  async acl(context, rootId, entryId = null) {
    if (entryId !== null) uuid(entryId); await this.#rootAccess(context, rootId, "file:share", "manager", entryId);
    return Object.freeze((await this.#repository.listAcl(rootId, entryId)).map(aclPublic));
  }

  async share(context, entryId, { principalKind, principalKey, role = "viewer", expiresAt = null }) {
    const entry = await this.#repository.findEntry(uuid(entryId)); if (!entry) throw new PlatformError("file_not_found", "File entry is unavailable", { status: 404 });
    const { owner } = await this.#rootAccess(context, entry.rootId, "file:share", "manager", entryId);
    if (!new Set(["identity", "team"]).has(principalKind) || (principalKind === "identity" ? !UUID.test(principalKey ?? "") : !KEY.test(principalKey ?? "")) || !new Set(["viewer", "editor"]).has(role)) throw new PlatformError("file_share_invalid", "File share declaration is invalid", { status: 400 });
    const now = this.#clock(), expiry = expiresAt === null ? null : new Date(expiresAt); if (expiry && (!Number.isFinite(expiry.valueOf()) || expiry <= now)) throw new PlatformError("file_share_invalid", "File share expiry is invalid", { status: 400 });
    const value = await this.#repository.createShare({ rootId: entry.rootId, entryId, principalKind, principalKey, role, expiresAt: expiry, createdByIdentityId: owner.actorIdentityId, createdAt: now });
    await this.#repository.setAcl({ rootId: entry.rootId, entryId, principalKind, principalKey, role, inherited: true, expiresAt: expiry, createdByIdentityId: owner.actorIdentityId, createdAt: now });
    return sharePublic(value);
  }

  async revokeShare(context, shareId) {
    const value = await this.#repository.findShare(uuid(shareId, "file_share_invalid")); if (!value || value.revokedAt) throw new PlatformError("file_share_not_found", "File share is unavailable", { status: 404 });
    await this.#rootAccess(context, value.rootId, "file:share", "manager", value.entryId);
    const revoked = await this.#repository.revokeShare(shareId, this.#clock()); await this.#repository.removeAcl(value);
    return sharePublic(revoked);
  }

  async shares(context, entryId) {
    const entry = await this.#repository.findEntry(uuid(entryId)); if (!entry) throw new PlatformError("file_not_found", "File entry is unavailable", { status: 404 });
    await this.#rootAccess(context, entry.rootId, "file:share", "manager", entryId);
    return Object.freeze((await this.#repository.listShares(entryId)).map(sharePublic));
  }

  async sharedEntry(context, shareId) {
    const owner = actor(context, "file:read"), value = await this.#repository.findShare(uuid(shareId, "file_share_invalid")), now = this.#clock();
    const principalMatches = value?.principalKind === "identity" ? value.principalKey === owner.actorIdentityId : Object.hasOwn(owner.teamRoles, value?.principalKey ?? "");
    if (!value || value.revokedAt || (value.expiresAt && value.expiresAt <= now) || !principalMatches) throw new PlatformError("file_share_not_found", "File share is unavailable", { status: 404 });
    const entry = await this.#repository.findEntry(value.entryId), role = await this.#repository.accessRole({ rootId: value.rootId, entryId: value.entryId, actorIdentityId: owner.actorIdentityId, teamRoles: owner.teamRoles, now });
    if (!entry || entry.trashedAt || !role || ROLE_RANK[role] < ROLE_RANK[value.role]) throw new PlatformError("file_share_not_found", "File share is unavailable", { status: 404 });
    // A directly shared file must disappear when its containing folder is recycled.
    const seen = new Set([entry.id]);
    let parentId = entry.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new PlatformError("file_share_not_found", "File share is unavailable", { status: 404 });
      seen.add(parentId);
      const parent = await this.#repository.findEntry(parentId);
      if (!parent || parent.trashedAt) throw new PlatformError("file_share_not_found", "File share is unavailable", { status: 404 });
      parentId = parent.parentId;
    }
    return Object.freeze({ share: sharePublic(value), entry: entryPublic(entry), accessRole: role });
  }

  async receivedShares(context) {
    const owner = actor(context, "file:read");
    const candidates = await this.#repository.listReceivedShares({ ...owner, now: this.#clock() });
    const result = [];
    for (const candidate of candidates) {
      try { result.push(await this.sharedEntry(context, candidate.id)); }
      catch (error) { if (error.code !== "file_share_not_found") throw error; }
    }
    return Object.freeze(result);
  }

  async authorizeObjectRead(context, { objectId, objectVersion }) {
    actor(context, "file:read");
    uuid(objectId);
    revision(objectVersion);
    // A previously issued download is not an independent copy of the file ACL.
    // Reuse current file permissions, including inherited and team access.
    const entries = await this.#repository.entriesForObjectVersion(objectId, objectVersion);
    for (const entry of entries) {
      const seen = new Set();
      let current = entry;
      while (current && !current.trashedAt && !seen.has(current.id) && current.rootId === entry.rootId) {
        seen.add(current.id);
        if (!current.parentId) {
          try {
            await this.#rootAccess(context, entry.rootId, "file:read", "viewer", entry.id);
            return;
          } catch (error) {
            if (!new Set(["file_not_found", "file_root_not_found"]).has(error.code)) throw error;
          }
          break;
        }
        current = await this.#repository.findEntry(current.parentId);
      }
    }
    throw new PlatformError("file_not_found", "File is unavailable", { status: 404 });
  }

  async search(context, rootId, { query, includeTrashed = false, limit = 50 }) {
    const { role } = await this.#rootAccess(context, rootId, "file:read", "viewer");
    if (includeTrashed && ROLE_RANK[role] < ROLE_RANK.editor) throw new PlatformError("file_permission_denied", "Recycle-bin search requires editing access", { status: 403 });
    if (typeof query !== "string" || query.trim().length < 2 || query.trim().length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new PlatformError("file_search_invalid", "File search is invalid", { status: 400 });
    const values = await this.#repository.search(rootId, query.trim(), { includeTrashed, limit }), allowed = [];
    for (const entry of values) if (await this.#repository.accessRole({ rootId, entryId: entry.id, actorIdentityId: context.actorIdentityId, teamRoles: context.teamRoles, now: this.#clock() })) allowed.push(entryPublic(entry));
    return Object.freeze(allowed);
  }

  async preview(context, fileId, { version: requestedVersion = null } = {}) {
    const entry = await this.#repository.findEntry(uuid(fileId)); if (!entry || entry.kind !== "file" || entry.trashedAt) throw new PlatformError("file_not_found", "File is unavailable", { status: 404 });
    const { owner } = await this.#rootAccess(context, entry.rootId, "file:read", "viewer", fileId), values = await this.#repository.listVersions(fileId);
    const selected = requestedVersion === null ? values.at(-1) : values.find((value) => value.version === requestedVersion);
    if (!selected) throw new PlatformError("file_version_not_found", "File version is unavailable", { status: 404 });
    const kind = previewKind(selected.mediaType);
    if (!kind) return Object.freeze({ supported: false, reason: "media_type_unsupported", version: versionPublic(selected) });
    const reference = await this.#objects.issueReadReference({ actorIdentityId: owner.actorIdentityId, objectId: selected.objectId, objectVersion: selected.objectVersion, audience: "team-drive.preview", expiresInSeconds: 300 });
    if (!reference || !UUID.test(reference.referenceId ?? "") || typeof reference.expiresAt !== "string") throw new PlatformError("file_preview_unavailable", "File preview reference is unavailable", { status: 409 });
    return Object.freeze({ supported: true, previewKind: kind, referenceId: reference.referenceId, expiresAt: reference.expiresAt, version: versionPublic(selected) });
  }

  async download(context, fileId, { version: requestedVersion = null } = {}) {
    const entry = await this.#repository.findEntry(uuid(fileId)); if (!entry || entry.kind !== "file" || entry.trashedAt) throw new PlatformError("file_not_found", "File is unavailable", { status: 404 });
    const { owner } = await this.#rootAccess(context, entry.rootId, "file:read", "viewer", fileId), values = await this.#repository.listVersions(fileId);
    const selected = requestedVersion === null ? values.at(-1) : values.find((value) => value.version === requestedVersion);
    if (!selected) throw new PlatformError("file_version_not_found", "File version is unavailable", { status: 404 });
    const reference = await this.#objects.issueReadReference({ actorIdentityId: owner.actorIdentityId, objectId: selected.objectId, objectVersion: selected.objectVersion, audience: "team-drive.download", expiresInSeconds: 300 });
    if (!reference || !UUID.test(reference.referenceId ?? "") || typeof reference.expiresAt !== "string") throw new PlatformError("file_download_unavailable", "File download reference is unavailable", { status: 409 });
    return Object.freeze({ referenceId: reference.referenceId, expiresAt: reference.expiresAt, version: versionPublic(selected) });
  }

  async quota(context, rootId) {
    await this.#rootAccess(context, rootId, "file:read", "viewer"); const value = await this.#repository.quota(rootId); if (!value) throw new PlatformError("file_root_not_found", "File root is unavailable", { status: 404 }); return Object.freeze(value);
  }
}
