import assert from "node:assert/strict";
import test from "node:test";

import { PostgresFileRepository } from "../src/postgres-file-repository.mjs";

const ROOT = "018f6f18-24d7-7c21-9b62-8c0174199501";
const FILE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const OWNER = "018f6f18-24d7-7c21-9b62-8c0174199503";
const MEMBER = "018f6f18-24d7-7c21-9b62-8c0174199504";
const OBJECT = "018f6f18-24d7-7c21-9b62-8c0174199505";
const NOW = "2026-08-11T07:00:00.000Z";
const hash = Buffer.from("a".repeat(64), "hex");

const rootRow = { id: ROOT, scope_kind: "team", scope_key: "team.product", quota_bytes: "1000", used_bytes: "20", revision: "2", created_by_identity_id: OWNER, created_at: NOW, updated_at: NOW };
const entryRow = { id: FILE, root_id: ROOT, parent_id: null, entry_kind: "file", entry_name: "report.txt", owner_identity_id: OWNER, current_version: "1", revision: "1", created_at: NOW, updated_at: NOW, trashed_at: null, retention_until: null };
const versionRow = { file_id: FILE, root_id: ROOT, version: "1", object_id: OBJECT, object_version: "3", byte_size: "20", media_type: "text/plain", sha256: hash, provenance: { source: "agent" }, created_by_identity_id: OWNER, created_at: NOW };

function database(resolver) {
  const calls = [];
  const adapter = {
    async query(sql, values = []) { calls.push({ sql, values }); return resolver(sql, values, calls.length); },
    async transaction(callback) { calls.push({ sql: "BEGIN", values: [] }); return callback(adapter); },
  };
  return { adapter, calls };
}

test("object references resolve exact stored versions without depending on the current version", async () => {
  const value = database((sql, values) => {
    assert.match(sql, /stored\.file_id=candidate\.id/);
    assert.match(sql, /stored\.object_id=\$1 AND stored\.object_version=\$2/);
    assert.doesNotMatch(sql, /stored\.version=candidate\.current_version/);
    assert.deepEqual(values, [OBJECT, 3]);
    return { rows: [entryRow] };
  });
  const repository = new PostgresFileRepository({ database: value.adapter });
  assert.equal((await repository.entriesForObjectVersion(OBJECT, 3))[0].id, FILE);
});

test("PostgreSQL root creation is idempotent and projects numeric quota facts", async () => {
  const value = database((sql) => sql.includes("SELECT * FROM files.roots") ? { rows: [rootRow] } : { rows: [], rowCount: 1 });
  const repository = new PostgresFileRepository({ database: value.adapter });
  const created = await repository.createRoot({ scopeKind: "team", scopeKey: "team.product", quotaBytes: 1000, createdByIdentityId: OWNER, createdAt: new Date(NOW), updatedAt: new Date(NOW) });
  assert.equal(created.usedBytes, 20);
  assert.equal(created.quotaBytes, 1000);
  assert.match(value.calls[1].sql, /ON CONFLICT \(scope_kind,scope_key\) DO NOTHING/);
  assert.match(value.calls[2].sql, /FOR UPDATE/);
});

test("PostgreSQL file creation commits metadata and immutable object facts in one transaction", async () => {
  const value = database((sql) => {
    if (sql.includes("INSERT INTO files.entries")) return { rows: [{ ...entryRow, current_version: "0" }] };
    if (sql.includes("INSERT INTO files.versions")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT candidate.*")) return { rows: [{ ...entryRow, byte_size: "20", media_type: "text/plain" }] };
    if (sql.includes("SELECT * FROM files.versions")) return { rows: [versionRow] };
    if (sql.includes("SELECT * FROM files.roots")) return { rows: [rootRow] };
    throw new Error("unexpected SQL");
  });
  const repository = new PostgresFileRepository({ database: value.adapter });
  const committed = await repository.createFile({
    entry: { rootId: ROOT, parentId: null, name: "report.txt", ownerIdentityId: OWNER, createdAt: new Date(NOW), updatedAt: new Date(NOW) },
    version: { objectId: OBJECT, objectVersion: 3, size: 20, mediaType: "text/plain", sha256: `sha256:${"a".repeat(64)}`, provenance: { source: "agent" }, createdByIdentityId: OWNER, createdAt: new Date(NOW) },
  });
  assert.equal(committed.entry.currentVersion, 1);
  assert.equal(committed.entry.size, 20);
  assert.equal(committed.entry.mediaType, "text/plain");
  assert.equal(committed.version.objectId, OBJECT);
  const insert = value.calls.find((call) => call.sql.includes("INSERT INTO files.versions"));
  assert.equal(Buffer.compare(insert.values[6], hash), 0);
  assert.ok(!JSON.stringify(insert.values).includes("referenceId"));
});

test("PostgreSQL append rejects a stale metadata revision before inserting", async () => {
  const value = database((sql) => sql.includes("SELECT candidate.*") ? { rows: [{ ...entryRow, revision: "4" }] } : { rows: [] });
  const repository = new PostgresFileRepository({ database: value.adapter });
  await assert.rejects(repository.appendVersion(FILE, { objectId: OBJECT, objectVersion: 3, size: 20, mediaType: "text/plain", sha256: `sha256:${"a".repeat(64)}`, provenance: {}, createdByIdentityId: OWNER, createdAt: new Date(NOW) }, 3), { code: "file_revision_conflict" });
  assert.equal(value.calls.some((call) => call.sql.includes("INSERT INTO files.versions")), false);
  assert.match(value.calls.find((call) => call.sql.includes("SELECT candidate.*")).sql, /FOR UPDATE OF candidate/);
});

test("empty files retain a zero-byte size rather than an unknown size", async () => {
  const repository = new PostgresFileRepository({ database: {
    query: async () => ({ rows: [{ ...entryRow, byte_size: '0', media_type: 'text/plain' }] }),
    transaction: async () => { throw new Error('unexpected write'); },
  } });
  assert.equal((await repository.findEntry(FILE)).size, 0);
});

test("PostgreSQL effective access combines root membership with unexpired inherited ACLs", async () => {
  const aclRow = { id: "018f6f18-24d7-7c21-9b62-8c0174199510", root_id: ROOT, entry_id: FILE, principal_kind: "identity", principal_key: MEMBER, access_role: "viewer", inherited: true, expires_at: null, revision: "1", created_by_identity_id: OWNER, created_at: NOW };
  const value = database((sql) => sql.includes("SELECT * FROM files.roots") ? { rows: [rootRow] } : sql.includes("WITH RECURSIVE targets") ? { rows: [aclRow] } : { rows: [] });
  const repository = new PostgresFileRepository({ database: value.adapter });
  assert.equal(await repository.accessRole({ rootId: ROOT, entryId: FILE, actorIdentityId: MEMBER, teamRoles: {}, now: new Date(NOW) }), "viewer");
  const query = value.calls.find((call) => call.sql.includes("WITH RECURSIVE targets"));
  assert.match(query.sql, /expires_at IS NULL OR expires_at>\$5/);
  assert.deepEqual(query.values.slice(0, 4), [ROOT, FILE, MEMBER, []]);
});

test("PostgreSQL search excludes entries under recycled ancestors", async () => {
  const value = database((sql) => sql.includes("SELECT candidate") ? { rows: [entryRow] } : { rows: [] });
  const repository = new PostgresFileRepository({ database: value.adapter });
  assert.equal((await repository.search(ROOT, "report", { limit: 20 }))[0].id, FILE);
  assert.match(value.calls[0].sql, /WITH RECURSIVE ancestors/);
  assert.match(value.calls[0].sql, /trashed_at IS NOT NULL/);
});

test("PostgreSQL repository requires a transactional adapter", () => {
  assert.throws(() => new PostgresFileRepository({ database: { query() {} } }), /requires transactions/);
});

test("received share query is bound to the actor, current teams and expiry without an arbitrary result cap", async () => {
  const value = database(() => ({ rows: [] }));
  const repository = new PostgresFileRepository({ database: value.adapter });
  assert.deepEqual(await repository.listReceivedShares({ actorIdentityId: MEMBER, teamRoles: { "team.review": "member" }, now: new Date(NOW) }), []);
  assert.deepEqual(value.calls[0].values, [MEMBER, ["team.review"], new Date(NOW)]);
  assert.match(value.calls[0].sql, /revoked_at IS NULL/);
  assert.match(value.calls[0].sql, /expires_at > \$3/);
  assert.match(value.calls[0].sql, /principal_kind='identity' AND principal_key=\$1/);
  assert.match(value.calls[0].sql, /principal_kind='team' AND principal_key=ANY\(\$2::text\[\]\)/);
  assert.doesNotMatch(value.calls[0].sql, /LIMIT/);
});

test("entry, folder listing and search join only the current version in one query", async () => {
  const value = database(() => ({ rows: [
    { ...entryRow, current_version: "2", byte_size: "228", media_type: "text/plain" },
    { ...entryRow, id: ROOT, entry_kind: "folder", current_version: "0", byte_size: null, media_type: null },
  ] }));
  const repository = new PostgresFileRepository({ database: value.adapter });
  assert.equal((await repository.findEntry(FILE)).size, 228);
  for (const result of [await repository.listChildren(ROOT, null), await repository.search(ROOT, "report")]) {
    assert.equal(result[0].size, 228);
    assert.equal(result[0].mediaType, "text/plain");
    assert.equal(result[1].size, null);
    assert.equal(result[1].mediaType, null);
  }
  assert.equal(value.calls.length, 3);
  for (const call of value.calls) {
    assert.match(call.sql, /LEFT JOIN files\.versions current_file/);
    assert.match(call.sql, /current_file\.file_id=candidate\.id AND current_file\.version=candidate\.current_version/);
    assert.ok(!call.sql.includes("object_id"));
  }
});
