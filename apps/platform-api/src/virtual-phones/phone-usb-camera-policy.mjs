import {identifier,integer,record,failPhone} from './contracts.mjs';
import {cameraError} from './phone-camera-contracts.mjs';

export function usbCameraSelection(value){
  record(value,['kind','deviceId','attachmentId','continueWithoutViewer']);
  if(value.kind!=='usb'||value.continueWithoutViewer!==true)cameraError('phone_camera_source_unsupported');
  if(typeof value.attachmentId!=='string'||! /^[a-f0-9]{64}$/.test(value.attachmentId))failPhone('phone_input_invalid');
  return {kind:'usb',deviceId:identifier(value.deviceId),attachmentId:value.attachmentId,continueWithoutViewer:true};
}
export function usbCameraPolicyInput(input){
  record(input,['enabled','ownerIds','expectedRevision']);
  if(typeof input.enabled!=='boolean'||!Array.isArray(input.ownerIds))failPhone('phone_input_invalid');
  const ownerIds=input.ownerIds.map(identifier).sort();
  if(new Set(ownerIds).size!==ownerIds.length)failPhone('phone_input_invalid');
  return {enabled:input.enabled,ownerIds,expectedRevision:integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER-1)};
}

// Called inside the source reservation transaction, after the phone lock.
// Policy updates acquire the conflicting row lock, so revocation cannot race
// an unrecorded source past the admission decision.
export async function lockUsbCameraPermission(db,{nodeId,ownerId,source}){
  const {rows}=await db.query(`SELECT p.revision FROM platform.phone_usb_camera_policy p
    JOIN platform.phone_usb_camera_users u ON u.node_id=p.node_id AND u.device_id=p.device_id
    WHERE p.node_id=$1 AND p.device_id=$2 AND u.owner_id=$3 AND p.enabled FOR SHARE OF p,u`,
    [identifier(nodeId),identifier(source.deviceId),identifier(ownerId)]);
  if(rows.length!==1)cameraError('phone_camera_usb_permission_required');
  return Number(rows[0].revision);
}

// Reused by source renewal and list/status. No policy query on old installations
// until the USB schema and adapter are deliberately configured.
export const usbCameraAuthorizedSQL=`(c.source_kind<>'usb' OR EXISTS (
  SELECT 1 FROM platform.phone_usb_camera_policy d JOIN platform.phone_usb_camera_users u
  ON u.node_id=d.node_id AND u.device_id=d.device_id WHERE d.node_id=c.usb_node_id
  AND d.node_id=r.node_id AND d.node_id=p.node_id AND d.device_id=c.usb_device_id
  AND d.enabled AND d.revision=c.usb_policy_revision AND u.owner_id=c.owner_id))`;

export class PostgresPhoneUsbCameraPolicy {
  #database;
  constructor({database}){
    if(!database?.query||!database?.transaction)throw TypeError('USB camera policy requires PostgreSQL');
    this.#database=database;
  }
  async listAllowed({nodeId,ownerId}){
    return (await this.#database.query(`SELECT p.device_id FROM platform.phone_usb_camera_policy p
      JOIN platform.phone_usb_camera_users u ON u.node_id=p.node_id AND u.device_id=p.device_id
      WHERE p.node_id=$1 AND p.enabled AND u.owner_id=$2 ORDER BY p.device_id`,[identifier(nodeId),identifier(ownerId)])).rows.map(r=>r.device_id);
  }
  async listPolicies({nodeId}){
    const {rows}=await this.#database.query(`SELECT p.device_id,p.enabled,p.revision,
      coalesce(array_agg(u.owner_id ORDER BY u.owner_id) FILTER(WHERE u.owner_id IS NOT NULL),'{}') AS owners
      FROM platform.phone_usb_camera_policy p LEFT JOIN platform.phone_usb_camera_users u
      ON u.node_id=p.node_id AND u.device_id=p.device_id WHERE p.node_id=$1
      GROUP BY p.device_id,p.enabled,p.revision ORDER BY p.device_id`,[identifier(nodeId)]);
    return rows.map(r=>({deviceId:r.device_id,enabled:r.enabled,revision:Number(r.revision),ownerIds:r.owners}));
  }
  async configure({nodeId,deviceId,actorId,input}){
    identifier(nodeId);identifier(deviceId);identifier(actorId);
    const policy=usbCameraPolicyInput(input);
    return this.#database.transaction(async db=>{
      // Lock the node for the initial insert too; no absent-row upsert race.
      if((await db.query('SELECT id FROM compute.nodes WHERE id=$1 FOR UPDATE',[nodeId])).rows.length!==1)failPhone('phone_node_unavailable');
      const old=(await db.query('SELECT revision FROM platform.phone_usb_camera_policy WHERE node_id=$1 AND device_id=$2 FOR UPDATE',[nodeId,deviceId])).rows[0];
      if(Number(old?.revision??0)!==policy.expectedRevision)failPhone('phone_state_conflict');
      if(policy.ownerIds.length&&(await db.query(`SELECT id FROM iam.identities WHERE id=ANY($1::uuid[])
        AND status='active' AND identity_kind='local_user' FOR SHARE`,[policy.ownerIds])).rows.length!==policy.ownerIds.length)failPhone('phone_input_invalid');
      const revision=policy.expectedRevision+1;
      await db.query(`INSERT INTO platform.phone_usb_camera_policy(node_id,device_id,enabled,revision,updated_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(node_id,device_id) DO UPDATE SET enabled=EXCLUDED.enabled,
        revision=EXCLUDED.revision,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,[nodeId,deviceId,policy.enabled,revision,actorId]);
      await db.query('DELETE FROM platform.phone_usb_camera_users WHERE node_id=$1 AND device_id=$2',[nodeId,deviceId]);
      if(policy.ownerIds.length)await db.query(`INSERT INTO platform.phone_usb_camera_users(node_id,device_id,owner_id)
        SELECT $1,$2,id FROM unnest($3::uuid[]) AS id`,[nodeId,deviceId,policy.ownerIds]);
      return {nodeId,deviceId,enabled:policy.enabled,revision,ownerIds:policy.ownerIds};
    });
  }
}
