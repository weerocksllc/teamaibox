// Real PostgreSQL semantics, synthetic temporary tables only. No user writes.
import assert from 'node:assert/strict';
import { createPostgresDatabaseFromEnvironment } from '../packages/persistence/src/postgres-database.mjs';
import { PostgresFileRepository } from '../services/object-service/src/postgres-file-repository.mjs';
const db = await createPostgresDatabaseFromEnvironment(process.env);
const root = '018f6f18-24d7-7c21-9b62-8c0174199501';
const file = '018f6f18-24d7-7c21-9b62-8c0174199502';
const folder = '018f6f18-24d7-7c21-9b62-8c0174199503';
try {
  const result = await db.transaction(async tx => {
    await tx.query('CREATE TEMP TABLE drive_entries (LIKE files.entries INCLUDING DEFAULTS) ON COMMIT DROP');
    await tx.query('CREATE TEMP TABLE drive_versions (LIKE files.versions INCLUDING DEFAULTS) ON COMMIT DROP');
    await tx.query(`INSERT INTO drive_entries(id,root_id,parent_id,entry_kind,entry_name,owner_identity_id,current_version)
      VALUES ($1,$3,NULL,'file','验收文件.txt',$3,2),($2,$3,NULL,'folder','验收文件夹',$3,0)`, [file, folder, root]);
    await tx.query(`INSERT INTO drive_versions(file_id,root_id,version,object_id,object_version,byte_size,media_type,sha256,provenance,created_by_identity_id)
      VALUES ($1,$2,1,$1,1,20,'image/png',$3,'{}',$2),($1,$2,2,$1,2,228,'text/plain',$3,'{}',$2)`, [file, root, Buffer.alloc(32, 7)]);
    let queries = 0;
    const query = async (sql, params) => {
      queries++;
      return tx.query(sql.replaceAll('files.entries', 'pg_temp.drive_entries').replaceAll('files.versions', 'pg_temp.drive_versions'), params);
    };
    const repository = new PostgresFileRepository({ database: { query, transaction: callback => callback({ query }) } });
    assert.equal((await repository.findEntry(file)).size, 228);
    let before = queries;
    const listing = await repository.listChildren(root, null);
    assert.equal(queries - before, 1);
    assert.equal(listing.find(e => e.id === file).size, 228);
    assert.equal(listing.find(e => e.id === folder).size, null);
    before = queries;
    const search = await repository.search(root, '验收');
    assert.equal(queries - before, 1);
    assert.equal(search.find(e => e.id === file).mediaType, 'text/plain');
    // PostgreSQL must lock only the non-nullable entry side of the LEFT JOIN.
    const moved = await repository.moveEntry(file, { parentId: null, name: '改名.txt', expectedRevision: 1, now: new Date() });
    assert.equal(moved.size, 228);
    const trashed = await repository.trashEntry(file, { expectedRevision: moved.revision, trashedAt: new Date(), retentionUntil: new Date(Date.now()+1000) });
    assert.equal(trashed.size, 228);
    assert.equal((await repository.search(root, '改名')).length, 0);
    const restored = await repository.restoreEntry(file, { expectedRevision: trashed.revision, parentId: null, now: new Date() });
    assert.equal(restored.mediaType, 'text/plain');
    return { status: 'passed', latestVersionOnly: true, foldersHaveNoSize: true, singleQueryListAndSearch: true, lockAndMutationPassed: true, userTablesChanged: false };
  });
  assert.equal((await db.query("SELECT to_regclass('pg_temp.drive_entries') AS value")).rows[0].value, null);
  console.log(JSON.stringify({ ...result, temporaryTablesRemoved: true }));
} finally { await db.close(); }
