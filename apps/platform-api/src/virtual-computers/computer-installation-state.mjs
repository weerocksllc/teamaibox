import {computerError,computerId} from './lifecycle.mjs';
import {installationActionInput,requireMountableMedia,requestDiscBoot} from './installation-media.mjs';

export const mapInstallation = r => r && ({phase:r.phase,revision:Number(r.revision),observedRevision:Number(r.observed_revision),
  desiredMediaId:r.desired_media_id,observedMediaId:r.observed_media_id,operationId:r.operation_id,
  autoStart:r.auto_start===true,errorCode:r.error_code??null,
  boot:r.boot_request_id?{id:r.boot_request_id,mediaId:r.boot_media_id,generation:Number(r.boot_generation),state:r.boot_state}:null});

/** Power state and installation intent are distinct. In particular, mounting
 * an ISO never restarts a guest and "installed" is an explicit user statement,
 * not an inference from an open console or a successful power-on. */
export function beginInstallationAction(computer,installation,action,input,{operationId,media=null}) {
  const request=installationActionInput(action,input),id=computerId(operationId);
  if(!installation)computerError('computer_installation_upgrade_required');
  if(installation.revision!==request.expectedRevision)computerError('computer_state_conflict');
  if(installation.operationId||installation.revision!==installation.observedRevision)computerError('computer_operation_pending');
  if(!['stopped','running'].includes(computer.state)||computer.state==='running'&&!computer.run?.containerId)
    computerError('computer_state_conflict');
  let next=structuredClone(installation);
  next.errorCode=null;
  if(action==='mount'||action==='eject') {
    if(next.boot&&['pending','armed'].includes(next.boot.state))computerError('computer_installation_boot_pending');
    if(action==='mount')requireMountableMedia(media,computer.ownerId,request);
    next.desiredMediaId=action==='mount'?media.id:null;
    // Until the same operation observes QMP/staging, preserve the old media
    // reference. Neither copy may be deleted on an uncertain transport reply.
    next.operationId=id;
    next.revision++;
    return {installation:next,queued:true,command:{action,revision:next.revision,
      mediaId:next.desiredMediaId,digest:action==='mount'?media.digest:null,size:action==='mount'?media.size:0}};
  }
  if(action==='boot-disc') {
    // Scheduling next power-on is harmless while running. Restart is a separate
    // named confirmation and the existing graceful-shutdown/start workflow.
    next=requestDiscBoot(next,{operationId:id,nextGeneration:computer.generation+1});
    next.phase='installing';
  } else if(action==='cancel-boot') {
    if(next.boot?.state==='armed')computerError('computer_operation_pending');
    if(next.boot?.state==='pending')next.boot.state='cancelled';
  } else {
    if(next.boot&&['pending','armed'].includes(next.boot.state))computerError('computer_installation_boot_pending');
    next.phase='user-confirmed';
  }
  next.revision++;next.observedRevision=next.revision;
  return {installation:next,queued:false,command:{action,revision:next.revision}};
}

export function completeInstallationAction(computer,installation,operation,result) {
  const expected=operation.command.installation;
  if(!expected||!installation||installation.operationId!==operation.id||installation.revision!==expected.revision
    ||operation.ownerId!==computer.ownerId||operation.computerId!==computer.id||operation.generation!==computer.generation
    ||operation.command.run?.id!==computer.run?.id||result.operationId!==operation.id
    ||result.installationRevision!==expected.revision)computerError('computer_result_mismatch');
  const next=structuredClone(installation);
  if(result.rejected===true) {
    if(result.noSideEffects!==true||!['computer_optical_locked','computer_media_not_ready','computer_installation_upgrade_required',
      'computer_capacity_unavailable','computer_storage_unavailable'].includes(result.errorCode))computerError('computer_result_mismatch');
    next.desiredMediaId=next.observedMediaId;
    next.errorCode=result.errorCode;next.autoStart=false;
  } else {
    if(result.mediaDigest!==expected.digest||result.mediaReady!==true)computerError('computer_result_mismatch');
    next.observedMediaId=next.desiredMediaId;
    next.errorCode=null;
  }
  next.operationId=null;next.revision++;next.observedRevision=next.revision;
  return next;
}

export async function readInstallation(db,ownerId,computerId,lock=false) {
  return mapInstallation((await db.query(`SELECT * FROM platform.computer_installations
    WHERE computer_id=$1 AND owner_id=$2${lock?' FOR UPDATE':''}`,[computerId,ownerId])).rows[0]??null);
}
export async function writeInstallation(db,computerId,next) {
  await db.query(`UPDATE platform.computer_installations SET phase=$2,revision=$3,observed_revision=$4,
    desired_media_id=$5,observed_media_id=$6,operation_id=$7,boot_request_id=$8,boot_media_id=$9,
    boot_generation=$10,boot_state=$11,auto_start=$12,error_code=$13,updated_at=clock_timestamp() WHERE computer_id=$1`,
    [computerId,next.phase,next.revision,next.observedRevision,next.desiredMediaId,next.observedMediaId,next.operationId,
      next.boot?.id??null,next.boot?.mediaId??null,next.boot?.generation??null,next.boot?.state??null,next.autoStart===true,next.errorCode??null]);
}
