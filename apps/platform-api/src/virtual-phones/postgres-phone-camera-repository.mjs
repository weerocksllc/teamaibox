import {randomUUID} from 'node:crypto';
import {failPhone,identifier,integer} from './contracts.mjs';
import {cameraError,cameraStartInput} from './phone-camera-contracts.mjs';
import {lockUsbCameraPermission,usbCameraAuthorizedSQL} from './phone-usb-camera-policy.mjs';
import {lockUdpCameraPermission,udpCameraAuthorizedSQL} from './phone-udp-camera-policy.mjs';
import {phoneApprovedNodes} from '../../../../services/scheduler/src/phone-approved-nodes.mjs';
import {installedPhoneRuntime} from '../../../../services/scheduler/src/phone-rom.mjs';

const row=r=>r&&({id:r.id,sourceId:r.source_id,phoneId:r.phone_id,ownerId:r.owner_id,runId:r.run_id,
  generation:Number(r.generation),sessionId:r.session_id,sourceKind:r.source_kind,source:r.source_config,
  fingerprint:r.request_fingerprint,state:r.state,authorized:r.authorized===true,
  ...(r.source_kind==='usb'?{usbNodeId:r.usb_node_id,usbPolicyRevision:Number(r.usb_policy_revision)}:{}),
  ...(r.source_kind==='udp'?{udpNodeId:r.udp_node_id,udpPolicyRevision:Number(r.udp_policy_revision)}:{})});
const first=r=>r.rows[0]??null;
const liveLogin=`s.revoked_at IS NULL AND i.status='active' AND i.identity_kind='local_user'
  AND s.password_version=i.password_version AND least(s.idle_expires_at,s.expires_at)>clock_timestamp()`;
export class PostgresPhoneCameraRepository {
  #database;#usbEnabled;#udpEnabled;#nodes;
  constructor({database,usbEnabled=false,udpEnabled=false,approvedNodes=[]}){if(!database?.transaction||!database?.query)throw TypeError('Camera inputs require PostgreSQL');this.#database=database;this.#usbEnabled=usbEnabled===true;this.#udpEnabled=udpEnabled===true;this.#nodes=phoneApprovedNodes(approvedNodes);}
  #authorized(){return `(${this.#usbEnabled?usbCameraAuthorizedSQL:"c.source_kind<>'usb'"}) AND (${this.#udpEnabled?udpCameraAuthorizedSQL:"c.source_kind<>'udp'"})`;}
  async #selected(db,{ownerId,phoneId,sessionId,generation}){
    identifier(ownerId);identifier(phoneId);identifier(sessionId);integer(generation,1,Number.MAX_SAFE_INTEGER);
    if(!first(await db.query(`SELECT s.id FROM iam.sessions s JOIN iam.identities i ON i.id=s.identity_id
      WHERE s.id=$1 AND s.identity_id=$2 AND ${liveLogin} FOR SHARE OF s,i`,[sessionId,ownerId])))failPhone('phone_grant_invalid');
    const p=first(await db.query(`SELECT p.*,v.camera_capability,v.runtime_image_digest FROM platform.phones p
      JOIN platform.phone_rom_versions v ON v.id=p.rom_version_id WHERE p.id=$1 AND p.owner_id=$2 AND p.state<>'deleted' FOR UPDATE OF p`,[phoneId,ownerId]));
    if(!p)failPhone('phone_not_found');
    if(p.state!=='running'||Number(p.generation)!==generation)failPhone('phone_stale_run');
    const r=first(await db.query(`SELECT * FROM platform.phone_runs WHERE phone_id=$1 AND owner_id=$2 AND generation=$3 AND state='running' FOR SHARE`,[phoneId,ownerId,generation]));
    if(!r||r.node_id!==p.node_id)failPhone('phone_stale_run');
    // A host runtime repair does not replace the phone's Android system or data.
    // Use the same maintenance mapping as start/display, not ROM byte equality.
    if(r.image_digest!==p.runtime_image_digest&&!installedPhoneRuntime(this.#nodes.get(p.node_id),{
      id:p.id,ownerId:p.owner_id,volumeId:p.volume_id,romVersionId:p.rom_version_id,
      rom:{imageDigest:p.runtime_image_digest}},r.image_digest))failPhone('phone_stale_run');
    return {ownerId,phoneId,sessionId,generation,runId:r.id,nodeId:r.node_id,imageDigest:r.image_digest,
      volumeId:p.volume_id,romImageDigest:p.runtime_image_digest,
      romVersionId:p.rom_version_id,cameraCapability:p.camera_capability,memoryBytes:Number(r.memory_bytes),cpuMillis:Number(r.cpu_millis)};
  }
  assertSelected(args){return this.#database.transaction(db=>this.#selected(db,args));}
  async reserve(args){
    const spec=cameraStartInput({expectedGeneration:args.expectedGeneration,requestId:args.sourceId,source:args.source});
    if(spec.sourceKind==='usb'&&!this.#usbEnabled)cameraError('phone_camera_unavailable');
    if(spec.sourceKind==='udp'&&!this.#udpEnabled)cameraError('phone_camera_unavailable');
    try{return await this.#database.transaction(async db=>{
      const selected=await this.#selected(db,args);
      if(selected.runId!==args.runId)failPhone('phone_stale_run');
      if(selected.cameraCapability!=='verified')cameraError('phone_camera_unavailable');
      const existing=first(await db.query(`SELECT * FROM platform.phone_camera_inputs WHERE phone_id=$1 AND source_id=$2`,[args.phoneId,spec.sourceId]));
      if(existing){
        if(existing.owner_id!==args.ownerId||existing.session_id!==args.sessionId||existing.run_id!==args.runId||existing.request_fingerprint!==spec.fingerprint)failPhone('phone_idempotency_conflict');
        return {...row(existing),created:false};
      }
      if(first(await db.query(`SELECT id FROM platform.phone_camera_inputs WHERE phone_id=$1 AND state<>'stopped'`,[args.phoneId])))failPhone('phone_operation_conflict');
      const usb=spec.sourceKind==='usb';
      const revision=usb?await lockUsbCameraPermission(db,{nodeId:selected.nodeId,ownerId:selected.ownerId,source:spec.source}):null;
      const udp=spec.sourceKind==='udp',policy=udp?await lockUdpCameraPermission(db,{nodeId:selected.nodeId,ownerId:selected.ownerId,source:spec.source}):null;
      const value=first(await db.query(`INSERT INTO platform.phone_camera_inputs
        (id,source_id,phone_id,owner_id,run_id,generation,session_id,source_kind,source_config,request_fingerprint,state${usb?',usb_node_id,usb_device_id,usb_policy_revision':udp?',udp_node_id,udp_policy_id,udp_policy_revision':''})
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'starting'${usb||udp?',$11,$12,$13':''}) RETURNING *`,
        [randomUUID(),spec.sourceId,args.phoneId,args.ownerId,args.runId,args.generation,args.sessionId,spec.sourceKind,spec.source,spec.fingerprint,
          ...(usb?[selected.nodeId,spec.source.deviceId,revision]:udp?[selected.nodeId,policy.id,policy.revision]:[])]));
      return {...row(value),created:true,...(udp?{udpPolicy:{listenAddress:policy.listenAddress,listenPort:policy.listenPort,allowedSources:policy.allowedSources}}:{})};
    });}catch(error){
      if(error.code==='23505'&&error.constraint==='phone_camera_usb_exclusive_idx')cameraError('phone_camera_usb_busy');
      if(error.code==='23505'&&error.constraint==='phone_camera_udp_exclusive_idx')cameraError('phone_camera_udp_port_unavailable');
      throw error;
    }
  }
  async activate(value){
    return this.#database.transaction(async db=>{
      const selected=await this.#selected(db,value);if(selected.runId!==value.runId)failPhone('phone_stale_run');
      if(value.sourceKind==='usb'&&(!this.#usbEnabled||await lockUsbCameraPermission(db,{nodeId:selected.nodeId,ownerId:selected.ownerId,source:value.source})!==value.usbPolicyRevision))cameraError('phone_camera_source_stopped');
      if(value.sourceKind==='udp'&&(!this.#udpEnabled||(await lockUdpCameraPermission(db,{nodeId:selected.nodeId,ownerId:selected.ownerId,source:value.source})).revision!==value.udpPolicyRevision))cameraError('phone_camera_source_stopped');
      const result=first(await db.query(`UPDATE platform.phone_camera_inputs SET state='active',updated_at=clock_timestamp()
        WHERE id=$1 AND phone_id=$2 AND owner_id=$3 AND run_id=$4 AND generation=$5 AND session_id=$6 AND state='starting' RETURNING *`,
        [value.id,value.phoneId,value.ownerId,value.runId,value.generation,value.sessionId]));
      if(!result)cameraError('phone_camera_source_stopped');return row(result);
    });
  }
  async #active({id=null,ownerId=null,phoneId=null}={}){
    return (await this.#database.query(`SELECT c.*,(${liveLogin} AND p.state='running' AND r.state='running'
      AND p.generation=c.generation AND c.state IN ('starting','active') AND ${this.#authorized()}) AS authorized
      FROM platform.phone_camera_inputs c JOIN iam.sessions s ON s.id=c.session_id AND s.identity_id=c.owner_id
      JOIN iam.identities i ON i.id=c.owner_id JOIN platform.phones p ON p.id=c.phone_id AND p.owner_id=c.owner_id
      JOIN platform.phone_runs r ON r.id=c.run_id AND r.phone_id=c.phone_id AND r.owner_id=c.owner_id AND r.generation=c.generation
      WHERE c.state<>'stopped' AND ($1::uuid IS NULL OR c.id=$1) AND ($2::uuid IS NULL OR c.owner_id=$2)
      AND ($3::uuid IS NULL OR c.phone_id=$3) ORDER BY c.created_at,c.id`,[id,ownerId,phoneId])).rows.map(row);
  }
  active(){return this.#active();}
  async listStates({ownerId,phones}){
    identifier(ownerId);
    if(!Array.isArray(phones))failPhone('phone_input_invalid');
    for(const p of phones){identifier(p.id);integer(p.generation,0,Number.MAX_SAFE_INTEGER);}
    if(!phones.length)return [];
    // One metadata query for the owner list. Never open Docker, read an image,
    // or poll each phone's media socket while rendering the phone list.
    const values=await this.#database.query(`SELECT c.phone_id,c.source_id,c.source_kind,c.state,c.generation,
      (${liveLogin} AND p.state='running' AND r.state='running' AND p.generation=c.generation AND ${this.#authorized()}) AS authorized
      FROM unnest($2::uuid[],$3::bigint[]) AS selected(id,generation)
      JOIN platform.phones p ON p.id=selected.id AND p.owner_id=$1 AND p.state<>'deleted'
      JOIN platform.phone_camera_inputs c ON c.phone_id=p.id AND c.owner_id=p.owner_id AND c.generation=selected.generation
      JOIN platform.phone_runs r ON r.id=c.run_id AND r.phone_id=p.id AND r.owner_id=p.owner_id AND r.generation=c.generation
      JOIN iam.sessions s ON s.id=c.session_id AND s.identity_id=c.owner_id JOIN iam.identities i ON i.id=c.owner_id
      WHERE c.state<>'stopped' AND p.generation=selected.generation ORDER BY c.phone_id`,[ownerId,phones.map(p=>p.id),phones.map(p=>p.generation)]);
    return values.rows.map(c=>({phoneId:c.phone_id,generation:Number(c.generation),sourceId:c.source_id,
      sourceKind:c.source_kind,state:c.authorized===true?c.state:'stopping'}));
  }
  async get(id){return (await this.#active({id:identifier(id)}))[0]??null;}
  async current({ownerId,phoneId}){return (await this.#active({ownerId:identifier(ownerId),phoneId:identifier(phoneId)}))[0]??null;}
  async beginStop({ownerId,phoneId,id=null,sessionId=null,runId=null}){
    identifier(ownerId);identifier(phoneId);for(const v of [id,sessionId,runId])if(v!==null)identifier(v);
    return this.#database.transaction(async db=>{
      // Same phone lock as reserve, including already-stopping/deleted phones.
      if(!first(await db.query(`SELECT id FROM platform.phones WHERE id=$1 AND owner_id=$2 FOR UPDATE`,[phoneId,ownerId])))failPhone('phone_not_found');
      return (await db.query(`UPDATE platform.phone_camera_inputs SET state='stopping',updated_at=clock_timestamp()
        WHERE phone_id=$1 AND owner_id=$2 AND state<>'stopped' AND ($3::uuid IS NULL OR id=$3)
        AND ($4::uuid IS NULL OR session_id=$4) AND ($5::uuid IS NULL OR run_id=$5) RETURNING *`,[phoneId,ownerId,id,sessionId,runId])).rows.map(row);
    });
  }
  async confirmStopped(value){
    const args=[value.id,value.phoneId,value.ownerId,value.runId,value.generation,value.sessionId];
    const binding=`id=$1 AND phone_id=$2 AND owner_id=$3 AND run_id=$4 AND generation=$5 AND session_id=$6`;
    const updated=first(await this.#database.query(`UPDATE platform.phone_camera_inputs SET state='stopped',updated_at=clock_timestamp(),stopped_at=clock_timestamp()
      WHERE ${binding} AND state='stopping' RETURNING *`,args));
    if(updated)return row(updated);
    const existing=first(await this.#database.query(`SELECT * FROM platform.phone_camera_inputs WHERE ${binding} AND state='stopped'`,args));
    if(!existing)cameraError('phone_camera_source_stopped');return row(existing);
  }
}
