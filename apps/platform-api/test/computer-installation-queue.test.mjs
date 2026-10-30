import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {PostgresInstallationMediaRepository} from '../src/virtual-computers/postgres-installation-media-repository.mjs';
import {InstallationMediaService} from '../src/virtual-computers/installation-media-service.mjs';
import {InstallationMediaWorker} from '../src/virtual-computers/installation-media-worker.mjs';
import {VirtualComputerHttpApi} from '../src/virtual-computers/virtual-computer-http-api.mjs';

test('media HTTP flow persists one import, fences stale workers, protects in-use media and releases only its own object',{
  skip:!process.env.TEAMAIBOX_INSTALLATION_PGLITE_MODULE,
},async()=>{
  const {PGlite}=await import(pathToFileURL(process.env.TEAMAIBOX_INSTALLATION_PGLITE_MODULE));
  const db=new PGlite();
  const owner=randomUUID(),other=randomUUID(),object=randomUUID(),computer=randomUUID();
  try{
    await db.exec(`CREATE SCHEMA iam; CREATE SCHEMA objects; CREATE SCHEMA platform;
      CREATE TABLE iam.identities(id uuid PRIMARY KEY,status text);
      CREATE TABLE objects.object_entries(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE objects.object_versions(object_id uuid,version integer,PRIMARY KEY(object_id,version));
      CREATE TABLE platform.computers(id uuid PRIMARY KEY,owner_id uuid,UNIQUE(id,owner_id));`);
    await db.query("INSERT INTO iam.identities VALUES($1,'active'),($2,'active')",[owner,other]);
    await db.query('INSERT INTO objects.object_entries VALUES($1,NULL)',[object]);
    await db.query('INSERT INTO objects.object_versions VALUES($1,1)',[object]);
    await db.query('INSERT INTO platform.computers VALUES($1,$2)',[computer,owner]);
    await db.exec(await readFile(new URL('../../../packages/persistence/migrations/000112_computer_installation_media.up.sql',import.meta.url),'utf8'));
    const repository=new PostgresInstallationMediaRepository({database:db});
    const directory={authorization:async()=>({permissions:['computer:use','file:read'],teamMemberships:[]})};
    let sourceCalls=0,releaseCalls=0;
    const transfer={source:async({input})=>{sourceCalls++;return {kind:'drive',fileId:input.fileId,version:1,
      objectId:object,objectVersion:1,size:184320,digest:'sha256:'+'a'.repeat(64)};},
      prepare:async({onProgress})=>{await onProgress(184320);return {objectId:object,objectVersion:1,size:184320,digest:'sha256:'+'a'.repeat(64),compatibility:'arm64'};},
      release:async media=>{releaseCalls++;assert.equal(media.objectId,object);}};
    const service=new InstallationMediaService({repository,directory,transfer});
    const worker=new InstallationMediaWorker({repository,directory,transfer});
    const api=new VirtualComputerHttpApi({service:Object.fromEntries(['availability','list','get','getOperation','create','action'].map(k=>[k,()=>{throw Error('unrelated VM action');}])),mediaService:service});
    const root='/api/v1/virtual-computers/installation-media',key=randomUUID(),input={source:'drive',name:'Linux.iso',fileId:randomUUID(),version:1};
    const call=(method,pathname,body,identityId=owner)=>api.handle({method,pathname,context:{identityId},body,headers:{'idempotency-key':key}});
    const created=(await call('POST',root,input)).body;
    assert.equal(created.state,'preparing');
    assert.deepEqual((await call('POST',root,input)).body,created);assert.equal(sourceCalls,1);
    await assert.rejects(call('POST',root,{...input,name:'different.iso'}),{code:'computer_idempotency_conflict'});
    const path=root+'/'+created.id;
    await assert.rejects(call('GET',path,null,other),{code:'computer_media_not_found'});
    assert.equal((await call('GET',root,null,other)).body.data.length,0);
    const claim=await repository.claimNext({leaseMs:30000});
    assert.equal(await repository.claimNext({leaseMs:30000}),null);
    await db.query(`UPDATE platform.computer_installation_media SET claimed_until=clock_timestamp()-interval '1 second',revision=revision+1 WHERE id=$1`,[created.id]);
    assert.equal(await repository.renew(claim,{leaseMs:30000}),false);
    assert.equal(await repository.progress(claim,100),false);
    assert.equal((await worker.runOnce()).state,'ready');
    await assert.rejects(repository.complete(claim,await transfer.prepare({onProgress:async()=>{}})),{code:'computer_claim_lost'});
    const ready=(await call('GET',path)).body;
    assert.equal(ready.copiedBytes,184320);assert.equal(ready.compatibility,'arm64');assert.equal(ready.objectId,undefined);
    await assert.rejects(call('DELETE',path,{confirmDelete:true,expectedRevision:1}),{code:'computer_state_conflict'});
    await db.query('INSERT INTO platform.computer_installations(computer_id,owner_id,desired_media_id,observed_media_id) VALUES($1,$2,$3,$3)',[computer,owner,created.id]);
    await assert.rejects(call('DELETE',path,{confirmDelete:true,expectedRevision:ready.revision}),{code:'computer_media_in_use'});
    await db.query('UPDATE platform.computer_installations SET desired_media_id=NULL,observed_media_id=NULL,revision=revision+1 WHERE computer_id=$1',[computer]);
    assert.equal((await call('DELETE',path,{confirmDelete:true,expectedRevision:ready.revision})).body.state,'deleting');
    assert.equal((await worker.runOnce()).state,'deleted');assert.equal(releaseCalls,1);
    assert.equal((await call('DELETE',path,{confirmDelete:true,expectedRevision:ready.revision})).body.state,'deleted');
    assert.equal((await worker.runOnce()).processed,0);
    assert.equal((await db.query('SELECT * FROM platform.computers')).rows.length,1);
  }finally{await db.close();}
});
