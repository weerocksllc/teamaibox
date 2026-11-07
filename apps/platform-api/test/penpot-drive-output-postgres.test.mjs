import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PostgresDatabase} from '../../../packages/persistence/src/postgres-database.mjs';
import {PostgresFileRepository} from '../../../services/object-service/src/postgres-file-repository.mjs';
import {PostgresObjectRepository} from '../../../services/object-service/src/postgres-object-repository.mjs';
import {PostgresEnvelopeMetadataRepository} from '../../../services/object-service/src/postgres-envelope-metadata-repository.mjs';
import {PostgresArtifactProvenanceRepository} from '../../../services/object-service/src/postgres-artifact-provenance-repository.mjs';
import {PostgresObjectGrantRepository} from '../../../services/object-service/src/postgres-object-grant-repository.mjs';
import {MemoryBlobStore} from '../../../services/object-service/src/memory-blob-store.mjs';
import {MemoryVersionedEnvelopeKeyring} from '../../../services/object-service/src/envelope-keyring.mjs';
import {EnvelopeEncryptedBlobStore} from '../../../services/object-service/src/envelope-encrypted-blob-store.mjs';
import {ProtectedObjectService} from '../../../services/object-service/src/object-service.mjs';
import {ArtifactProvenanceService} from '../../../services/object-service/src/artifact-provenance-service.mjs';
import {TeamDriveService} from '../../../services/object-service/src/team-drive-service.mjs';
import {TeamDriveArtifactHandoff} from '../../../services/object-service/src/team-drive-artifact-handoff.mjs';
import {PenpotDriveOutput} from '../src/design/penpot-drive-output.mjs';
import {PenpotDriveInput} from '../src/design/penpot-drive-input.mjs';
import {penpotDerivedObjectAccess} from '../src/design/penpot-derived-object-access.mjs';

const url=process.env.TEAMAIBOX_PENPOT_TEST_DATABASE_URL;
test('a real Drive commit recovers its exact version after a lost acknowledgement without replay',{
  skip:!url&&'Requires an explicitly supplied empty disposable PostgreSQL database',timeout:60000,
},async t=>{
  const {default:pg}=await import('../../../packages/persistence/node_modules/pg/lib/index.js');
  const database=new PostgresDatabase({pool:new pg.Pool({connectionString:url,max:4})});t.after(()=>database.close());
  assert.equal((await database.query(`SELECT count(*)::int AS count FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema')`)).rows[0].count,0,'Existing data is never used');
  const migrations=new URL('../../../packages/persistence/migrations/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',migrations)));
  for(const row of manifest.migrations.filter(row=>row.version<=122)){
    const sql=await readFile(new URL(row.up,migrations),'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'),row.upSha256);await database.query(sql);
  }
  const identityId=randomUUID();
  await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
    VALUES ($1,'local_user',$2,$2,'Synthetic designer','fixture')`,[identityId,'design-'+identityId]);
  const keyring=new MemoryVersionedEnvelopeKeyring(randomBytes(32));t.after(()=>keyring.close());
  const objects=new ProtectedObjectService({repository:new PostgresObjectRepository({database}),
    blobStore:new EnvelopeEncryptedBlobStore({rawStore:new MemoryBlobStore(),keyring,
      metadataRepository:new PostgresEnvelopeMetadataRepository({database})}),
    grantRepository:new PostgresObjectGrantRepository({database}),referenceSigningKey:randomBytes(32)});
  const objectGateway=objects.createObjectHandoffGateway();
  const provenanceService=new ArtifactProvenanceService({repository:new PostgresArtifactProvenanceRepository({database}),objectGateway});
  const drive=new TeamDriveService({repository:new PostgresFileRepository({database}),
    artifactHandoff:new TeamDriveArtifactHandoff({provenanceService}),objectReferences:{
      resolve:input=>objectGateway.resolve(input),
      issueReadReference:input=>objectGateway.issue({...input,operations:['head','read','range']}),
    }});
  const owner={actorIdentityId:identityId,permissions:['file:write','file:read'],teamRoles:{}},currentActor=async()=>owner;
  const root=await drive.createRoot(owner,{scopeKind:'user',scopeKey:identityId,quotaBytes:4096});
  const fileId=randomUUID(),pageId=randomUUID(),objectId=randomUUID(),profileId=randomUUID();
  let revoked=false;
  objects.setDesignReadAuthorization(penpotDerivedObjectAccess({database,
    teamDirectory:{async activeProfile(actor){assert.equal(actor,identityId);return profileId;}},
    nativePermissions:{async check(target){
      assert.deepEqual(target,{profileId,fileId,pageId});
      if(revoked)throw Error('No longer a member of the source design');
      return {canRead:true};
    }},
  }));
  let renders=0,checks=0,writes=0,denyCommit=false;
  // Only the renderer is synthetic; the object store metadata, encryption,
  // references, provenance, Drive ACL and PostgreSQL commit are real.
  const bytes=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
  const pdf=Buffer.from('%PDF-1.7\n%%EOF\n');
  const output=new PenpotDriveOutput({database,objectGateway,provenanceService,nativeExporter:{
    async exportSaved({source}){renders++;return {...source,bytes:Buffer.from(source.format==='pdf'?pdf:bytes)};},
    async checkSaved(){checks++;if(denyCommit&&checks%2===0)throw Error('Source revision changed before commit');},
  },teamDrive:{
    authorizeDesignDestination:drive.authorizeDesignDestination.bind(drive),versions:drive.versions.bind(drive),
    async commitDesignExport(...input){writes++;await drive.commitDesignExport(...input);throw Error('Synthetic lost COMMIT acknowledgement');},
  }});
  const source={fileId,pageId,objectId,revision:5,format:'png'};
  const target={rootId:root.id,name:'example.png'};
  const initial={operationId:randomUUID(),source,target,currentActor};
  assert.deepEqual(await output.save({...initial,observeOnly:true}),{operationId:initial.operationId,state:'not_started'});
  assert.equal(renders,0);
  const saved=await output.save(initial);
  assert.equal(saved.state,'complete');assert.equal(saved.version,1);
  assert.deepEqual(await output.save(initial),saved);assert.equal(writes,1);assert.equal(renders,1);
  await assert.rejects(output.save({...initial,source:{...source,revision:6}}),{status:409});
  await assert.rejects(output.save({...initial,operationId:randomUUID()}),{code:'file_name_conflict'});
  assert.equal((await drive.versions(owner,saved.fileId)).length,1);
  const fixed=(await drive.versions(owner,saved.fileId))[0];
  assert.equal(fixed.provenance.clientAnnotations.source.revision,5);
  const folder=await drive.list(owner,root.id);
  const selected=folder.find(row=>row.id===saved.fileId);
  const replace={operationId:randomUUID(),source:{...source,revision:6},currentActor,
    target:{rootId:root.id,fileId:saved.fileId,expectedRevision:selected.revision}};
  assert.equal((await output.save(replace)).version,2);
  await assert.rejects(output.save({...replace,operationId:randomUUID()}),{code:'file_revision_conflict'});
  const adapter=new PenpotDriveInput({teamDrive:drive,objectGateway});
  const old=await adapter.read({fileId:saved.fileId,version:1,format:'image/png',currentActor});
  try{assert.equal(old.selected.objectId,fixed.objectId);assert.deepEqual(old.content,bytes);}
  finally{old.release();}
  const pdfRequest={...initial,operationId:randomUUID(),source:{...source,format:'pdf'},target:{rootId:root.id,name:'example.pdf'}};
  const savedPdf=await output.save(pdfRequest);
  const pdfEntry=(await drive.list(owner,root.id)).find(row=>row.id===savedPdf.fileId);
  assert.equal((await output.save({...pdfRequest,operationId:randomUUID(),source:{...pdfRequest.source,revision:6},
    target:{rootId:root.id,fileId:pdfEntry.id,expectedRevision:pdfEntry.revision}})).version,2);
  const copied=await drive.copy(owner,savedPdf.fileId,{name:'copied.pdf',expectedRevision:pdfEntry.revision+1});
  const handles=[];
  for(const [id,content] of [[saved.fileId,bytes],[savedPdf.fileId,pdf],[copied.entry.id,pdf]]){
    const issued=await drive.download(owner,id,{version:1});
    const handle={actorIdentityId:identityId,referenceId:issued.referenceId,audience:'team-drive.download'};
    assert.deepEqual((await objectGateway.download(handle)).content,content);
    handles.push([id,handle]);
  }
  revoked=true;
  for(const [id,handle] of handles){
    await assert.rejects(objectGateway.head(handle),{status:404});
    await assert.rejects(objectGateway.downloadStream(handle),{status:404});
    await assert.rejects(objectGateway.download({...handle,range:{start:0,endInclusive:3}}),{status:404});
    await assert.rejects(drive.download(owner,id,{version:1}),{status:404});
  }
  revoked=false;
  await database.query('UPDATE files.roots SET quota_bytes=used_bytes+1 WHERE id=$1',[root.id]);
  await assert.rejects(output.save({...initial,operationId:randomUUID(),target:{...target,name:'quota.png'}}),{code:'file_quota_exceeded'});
  denyCommit=true;
  await assert.rejects(output.save({...initial,operationId:randomUUID(),target:{...target,name:'changed.png'}}),/Source revision changed/);
  assert.equal((await drive.list(owner,root.id)).length,3);
  assert.equal((await drive.versions(owner,saved.fileId)).length,2);
  await assert.rejects(database.query(await readFile(new URL('000122_penpot_drive_export_receipts.down.sql',migrations),'utf8')),
    /rollback would remove commit evidence/);
});
