import {PlatformError} from '../../../packages/observability/src/index.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest=/^sha256:[a-f0-9]{64}$/;
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const positive=v=>Number.isSafeInteger(v)&&v>0;
const ids=['computerId','ownerId','nodeId','volumeId','firmwareId','operationId'];
export function validateComputerCommand(action,p) {
  if(!['create','start','shutdown','delete','inspect','installation'].includes(action)
    ||!closed(p,[...ids,'poolId','tpmId','profileId','runtimeImage','generation','resources','run',...(Object.hasOwn(p??{},'allocation')?['allocation']:[]),...(Object.hasOwn(p??{},'installation')?['installation']:[])])
    ||ids.some(k=>!uuid.test(p[k]??''))||p.tpmId!==null&&!uuid.test(p.tpmId??'')
    ||typeof p.profileId!=='string'||!/^[a-z0-9][a-z0-9._-]*$/.test(p.profileId)
    ||typeof p.poolId!=='string'||!/^[a-z][a-z0-9_.-]{2,127}$/.test(p.poolId)
    ||!digest.test(p.runtimeImage??'')||!Number.isSafeInteger(p.generation)||p.generation<0||p.generation>=Number.MAX_SAFE_INTEGER
    ||!closed(p.resources,['vcpus','memoryBytes','diskBytes'])||Object.values(p.resources).some(v=>!positive(v)))throw TypeError('Invalid computer command');
  if(['start','shutdown','inspect'].includes(action)||action==='installation'&&p.run!==null) {
    if(p.generation===0||!closed(p.run,['id','generation','containerId','runtimeImage'])||!uuid.test(p.run.id??'')
      ||p.run.generation!==p.generation||p.run.runtimeImage!==p.runtimeImage
      ||p.run.containerId!==null&&!/^[a-f0-9]{64}$/.test(p.run.containerId??'')
      ||action==='shutdown'&&p.run.containerId===null)throw TypeError('Invalid computer run');
  } else if(p.run!==null||action==='create'&&p.generation!==0)throw TypeError('Invalid computer storage command');
  if(action==='installation') {
    const i=p.installation;
    if(!closed(i,['action','revision','mediaId','digest','size'])||!['mount','eject'].includes(i.action)||!positive(i.revision)
      ||i.action==='mount'&&(!uuid.test(i.mediaId??'')||!digest.test(i.digest??'')||!positive(i.size))
      ||i.action==='eject'&&(i.mediaId!==null||i.digest!==null||i.size!==0))throw TypeError('Invalid computer installation command');
  } else if(action==='start'&&Object.hasOwn(p,'installation')) {
    const i=p.installation;
    if(!closed(i,['action','revision','mediaId','digest','size','bootRequestId'])||i.action!=='launch'||!positive(i.revision)
      ||i.mediaId===null&&(i.digest!==null||i.size!==0||i.bootRequestId!==null)
      ||i.mediaId!==null&&(!uuid.test(i.mediaId??'')||!digest.test(i.digest??'')||!positive(i.size))
      ||i.bootRequestId!==null&&!uuid.test(i.bootRequestId??''))throw TypeError('Invalid computer installation launch');
  } else if(Object.hasOwn(p,'installation'))throw TypeError('Unexpected computer installation command');
  if(Object.hasOwn(p,'allocation')) {
    const a=p.allocation;
    if(action!=='start'||!closed(a,['memoryBytes','cpuIds'])||!positive(a.memoryBytes)||a.memoryBytes<=p.resources.memoryBytes
      ||!Array.isArray(a.cpuIds)||a.cpuIds.length!==p.resources.vcpus||a.cpuIds.some(n=>!Number.isSafeInteger(n)||n<0)
      ||new Set(a.cpuIds).size!==a.cpuIds.length)throw TypeError('Invalid computer allocation');
  }
  return structuredClone(p);
}
export function computerCommand(operation) {
  const c=operation.command;
  return validateComputerCommand(operation.action,{computerId:c.computerId,ownerId:c.ownerId,nodeId:c.nodeId,
    volumeId:c.volumeId,firmwareId:c.firmwareId,operationId:operation.id,poolId:c.poolId,tpmId:c.tpmId,
    profileId:c.profile.id,runtimeImage:c.profile.runtimeImage,generation:c.generation,resources:c.resources,run:c.run,
    ...(c.installation?{installation:c.installation}:{})});
}
export function validateComputerCommandResult(action,p,value) {
  const fail=()=>{throw new PlatformError('node_agent_protocol_mismatch','本机返回的电脑状态与当前操作不一致。',{status:502});};
  const required=[...ids,'tpmId','generation'];
  const optional=['runId','containerId','runtimeImage','provisioned','encryption','running','stopped','cleanShutdown','dataDeleted','rejected','noSideEffects','errorCode',
    ...(action==='installation'?['installationRevision','mediaDigest','mediaReady']:[]),
    ...(['start','inspect'].includes(action)?['bootRequestId','bootState']:[])];
  if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>value[k]!==p[k])
    ||Object.keys(value).some(k=>![...required,...optional].includes(k)))fail();
  if(['provisioned','running','stopped','cleanShutdown','dataDeleted','rejected','noSideEffects'].some(k=>value[k]!==undefined&&typeof value[k]!=='boolean')
    ||value.running&&value.stopped||value.cleanShutdown&&!value.stopped)fail();
  if(action==='installation') {
    if(value.installationRevision!==p.installation.revision||value.provisioned||value.dataDeleted||value.running||value.stopped)fail();
    if(p.run!==null&&(value.runId!==p.run.id||value.containerId!==p.run.containerId||value.runtimeImage!==p.runtimeImage))fail();
    if(p.run===null&&(value.runId!==undefined||value.containerId!==undefined||value.runtimeImage!==undefined))fail();
    if(value.rejected===true) {
      if(value.noSideEffects!==true||value.mediaReady||!['computer_optical_locked','computer_media_not_ready',
        'computer_installation_upgrade_required','computer_capacity_unavailable','computer_storage_unavailable'].includes(value.errorCode))fail();
    } else if(value.noSideEffects||value.errorCode||value.mediaReady!==true||value.mediaDigest!==p.installation.digest)fail();
  } else if(value.rejected===true) {
    if(value.noSideEffects!==true||value.running||value.provisioned||value.dataDeleted||!['computer_capacity_unavailable','computer_storage_unavailable','computer_profile_unavailable','computer_permission_required'].includes(value.errorCode))fail();
  } else if(value.noSideEffects||value.errorCode)fail();
  else if(action==='create') { if(value.provisioned!==true||value.encryption!=='luks2'||value.running||value.dataDeleted||value.containerId)fail(); }
  else if(action==='delete') { if(value.dataDeleted!==true||value.running||value.containerId)fail(); }
  else {
    if(value.runId!==p.run?.id||value.runtimeImage!==p.runtimeImage)fail();
    if(action==='start'&&(value.running!==true||!/^[a-f0-9]{64}$/.test(value.containerId??'')))fail();
    if(action==='shutdown'&&(value.stopped!==true||value.cleanShutdown!==true||value.containerId!==p.run.containerId))fail();
    if(action==='inspect'&&(!/^[a-f0-9]{64}$/.test(value.containerId??'')
      ||p.run.containerId!==null&&value.containerId!==p.run.containerId
      ||!(value.stopped===true&&value.running!==true||value.running===true&&value.stopped!==true)))fail();
  }
  if(value.rejected!==true&&action==='start'&&p.installation?.bootRequestId) {
    if(value.bootRequestId!==p.installation.bootRequestId||!['armed','consumed'].includes(value.bootState))fail();
  } else if(value.bootRequestId!==undefined||value.bootState!==undefined) {
    if(action!=='inspect'||!uuid.test(value.bootRequestId??'')||!['armed','consumed'].includes(value.bootState))fail();
  }
  return structuredClone(value);
}
