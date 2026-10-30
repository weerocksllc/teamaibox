import { randomUUID } from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {profileRevision} from './computer-profiles.mjs';
import {beginInstallationAction,completeInstallationAction,readInstallation,writeInstallation} from './computer-installation-state.mjs';
import {installationActionInput,requireMountableMedia} from './installation-media.mjs';
import {computerCommand,validateComputerCommandResult} from '../../../../services/scheduler/src/computer-command.mjs';
import { beginComputerOperation, completeComputerOperation, newComputer, createInput, actionInput,
  computerId, requestKey, fingerprint, computerError, applyRuntimeUpdate } from './lifecycle.mjs';

const first = result => result.rows[0] ?? null;
const nullableNumber=v=>v==null?null:Number(v);
async function readPolicy(db,base,ownerId=null,lock=false) {
  const row=first(await db.query('SELECT * FROM platform.computer_feature_policy WHERE singleton'+(lock?' FOR SHARE':'')));
  const p=row?{...base,enabled:base.enabled===true&&row.enabled,maximum:row.maximum,storedPerUser:nullableNumber(row.stored_limit),
    runningPerUser:nullableNumber(row.running_limit),revision:Number(row.revision)}:{...base,revision:0};
  if(ownerId){
    const quota=first(await db.query('SELECT * FROM platform.computer_quotas WHERE owner_id=$1',[ownerId]));
    if(quota)Object.assign(p,{storedPerUser:nullableNumber(quota.stored_limit),runningPerUser:nullableNumber(quota.running_limit)});
  }
  return p;
}
const mapComputer = r => r && ({ id:r.id, ownerId:r.owner_id, nodeId:r.node_id, poolId:r.pool_id,
  volumeId:r.volume_id, firmwareId:r.firmware_id, tpmId:r.tpm_id, name:r.name, state:r.state,
  revision:Number(r.revision), generation:Number(r.generation), profile:r.profile, resources:r.resources,
  run:r.run, errorCode:r.error_code });
const mapOperation = r => r && ({ id:r.id, computerId:r.computer_id, ownerId:r.owner_id, action:r.action,
  state:r.state, generation:Number(r.generation), command:r.command, errorCode:r.error_code, claimId:r.claim_id });
async function owned(db, ownerId, id, lock = false) {
  const value = mapComputer(first(await db.query(`SELECT * FROM platform.computers WHERE id=$1 AND owner_id=$2
    AND state<>'deleted'${lock ? ' FOR UPDATE' : ''}`, [computerId(id),computerId(ownerId)])));
  if (!value) computerError('computer_not_found',404);
  return value;
}
async function prior(db, ownerId, action, key, request) {
  const row = first(await db.query(`SELECT * FROM platform.computer_operations WHERE owner_id=$1 AND action=$2 AND request_key=$3`,
    [ownerId,action,requestKey(key)]));
  if (row && row.request_fingerprint !== fingerprint(request)) computerError('computer_idempotency_conflict');
  return mapOperation(row);
}
async function save(db, c) {
  await db.query(`UPDATE platform.computers SET name=$2,state=$3,revision=$4,generation=$5,run=$6,error_code=$7,
    profile=$8,updated_at=clock_timestamp() WHERE id=$1`, [c.id,c.name,c.state,c.revision,c.generation,c.run,c.errorCode,c.profile]);
}
async function insertOperation(db, op, key, request) {
  return mapOperation(first(await db.query(`INSERT INTO platform.computer_operations
    (id,computer_id,owner_id,action,request_key,request_fingerprint,state,generation,command)
    VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8) RETURNING *`,
    [op.id,op.computerId,op.ownerId,op.action,key,fingerprint(request),op.generation,op.command])));
}
const limit = (value,count,code) => {
  if (value == null) return; // No invented default quota.
  if (!Number.isSafeInteger(value) || value < 0) throw TypeError('Invalid administrator computer quota');
  if (count >= value) computerError(code);
};

/** Uses the same PostgreSQL/node/pool rows as existing services. It does not
 * start guests or reserve runtime capacity. Those steps require the shared
 * scheduler and an authenticated, idempotent Node Agent implementation.
 */
export class PostgresComputerRepository {
  #db;
  constructor({database}) {
    if (!database?.query || !database?.transaction) throw TypeError('Computer repository requires PostgreSQL');
    this.#db=database;
  }
  async #owner(db,id) {
    // Serializes user quantity admission across concurrent API processes.
    const user=first(await db.query('SELECT status FROM iam.identities WHERE id=$1 FOR UPDATE',[computerId(id)]));
    if (user?.status!=='active') computerError('computer_permission_required',403);
  }
  async list(ownerId) {
    return (await this.#db.query(`SELECT * FROM platform.computers WHERE owner_id=$1 AND state<>'deleted' ORDER BY created_at,id`,[computerId(ownerId)])).rows.map(mapComputer);
  }
  get(ownerId,id) { return owned(this.#db,ownerId,id); }
  async getInstallation(ownerId,id) {
    await owned(this.#db,ownerId,id);
    return readInstallation(this.#db,ownerId,id);
  }
  async requestInstallation({ownerId,computerId:id,action,input,key,automatic=false,policy=null}) {
    const request={computerId:computerId(id),action,...installationActionInput(action,input)};requestKey(key);
    return this.#db.transaction(async db=>{
      await this.#owner(db,ownerId);
      const old=await prior(db,ownerId,'installation',key,request);if(old)return old;
      const c=await owned(db,ownerId,id,true);
      if(first(await db.query(`SELECT id FROM platform.computer_operations WHERE computer_id=$1 AND state IN ('queued','executing')`,[id])))
        computerError('computer_operation_pending');
      const installation=await readInstallation(db,ownerId,id,true),operationId=randomUUID();
      if(action==='adopt') {
        if(automatic||installation||c.state!=='stopped'||c.run!==null)computerError('computer_installation_shutdown_required');
        if(c.revision!==request.expectedRevision)computerError('computer_state_conflict');
        applyRuntimeUpdate(c.profile,policy?.runtimeUpdates?.[c.profile.id]??null);
        if(!policy?.mediaRuntimeImages?.includes(c.profile.runtimeImage))computerError('computer_installation_upgrade_required');
        // This changes only the explicitly selected stopped computer's host
        // runtime. Schema-1 disk/firmware/TPM and fixed-media identity stay exact.
        c.revision++;await save(db,c);
        await db.query(`INSERT INTO platform.computer_installations(computer_id,owner_id,phase) VALUES($1,$2,'user-confirmed')`,[id,ownerId]);
        const op=await insertOperation(db,{id:operationId,computerId:id,ownerId,action:'installation',generation:c.generation,command:{computerId:id,action:'adopt'}},key,request);
        return mapOperation(first(await db.query(`UPDATE platform.computer_operations SET state='succeeded',finished_at=clock_timestamp() WHERE id=$1 RETURNING *`,[op.id])));
      }
      let media=null;
      if(action==='mount') {
        const row=first(await db.query('SELECT * FROM platform.computer_installation_media WHERE id=$1 AND owner_id=$2 FOR UPDATE',[request.mediaId,ownerId]));
        if(row)media={id:row.id,ownerId:row.owner_id,state:row.state,compatibility:row.compatibility,digest:row.digest,size:Number(row.size_bytes)};
      }
      const next=beginInstallationAction(c,installation,action,installationActionInput(action,input),{operationId,media});
      if(automatic&&!installation.autoStart)computerError('computer_state_conflict');
      if(!automatic)next.installation.autoStart=false;
      next.installation.errorCode=null;
      const command={computerId:c.id,ownerId:c.ownerId,nodeId:c.nodeId,poolId:c.poolId,volumeId:c.volumeId,
        firmwareId:c.firmwareId,tpmId:c.tpmId,generation:c.generation,profile:c.profile,resources:c.resources,run:c.run,installation:next.command};
      await writeInstallation(db,id,next.installation);
      const op=await insertOperation(db,{id:operationId,computerId:id,ownerId,action:'installation',generation:c.generation,command},key,request);
      if(!next.queued)return mapOperation(first(await db.query(`UPDATE platform.computer_operations SET state='succeeded',
        finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[op.id])));
      return op;
    });
  }
  async installationFollowups() {
    return (await this.#db.query(`SELECT c.* FROM platform.computers c JOIN platform.computer_installations i ON i.computer_id=c.id
      WHERE i.auto_start AND c.state NOT IN ('creating','deleted') AND NOT EXISTS(SELECT 1 FROM platform.computer_operations o
        WHERE o.computer_id=c.id AND o.state IN ('queued','executing')) ORDER BY c.created_at,c.id LIMIT 10`)).rows.map(mapComputer);
  }
  async finishInstallationFollowup(ownerId,id,revision,errorCode=null) {
    return this.#db.transaction(async db=>{
      await owned(db,ownerId,id,true);const installation=await readInstallation(db,ownerId,id,true);
      if(!installation||!installation.autoStart||installation.revision!==revision)return false;
      installation.autoStart=false;installation.errorCode=errorCode;installation.revision++;
      if(installation.observedRevision===installation.revision-1)installation.observedRevision=installation.revision;
      await writeInstallation(db,id,installation);return true;
    });
  }
  findRequest(ownerId,action,key,input) { return prior(this.#db,computerId(ownerId),action,key,input); }
  async getOperation(ownerId,id) {
    const op=mapOperation(first(await this.#db.query('SELECT * FROM platform.computer_operations WHERE id=$1 AND owner_id=$2',[computerId(id),computerId(ownerId)])));
    if (!op) computerError('computer_not_found',404);
    return op;
  }
  async profiles() { return (await this.#db.query('SELECT profile,create_enabled FROM platform.computer_profiles ORDER BY id')).rows; }
  async reconciliationCandidates(after=null){
    return (await this.#db.query(`SELECT * FROM platform.computers WHERE run IS NOT NULL
      AND state IN ('running','unavailable','error','starting','stopping') AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 20`,[after])).rows.map(mapComputer);
  }
  async observeRun(observed,result){
    return this.#db.transaction(async db=>{
      // Same lock order as admission and queue completion.
      await db.query('SELECT id FROM compute.nodes WHERE id=$1 FOR UPDATE',[observed.nodeId]);
      const c=mapComputer(first(await db.query('SELECT * FROM platform.computers WHERE id=$1 FOR UPDATE',[observed.id])));
      if(!c||!isDeepStrictEqual(c,observed)||!c.run)return false;
      if(result){
        const equal=k=>result[k]===c[k];
        if(result.rejected||!['ownerId','nodeId','volumeId','firmwareId','tpmId','generation'].every(equal)
          ||result.computerId!==c.id||result.runId!==c.run.id||result.runtimeImage!==c.run.runtimeImage
          ||!/^[a-f0-9]{64}$/.test(result.containerId??'')||c.run.containerId!==null&&result.containerId!==c.run.containerId
          ||!(result.stopped===true&&result.running!==true||result.running===true&&result.stopped!==true))computerError('computer_result_mismatch');
      }
      const pending=(await db.query(`SELECT * FROM platform.computer_operations WHERE computer_id=$1 AND state IN ('queued','executing') FOR UPDATE`,[c.id])).rows;
      if(result?.bootRequestId) {
        const installation=await readInstallation(db,c.ownerId,c.id,true);
        if(installation?.boot?.generation===c.generation) {
          if(installation.boot.id!==result.bootRequestId||!['armed','consumed'].includes(result.bootState))computerError('computer_result_mismatch');
          if(installation.boot.state!==result.bootState&&installation.boot.state!=='consumed') {
            if(pending.length)return false;
            installation.boot.state=result.bootState;installation.revision++;
            if(installation.observedRevision===installation.revision-1)installation.observedRevision=installation.revision;
            await writeInstallation(db,c.id,installation);
          }
        }
      }
      if(result?.stopped){
        if(pending.some(op=>!['start','shutdown'].includes(op.action)||Number(op.generation)!==c.generation||op.command.run?.id!==c.run.id))return false;
        await db.query(`UPDATE compute.computer_runs SET state='released' WHERE id=$1 AND computer_id=$2 AND owner_id=$3
          AND node_id=$4 AND generation=$5 AND state='active'`,[c.run.id,c.id,c.ownerId,c.nodeId,c.generation]);
        for(const op of pending){
          const clean=op.action==='shutdown'&&result.cleanShutdown===true;
          await db.query(`UPDATE platform.computer_operations SET state=$2,error_code=$3,claim_id=NULL,claimed_until=NULL,
            finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[op.id,clean?'succeeded':'failed',clean?null:'computer_run_exited']);
        }
        c.run=null;c.state='stopped';c.errorCode=result.cleanShutdown===true?null:'computer_unclean_shutdown';
      }else{
        if(pending.length)return false; // The durable operation still owns transitions.
        const state=result?.running?'running':'unavailable',code=result?.running?null:'computer_runtime_unavailable';
        if(c.state===state&&c.errorCode===code)return false;
        c.state=state;c.errorCode=code;
      }
      c.revision++;await save(db,c);return true;
    });
  }
  async importProfile(profile){
    const inserted=first(await this.#db.query(`INSERT INTO platform.computer_profiles(id,profile,create_enabled)
      VALUES($1,$2,false) ON CONFLICT(id) DO NOTHING RETURNING profile,create_enabled`,[profile.id,profile]));
    if(inserted)return inserted;
    const old=first(await this.#db.query('SELECT profile,create_enabled FROM platform.computer_profiles WHERE id=$1 AND profile=$2::jsonb',[profile.id,profile]));
    if(!old)computerError('computer_profile_version_conflict');
    return old; // Identical retry never unpublishes a version or replaces it.
  }
  async publishProfile(id,input,checkInstalled){
    return this.#db.transaction(async db=>{
      const row=first(await db.query('SELECT profile,create_enabled FROM platform.computer_profiles WHERE id=$1 FOR UPDATE',[id]));
      if(!row)computerError('computer_profile_unavailable');
      if(profileRevision(row)!==input.expectedRevision)computerError('computer_state_conflict');
      if(input.enabled)await checkInstalled(row.profile);
      await db.query('UPDATE platform.computer_profiles SET create_enabled=$2 WHERE id=$1',[id,input.enabled]);
      return {...row,create_enabled:input.enabled};
    });
  }
  policy(base,ownerId=null){return readPolicy(this.#db,base,ownerId);}
  async setPolicy(actorId,p) {
    const values=[p.enabled,p.maximum,p.storedPerUser,p.runningPerUser,actorId,p.expectedRevision];
    const added=first(await this.#db.query(`INSERT INTO platform.computer_feature_policy(singleton,enabled,maximum,stored_limit,running_limit,updated_by)
      SELECT true,$1,$2,$3,$4,$5 WHERE $6::bigint=0 ON CONFLICT(singleton) DO NOTHING RETURNING revision`,values));
    if(added)return;
    const updated=first(await this.#db.query(`UPDATE platform.computer_feature_policy SET enabled=$1,maximum=$2,stored_limit=$3,running_limit=$4,
      updated_by=$5,revision=revision+1,updated_at=clock_timestamp() WHERE singleton AND revision=$6 RETURNING revision`,values));
    if(!updated)computerError('computer_state_conflict');
  }
  async setQuota(actorId,ownerId,p) {
    return this.#db.transaction(async db=>{
      if(!first(await db.query('SELECT id FROM iam.identities WHERE id=$1 FOR UPDATE',[ownerId])))computerError('computer_not_found',404);
      const old=first(await db.query('SELECT revision FROM platform.computer_quotas WHERE owner_id=$1',[ownerId]));
      if(Number(old?.revision??0)!==p.expectedRevision)computerError('computer_state_conflict');
      await db.query(`INSERT INTO platform.computer_quotas(owner_id,stored_limit,running_limit,updated_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(owner_id) DO UPDATE SET stored_limit=$2,running_limit=$3,updated_by=$4,
        revision=platform.computer_quotas.revision+1,updated_at=clock_timestamp()`,[ownerId,p.storedPerUser,p.runningPerUser,actorId]);
      return {revision:p.expectedRevision+1};
    });
  }
  async administrationQuotas({search='',after=null},policy) {
    const literal=search.replace(/[\\%_]/g,v=>'\\'+v);
    const rows=(await this.#db.query(`SELECT i.id,i.login_name,i.display_name,i.status,coalesce(q.revision,0) AS revision,
      CASE WHEN q.owner_id IS NULL THEN $1::bigint ELSE q.stored_limit END AS stored_limit,
      CASE WHEN q.owner_id IS NULL THEN $2::bigint ELSE q.running_limit END AS running_limit,
      (SELECT count(*) FROM platform.computers c WHERE c.owner_id=i.id AND c.state<>'deleted') AS stored,
      (SELECT count(*) FROM platform.computers c WHERE c.owner_id=i.id AND c.run IS NOT NULL) AS running
      FROM iam.identities i LEFT JOIN platform.computer_quotas q ON q.owner_id=i.id
      WHERE i.identity_kind='local_user' AND ($3::uuid IS NULL OR i.id>$3) AND ($4='' OR i.login_name ILIKE $5 OR i.display_name ILIKE $5)
      ORDER BY i.id LIMIT 51`,[policy.storedPerUser??null,policy.runningPerUser??null,after,search,'%'+literal+'%'])).rows;
    const data=rows.slice(0,50).map(r=>({ownerId:r.id,loginName:r.login_name,displayName:r.display_name,status:r.status,
      storedPerUser:nullableNumber(r.stored_limit),runningPerUser:nullableNumber(r.running_limit),revision:Number(r.revision),stored:Number(r.stored),running:Number(r.running)}));
    return {data,nextCursor:rows.length>50?data.at(-1).ownerId:null};
  }
  async requestCreate({ownerId,input,key,placement,policy={}}) {
    const request=createInput(input); requestKey(key);
    return this.#db.transaction(async db=>{
      await this.#owner(db,ownerId);
      const old=await prior(db,ownerId,'create',key,request); if(old) return old;
      policy=await readPolicy(db,policy,ownerId,true);
      if(policy.enabled===false)computerError('computer_creation_paused',409);
      const profile=first(await db.query('SELECT * FROM platform.computer_profiles WHERE id=$1 FOR SHARE',[request.profileId]));
      if (!profile?.create_enabled) computerError('computer_profile_unavailable');
      const count=Number(first(await db.query(`SELECT count(*) AS count FROM platform.computers WHERE owner_id=$1 AND state<>'deleted'`,[ownerId])).count);
      limit(policy.storedPerUser,count,'computer_stored_quota');
      const c=newComputer({ownerId,input:request,profile:profile.profile,nodeId:placement?.nodeId,poolId:placement?.poolId,policy});
      if(request.installationMediaId) {
        if(c.profile.schemaVersion!==2)computerError('computer_installation_upgrade_required');
        const row=first(await db.query('SELECT * FROM platform.computer_installation_media WHERE id=$1 AND owner_id=$2 FOR UPDATE',[request.installationMediaId,ownerId]));
        requireMountableMedia(row&&{id:row.id,ownerId:row.owner_id,state:row.state,compatibility:row.compatibility,digest:row.digest,size:Number(row.size_bytes)},ownerId,request);
      }
      await db.query('SELECT id FROM compute.nodes WHERE id=$1 FOR UPDATE',[c.nodeId]);
      const pool=first(await db.query(`SELECT * FROM objects.storage_pools WHERE pool_id=$1 AND node_id=$2 FOR UPDATE`,[c.poolId,c.nodeId]));
      if (!pool || pool.encryption_mode!=='luks2' || pool.encryption_status!=='verified' || pool.health_state!=='healthy'
        || pool.compatibility_status!=='verified' || pool.lifecycle_state!=='active') computerError('computer_storage_unavailable');
      // Validate the encrypted pool in this transaction, without booking the
      // future logical growth of other guests.
      if (typeof placement?.prepareStorage!=='function') computerError('computer_storage_unavailable');
      await placement.prepareStorage({db,computer:c,pool});
      await db.query(`INSERT INTO platform.computers(id,owner_id,node_id,pool_id,profile_id,volume_id,firmware_id,tpm_id,
        name,state,revision,generation,profile,resources) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [c.id,c.ownerId,c.nodeId,c.poolId,c.profile.id,c.volumeId,c.firmwareId,c.tpmId,c.name,c.state,c.revision,c.generation,c.profile,c.resources]);
      if(c.profile.schemaVersion===2)await db.query(`INSERT INTO platform.computer_installations(computer_id,owner_id,desired_media_id,auto_start,phase)
        VALUES($1,$2,$3,$4,$5)`,[c.id,c.ownerId,request.installationMediaId??null,Boolean(request.installationMediaId),request.installationMediaId?'installing':'empty']);
      return insertOperation(db,beginComputerOperation(c,'create').operation,key,request);
    });
  }
  async requestAction({ownerId,computerId:id,action,input,key,policy={},automatic=false}) {
    const request={computerId:computerId(id),...actionInput(action,input)}; requestKey(key);
    return this.#db.transaction(async db=>{
      await this.#owner(db,ownerId);
      const old=await prior(db,ownerId,action,key,request); if(old) return old;
      const current=await owned(db,ownerId,id,true);
      if(automatic&&!(await readInstallation(db,ownerId,id,true))?.autoStart)computerError('computer_state_conflict');
      if (first(await db.query(`SELECT id FROM platform.computer_operations WHERE computer_id=$1 AND state IN ('queued','executing')`,[id]))) computerError('computer_operation_pending');
      if(action==='start') {
        policy=await readPolicy(db,policy,ownerId,true);
        if(policy.enabled===false)computerError('computer_creation_paused',409);
        const count=Number(first(await db.query('SELECT count(*) AS count FROM platform.computers WHERE owner_id=$1 AND run IS NOT NULL',[ownerId])).count);
        limit(policy.runningPerUser,count,'computer_running_quota');
      }
      const next=beginComputerOperation(current,action,input,{runtimeUpdate:action==='start'?(policy.runtimeUpdates?.[current.profile.id]??null):null});
      const installation=action==='start'?await readInstallation(db,ownerId,id,true):null;
      if(action==='start'&&(current.profile.schemaVersion===2||installation)) {
        if(!installation||installation.operationId||installation.revision!==installation.observedRevision)computerError('computer_operation_pending');
        if(installation.boot?.state==='armed')computerError('computer_installation_boot_unconfirmed');
        let media=null;
        if(installation.desiredMediaId) {
          media=first(await db.query(`SELECT digest,size_bytes FROM platform.computer_installation_media WHERE id=$1 AND owner_id=$2 AND state='ready' FOR SHARE`,[installation.desiredMediaId,ownerId]));
          if(!media)computerError('computer_media_not_ready');
        }
        const boot=installation.boot?.state==='pending'?installation.boot:null;
        if(boot&&boot.generation!==next.computer.generation) {
          // Only a new explicit start after a proved no-effect admission
          // rejection can move a still-pending boot request to the next run.
          boot.generation=next.computer.generation;installation.revision++;installation.observedRevision=installation.revision;
          await writeInstallation(db,id,installation);
        }
        next.operation.command.installation={action:'launch',revision:installation.revision,mediaId:installation.desiredMediaId,
          digest:media?.digest??null,size:media?Number(media.size_bytes):0,bootRequestId:boot?.id??null};
      }
      await save(db,next.computer);
      return insertOperation(db,next.operation,key,request);
    });
  }
  async claimNext({leaseMs}) {
    if (!Number.isSafeInteger(leaseMs)||leaseMs<=0) throw TypeError('Operation lease duration is required');
    return this.#db.transaction(async db=>{
      const row=first(await db.query(`SELECT id FROM platform.computer_operations WHERE state IN ('queued','executing')
        AND (claimed_until IS NULL OR claimed_until<=clock_timestamp()) ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1`));
      if(!row) return null;
      return mapOperation(first(await db.query(`UPDATE platform.computer_operations SET state='executing',claim_id=$2,
        claimed_until=clock_timestamp()+$3::bigint*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[row.id,randomUUID(),leaseMs])));
    });
  }
  async renew(op,{leaseMs}) {
    if (!Number.isSafeInteger(leaseMs)||leaseMs<=0) throw TypeError('Operation lease duration is required');
    const row=first(await this.#db.query(`UPDATE platform.computer_operations SET claimed_until=clock_timestamp()+$3::bigint*interval '1 millisecond'
      WHERE id=$1 AND claim_id=$2 AND state='executing' AND claimed_until>clock_timestamp() RETURNING id`,[op.id,op.claimId,leaseMs]));
    return Boolean(row);
  }
  async complete(op,result,{releaseResources}={}) {
    return this.#db.transaction(async db=>{
      const completed=first(await db.query(`SELECT * FROM platform.computer_operations WHERE id=$1 AND owner_id=$2 AND state IN ('succeeded','failed')`,[op.id,op.ownerId]));
      if(completed) return mapOperation(completed);
      // Shared admissions lock node first; release uses that same order.
      const observed=await owned(db,op.ownerId,op.computerId);
      await db.query('SELECT id FROM compute.nodes WHERE id=$1 FOR UPDATE',[observed.nodeId]);
      const c=await owned(db,op.ownerId,op.computerId,true);
      const row=first(await db.query(`SELECT *,claimed_until>clock_timestamp() AS claim_live FROM platform.computer_operations WHERE id=$1 AND owner_id=$2 FOR UPDATE`,[op.id,op.ownerId]));
      if(['succeeded','failed'].includes(row?.state)) return mapOperation(row);
      if (!row || row.claim_id!==op.claimId || row.state!=='executing'
        || !row.claim_live) computerError('computer_state_conflict');
      if(row.action==='installation') {
        const currentOperation=mapOperation(row);
        validateComputerCommandResult('installation',computerCommand(currentOperation),result);
        const installation=await readInstallation(db,c.ownerId,c.id,true);
        const next=completeInstallationAction(c,installation,currentOperation,result);
        await writeInstallation(db,c.id,next);
        return mapOperation(first(await db.query(`UPDATE platform.computer_operations SET state=$2,error_code=$3,
          claim_id=NULL,claimed_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
          [op.id,result.rejected===true?'failed':'succeeded',result.rejected===true?result.errorCode:null])));
      }
      const next=completeComputerOperation(c,mapOperation(row),result);
      if(row.action==='start'&&result.rejected===true) {
        const installation=await readInstallation(db,c.ownerId,c.id,true);
        if(installation?.autoStart) {
          installation.autoStart=false;installation.errorCode=result.errorCode;
          installation.revision++;installation.observedRevision=installation.revision;
          await writeInstallation(db,c.id,installation);
        }
      }
      if(row.action==='start'&&row.command.installation?.bootRequestId&&result.rejected!==true) {
        const installation=await readInstallation(db,c.ownerId,c.id,true);
        if(installation?.boot?.id!==result.bootRequestId||installation.boot.generation!==c.generation
          ||!['armed','consumed'].includes(result.bootState))computerError('computer_result_mismatch');
        installation.boot.state=result.bootState;installation.revision++;installation.observedRevision=installation.revision;
        await writeInstallation(db,c.id,installation);
      }
      if(row.action==='delete'&&result.rejected!==true) {
        const installation=await readInstallation(db,c.ownerId,c.id,true);
        if(installation) {
          installation.desiredMediaId=null;installation.observedMediaId=null;installation.operationId=null;
          if(installation.boot&&['pending','armed'].includes(installation.boot.state))installation.boot.state='cancelled';
          installation.revision++;installation.observedRevision=installation.revision;
          await writeInstallation(db,c.id,installation);
        }
      }
      if(result.rejected===true&&['create','start'].includes(op.action)||result.rejected!==true&&['shutdown','delete'].includes(op.action)) {
        if(typeof releaseResources!=='function') computerError('computer_capacity_unavailable');
        await releaseResources({db,computer:c,operation:mapOperation(row),result});
      }
      await save(db,next);
      return mapOperation(first(await db.query(`UPDATE platform.computer_operations SET state=$2,error_code=$3,
        claim_id=NULL,claimed_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [op.id,result.rejected===true?'failed':'succeeded',next.errorCode])));
    });
  }
  async retry(op) {
    // Never persist raw exception messages (may contain transport credentials).
    // An uncertain result is replayed with the SAME operation/run IDs; no charge
    // is released and no fresh disk is substituted. Lease expiry provides backoff.
    return Boolean(first(await this.#db.query(`UPDATE platform.computer_operations SET error_code='computer_runtime_unavailable',
      updated_at=clock_timestamp() WHERE id=$1 AND claim_id=$2 AND state='executing' RETURNING id`,[op.id,op.claimId])));
  }
}
