import {isIPv4} from 'node:net';
import {PlatformError} from '../../../../packages/observability/src/index.mjs';
import {identifier,integer,record,failPhone} from './contracts.mjs';

export function udpCameraError(code){
  const errors={permission_required:[403,'没有使用此网络摄像头入口的权限。'],
    busy:[409,'此网络摄像头入口正在使用中，请先停止原输入。'],
    unavailable:[409,'此网络摄像头入口不可用，请刷新后重新选择。']};
  if(!errors[code])throw TypeError('Unknown network camera error');
  throw new PlatformError('phone_camera_udp_'+code,errors[code][1],{status:errors[code][0]});
}

function address(value){
  if(typeof value!=='string'||!isIPv4(value))failPhone('phone_input_invalid');
  const p=value.split('.').map(Number);
  if(p[0]===0||p[0]>=224||p[0]===169&&p[1]===254)failPhone('phone_input_invalid');
  return value;
}
function network(value){
  if(typeof value!=='string'||!value.includes('/'))failPhone('phone_input_invalid');
  const parts=value.split('/');if(parts.length!==2||!/^\d+$/.test(parts[1]))failPhone('phone_input_invalid');
  const ip=address(parts[0]),prefix=integer(Number(parts[1]),1,32);
  const number=ip.split('.').reduce((n,v)=>(n*256+Number(v))>>>0,0),mask=(0xffffffff<<(32-prefix))>>>0;
  if(((number&mask)>>>0)!==number)failPhone('phone_input_invalid');
  return ip+'/'+prefix;
}

export function udpCameraPolicyInput(input){
  record(input,['name','enabled','listenAddress','listenPort','allowedSources','ownerIds','expectedRevision']);
  if(typeof input.name!=='string'||!input.name.trim()||/[\p{Cc}\p{Cf}]/u.test(input.name)
    ||typeof input.enabled!=='boolean'||!Array.isArray(input.ownerIds)
    ||!Array.isArray(input.allowedSources)||!input.allowedSources.length)failPhone('phone_input_invalid');
  const ownerIds=input.ownerIds.map(identifier).sort(),allowedSources=input.allowedSources.map(network).sort();
  if(new Set(ownerIds).size!==ownerIds.length||new Set(allowedSources).size!==allowedSources.length)failPhone('phone_input_invalid');
  return {name:input.name.trim(),enabled:input.enabled,listenAddress:address(input.listenAddress),listenPort:integer(input.listenPort,1024,65535),
    allowedSources,ownerIds,expectedRevision:integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER-1)};
}
export function udpCameraSelection(source){
  record(source,['kind','policyId','policyRevision','continueWithoutViewer']);
  if(source.kind!=='udp'||source.continueWithoutViewer!==true)failPhone('phone_input_invalid');
  return {kind:'udp',policyId:identifier(source.policyId),policyRevision:integer(source.policyRevision,1,Number.MAX_SAFE_INTEGER),continueWithoutViewer:true};
}

const project=r=>({id:r.id,nodeId:r.node_id,name:r.name,enabled:r.enabled,listenAddress:r.listen_address,listenPort:r.listen_port,
  allowedSources:r.allowed_sources,revision:Number(r.revision),ownerIds:r.owners??[],externalInputEncrypted:false,format:'UDP/MPEG-TS/H.264'});
export const udpCameraAuthorizedSQL=`(c.source_kind<>'udp' OR EXISTS (
 SELECT 1 FROM platform.phone_udp_camera_policy d JOIN platform.phone_udp_camera_users u ON u.policy_id=d.id
 WHERE d.id=c.udp_policy_id AND d.node_id=c.udp_node_id AND d.node_id=r.node_id AND d.node_id=p.node_id
 AND d.enabled AND d.revision=c.udp_policy_revision AND u.owner_id=c.owner_id))`;

export async function lockUdpCameraPermission(db,{nodeId,ownerId,source}){
  const {rows}=await db.query(`SELECT p.* FROM platform.phone_udp_camera_policy p
    JOIN platform.phone_udp_camera_users u ON u.policy_id=p.id
    WHERE p.id=$1 AND p.node_id=$2 AND p.enabled AND p.revision=$3 AND u.owner_id=$4 FOR SHARE OF p,u`,
    [identifier(source.policyId),identifier(nodeId),source.policyRevision,identifier(ownerId)]);
  if(rows.length!==1)udpCameraError('permission_required');return project(rows[0]);
}

export class PostgresPhoneUdpCameraPolicy {
  #database;
  constructor({database}){if(!database?.query||!database?.transaction)throw TypeError('Network camera policy requires PostgreSQL');this.#database=database;}
  async list({nodeId,ownerId=null}){
    const {rows}=await this.#database.query(`SELECT p.*,coalesce(array_agg(u.owner_id ORDER BY u.owner_id)
      FILTER(WHERE u.owner_id IS NOT NULL),'{}') AS owners FROM platform.phone_udp_camera_policy p
      LEFT JOIN platform.phone_udp_camera_users u ON u.policy_id=p.id WHERE p.node_id=$1
      AND ($2::uuid IS NULL OR p.enabled AND EXISTS(SELECT 1 FROM platform.phone_udp_camera_users a WHERE a.policy_id=p.id AND a.owner_id=$2))
      GROUP BY p.id ORDER BY p.name,p.id`,[identifier(nodeId),ownerId===null?null:identifier(ownerId)]);
    return rows.map(project);
  }
  async configure({nodeId,policyId,actorId,input}){
    identifier(nodeId);identifier(policyId);identifier(actorId);const v=udpCameraPolicyInput(input);
    try{return await this.#database.transaction(async db=>{
      if((await db.query('SELECT id FROM compute.nodes WHERE id=$1 FOR UPDATE',[nodeId])).rows.length!==1)failPhone('phone_node_unavailable');
      const old=(await db.query('SELECT node_id,revision FROM platform.phone_udp_camera_policy WHERE id=$1 FOR UPDATE',[policyId])).rows[0];
      if(old&&old.node_id!==nodeId||Number(old?.revision??0)!==v.expectedRevision)failPhone('phone_state_conflict');
      if(v.ownerIds.length&&(await db.query("SELECT id FROM iam.identities WHERE id=ANY($1::uuid[]) AND status='active' AND identity_kind='local_user' FOR SHARE",[v.ownerIds])).rows.length!==v.ownerIds.length)failPhone('phone_input_invalid');
      const revision=v.expectedRevision+1;
      await db.query(`INSERT INTO platform.phone_udp_camera_policy(id,node_id,name,enabled,listen_address,listen_port,allowed_sources,revision,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,
        listen_address=EXCLUDED.listen_address,listen_port=EXCLUDED.listen_port,allowed_sources=EXCLUDED.allowed_sources,
        revision=EXCLUDED.revision,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
        [policyId,nodeId,v.name,v.enabled,v.listenAddress,v.listenPort,v.allowedSources,revision,actorId]);
      await db.query('DELETE FROM platform.phone_udp_camera_users WHERE policy_id=$1',[policyId]);
      if(v.ownerIds.length)await db.query('INSERT INTO platform.phone_udp_camera_users(policy_id,owner_id) SELECT $1,id FROM unnest($2::uuid[]) AS id',[policyId,v.ownerIds]);
      return {...v,id:policyId,nodeId,revision,externalInputEncrypted:false,format:'UDP/MPEG-TS/H.264'};
    });}catch(e){if(e.code==='23505')udpCameraError('busy');throw e;}
  }
}
