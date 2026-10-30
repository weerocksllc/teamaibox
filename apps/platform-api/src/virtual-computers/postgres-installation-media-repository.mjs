import {randomUUID} from 'node:crypto';
import {computerError,computerId,requestKey,fingerprint} from './lifecycle.mjs';

const first=result=>result.rows[0]??null;
const map=r=>r&&({id:r.id,ownerId:r.owner_id,name:r.name,state:r.state,source:r.source,
  objectId:r.object_id,objectVersion:r.object_version,digest:r.digest,size:r.size_bytes===null?null:Number(r.size_bytes),
  compatibility:r.compatibility,errorCode:r.error_code,revision:Number(r.revision),copiedBytes:Number(r.copied_bytes),claimId:r.claim_id});
export class PostgresInstallationMediaRepository {
  #db;
  constructor({database}){
    if(!database?.query||!database?.transaction)throw TypeError('Media repository requires PostgreSQL');
    this.#db=database;
  }
  async list(ownerId){return (await this.#db.query(`SELECT * FROM platform.computer_installation_media
    WHERE owner_id=$1 AND state<>'deleted' ORDER BY created_at,id`,[computerId(ownerId)])).rows.map(map);}
  async get(ownerId,id){
    const result=map(first(await this.#db.query(`SELECT * FROM platform.computer_installation_media
      WHERE id=$1 AND owner_id=$2 AND state<>'deleted'`,[computerId(id),computerId(ownerId)])));
    if(!result)computerError('computer_media_not_found',404);return result;
  }
  async findRequest(ownerId,key,input){
    const row=first(await this.#db.query('SELECT * FROM platform.computer_installation_media WHERE owner_id=$1 AND request_key=$2',
      [computerId(ownerId),requestKey(key)]));
    if(row&&row.request_fingerprint!==fingerprint(input))computerError('computer_idempotency_conflict');
    return map(row);
  }
  async create({ownerId,key,input,source}){
    return this.#db.transaction(async db=>{
      const user=first(await db.query('SELECT status FROM iam.identities WHERE id=$1 FOR UPDATE',[computerId(ownerId)]));
      if(user?.status!=='active')computerError('computer_permission_required',403);
      const old=first(await db.query('SELECT * FROM platform.computer_installation_media WHERE owner_id=$1 AND request_key=$2',[ownerId,requestKey(key)]));
      if(old){if(old.request_fingerprint!==fingerprint(input))computerError('computer_idempotency_conflict');return map(old);}
      return map(first(await db.query(`INSERT INTO platform.computer_installation_media
        (id,owner_id,request_key,request_fingerprint,name,source,state)
        VALUES($1,$2,$3,$4,$5,$6,'preparing') RETURNING *`,[randomUUID(),ownerId,key,fingerprint(input),input.name,source])));
    });
  }
  async remove(ownerId,id,expectedRevision){
    return this.#db.transaction(async db=>{
      const row=first(await db.query('SELECT * FROM platform.computer_installation_media WHERE id=$1 AND owner_id=$2 FOR UPDATE',[computerId(id),computerId(ownerId)]));
      if(!row)computerError('computer_media_not_found',404);
      if(['deleting','deleted'].includes(row.state))return map(row); // Same delete retry is harmless.
      if(Number(row.revision)!==expectedRevision)computerError('computer_state_conflict');
      if(row.state==='preparing')computerError('computer_operation_pending');
      const uses=(await db.query(`SELECT computer_id FROM platform.computer_installations WHERE desired_media_id=$1 OR observed_media_id=$1
        OR (boot_media_id=$1 AND boot_state IN ('pending','armed'))`,[id])).rows;
      if(uses.length)computerError('computer_media_in_use');
      return map(first(await db.query(`UPDATE platform.computer_installation_media SET state='deleting',revision=revision+1,
        claim_id=NULL,claimed_until=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id])));
    });
  }
  async claimNext({leaseMs}){
    return this.#db.transaction(async db=>{
      const row=first(await db.query(`SELECT * FROM platform.computer_installation_media WHERE state IN ('preparing','deleting')
        AND next_attempt_at<=clock_timestamp() AND (claimed_until IS NULL OR claimed_until<clock_timestamp())
        ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`));
      if(!row)return null;
      return map(first(await db.query(`UPDATE platform.computer_installation_media SET claim_id=$2,
        claimed_until=clock_timestamp()+$3*interval '1 millisecond',revision=revision+1 WHERE id=$1 RETURNING *`,[row.id,randomUUID(),leaseMs])));
    });
  }
  async renew(media,{leaseMs}){
    return Boolean(first(await this.#db.query(`UPDATE platform.computer_installation_media
      SET claimed_until=clock_timestamp()+$3*interval '1 millisecond',revision=revision+1
      WHERE id=$1 AND claim_id=$2 AND claimed_until>clock_timestamp() AND state IN ('preparing','deleting') RETURNING id`,[media.id,media.claimId,leaseMs])));
  }
  async progress(media,bytes){
    return Boolean(first(await this.#db.query(`UPDATE platform.computer_installation_media SET copied_bytes=greatest(copied_bytes,$3),revision=revision+1
      WHERE id=$1 AND claim_id=$2 AND claimed_until>clock_timestamp() AND state='preparing' RETURNING id`,[media.id,media.claimId,bytes])));
  }
  async hasOtherObjectReferences(media){
    if(!media.objectId)return false;
    return Boolean(first(await this.#db.query(`SELECT id FROM platform.computer_installation_media
      WHERE object_id=$1 AND id<>$2 AND state='ready' LIMIT 1`,[media.objectId,media.id])));
  }
  async complete(media,result){
    const deleting=media.state==='deleting';
    const row=first(await this.#db.query(`UPDATE platform.computer_installation_media SET state=$3,
      object_id=$4,object_version=$5,digest=$6,size_bytes=$7,compatibility=$8,error_code=NULL,
      claim_id=NULL,claimed_until=NULL,revision=revision+1,updated_at=clock_timestamp()
      WHERE id=$1 AND claim_id=$2 AND claimed_until>clock_timestamp() AND state=$9 RETURNING *`,
    [media.id,media.claimId,deleting?'deleted':'ready',deleting?null:result.objectId,deleting?null:result.objectVersion,
      deleting?media.digest:result.digest,deleting?media.size:result.size,deleting?media.compatibility:result.compatibility,media.state]));
    if(!row)computerError('computer_claim_lost');return map(row);
  }
  async retry(media,code,{permanent=false}={}){
    return this.#db.query(`UPDATE platform.computer_installation_media SET state=$3,error_code=$4,claim_id=NULL,claimed_until=NULL,
      next_attempt_at=clock_timestamp()+interval '10 seconds',revision=revision+1,updated_at=clock_timestamp()
      WHERE id=$1 AND claim_id=$2 AND claimed_until>clock_timestamp() AND state IN ('preparing','deleting')`,
    [media.id,media.claimId,permanent&&media.state==='preparing'?'failed':media.state,code]);
  }
}
