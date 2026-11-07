import { createHash } from 'node:crypto';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST=/^[a-f0-9]{64}$/;
const unavailable=(status=503)=>new PlatformError('penpot_drive_import_unavailable','The design import is unavailable',{status});
const pending=operationId=>({operationId,state:'pending_confirmation'});

export class PenpotDriveImporter {
  #db;#input;#origin;#key;#fetch;#active=new Map();
  constructor({database,driveInput,backendOrigin,backendKey,fetchImplementation=fetch}){
    const origin=new URL(backendOrigin);
    if(!database?.query||!driveInput?.read||!['http:','https:'].includes(origin.protocol)
      ||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!/^[A-Za-z0-9_-]{43}$/.test(backendKey??''))
      throw new TypeError('Protected design import configuration is required');
    this.#db=database;this.#input=driveInput;this.#origin=origin;this.#key=backendKey;this.#fetch=fetchImplementation;
  }
  async #native(method,params,{bytes,signal}={}){
    const headers={authorization:'Bearer '+this.#key,accept:'application/json'};
    let payload;
    if(bytes){
      payload=new FormData();
      for(const [key,value] of Object.entries(params))payload.set(key,value);
      payload.set('file',new Blob([bytes],{type:'application/zip'}),'design.penpot');
    }else{headers['content-type']='application/json';payload=JSON.stringify(params);}
    const timeout=AbortSignal.timeout(bytes?60_000:3000);
    const response=await this.#fetch(new URL('/api/main/methods/'+method,this.#origin),{method:'POST',headers,body:payload,
      redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
    if(!response.ok||!response.body){
      await response.body?.cancel();
      throw unavailable([400,401,403,404,413,415,422].includes(response.status)?response.status:503);
    }
    let length=0;const chunks=[];
    for await(const chunk of response.body){length+=chunk.length;if(length>8192)throw unavailable();chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
  }
  #result(operationId,reply){
    if(reply?.state==='pending')return pending(operationId);
    if(reply?.operationId!==operationId||!UUID.test(reply.fileId??''))throw unavailable();
    return {operationId,state:'complete',fileId:reply.fileId};
  }
  async confirm({operationId,profileId,sourceDigest}){
    if(!UUID.test(operationId??'')||!UUID.test(profileId??'')||!DIGEST.test(sourceDigest??''))throw unavailable(403);
    const binding=this.#active.get(operationId);
    if(!binding||binding.profileId!==profileId||binding.sourceDigest!==sourceDigest)throw unavailable(403);
    await binding.confirm();
  }
  async run({operationId,source,projectId,nativeContext,currentActor,signal,observeOnly=false}){
    if(!UUID.test(operationId??'')||!UUID.test(source?.fileId??'')||!UUID.test(projectId??'')
      ||!Number.isSafeInteger(source?.version)||source.version<1)throw unavailable(400);
    const {profileId}=await nativeContext.assertCurrent();
    const {actorIdentityId:identityId}=await currentActor();
    if(!UUID.test(profileId??'')||!UUID.test(identityId??''))throw unavailable(403);
    const requestHash=createHash('sha256').update(JSON.stringify([source.fileId,source.version,projectId])).digest();
    const claim=observeOnly?null:await this.#db.query(`INSERT INTO design.drive_import_requests
      (operation_id,identity_id,profile_id,project_id,request_hash,source_file_id,source_version) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING RETURNING operation_id`,[operationId,identityId,profileId,projectId,requestHash,source.fileId,source.version]);
    const params={'operation-id':operationId,'target-profile-id':profileId,'project-id':projectId};
    const observe=async digest=>this.#result(operationId,await this.#native('teamaibox-drive-import-result',
      {...params,'source-digest':digest},{signal}));
    if(!claim?.rows.length){
      const {rows}=await this.#db.query(`SELECT source_digest,failed FROM design.drive_import_requests
        WHERE operation_id=$1 AND identity_id=$2 AND profile_id=$3 AND project_id=$4 AND request_hash=$5`,
      [operationId,identityId,profileId,projectId,requestHash]);
      if(!rows.length){
        if(observeOnly)return {operationId,state:'not_started'};
        throw unavailable(409);
      }
      if(rows[0].failed)return {operationId,state:'failed'};
      return rows[0].source_digest?observe(rows[0].source_digest):pending(operationId);
    }
    let staged,dispatch=false,digest;
    try{
      staged=await this.#input.read({fileId:source.fileId,version:source.version,format:'application/x-penpot',currentActor,signal});
      digest=staged.selected.sha256.slice(7);
      await this.#db.query('UPDATE design.drive_import_requests SET source_digest=$2 WHERE operation_id=$1',[operationId,digest]);
      const confirm=async()=>{
        signal?.throwIfAborted();
        const current=await nativeContext.assertCurrent();
        if(current.profileId!==profileId)throw unavailable(403);
        await staged.recheck();
      };
      await confirm();
      this.#active.set(operationId,{profileId,sourceDigest:digest,confirm});
      dispatch=true;
      const reply=await this.#native('teamaibox-drive-import',{...params,'source-digest':digest},{bytes:staged.content,signal});
      return this.#result(operationId,reply);
    }catch(error){
      if(!dispatch||[400,401,403,404,413,415,422].includes(error?.status)){
        await this.#db.query('UPDATE design.drive_import_requests SET failed=true WHERE operation_id=$1',[operationId]);
        throw error;
      }
      // Never post another write after a timeout. Ask Penpot for its own
      // atomic commit receipt for the original profile, project and digest.
      try{await nativeContext.assertCurrent();return await observe(digest);}catch{return pending(operationId);}
    }finally{this.#active.delete(operationId);staged?.release();}
  }
}
