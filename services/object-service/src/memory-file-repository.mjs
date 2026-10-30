import { randomUUID } from "node:crypto";

const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2, manager: 3, owner: 4 });

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function rootProjection(root) {
  if (!root) return null;
  return copy({ ...root, entries: undefined, acl: undefined, shares: undefined });
}

export class FileRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FileRepositoryError";
    this.code = code;
  }
}

export class MemoryFileRepository {
  #roots = new Map();
  #rootByScope = new Map();
  #entries = new Map();
  #versions = new Map();
  #acl = new Map();
  #shares = new Map();

  #entryProjection(entry) {
    if (!entry) return null;
    const current = this.#versions.get(entry.id)?.find((value) => value.version === entry.currentVersion);
    return copy({ ...entry, size: current?.size ?? null, mediaType: current?.mediaType ?? null });
  }

  async createRoot(value) {
    const key = `${value.scopeKind}:${value.scopeKey}`;
    const existing = this.#rootByScope.get(key);
    if (existing) return rootProjection(this.#roots.get(existing));
    const root = {
      ...copy(value), id: value.id ?? randomUUID(), usedBytes: 0, revision: 1,
    };
    this.#roots.set(root.id, root);
    this.#rootByScope.set(key, root.id);
    this.#acl.set(root.id, []);
    return rootProjection(root);
  }

  async findRoot(rootId) {
    return rootProjection(this.#roots.get(rootId) ?? null);
  }

  async findRootByScope(scopeKind, scopeKey) {
    const id = this.#rootByScope.get(`${scopeKind}:${scopeKey}`);
    return id ? rootProjection(this.#roots.get(id)) : null;
  }

  async findEntry(entryId) {
    return this.#entryProjection(this.#entries.get(entryId));
  }

  async entriesForObjectVersion(objectId, objectVersion) {
    return [...this.#entries.values()].filter(entry => this.#versions.get(entry.id)?.some(
      version => version.objectId === objectId && version.objectVersion === objectVersion,
    )).map(entry => this.#entryProjection(entry));
  }

  #entryChain(entryId) {
    const chain = [];
    let current = entryId ? this.#entries.get(entryId) : null;
    const seen = new Set();
    while (current) {
      if (seen.has(current.id)) throw new FileRepositoryError("file_hierarchy_corrupt", "File hierarchy contains a cycle");
      seen.add(current.id);
      chain.push(current);
      current = current.parentId ? this.#entries.get(current.parentId) : null;
    }
    return chain;
  }

  #isVisible(entry) {
    return !this.#entryChain(entry.id).some((value) => value.trashedAt);
  }

  #conflictingSibling(rootId, parentId, name, exceptId = null) {
    return [...this.#entries.values()].find((entry) => entry.rootId === rootId
      && entry.parentId === parentId && entry.id !== exceptId && !entry.trashedAt && entry.name === name) ?? null;
  }

  #assertParent(rootId, parentId) {
    if (parentId === null) return;
    const parent = this.#entries.get(parentId);
    if (!parent || parent.rootId !== rootId || parent.kind !== "folder" || parent.trashedAt) {
      throw new FileRepositoryError("file_parent_not_found", "File parent folder is unavailable");
    }
  }

  async createFolder(value) {
    this.#assertParent(value.rootId, value.parentId);
    if (this.#conflictingSibling(value.rootId, value.parentId, value.name)) throw new FileRepositoryError("file_name_conflict", "A sibling already uses this name");
    const entry = { ...copy(value), id: value.id ?? randomUUID(), revision: 1, currentVersion: 0, trashedAt: null, retentionUntil: null };
    this.#entries.set(entry.id, entry);
    this.#versions.set(entry.id, []);
    this.#acl.set(entry.id, []);
    return this.#entryProjection(entry);
  }

  async createFile({ entry: value, version }) {
    this.#assertParent(value.rootId, value.parentId);
    if (this.#conflictingSibling(value.rootId, value.parentId, value.name)) throw new FileRepositoryError("file_name_conflict", "A sibling already uses this name");
    const root = this.#roots.get(value.rootId);
    if (!root) throw new FileRepositoryError("file_root_not_found", "File root is unavailable");
    if (root.usedBytes + version.size > root.quotaBytes) throw new FileRepositoryError("file_quota_exceeded", "File quota exceeded");
    const entry = { ...copy(value), id: value.id ?? randomUUID(), revision: 1, currentVersion: 1, trashedAt: null, retentionUntil: null };
    const committed = { ...copy(version), fileId: entry.id, version: 1 };
    this.#entries.set(entry.id, entry);
    this.#versions.set(entry.id, [committed]);
    this.#acl.set(entry.id, []);
    root.usedBytes += committed.size;
    root.revision += 1;
    root.updatedAt = new Date(committed.createdAt);
    return copy({ entry: this.#entryProjection(entry), version: committed, root: rootProjection(root) });
  }

  async appendVersion(entryId, value, expectedRevision) {
    const entry = this.#entries.get(entryId), root = entry ? this.#roots.get(entry.rootId) : null;
    if (!entry || entry.kind !== "file" || entry.trashedAt || !root) throw new FileRepositoryError("file_not_found", "File is unavailable");
    if (entry.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
    if (root.usedBytes + value.size > root.quotaBytes) throw new FileRepositoryError("file_quota_exceeded", "File quota exceeded");
    const values = this.#versions.get(entryId), version = { ...copy(value), fileId: entryId, version: values.length + 1 };
    values.push(version);
    entry.currentVersion = version.version;
    entry.revision += 1;
    entry.updatedAt = new Date(value.createdAt);
    root.usedBytes += version.size;
    root.revision += 1;
    root.updatedAt = new Date(value.createdAt);
    return copy({ entry: this.#entryProjection(entry), version, root: rootProjection(root) });
  }

  async listVersions(entryId) {
    return copy(this.#versions.get(entryId) ?? []);
  }

  async listChildren(rootId, parentId, { includeTrashed = false } = {}) {
    return [...this.#entries.values()].filter((entry) => entry.rootId === rootId && entry.parentId === parentId
      && (includeTrashed || this.#isVisible(entry)))
      .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "folder" ? -1 : 1)
      .map((entry) => this.#entryProjection(entry));
  }

  async moveEntry(entryId, { parentId, name, expectedRevision, now }) {
    const entry = this.#entries.get(entryId);
    if (!entry || entry.trashedAt) throw new FileRepositoryError("file_not_found", "File entry is unavailable");
    if (entry.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
    this.#assertParent(entry.rootId, parentId);
    if (entry.kind === "folder" && parentId && this.#entryChain(parentId).some((value) => value.id === entry.id)) throw new FileRepositoryError("file_hierarchy_cycle", "A folder cannot move inside itself");
    if (this.#conflictingSibling(entry.rootId, parentId, name, entry.id)) throw new FileRepositoryError("file_name_conflict", "A sibling already uses this name");
    entry.parentId = parentId;
    entry.name = name;
    entry.revision += 1;
    entry.updatedAt = new Date(now);
    return this.#entryProjection(entry);
  }

  async copyEntry(entryId, { parentId, name, expectedRevision, ownerIdentityId, now }) {
    const source = this.#entries.get(entryId);
    if (!source || !this.#isVisible(source)) throw new FileRepositoryError("file_not_found", "File entry is unavailable");
    if (source.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
    this.#assertParent(source.rootId, parentId);
    if (this.#conflictingSibling(source.rootId, parentId, name)) throw new FileRepositoryError("file_name_conflict", "A sibling already uses this name");

    const descendants = [...this.#entries.values()]
      .filter((candidate) => candidate.id === source.id || this.#entryChain(candidate.id).some((value) => value.id === source.id))
      .sort((left, right) => this.#entryChain(left.id).length - this.#entryChain(right.id).length);
    const copiedBytes = descendants.reduce((total, candidate) => total
      + (this.#versions.get(candidate.id) ?? []).reduce((sum, version) => sum + version.size, 0), 0);
    const root = this.#roots.get(source.rootId);
    if (!root) throw new FileRepositoryError("file_root_not_found", "File root is unavailable");
    if (root.usedBytes + copiedBytes > root.quotaBytes) throw new FileRepositoryError("file_quota_exceeded", "File quota exceeded");

    const ids = new Map(), created = [];
    for (const original of descendants) {
      const id = randomUUID(); ids.set(original.id, id);
      const cloned = {
        ...copy(original),
        id,
        parentId: original.id === source.id ? parentId : ids.get(original.parentId),
        name: original.id === source.id ? name : original.name,
        ownerIdentityId,
        revision: 1,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        trashedAt: null,
        retentionUntil: null,
      };
      const versions = (this.#versions.get(original.id) ?? []).map((version) => ({
        ...copy(version), fileId: id, createdByIdentityId: ownerIdentityId, createdAt: new Date(now),
        provenance: { ...copy(version.provenance), copiedFrom: { fileId: original.id, version: version.version } },
      }));
      this.#entries.set(id, cloned); this.#versions.set(id, versions); this.#acl.set(id, []); created.push(cloned);
    }
    root.usedBytes += copiedBytes; root.revision += 1; root.updatedAt = new Date(now);
    return copy({ entry: this.#entryProjection(created[0]), entryIds: created.map((value) => value.id), versionCount: created.reduce((total, value) => total + (this.#versions.get(value.id)?.length ?? 0), 0), copiedBytes, root: rootProjection(root) });
  }

  async trashEntry(entryId, { expectedRevision, trashedAt, retentionUntil }) {
    const entry = this.#entries.get(entryId);
    if (!entry || entry.trashedAt) throw new FileRepositoryError("file_not_found", "File entry is unavailable");
    if (entry.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
    entry.trashedAt = new Date(trashedAt);
    entry.retentionUntil = new Date(retentionUntil);
    entry.revision += 1;
    entry.updatedAt = new Date(trashedAt);
    return this.#entryProjection(entry);
  }

  async restoreEntry(entryId, { expectedRevision, parentId, now }) {
    const entry = this.#entries.get(entryId);
    if (!entry || !entry.trashedAt) throw new FileRepositoryError("file_not_found", "Recycled file entry is unavailable");
    if (entry.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
    this.#assertParent(entry.rootId, parentId);
    if (this.#conflictingSibling(entry.rootId, parentId, entry.name, entry.id)) throw new FileRepositoryError("file_name_conflict", "A sibling already uses this name");
    entry.parentId = parentId;
    entry.trashedAt = null;
    entry.retentionUntil = null;
    entry.revision += 1;
    entry.updatedAt = new Date(now);
    return this.#entryProjection(entry);
  }

  async purgeEntry(entryId, now) {
    const entry = this.#entries.get(entryId);
    if (!entry || !entry.trashedAt) throw new FileRepositoryError("file_not_found", "Recycled file entry is unavailable");
    const descendants = [...this.#entries.values()].filter((candidate) => candidate.id === entryId || this.#entryChain(candidate.id).some((value) => value.id === entryId));
    const root = this.#roots.get(entry.rootId);
    let releasedBytes = 0;
    for (const candidate of descendants) {
      for (const version of this.#versions.get(candidate.id) ?? []) releasedBytes += version.size;
      this.#versions.delete(candidate.id); this.#acl.delete(candidate.id); this.#entries.delete(candidate.id);
    }
    for (const [id, share] of this.#shares) if (descendants.some((candidate) => candidate.id === share.entryId)) this.#shares.delete(id);
    root.usedBytes -= releasedBytes;
    root.revision += 1;
    root.updatedAt = new Date(now);
    return copy({ entryIds: descendants.map((value) => value.id), releasedBytes, root: rootProjection(root) });
  }

  async setAcl(value) {
    const values = this.#acl.get(value.entryId ?? value.rootId);
    if (!values) throw new FileRepositoryError("file_not_found", "ACL target is unavailable");
    const existing = values.find((item) => item.principalKind === value.principalKind && item.principalKey === value.principalKey);
    if (existing) Object.assign(existing, copy(value), { revision: existing.revision + 1 });
    else values.push({ ...copy(value), id: randomUUID(), revision: 1 });
    return copy(existing ?? values.at(-1));
  }

  async removeAcl({ rootId, entryId, principalKind, principalKey }) {
    const values = this.#acl.get(entryId ?? rootId);
    if (!values) return false;
    const index = values.findIndex((item) => item.principalKind === principalKind && item.principalKey === principalKey);
    if (index < 0) return false;
    values.splice(index, 1);
    return true;
  }

  async listAcl(rootId, entryId = null) {
    return copy(this.#acl.get(entryId ?? rootId) ?? []);
  }

  async accessRole({ rootId, entryId = null, actorIdentityId, teamRoles = {}, now = new Date() }) {
    const root = this.#roots.get(rootId);
    if (!root) return null;
    let role = null;
    if (root.scopeKind === "user" && root.scopeKey === actorIdentityId) role = "owner";
    if (root.scopeKind === "team" && teamRoles[root.scopeKey]) role = ({ owner: "owner", manager: "manager", member: "editor", guest: "viewer" })[teamRoles[root.scopeKey]] ?? null;
    const targets = [root.id, ...this.#entryChain(entryId).reverse().map((entry) => entry.id)];
    for (let index = 0; index < targets.length; index += 1) {
      for (const acl of this.#acl.get(targets[index]) ?? []) {
        const match = acl.principalKind === "identity" ? acl.principalKey === actorIdentityId : Object.hasOwn(teamRoles, acl.principalKey);
        const applicable = targets[index] === entryId || acl.inherited;
        const current = !acl.expiresAt || acl.expiresAt > now;
        if (match && applicable && current && (!role || ROLE_RANK[acl.role] > ROLE_RANK[role])) role = acl.role;
      }
    }
    return role;
  }

  async createShare(value) {
    const share = { ...copy(value), id: value.id ?? randomUUID(), revision: 1, revokedAt: null };
    this.#shares.set(share.id, share);
    return copy(share);
  }

  async findShare(shareId) {
    return copy(this.#shares.get(shareId) ?? null);
  }

  async listShares(entryId) {
    return [...this.#shares.values()].filter((value) => value.entryId === entryId).map(copy);
  }

  async listReceivedShares({ actorIdentityId, teamRoles = {}, now }) {
    return [...this.#shares.values()].filter(value => !value.revokedAt
      && (!value.expiresAt || value.expiresAt > now)
      && (value.principalKind === "identity" ? value.principalKey === actorIdentityId : Object.hasOwn(teamRoles, value.principalKey)))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(copy);
  }

  async revokeShare(shareId, now) {
    const share = this.#shares.get(shareId);
    if (!share || share.revokedAt) return null;
    share.revokedAt = new Date(now); share.revision += 1;
    return copy(share);
  }

  async search(rootId, query, { includeTrashed = false, limit = 100 } = {}) {
    const normalized = query.toLocaleLowerCase("en-US");
    return [...this.#entries.values()].filter((entry) => entry.rootId === rootId && (includeTrashed ? true : this.#isVisible(entry))
      && entry.name.toLocaleLowerCase("en-US").includes(normalized)).slice(0, limit).map((entry) => this.#entryProjection(entry));
  }

  async quota(rootId) {
    const root = this.#roots.get(rootId);
    return root ? copy({ rootId, quotaBytes: root.quotaBytes, usedBytes: root.usedBytes, availableBytes: root.quotaBytes - root.usedBytes }) : null;
  }
}
