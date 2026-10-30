// Run inside the object-service image. Synthetic temporary tables only; no user
// table writes, blobs or credentials are printed or retained.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresDatabaseFromEnvironment } from '/opt/teamaibox/packages/persistence/src/postgres-database.mjs';
import { PostgresObjectRepository } from '/opt/teamaibox/services/object-service/src/postgres-object-repository.mjs';
const db = await createPostgresDatabaseFromEnvironment(process.env);
try {
  const result = await db.transaction(async tx => {
    await tx.query(`CREATE TEMP TABLE page_entries (id uuid PRIMARY KEY, namespace_key text,
      object_key text, deleted_at timestamptz, purge_after timestamptz, created_at timestamptz) ON COMMIT DROP`);
    await tx.query(`CREATE TEMP TABLE page_versions (object_id uuid, version integer, blob_key text,
      size bigint, sha256 bytea, content_type text, created_at timestamptz, created_by_identity_id uuid,
      PRIMARY KEY(object_id,version)) ON COMMIT DROP`);
    await tx.query(`INSERT INTO page_entries SELECT md5(i::text)::uuid,'user:page-test',
      'reports/'||lpad(i::text,5,'0')||CASE i%3 WHEN 0 THEN '中文' WHEN 1 THEN 'é' ELSE '😀' END,
      NULL,NULL,'2026-09-01'::timestamptz FROM generate_series(1,1203) i`);
    await tx.query(`INSERT INTO page_versions SELECT id,v,'objects/synthetic-'||v,9,$1,'text/plain',
      '2026-09-02'::timestamptz,id FROM page_entries CROSS JOIN generate_series(1,3) v`, [Buffer.alloc(32,7)]);
    await tx.query("UPDATE page_entries SET deleted_at=now() WHERE object_key LIKE 'reports/00002%'");
    await tx.query("UPDATE page_entries SET namespace_key='user:other' WHERE object_key LIKE 'reports/00003%'");
    await tx.query("UPDATE page_entries SET object_key='excluded' WHERE object_key LIKE 'reports/00004%'");
    let queries=0, maxRows=0;
    const repository = new PostgresObjectRepository({ database: { transaction() { assert.fail(); },
      async query(sql, params) {
        queries++; const result=await tx.query(sql.replaceAll('objects.object_entries','pg_temp.page_entries')
          .replaceAll('objects.object_versions','pg_temp.page_versions'),params);
        maxRows=Math.max(maxRows,result.rows.length); return result;
      } } });
    const keys=[]; let after='', pages=0;
    for (;;) {
      const rows=await repository.listObjects('user:page-test',{prefix:'reports/',after,limit:101});
      assert(rows.length<=101); assert(rows.every(r=>r.versions.length===1&&r.versions[0].version===3));
      const page=rows.slice(0,100); keys.push(...page.map(r=>r.objectKey)); pages++;
      if (rows.length<=100) break;
      after=page.at(-1).objectKey; assert(pages<15);
    }
    assert.equal(keys.length,1200); assert.equal(new Set(keys).size,1200); assert.equal(queries,pages);
    const expected=(await tx.query("SELECT object_key FROM page_entries WHERE namespace_key='user:page-test' AND deleted_at IS NULL AND object_key LIKE 'reports/%' ORDER BY object_key")).rows.map(r=>r.object_key);
    assert.deepEqual(keys,expected);
    return {status:'passed',objects:keys.length,pages,queries,maxRows,latestVersionOnly:true,
      temporaryTablesOnly:true,resultDigest:'sha256:'+createHash('sha256').update(JSON.stringify(keys)).digest('hex')};
  });
  assert.equal((await db.query("SELECT to_regclass('pg_temp.page_entries') AS entries, to_regclass('pg_temp.page_versions') AS versions")).rows[0].entries,null);
  console.log(JSON.stringify({...result,temporaryTablesRemoved:true}));
} finally { await db.close(); }
