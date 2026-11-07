import { createHash } from 'node:crypto';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORMATS=Object.freeze({penpot:'application/x-penpot',png:'image/png',pdf:'application/pdf'});
const SIGNATURES=Object.freeze({penpot:'504b0304',png:'89504e470d0a1a0a',pdf:'255044462d'});
const MAX_BYTES=32*1024*1024;
const conflicts=new Set(['file_name_conflict','file_revision_conflict','file_quota_exceeded','file_parent_not_found','file_not_found','file_permission_denied']);
const invalid=(code='penpot_drive_export_invalid',status=400)=>new PlatformError(code,'The design export could not be saved',{status});
const sha=bytes=>createHash('sha256').update(bytes).digest();

function requestFacts({operationId,source,target}){
  if(!UUID.test(operationId??'')||!UUID.test(source?.fileId??'')||!UUID.test(source?.pageId??'')
    ||!Number.isSafeInteger(source.revision)||source.revision<0||typeof source.format!=='string'||!Object.hasOwn(FORMATS,source.format)
    ||(source.documentVersion!==undefined&&(!Number.isSafeInteger(source.documentVersion)||source.documentVersion<0))
    ||(source.format!=='penpot'&&!UUID.test(source.objectId??''))
    ||!UUID.test(target?.rootId??'')||(target.parentId!=null&&!UUID.test(target.parentId))
    ||(target.fileId!=null&&!UUID.test(target.fileId)))throw invalid();
  const fileId=target.fileId??null;
  const name=typeof target.name==='string'?target.name.trim().normalize('NFC'):'';
  const expectedRevision=target.expectedRevision??null;
  if(fileId?(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||target.name!=null)
    :(expectedRevision!==null||!name||name.length>255||/[\\/\x00-\x1f]/.test(name)||!name.toLowerCase().endsWith('.'+source.format)))throw invalid();
  return {
    operationId,source:{fileId:source.fileId,pageId:source.pageId,revision:source.revision,format:source.format,
      ...(source.format!=='penpot'?{objectId:source.objectId}:{}),
      ...(source.documentVersion!==undefined?{documentVersion:source.documentVersion}:{})},
    target:{rootId:target.rootId,parentId:target.parentId??null,fileId,expectedRevision,...(!fileId?{name}:{})},
  };
}

/** Server-only save pipeline. The native adapter must read an authenticated
 * saved revision (not a mutable canvas or a browser-supplied export URL). */
export class PenpotDriveOutput {
  #db;#drive;#objects;#native;#provenance;
  constructor({database,teamDrive,objectGateway,nativeExporter,provenanceService}){
    if(!database?.query||!teamDrive?.authorizeDesignDestination||!teamDrive?.commitDesignExport||!teamDrive?.versions
      ||!objectGateway?.storeOutput||!objectGateway?.issue||!objectGateway?.revoke||!provenanceService?.register
      ||!nativeExporter?.exportSaved||!nativeExporter?.checkSaved)throw new TypeError('Design export requires protected native and Drive stores');
    this.#db=database;this.#drive=teamDrive;this.#objects=objectGateway;this.#native=nativeExporter;this.#provenance=provenanceService;
  }
  async #recover(actor,operationId,requestHash,observeOnly=false){
    const {rows}=await this.#db.query(`SELECT state,file_id,file_version FROM design.drive_export_receipts
      WHERE operation_id=$1 AND identity_id=$2 AND request_hash=$3`,[operationId,actor.actorIdentityId,requestHash]);
    const row=rows[0];
    if(!row){
      if(observeOnly)return {operationId,state:'not_started'};
      throw invalid('penpot_drive_export_conflict',409);
    }
    if(row.state!=='complete')return {operationId,state:row.state==='failed'?'failed':'pending_confirmation'};
    const version=(await this.#drive.versions(actor,row.file_id)).find(v=>v.version===row.file_version);
    if(!version)throw invalid('penpot_drive_export_unavailable',404);
    return {operationId,state:'complete',fileId:row.file_id,version:version.version};
  }
  async save({currentActor,nativeContext,signal,observeOnly=false,...input}){
    const {operationId,source,target}=requestFacts(input), requestHash=sha(JSON.stringify({source,target}));
    const actor=await currentActor(), identity=actor?.actorIdentityId;
    if(!UUID.test(identity??''))throw invalid('penpot_drive_export_denied',403);
    if(observeOnly)return this.#recover(actor,operationId,requestHash,true);
    const refresh=async()=>{
      signal?.throwIfAborted();
      const live=await currentActor();
      if(live?.actorIdentityId!==identity)throw invalid('penpot_drive_export_denied',403);
      return live;
    };
    // Claim exactly once. A repeat is observation only, even while running.
    const claim=await this.#db.query(`INSERT INTO design.drive_export_receipts(operation_id,identity_id,request_hash)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING operation_id`,[operationId,identity,requestHash]);
    if(!claim.rows.length)return this.#recover(actor,operationId,requestHash);
    let referenceId,dispatch=false;
    try{
      await this.#drive.authorizeDesignDestination(await refresh(),target);
      const rendered=await this.#native.exportSaved({nativeContext,source,signal});
      if(rendered?.fileId!==source.fileId||rendered.pageId!==source.pageId||rendered.revision!==source.revision
        ||rendered.format!==source.format||rendered.objectId!==source.objectId||!Buffer.isBuffer(rendered.bytes)||rendered.bytes.length<8||rendered.bytes.length>MAX_BYTES)
        throw invalid('penpot_drive_export_source_changed',409);
      const expectedSignature=Buffer.from(SIGNATURES[source.format],'hex');
      if(!rendered.bytes.subarray(0,expectedSignature.length).equals(expectedSignature))throw invalid();
      await this.#native.checkSaved({nativeContext,source,signal});
      const contentType=FORMATS[source.format];
      const object=await this.#objects.storeOutput({actorIdentityId:identity,objectKey:'design/exports/'+operationId+'.'+source.format,
        contentType,content:rendered.bytes,expectedSha256:sha(rendered.bytes).toString('hex')});
      const grant=await this.#objects.issue({actorIdentityId:identity,objectId:object.objectId,objectVersion:object.version,
        audience:'team-drive.file',operations:['head','read'],expiresInSeconds:60});
      referenceId=grant.referenceId;
      await this.#provenance.register({context:{identityId:identity},referenceId,audience:'team-drive.file',artifactKind:'design-export',
        producer:{kind:'application',key:'penpot.export',applicationKey:'official.penpot'},metadata:{schemaVersion:1,source,operationId}});
      await this.#native.checkSaved({nativeContext,source,signal});
      const live=await refresh();
      dispatch=true;
      const saved=await this.#drive.commitDesignExport(live,target,{objectReferenceId:referenceId,
        provenance:{schemaVersion:1,source,operationId},receipt:{operationId,requestHash}});
      return {operationId,state:'complete',fileId:saved.entry.id,version:saved.version.version};
    }catch(error){
      if(!dispatch||conflicts.has(error?.code)){
        await this.#db.query(`UPDATE design.drive_export_receipts SET state='failed'
          WHERE operation_id=$1 AND identity_id=$2 AND request_hash=$3 AND state='pending'`,[operationId,identity,requestHash]);
        throw error;
      }
      // Commit may have succeeded. Read the atomic receipt; never upload,
      // append another version or delete anything on ambiguous outcomes.
      try{return await this.#recover(await refresh(),operationId,requestHash);}
      catch{return {operationId,state:'pending_confirmation'};}
    }finally{
      if(referenceId)await this.#objects.revoke({actorIdentityId:identity,referenceId,reason:'penpot_drive_export_finished'}).catch(()=>{});
    }
  }
}
