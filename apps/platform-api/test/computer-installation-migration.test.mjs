import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Optional isolated PostgreSQL/WASM fixture, never connects to a product DB.
// TEAMAIBOX_INSTALLATION_PGLITE_MODULE points to a locally installed module.
test('installation migration preserves legacy rows and enforces owner/media/boot constraints', {
  skip: !process.env.TEAMAIBOX_INSTALLATION_PGLITE_MODULE,
}, async () => {
  const {PGlite} = await import(pathToFileURL(process.env.TEAMAIBOX_INSTALLATION_PGLITE_MODULE));
  const db = new PGlite();
  const up = await readFile(new URL('../../../packages/persistence/migrations/000112_computer_installation_media.up.sql', import.meta.url), 'utf8');
  const down = await readFile(new URL('../../../packages/persistence/migrations/000112_computer_installation_media.down.sql', import.meta.url), 'utf8');
  const owner=randomUUID(),other=randomUUID(),computer=randomUUID(),object=randomUUID(),media=randomUUID(),foreign=randomUUID();
  try {
    await db.exec(`CREATE SCHEMA iam; CREATE SCHEMA platform; CREATE SCHEMA objects;
      CREATE TABLE iam.identities(id uuid PRIMARY KEY);
      CREATE TABLE objects.object_entries(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE objects.object_versions(object_id uuid,version integer,PRIMARY KEY(object_id,version));
      CREATE TABLE platform.computers(id uuid PRIMARY KEY,owner_id uuid REFERENCES iam.identities(id),
        volume_id uuid,firmware_id uuid,tpm_id uuid,profile jsonb,run jsonb,UNIQUE(id,owner_id));`);
    await db.query('INSERT INTO iam.identities VALUES ($1),($2)',[owner,other]);
    await db.query(`INSERT INTO platform.computers VALUES($1,$2,$3,$4,$5,$6,$7)`,[
      computer,owner,randomUUID(),randomUUID(),randomUUID(),{mediaDigest:'sha256:'+'f'.repeat(64)}, {id:randomUUID(),containerId:'a'.repeat(64)}]);
    const before=(await db.query('SELECT * FROM platform.computers')).rows;
    await db.exec(up);
    await db.exec(down); // Only a never-used schema supports removal.
    await db.exec(up);
    assert.deepEqual((await db.query('SELECT * FROM platform.computers')).rows,before);
    assert.equal((await db.query('SELECT * FROM platform.computer_installations')).rows.length,0);
    await db.query('INSERT INTO objects.object_versions VALUES ($1,1)',[object]);
    await db.query('INSERT INTO objects.object_entries VALUES ($1,NULL)',[object]);
    const insert=async(id,owned,key)=>db.query(`INSERT INTO platform.computer_installation_media
      (id,owner_id,request_key,request_fingerprint,name,source,state,object_id,object_version,digest,size_bytes,compatibility)
      VALUES($1,$2,$3,$4,'system.iso','{"kind":"upload"}','ready',$5,1,$6,$7,'arm64')`,
      [id,owned,key,'a'.repeat(64),object,'sha256:'+'b'.repeat(64),16*1024**3]);
    await insert(media,owner,'first');await insert(foreign,other,'first');
    await assert.rejects(db.query('UPDATE objects.object_entries SET deleted_at=now() WHERE id=$1',[object]),/still referenced/);
    await assert.rejects(insert(randomUUID(),owner,'first'),/unique/);
    await assert.rejects(db.query(`INSERT INTO platform.computer_installations(computer_id,owner_id,desired_media_id)
      VALUES($1,$2,$3)`,[computer,owner,foreign]),/not ready or owned/);
    await db.query(`INSERT INTO platform.computer_installations(computer_id,owner_id,desired_media_id,observed_media_id)
      VALUES($1,$2,$3,$3)`,[computer,owner,media]);
    await assert.rejects(db.query(`UPDATE platform.computer_installation_media SET state='deleted',revision=revision+1 WHERE id=$1`,[media]),/still in use/);
    await assert.rejects(db.query(`UPDATE platform.computer_installation_media SET digest=$2,revision=revision+1 WHERE id=$1`,[media,'sha256:'+'c'.repeat(64)]),/immutable/);
    await assert.rejects(db.query('DELETE FROM objects.object_versions WHERE object_id=$1',[object]),/foreign key/);
    const boot=randomUUID();
    await db.query(`UPDATE platform.computer_installations SET boot_request_id=$2,boot_media_id=$3,
      boot_generation=1,boot_state='consumed',revision=revision+1 WHERE computer_id=$1`,[computer,boot,media]);
    await assert.rejects(db.query(`UPDATE platform.computer_installations SET boot_state='pending',revision=revision+1 WHERE computer_id=$1`,[computer]),/cannot be replayed/);
    await db.query(`UPDATE platform.computer_installations SET desired_media_id=NULL,observed_media_id=NULL,
      revision=revision+1 WHERE computer_id=$1`,[computer]);
    await db.query(`UPDATE platform.computer_installation_media SET state='deleted',object_id=NULL,object_version=NULL,
      revision=revision+1 WHERE id=$1`,[media]);
    await assert.rejects(db.exec(down),/cannot remove persisted/);
    assert.deepEqual((await db.query('SELECT * FROM platform.computers')).rows,before);
  } finally { await db.close(); }
});
