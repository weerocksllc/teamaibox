import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { FileRepositoryError } from "./memory-file-repository.mjs";

const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2, manager: 3, owner: 4 });

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL file query result is invalid");
  return result.rows;
}

const date = (value) => value === null || value === undefined ? null : new Date(value);
const digest = (value) => `sha256:${Buffer.from(value).toString("hex")}`;
const binaryDigest = (value) => Buffer.from(value.slice(7), "hex");

function root(row) {
  return row ? { id: row.id, scopeKind: row.scope_kind, scopeKey: row.scope_key, quotaBytes: Number(row.quota_bytes), usedBytes: Number(row.used_bytes), revision: Number(row.revision), createdByIdentityId: row.created_by_identity_id, createdAt: date(row.created_at), updatedAt: date(row.updated_at) } : null;
}

function entry(row) {
  return row ? { id: row.id, rootId: row.root_id, parentId: row.parent_id, kind: row.entry_kind, name: row.entry_name, ownerIdentityId: row.owner_identity_id, currentVersion: Number(row.current_version), size: row.byte_size == null ? null : Number(row.byte_size), mediaType: row.media_type ?? null, revision: Number(row.revision), createdAt: date(row.created_at), updatedAt: date(row.updated_at), trashedAt: date(row.trashed_at), retentionUntil: date(row.retention_until) } : null;
}

function version(row) {
  return row ? { fileId: row.file_id, version: Number(row.version), objectId: row.object_id, objectVersion: Number(row.object_version), size: Number(row.byte_size), mediaType: row.media_type, sha256: digest(row.sha256), provenance: typeof row.provenance === "string" ? JSON.parse(row.provenance) : structuredClone(row.provenance), createdByIdentityId: row.created_by_identity_id, createdAt: date(row.created_at) } : null;
}

function acl(row) {
  return row ? { id: row.id, rootId: row.root_id, entryId: row.entry_id, principalKind: row.principal_kind, principalKey: row.principal_key, role: row.access_role, inherited: row.inherited, expiresAt: date(row.expires_at), revision: Number(row.revision), createdByIdentityId: row.created_by_identity_id, createdAt: date(row.created_at) } : null;
}

function share(row) {
  return row ? { id: row.id, rootId: row.root_id, entryId: row.entry_id, principalKind: row.principal_kind, principalKey: row.principal_key, role: row.access_role, expiresAt: date(row.expires_at), revokedAt: date(row.revoked_at), revision: Number(row.revision), createdByIdentityId: row.created_by_identity_id, createdAt: date(row.created_at) } : null;
}

function translated(error) {
  if (error instanceof FileRepositoryError) return error;
  if (error?.code === "23505") return new FileRepositoryError("file_name_conflict", "A sibling or ACL already exists");
  if (error?.code === "23503") return new FileRepositoryError("file_parent_not_found", "File parent or object version is unavailable");
  if (error?.code === "23514") {
    const message = String(error.message || "");
    if (message.includes("quota")) return new FileRepositoryError("file_quota_exceeded", "File quota exceeded");
    if (message.includes("cycle")) return new FileRepositoryError("file_hierarchy_cycle", "File hierarchy cycle is forbidden");
    return new FileRepositoryError("file_object_unavailable", "File database boundary rejected inconsistent facts");
  }
  return error;
}

async function loadEntry(executor, entryId, lock = false) {
  return entry(rows(await executor.query(`SELECT candidate.*, current_file.byte_size, current_file.media_type
    FROM files.entries candidate LEFT JOIN files.versions current_file
      ON current_file.file_id=candidate.id AND current_file.version=candidate.current_version
    WHERE candidate.id=$1${lock ? " FOR UPDATE OF candidate" : ""}`, [entryId]))[0]);
}

async function loadRoot(executor, rootId, lock = false) {
  return root(rows(await executor.query(`SELECT * FROM files.roots WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [rootId]))[0]);
}

async function loadVersion(executor, fileId, versionNumber) {
  return version(rows(await executor.query("SELECT * FROM files.versions WHERE file_id=$1 AND version=$2", [fileId, versionNumber]))[0]);
}

export class PostgresFileRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL file repository requires transactions");
    this.#database = database;
  }

  async createRoot(value) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query(`INSERT INTO files.roots (
        scope_kind,scope_key,quota_bytes,created_by_identity_id,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (scope_kind,scope_key) DO NOTHING`, [value.scopeKind, value.scopeKey, value.quotaBytes, value.createdByIdentityId, value.createdAt, value.updatedAt]);
      return root(rows(await transaction.query("SELECT * FROM files.roots WHERE scope_kind=$1 AND scope_key=$2 FOR UPDATE", [value.scopeKind, value.scopeKey]))[0]);
    });
  }

  async findRoot(rootId) { return loadRoot(this.#database, rootId); }
  async findRootByScope(scopeKind, scopeKey) { return root(rows(await this.#database.query("SELECT * FROM files.roots WHERE scope_kind=$1 AND scope_key=$2", [scopeKind, scopeKey]))[0]); }
  async findEntry(entryId) { return loadEntry(this.#database, entryId); }

  async entriesForObjectVersion(objectId, objectVersion) {
    return rows(await this.#database.query(`SELECT candidate.* FROM files.entries candidate
      WHERE EXISTS (SELECT 1 FROM files.versions stored WHERE stored.file_id=candidate.id
        AND stored.object_id=$1 AND stored.object_version=$2)`, [objectId, objectVersion])).map(entry);
  }

  async createFolder(value) {
    try {
      return entry(rows(await this.#database.query(`INSERT INTO files.entries (
        root_id,parent_id,entry_kind,entry_name,owner_identity_id,created_at,updated_at
      ) VALUES ($1,$2,'folder',$3,$4,$5,$6) RETURNING *`, [value.rootId, value.parentId, value.name, value.ownerIdentityId, value.createdAt, value.updatedAt]))[0]);
    } catch (error) { throw translated(error); }
  }

  async createFile({ entry: value, version: versionValue }) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const created = entry(rows(await transaction.query(`INSERT INTO files.entries (
          root_id,parent_id,entry_kind,entry_name,owner_identity_id,created_at,updated_at
        ) VALUES ($1,$2,'file',$3,$4,$5,$6) RETURNING *`, [value.rootId, value.parentId, value.name, value.ownerIdentityId, value.createdAt, value.updatedAt]))[0]);
        await transaction.query(`INSERT INTO files.versions (
          file_id,root_id,version,object_id,object_version,byte_size,media_type,sha256,provenance,created_by_identity_id,created_at
        ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [created.id, created.rootId, versionValue.objectId, versionValue.objectVersion, versionValue.size, versionValue.mediaType, binaryDigest(versionValue.sha256), JSON.stringify(versionValue.provenance), versionValue.createdByIdentityId, versionValue.createdAt]);
        return { entry: await loadEntry(transaction, created.id), version: await loadVersion(transaction, created.id, 1), root: await loadRoot(transaction, created.rootId) };
      });
    } catch (error) { throw translated(error); }
  }

  async appendVersion(entryId, value, expectedRevision) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const selected = await loadEntry(transaction, entryId, true);
        if (!selected || selected.kind !== "file" || selected.trashedAt) throw new FileRepositoryError("file_not_found", "File is unavailable");
        if (selected.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
        const next = selected.currentVersion + 1;
        await transaction.query(`INSERT INTO files.versions (
          file_id,root_id,version,object_id,object_version,byte_size,media_type,sha256,provenance,created_by_identity_id,created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, [entryId, selected.rootId, next, value.objectId, value.objectVersion, value.size, value.mediaType, binaryDigest(value.sha256), JSON.stringify(value.provenance), value.createdByIdentityId, value.createdAt]);
        return { entry: await loadEntry(transaction, entryId), version: await loadVersion(transaction, entryId, next), root: await loadRoot(transaction, selected.rootId) };
      });
    } catch (error) { throw translated(error); }
  }

  async listVersions(entryId) { return rows(await this.#database.query("SELECT * FROM files.versions WHERE file_id=$1 ORDER BY version", [entryId])).map(version); }

  async listChildren(rootId, parentId, { includeTrashed = false } = {}) {
    return rows(await this.#database.query(`SELECT candidate.*, current_file.byte_size, current_file.media_type
      FROM files.entries candidate LEFT JOIN files.versions current_file
        ON current_file.file_id=candidate.id AND current_file.version=candidate.current_version
      WHERE candidate.root_id=$1 AND candidate.parent_id IS NOT DISTINCT FROM $2
        AND ($3::boolean OR candidate.trashed_at IS NULL)
      ORDER BY CASE candidate.entry_kind WHEN 'folder' THEN 0 ELSE 1 END,lower(candidate.entry_name),candidate.id`, [rootId, parentId, includeTrashed])).map(entry);
  }

  async moveEntry(entryId, { parentId, name, expectedRevision, now }) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const selected = await loadEntry(transaction, entryId, true);
        if (!selected || selected.trashedAt) throw new FileRepositoryError("file_not_found", "File entry is unavailable");
        if (selected.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
        await transaction.query("UPDATE files.entries SET parent_id=$2,entry_name=$3,revision=revision+1,updated_at=$4 WHERE id=$1", [entryId, parentId, name, now]);
        return loadEntry(transaction, entryId);
      });
    } catch (error) { throw translated(error); }
  }

  async copyEntry(entryId, { parentId, name, expectedRevision, ownerIdentityId, now }) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const selected = await loadEntry(transaction, entryId, true);
        if (!selected || selected.trashedAt) throw new FileRepositoryError("file_not_found", "File entry is unavailable");
        if (selected.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
        const sourceRows = rows(await transaction.query(`WITH RECURSIVE descendants AS (
          SELECT entry.*,0 AS copy_depth FROM files.entries entry WHERE entry.id=$1 AND entry.trashed_at IS NULL
          UNION ALL SELECT child.*,descendants.copy_depth+1 FROM files.entries child
          JOIN descendants ON child.parent_id=descendants.id WHERE child.trashed_at IS NULL
        ) SELECT * FROM descendants ORDER BY copy_depth,id`, [entryId]));
        if (!sourceRows.length) throw new FileRepositoryError("file_not_found", "File entry is unavailable");
        const ids = new Map(), created = [];
        let versionCount = 0, copiedBytes = 0;
        for (const row of sourceRows) {
          const sourceEntry = entry(row), id = randomUUID(); ids.set(sourceEntry.id, id);
          const copied = entry(rows(await transaction.query(`INSERT INTO files.entries (
            id,root_id,parent_id,entry_kind,entry_name,owner_identity_id,created_at,updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [id, sourceEntry.rootId, sourceEntry.id === entryId ? parentId : ids.get(sourceEntry.parentId), sourceEntry.kind, sourceEntry.id === entryId ? name : sourceEntry.name, ownerIdentityId, now]))[0]);
          if (sourceEntry.kind === "file") {
            const sourceVersions = rows(await transaction.query("SELECT * FROM files.versions WHERE file_id=$1 ORDER BY version", [sourceEntry.id])).map(version);
            for (const sourceVersion of sourceVersions) {
              const copiedProvenance = { ...sourceVersion.provenance, copiedFrom: { fileId: sourceEntry.id, version: sourceVersion.version } };
              await transaction.query(`INSERT INTO files.versions (
                file_id,root_id,version,object_id,object_version,byte_size,media_type,sha256,provenance,created_by_identity_id,created_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, [id, sourceEntry.rootId, sourceVersion.version, sourceVersion.objectId, sourceVersion.objectVersion, sourceVersion.size, sourceVersion.mediaType, binaryDigest(sourceVersion.sha256), JSON.stringify(copiedProvenance), ownerIdentityId, now]);
              versionCount += 1; copiedBytes += sourceVersion.size;
            }
          }
          created.push(await loadEntry(transaction, id));
        }
        return { entry: created[0], entryIds: created.map((value) => value.id), versionCount, copiedBytes, root: await loadRoot(transaction, selected.rootId) };
      });
    } catch (error) { throw translated(error); }
  }

  async trashEntry(entryId, { expectedRevision, trashedAt, retentionUntil }) {
    return this.#database.transaction(async (transaction) => {
      const selected = await loadEntry(transaction, entryId, true);
      if (!selected || selected.trashedAt) throw new FileRepositoryError("file_not_found", "File entry is unavailable");
      if (selected.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
      await transaction.query("UPDATE files.entries SET trashed_at=$2,retention_until=$3,revision=revision+1,updated_at=$2 WHERE id=$1", [entryId, trashedAt, retentionUntil]);
      return loadEntry(transaction, entryId);
    });
  }

  async restoreEntry(entryId, { expectedRevision, parentId, now }) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const selected = await loadEntry(transaction, entryId, true);
        if (!selected || !selected.trashedAt) throw new FileRepositoryError("file_not_found", "Recycled file entry is unavailable");
        if (selected.revision !== expectedRevision) throw new FileRepositoryError("file_revision_conflict", "File revision changed");
        await transaction.query("UPDATE files.entries SET parent_id=$2,trashed_at=NULL,retention_until=NULL,revision=revision+1,updated_at=$3 WHERE id=$1", [entryId, parentId, now]);
        return loadEntry(transaction, entryId);
      });
    } catch (error) { throw translated(error); }
  }

  async purgeEntry(entryId, now) {
    return this.#database.transaction(async (transaction) => {
      const selected = await loadEntry(transaction, entryId, true);
      if (!selected || !selected.trashedAt) throw new FileRepositoryError("file_not_found", "Recycled file entry is unavailable");
      const selectedRows = rows(await transaction.query(`WITH RECURSIVE descendants AS (
        SELECT id FROM files.entries WHERE id=$1
        UNION ALL SELECT entry.id FROM files.entries entry JOIN descendants ON entry.parent_id=descendants.id
      ) SELECT id FROM descendants ORDER BY id`, [entryId]));
      const released = rows(await transaction.query(`WITH RECURSIVE descendants AS (
        SELECT id FROM files.entries WHERE id=$1
        UNION ALL SELECT entry.id FROM files.entries entry JOIN descendants ON entry.parent_id=descendants.id
      ) SELECT COALESCE(sum(byte_size),0)::bigint AS released_bytes FROM files.versions WHERE file_id IN (SELECT id FROM descendants)`, [entryId]))[0];
      await transaction.query("DELETE FROM files.entries WHERE id=$1", [entryId]);
      return { entryIds: selectedRows.map((row) => row.id), releasedBytes: Number(released.released_bytes), root: await loadRoot(transaction, selected.rootId) };
    });
  }

  async setAcl(value) {
    return this.#database.transaction(async (transaction) => {
      const found = rows(await transaction.query(`SELECT * FROM files.acl WHERE root_id=$1 AND entry_id IS NOT DISTINCT FROM $2
        AND principal_kind=$3 AND principal_key=$4 FOR UPDATE`, [value.rootId, value.entryId, value.principalKind, value.principalKey]))[0];
      if (found) return acl(rows(await transaction.query(`UPDATE files.acl SET access_role=$2,inherited=$3,expires_at=$4,
        revision=revision+1 WHERE id=$1 RETURNING *`, [found.id, value.role, value.inherited, value.expiresAt]))[0]);
      return acl(rows(await transaction.query(`INSERT INTO files.acl (
        root_id,entry_id,principal_kind,principal_key,access_role,inherited,expires_at,created_by_identity_id,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [value.rootId, value.entryId, value.principalKind, value.principalKey, value.role, value.inherited, value.expiresAt, value.createdByIdentityId, value.createdAt]))[0]);
    });
  }

  async removeAcl({ rootId, entryId, principalKind, principalKey }) {
    return (await this.#database.query("DELETE FROM files.acl WHERE root_id=$1 AND entry_id IS NOT DISTINCT FROM $2 AND principal_kind=$3 AND principal_key=$4 RETURNING id", [rootId, entryId, principalKind, principalKey])).rowCount > 0;
  }

  async listAcl(rootId, entryId = null) { return rows(await this.#database.query("SELECT * FROM files.acl WHERE root_id=$1 AND entry_id IS NOT DISTINCT FROM $2 ORDER BY created_at,id", [rootId, entryId])).map(acl); }

  async accessRole({ rootId, entryId = null, actorIdentityId, teamRoles = {}, now = new Date() }) {
    const selectedRoot = await loadRoot(this.#database, rootId); if (!selectedRoot) return null;
    let role = selectedRoot.scopeKind === "user" && selectedRoot.scopeKey === actorIdentityId ? "owner" : null;
    if (selectedRoot.scopeKind === "team" && teamRoles[selectedRoot.scopeKey]) role = ({ owner: "owner", manager: "manager", member: "editor", guest: "viewer" })[teamRoles[selectedRoot.scopeKey]] ?? null;
    const teamKeys = Object.keys(teamRoles);
    const grants = rows(await this.#database.query(`WITH RECURSIVE targets AS (
        SELECT id,parent_id,0 AS depth FROM files.entries WHERE id=$2 AND root_id=$1
        UNION ALL SELECT entry.id,entry.parent_id,targets.depth+1
        FROM files.entries entry JOIN targets ON entry.id=targets.parent_id
      ), matching AS (
        SELECT acl.* FROM files.acl acl
        WHERE acl.root_id=$1 AND acl.entry_id IS NULL
        UNION ALL
        SELECT acl.* FROM files.acl acl JOIN targets ON targets.id=acl.entry_id
        WHERE targets.depth=0 OR acl.inherited
      ) SELECT * FROM matching WHERE (expires_at IS NULL OR expires_at>$5)
        AND ((principal_kind='identity' AND principal_key=$3)
          OR (principal_kind='team' AND principal_key=ANY($4::text[])))`, [rootId, entryId, actorIdentityId, teamKeys, now]));
    for (const value of grants.map(acl)) if (!role || ROLE_RANK[value.role] > ROLE_RANK[role]) role = value.role;
    return role;
  }

  async createShare(value) {
    return share(rows(await this.#database.query(`INSERT INTO files.shares (
      root_id,entry_id,principal_kind,principal_key,access_role,expires_at,created_by_identity_id,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [value.rootId, value.entryId, value.principalKind, value.principalKey, value.role, value.expiresAt, value.createdByIdentityId, value.createdAt]))[0]);
  }
  async findShare(shareId) { return share(rows(await this.#database.query("SELECT * FROM files.shares WHERE id=$1", [shareId]))[0]); }
  async listShares(entryId) { return rows(await this.#database.query("SELECT * FROM files.shares WHERE entry_id=$1 ORDER BY created_at,id", [entryId])).map(share); }
  async listReceivedShares({ actorIdentityId, teamRoles = {}, now }) {
    return rows(await this.#database.query(`SELECT * FROM files.shares
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3)
        AND ((principal_kind='identity' AND principal_key=$1)
          OR (principal_kind='team' AND principal_key=ANY($2::text[])))
      ORDER BY created_at DESC,id`, [actorIdentityId, Object.keys(teamRoles), now])).map(share);
  }
  async revokeShare(shareId, now) { return share(rows(await this.#database.query("UPDATE files.shares SET revoked_at=$2,revision=revision+1 WHERE id=$1 AND revoked_at IS NULL RETURNING *", [shareId, now]))[0]); }

  async search(rootId, query, { includeTrashed = false, limit = 100 } = {}) {
    return rows(await this.#database.query(`SELECT candidate.*, current_file.byte_size, current_file.media_type
      FROM files.entries candidate LEFT JOIN files.versions current_file
        ON current_file.file_id=candidate.id AND current_file.version=candidate.current_version
      WHERE candidate.root_id=$1 AND lower(candidate.entry_name) LIKE '%'||lower($2)||'%'
        AND ($3::boolean OR NOT EXISTS (
          WITH RECURSIVE ancestors AS (
            SELECT id,parent_id,trashed_at FROM files.entries WHERE id=candidate.id
            UNION ALL SELECT entry.id,entry.parent_id,entry.trashed_at
            FROM files.entries entry JOIN ancestors ON entry.id=ancestors.parent_id
          ) SELECT 1 FROM ancestors WHERE trashed_at IS NOT NULL
        )) ORDER BY lower(candidate.entry_name),candidate.id LIMIT $4`, [rootId, query, includeTrashed, limit])).map(entry);
  }

  async quota(rootId) {
    const selected = await loadRoot(this.#database, rootId);
    return selected ? { rootId, quotaBytes: selected.quotaBytes, usedBytes: selected.usedBytes, availableBytes: selected.quotaBytes - selected.usedBytes } : null;
  }
}
