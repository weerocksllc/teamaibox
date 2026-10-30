import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID_SOURCE = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const BOOTSTRAP = /^\/api\/v1\/files\/bootstrap$/;
const ROOTS = /^\/api\/v1\/files\/roots$/;
const ROOT_ENTRIES = new RegExp(`^/api/v1/files/roots/${UUID_SOURCE}/entries$`, "i");
const ROOT_FOLDERS = new RegExp(`^/api/v1/files/roots/${UUID_SOURCE}/folders$`, "i");
const ROOT_FILES = new RegExp(`^/api/v1/files/roots/${UUID_SOURCE}/files$`, "i");
const ROOT_SEARCH = new RegExp(`^/api/v1/files/roots/${UUID_SOURCE}/search$`, "i");
const ROOT_QUOTA = new RegExp(`^/api/v1/files/roots/${UUID_SOURCE}/quota$`, "i");
const ENTRY = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}$`, "i");
const ENTRY_COPY = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}/copy$`, "i");
const ENTRY_TRASH = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}/trash$`, "i");
const ENTRY_RESTORE = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}/restore$`, "i");
const ENTRY_PURGE = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}/purge$`, "i");
const ENTRY_VERSIONS = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}/versions$`, "i");
const ENTRY_PREVIEW = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}/preview$`, "i");
const ENTRY_DOWNLOAD = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}/download$`, "i");
const ENTRY_SHARES = new RegExp(`^/api/v1/files/entries/${UUID_SOURCE}/shares$`, "i");
const SHARE = new RegExp(`^/api/v1/files/shares/${UUID_SOURCE}$`, "i");
const SHARED = new RegExp(`^/api/v1/files/shared/${UUID_SOURCE}$`, "i");
const RECEIVED = "/api/v1/files/shared";
const DEFAULT_TEAM_KEY = "team.default";

function driveContext(context, teamKey) {
  if (!context?.identityId || !Array.isArray(context.permissions)) {
    throw new PlatformError("file_permission_denied", "File permission is denied", { status: 403 });
  }
  let teamRoles = context.teamRoles && typeof context.teamRoles === "object" && !Array.isArray(context.teamRoles)
    ? structuredClone(context.teamRoles) : {};
  return Object.freeze({ actorIdentityId: context.identityId, permissions: Object.freeze([...context.permissions]), teamRoles: Object.freeze(teamRoles) });
}

const rootContract = (value) => Object.freeze({
  id: value.id, object: "files.root", scope_kind: value.scopeKind, scope_key: value.scopeKey,
  quota_bytes: value.quotaBytes, used_bytes: value.usedBytes, available_bytes: value.availableBytes,
  revision: value.revision, created_at: value.createdAt, updated_at: value.updatedAt,
});
const entryContract = (value) => Object.freeze({
  id: value.id, object: "files.entry", root_id: value.rootId, parent_id: value.parentId, kind: value.kind,
  name: value.name, owner_identity_id: value.ownerIdentityId, current_version: value.currentVersion,
  byte_size: value.size ?? null, media_type: value.mediaType ?? null,
  revision: value.revision, created_at: value.createdAt, updated_at: value.updatedAt,
  trashed_at: value.trashedAt, retention_until: value.retentionUntil,
});
const versionContract = (value) => Object.freeze({
  file_id: value.fileId, object: "files.version", version: value.version, object_id: value.objectId,
  object_version: value.objectVersion, byte_size: value.size, media_type: value.mediaType,
  sha256: value.sha256, provenance: value.provenance, created_by_identity_id: value.createdByIdentityId,
  created_at: value.createdAt,
});
const shareContract = (value) => Object.freeze({
  id: value.id, object: "files.share", root_id: value.rootId, entry_id: value.entryId,
  principal_kind: value.principalKind, principal_key: value.principalKey, role: value.role,
  expires_at: value.expiresAt, revoked_at: value.revokedAt, revision: value.revision,
  created_by_identity_id: value.createdByIdentityId, created_at: value.createdAt,
});

function integer(value) {
  if (value === null || value === undefined || value === "") return null;
  const selected = Number(value);
  return Number.isSafeInteger(selected) ? selected : Number.NaN;
}

export function matchesTeamDriveHttpRoute(method, pathname) {
  if (pathname === RECEIVED) return method === "GET";
  if (BOOTSTRAP.test(pathname)) return method === "GET";
  if (ROOTS.test(pathname)) return method === "POST";
  if (ROOT_ENTRIES.test(pathname) || ROOT_SEARCH.test(pathname) || ROOT_QUOTA.test(pathname)) return method === "GET";
  if (ROOT_FOLDERS.test(pathname) || ROOT_FILES.test(pathname)) return method === "POST";
  if (ENTRY.test(pathname)) return method === "PATCH";
  if (ENTRY_COPY.test(pathname) || ENTRY_TRASH.test(pathname) || ENTRY_RESTORE.test(pathname)
    || ENTRY_PURGE.test(pathname)) return method === "POST";
  if (ENTRY_VERSIONS.test(pathname) || ENTRY_SHARES.test(pathname)) return method === "GET" || method === "POST";
  if (ENTRY_PREVIEW.test(pathname) || ENTRY_DOWNLOAD.test(pathname) || SHARED.test(pathname)) return method === "GET";
  if (SHARE.test(pathname)) return method === "DELETE";
  return false;
}

export class TeamDriveHttpApi {
  #service;
  #teamKey;

  constructor({ service, defaultTeamKey = DEFAULT_TEAM_KEY }) {
    const methods = ["createRoot", "ensureTeamRoot", "rootByScope", "list", "createFolder", "createFile", "addVersion", "versions", "move", "copy", "trash", "restore", "purge", "search", "preview", "download", "quota", "share", "shares", "revokeShare", "sharedEntry", "receivedShares"];
    if (!service || methods.some((method) => typeof service[method] !== "function")
      || typeof defaultTeamKey !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(defaultTeamKey)) {
      throw new TypeError("Team Drive HTTP service is incomplete");
    }
    this.#service = service; this.#teamKey = defaultTeamKey;
  }

  matches(method, pathname) { return matchesTeamDriveHttpRoute(method, pathname); }
  bodyKind(method) { return method === "GET" ? "none" : "json"; }

  async #bootstrap(context) {
    const roots = [];
    let personal = await this.#service.rootByScope(context, "user", context.actorIdentityId);
    if (!personal && context.permissions.includes("file:write")) {
      personal = await this.#service.createRoot(context, { scopeKind: "user", scopeKey: context.actorIdentityId });
    }
    if (personal) roots.push(personal);
    if (context.teamRoles[this.#teamKey]) {
      let team = await this.#service.rootByScope(context, "team", this.#teamKey);
      if (!team) team = await this.#service.ensureTeamRoot(context, this.#teamKey);
      if (team) roots.push(team);
    }
    return { object: "list", data: roots.map(rootContract), default_team_key: this.#teamKey };
  }

  async handle({ method, pathname, body = null, context, query = new URLSearchParams() }) {
    const actor = driveContext(context, this.#teamKey);
    if (pathname === RECEIVED && method === "GET") {
      const data = await this.#service.receivedShares(actor);
      return { kind: "json", status: 200, body: { object: "list", data: data.map(value => ({
        share: shareContract(value.share), entry: entryContract(value.entry), access_role: value.accessRole,
      })) } };
    }
    if (BOOTSTRAP.test(pathname)) return { kind: "json", status: 200, body: await this.#bootstrap(actor) };
    if (ROOTS.test(pathname) && method === "POST") {
      const created = await this.#service.createRoot(actor, { scopeKind: body?.scope_kind, scopeKey: body?.scope_key, quotaBytes: body?.quota_bytes });
      return { kind: "json", status: 201, body: rootContract(created) };
    }
    let match = ROOT_ENTRIES.exec(pathname);
    if (match) {
      const data = await this.#service.list(actor, match[1], { parentId: query.get("parent_id") || null, includeTrashed: query.get("trashed") === "1" });
      return { kind: "json", status: 200, body: { object: "list", data: data.map(entryContract) } };
    }
    match = ROOT_FOLDERS.exec(pathname);
    if (match) return { kind: "json", status: 201, body: entryContract(await this.#service.createFolder(actor, match[1], { parentId: body?.parent_id ?? null, name: body?.name })) };
    match = ROOT_FILES.exec(pathname);
    if (match) {
      const created = await this.#service.createFile(actor, match[1], { parentId: body?.parent_id ?? null, name: body?.name, objectReferenceId: body?.object_reference_id, provenance: body?.provenance });
      return { kind: "json", status: 201, body: { entry: entryContract(created.entry), version: versionContract(created.version) } };
    }
    match = ROOT_SEARCH.exec(pathname);
    if (match) {
      const values = await this.#service.search(actor, match[1], { query: query.get("q"), includeTrashed: query.get("trashed") === "1", limit: integer(query.get("limit")) ?? 50 });
      return { kind: "json", status: 200, body: { object: "list", data: values.map(entryContract) } };
    }
    match = ROOT_QUOTA.exec(pathname);
    if (match) {
      const value = await this.#service.quota(actor, match[1]);
      return { kind: "json", status: 200, body: { object: "files.quota", root_id: value.rootId, quota_bytes: value.quotaBytes, used_bytes: value.usedBytes, available_bytes: value.availableBytes } };
    }
    match = ENTRY.exec(pathname);
    if (match) return { kind: "json", status: 200, body: entryContract(await this.#service.move(actor, match[1], { parentId: body?.parent_id ?? null, name: body?.name, expectedRevision: body?.expected_revision })) };
    match = ENTRY_COPY.exec(pathname);
    if (match) {
      const value = await this.#service.copy(actor, match[1], { parentId: body?.parent_id ?? null, name: body?.name, expectedRevision: body?.expected_revision });
      return { kind: "json", status: 201, body: { entry: entryContract(value.entry), entry_ids: value.entryIds, version_count: value.versionCount, copied_bytes: value.copiedBytes } };
    }
    match = ENTRY_TRASH.exec(pathname);
    if (match) return { kind: "json", status: 200, body: entryContract(await this.#service.trash(actor, match[1], { expectedRevision: body?.expected_revision })) };
    match = ENTRY_RESTORE.exec(pathname);
    if (match) return { kind: "json", status: 200, body: entryContract(await this.#service.restore(actor, match[1], { parentId: body?.parent_id ?? null, expectedRevision: body?.expected_revision })) };
    match = ENTRY_PURGE.exec(pathname);
    if (match) {
      const value = await this.#service.purge(actor, match[1]);
      return { kind: "json", status: 200, body: { entry_ids: value.entryIds, released_bytes: value.releasedBytes } };
    }
    match = ENTRY_VERSIONS.exec(pathname);
    if (match) {
      if (method === "GET") return { kind: "json", status: 200, body: { object: "list", data: (await this.#service.versions(actor, match[1])).map(versionContract) } };
      const created = await this.#service.addVersion(actor, match[1], { objectReferenceId: body?.object_reference_id, expectedRevision: body?.expected_revision, provenance: body?.provenance });
      return { kind: "json", status: 201, body: { entry: entryContract(created.entry), version: versionContract(created.version) } };
    }
    match = ENTRY_PREVIEW.exec(pathname);
    if (match) {
      const value = await this.#service.preview(actor, match[1], { version: integer(query.get("version")) });
      return { kind: "json", status: 200, body: { supported: value.supported, ...(value.supported ? { preview_kind: value.previewKind, reference_id: value.referenceId, expires_at: value.expiresAt } : { reason: value.reason }), version: versionContract(value.version) } };
    }
    match = ENTRY_DOWNLOAD.exec(pathname);
    if (match) {
      const value = await this.#service.download(actor, match[1], { version: integer(query.get("version")) });
      return { kind: "json", status: 200, body: { reference_id: value.referenceId, expires_at: value.expiresAt, version: versionContract(value.version) } };
    }
    match = ENTRY_SHARES.exec(pathname);
    if (match) {
      if (method === "GET") return { kind: "json", status: 200, body: { object: "list", data: (await this.#service.shares(actor, match[1])).map(shareContract) } };
      const created = await this.#service.share(actor, match[1], { principalKind: body?.principal_kind, principalKey: body?.principal_key, role: body?.role, expiresAt: body?.expires_at ?? null });
      return { kind: "json", status: 201, body: shareContract(created) };
    }
    match = SHARE.exec(pathname);
    if (match) return { kind: "json", status: 200, body: shareContract(await this.#service.revokeShare(actor, match[1])) };
    match = SHARED.exec(pathname);
    if (match) {
      const value = await this.#service.sharedEntry(actor, match[1]);
      return { kind: "json", status: 200, body: { share: shareContract(value.share), entry: entryContract(value.entry), access_role: value.accessRole } };
    }
    throw new PlatformError("not_found", "Team Drive endpoint was not found", { status: 404 });
  }
}
