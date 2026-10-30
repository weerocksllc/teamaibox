import {validateComputerResources,planComputerPlacement} from './virtual-computer-capacity.mjs';
import {PlatformError} from '../../../packages/observability/src/index.mjs';

const first=r=>r.rows[0]??null;
const deny=(code='computer_capacity_unavailable')=>{throw new PlatformError(code,'当前节点资源暂不可用，请稍后重试。',{status:409,retryable:true});};
const safe=n=>Number.isSafeInteger(n)&&n>=0;
const json=v=>typeof v==='string'?JSON.parse(v):v;
const runtimeReservation=(memory,cpu)=>({cpuMillis:cpu,unifiedMemoryBytes:memory,acceleratorUnits:0,codecSessions:0,storageBytes:0,networkBitsPerSecond:0});

// The baseline is collected by the authenticated Node Agent, not the browser.
// The node/run locks protect operation identity and exact shutdown results.
// Configured guest CPU/RAM values are not pooled advance allocations.
export class PostgresComputerCapacity {
  #db;#nodes;#baseline;#clock;
  constructor({database,installedNodes,localNodeId,baselineProvider,clock=()=>Date.now()}){
    if(!database?.query||!database?.transaction||!baselineProvider?.read||!Array.isArray(installedNodes)||!clock)throw TypeError('Computer capacity configuration required');
    this.#db=database;this.#baseline=baselineProvider;this.#clock=clock;
    this.#nodes=new Map();
    for(const node of installedNodes){
      if(!node.nodeId||!node.poolId||!Array.isArray(node.profileIds)||!node.policy||this.#nodes.has(node.nodeId))throw TypeError('Invalid installed computer node');
      this.#nodes.set(node.nodeId,structuredClone(node));
    }
    if(!localNodeId||this.#nodes.size!==1||!this.#nodes.has(localNodeId))throw TypeError('Computer capacity requires the single local appliance installation');
  }
  async #node(db,id){
    const n=first(await db.query('SELECT * FROM compute.nodes WHERE id=$1',[id]));
    if(!n||n.lifecycle_state!=='ready'||n.trust_kind!=='managed_appliance'||n.appliance_role!=='appliance-core'||n.recovery_state!=='healthy'||!['arm64','aarch64'].includes(n.architecture))deny();
    return n;
  }
  async status(){
    const result=[];
    for(const installed of this.#nodes.values()){
      const row=first(await this.#db.query(`SELECT n.id,n.node_key,n.lifecycle_state,n.recovery_state,n.last_seen_at,
        (SELECT count(*) FROM compute.computer_runs r WHERE r.node_id=n.id AND r.state='active') AS running
        FROM compute.nodes n WHERE n.id=$1`,[installed.nodeId]));
      result.push({nodeId:installed.nodeId,nodeName:row?.node_key??null,poolId:installed.poolId,profileIds:installed.profileIds,
        ready:row?.lifecycle_state==='ready'&&row?.recovery_state==='healthy',running:Number(row?.running??0),
        observedAt:row?.last_seen_at??null});
    }
    return result;
  }
  async checkProfile(profile,policy={}){
    const update=policy.runtimeUpdates?.[profile.id];
    const from=Array.isArray(update?.from)?update.from:[update?.from];
    if(update&&![...from,update.to].includes(profile.runtimeImage))deny('computer_profile_not_installed');
    const runtimeImage=update?.to??profile.runtimeImage;
    for(const installed of this.#nodes.values()){
      if(!installed.profileIds.includes(profile.id))continue;
      try{
        const node=await this.#node(this.#db,installed.nodeId),b=await this.#read(this.#db,node,installed);
        const p=b.installedProfiles?.find(p=>p.id===profile.id);
        if(p?.runtimeImage===runtimeImage&&['firmwareDigest','mediaDigest','driverDigest','tpm'].every(k=>p[k]===profile[k]))return;
      }catch(e){if(!['computer_capacity_unavailable','computer_storage_unavailable'].includes(e.code))throw e;}
    }
    deny('computer_profile_not_installed');
  }
  async #read(db,node,installed){
    const b=await this.#baseline.read({nodeId:node.id,nodeGeneration:Number(node.generation),poolId:installed.poolId});
    const now=Number(this.#clock()),age=installed.policy.maximumSampleAgeMs;
    if(b?.nodeId!==node.id||b.nodeGeneration!==Number(node.generation)||b.poolId!==installed.poolId||b.encryption!=='luks2'||
      !safe(b.sampledAt)||!safe(age)||age===0||now-b.sampledAt<0||now-b.sampledAt>age||!safe(b.freeStorageBytes)||
      !Array.isArray(b.volumes)||b.volumes.some(v=>!v.volumeId||!safe(v.usedBytes))||new Set(b.volumes.map(v=>v.volumeId)).size!==b.volumes.length
      ||b.storageOverheadBytes!==installed.policy.storageOverheadBytes||b.storageReserveBytes!==installed.policy.storageReserveBytes)deny('computer_storage_unavailable');
    return b;
  }
  async #storage(db,computer,b,policy){
    const pool=first(await db.query('SELECT * FROM objects.storage_pools WHERE pool_id=$1 AND node_id=$2 FOR UPDATE',[computer.poolId,computer.nodeId]));
    if(pool?.encryption_mode!=='luks2'||pool.encryption_status!=='verified'||pool.health_state!=='healthy'||pool.lifecycle_state!=='active')deny('computer_storage_unavailable');
    // Check actual free space only. Other sparse disks' logical maxima are
    // not pre-charged against this disk or another guest's future growth.
    if (b.freeStorageBytes < policy.storageOverheadBytes) deny('computer_storage_unavailable');
  }
  async placement({input,policy}){
    const row=first(await this.#db.query('SELECT profile FROM platform.computer_profiles WHERE id=$1 AND create_enabled',[input.profileId]));
    if(!row)deny('computer_profile_unavailable');
    const resources=validateComputerResources(input.resources,{profile:json(row.profile),policy});
    for(const installed of this.#nodes.values()){
      if(!installed.profileIds.includes(input.profileId))continue;
      try{
        const node=await this.#node(this.#db,installed.nodeId),b=await this.#read(this.#db,node,installed);
        // Placement is advisory; the transaction below takes fresh observations
        // and verifies storage health before adding the new computer.
        if(b.freeStorageBytes<installed.policy.storageOverheadBytes)continue;
        return {nodeId:installed.nodeId,poolId:installed.poolId,prepareStorage:async({db,computer})=>{
          if(computer.nodeId!==installed.nodeId||computer.poolId!==installed.poolId||!installed.profileIds.includes(computer.profile.id))deny();
          const current=await this.#node(db,computer.nodeId),fresh=await this.#read(db,current,installed);
          await this.#storage(db,computer,fresh,installed.policy);

        }};
      }catch(e){if(!['computer_capacity_unavailable','computer_storage_unavailable'].includes(e.code))throw e;}
    }
    deny('computer_storage_unavailable');
  }
  async acquireRun({computer,operation}){
    const installed=this.#nodes.get(computer.nodeId);
    if(!installed||installed.poolId!==computer.poolId||!installed.profileIds.includes(computer.profile.id)||operation.action!=='start'||!computer.run)deny();
    return this.#db.transaction(async db=>{
      await db.query('SELECT id FROM compute.nodes WHERE id=$1 FOR UPDATE',[computer.nodeId]);
      const node=await this.#node(db,computer.nodeId);
      const c=first(await db.query('SELECT generation,run,state FROM platform.computers WHERE id=$1 AND owner_id=$2 FOR UPDATE',[computer.id,computer.ownerId]));
      if(!c||c.state!=='starting'||Number(c.generation)!==computer.generation||json(c.run)?.id!==computer.run.id)deny();
      const old=first(await db.query('SELECT * FROM compute.computer_runs WHERE id=$1',[computer.run.id]));
      if(old){if(old.state!=='active'||old.computer_id!==computer.id||Number(old.generation)!==computer.generation)deny();return old;}
      // Under the node/computer locks, no runtime has ever been dispatched
      // for this run. Only this branch can prove that dispatch never occurred.
      // Transport/baseline failures still throw and preserve uncertain state.
      const refused=()=>({id:computer.run.id,computer_id:computer.id,owner_id:computer.ownerId,node_id:computer.nodeId,
        generation:computer.generation,state:'rejected',noSideEffects:true,errorCode:'computer_capacity_unavailable'});
      const b=await this.#read(db,node,installed),at=new Date(this.#clock());
      const exclusive=(await db.query(`SELECT id::text FROM compute.node_exclusive_intents WHERE node_id=$1
        AND (state='acquired' OR (state='pending' AND deadline_at>$2))
        UNION ALL SELECT id::text FROM compute.lease_sets WHERE node_id=$1 AND state='active' AND node_exclusive AND expires_at>$2
        UNION ALL SELECT id FROM compute.protected_office_set_transactions WHERE node_id=$1 AND transaction_state NOT IN ('succeeded','rolled-back')`,[computer.nodeId,at])).rows;
      if(exclusive.length)return refused();
      const plan=planComputerPlacement({resources:computer.resources,policy:installed.policy,now:Number(this.#clock()),nodes:[{
        ...b,id:computer.nodeId,online:true,architecture:'arm64',
        // A compatible CPU group can be shared by independently isolated VMs.
        availableCpuGroups:b.availableCpuGroups
      }]});
      if(!plan.selected)return refused();
      const desired=runtimeReservation(plan.selected.runtimeMemoryBytes,computer.resources.vcpus*1000);
      return first(await db.query(`INSERT INTO compute.computer_runs(id,computer_id,owner_id,node_id,node_generation,generation,memory_bytes,cpu_millis,cpu_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[computer.run.id,computer.id,computer.ownerId,computer.nodeId,node.generation,
        computer.generation,desired.unifiedMemoryBytes,desired.cpuMillis,JSON.stringify(plan.selected.cpuIds)]));
    });
  }
  async releaseResources({db,computer,operation,result}){
    // Called inside repository.complete after exact identity/result validation,
    // under its node/computer locks, in the same transaction as completion.
    if(result.rejected!==true&&!['shutdown','delete'].includes(operation.action)||result.rejected===true&&result.noSideEffects!==true)deny();
    if(operation.action==='create'||operation.action==='delete'){
      if(operation.action==='delete'&&result.dataDeleted!==true)deny();
      // No speculative storage allocation is acquired or released.
    }else if(computer.run){
      if(!result.rejected&&(result.stopped!==true||result.cleanShutdown!==true||result.runId!==computer.run.id||result.containerId!==computer.run.containerId))deny();
      await db.query("UPDATE compute.computer_runs SET state='released' WHERE id=$1 AND computer_id=$2 AND generation=$3",[computer.run.id,computer.id,computer.generation]);
    }
  }
}
