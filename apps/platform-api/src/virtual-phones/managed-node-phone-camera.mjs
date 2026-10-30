import {phoneApprovedNodes} from '../../../../services/scheduler/src/phone-approved-nodes.mjs';
import {installedPhoneRom,installedPhoneRuntime} from '../../../../services/scheduler/src/phone-rom.mjs';
import {validatePhoneCameraCommand,validatePhoneCameraResult} from '../../../../services/scheduler/src/android-phone-camera-command.mjs';
import {identifier,failPhone,PHONE_SPEC} from './contracts.mjs';
import {cameraGrant,cameraError} from './phone-camera-contracts.mjs';
import {createHash} from 'node:crypto';
import {browserCameraOffer} from './phone-browser-camera-sdp.mjs';

export class PostgresPhoneCameraRoutes {
  #database;#nodes;
  constructor({database,approvedNodes}){
    if(typeof database?.query!=='function')throw TypeError('Phone camera routes require PostgreSQL');
    this.#database=database;this.#nodes=phoneApprovedNodes(approvedNodes);
  }
  async resolve(grant,action){
    for(const k of ['id','sourceId','phoneId','ownerId','runId','sessionId'])identifier(grant?.[k]);
    if(!['image','browser','video','usb','udp'].includes(grant.sourceKind)||!Number.isSafeInteger(grant.generation)||grant.generation<1)failPhone('phone_grant_invalid');
    const {rows}=await this.#database.query(`SELECT p.id,p.owner_id,p.volume_id,p.pool_id,p.base_build_id,p.spec_id,p.storage_bytes,
      p.generation,p.node_id,p.state,p.rom_version_id,v.runtime_image_digest,v.camera_capability,
      r.id AS run_id,r.node_generation,r.image_digest,r.memory_bytes,r.cpu_millis,r.reservation_id,r.state AS run_state
      FROM platform.phones p JOIN platform.phone_rom_versions v ON v.id=p.rom_version_id JOIN platform.phone_runs r ON r.phone_id=p.id AND r.owner_id=p.owner_id
      WHERE p.id=$1 AND p.owner_id=$2 AND r.id=$3 AND p.generation=$4 AND r.generation=$4 AND p.state<>'deleted'`,
      [grant.phoneId,grant.ownerId,grant.runId,grant.generation]);
    if(rows.length!==1)failPhone('phone_stale_run');
    const row=rows[0],node=this.#nodes.get(row.node_id),rom=installedPhoneRuntime(node,{id:row.id,ownerId:row.owner_id,
      volumeId:row.volume_id,romVersionId:row.rom_version_id,rom:{imageDigest:row.runtime_image_digest}},row.image_digest);
    if(!node||!rom||node.poolId!==row.pool_id||rom.imageDigest!==row.image_digest||!Number.isSafeInteger(Number(row.node_generation))||Number(row.node_generation)<node.nodeGeneration)failPhone('phone_node_unavailable');
    if(row.camera_capability!=='verified')cameraError('phone_camera_unavailable');
    if(['browser','video','usb','udp'].includes(grant.sourceKind)&&!rom.cameraSources?.includes(grant.sourceKind)&&action!=='close')cameraError('phone_camera_unavailable');
    if(row.id!==grant.phoneId||row.owner_id!==grant.ownerId||row.run_id!==grant.runId||Number(row.generation)!==grant.generation
      ||row.base_build_id!==PHONE_SPEC.buildId||row.spec_id!==PHONE_SPEC.id||Number(row.storage_bytes)!==PHONE_SPEC.storageBytes
      ||Number(row.memory_bytes)!==PHONE_SPEC.memoryBytes||Number(row.cpu_millis)!==PHONE_SPEC.cpuMillis
      ||action!=='close'&&(row.state!=='running'||row.run_state!=='running'))failPhone('phone_stale_run');
    return {nodeId:node.nodeId,nodeGeneration:Number(row.node_generation),payload:{phoneId:grant.phoneId,ownerId:grant.ownerId,
      volumeId:identifier(row.volume_id),poolId:row.pool_id,baseBuildId:row.base_build_id,operationId:grant.id,generation:grant.generation,
      run:{id:grant.runId,reservationId:identifier(row.reservation_id),imageDigest:row.image_digest,memoryBytes:PHONE_SPEC.memoryBytes,cpuMillis:PHONE_SPEC.cpuMillis},
      grantId:grant.id,sourceId:grant.sourceId,sourceKind:grant.sourceKind,sessionId:grant.sessionId}};
  }
  capabilities(selected){
    const node=this.#nodes.get(selected.nodeId),rom=selected.romImageDigest
      ?installedPhoneRuntime(node,{id:selected.phoneId,ownerId:selected.ownerId,volumeId:selected.volumeId,
        romVersionId:selected.romVersionId,rom:{imageDigest:selected.romImageDigest}},selected.imageDigest)
      :installedPhoneRom(node,selected.romVersionId,selected.imageDigest);
    return {image:selected.cameraCapability==='verified'&&Boolean(rom),
      ...(rom?.cameraSources?.includes('browser')?{browser:selected.cameraCapability==='verified'}:{}),
      ...(rom?.cameraSources?.includes('video')?{video:selected.cameraCapability==='verified'}:{}),
      ...(rom?.cameraSources?.includes('usb')?{usb:selected.cameraCapability==='verified'}:{}),
      ...(rom?.cameraSources?.includes('udp')?{udp:selected.cameraCapability==='verified'}:{})};
  }
  usbNode(nodeId){const node=this.#nodes.get(identifier(nodeId));if(!node)failPhone('phone_node_unavailable');return {nodeId,nodeGeneration:node.nodeGeneration};}
}

export class ManagedNodePhoneCamera {
  maximumLeaseMilliseconds=5000;resourceScope='phone-run';#routes;#router;
  constructor({routes,nodeAgentRouter}){
    if(typeof routes?.resolve!=='function'||typeof routes?.capabilities!=='function'||typeof nodeAgentRouter?.executePhoneCamera!=='function')throw TypeError('Phone camera route incomplete');
    this.#routes=routes;this.#router=nodeAgentRouter;
  }
  capabilities(selected){return this.#routes.capabilities(selected);}
  async #execute(action,{grant,leaseExpiresAt,metadata,chunks,peerAddress,loop,signal,source,policy}){
    signal?.throwIfAborted();
    const binding=cameraGrant(grant),selected=await this.#routes.resolve(binding,action);
    const upload=['image','video','browser-offer'].includes(action);
    const payload=validatePhoneCameraCommand({...selected.payload,action,deadline:Date.now()+(upload||['usb','udp'].includes(action)?14000:4000),
      ...(['open','renew'].includes(action)?{leaseExpiresAt}:{}),...(upload?{sizeBytes:metadata.sizeBytes,sha256:metadata.sha256}:{}),
      ...(action==='browser-offer'?{peerAddress}:{}),...(action==='video'?{loop}:{}),
      ...(action==='usb'?{deviceId:source.deviceId,attachmentId:source.attachmentId}:{}),...(action==='udp'?{udpPolicy:policy}:{})});
    try{
      return validatePhoneCameraResult(payload,await this.#router.executePhoneCamera({...selected,payload,chunks,signal,correlationId:`phone-camera:${grant.id}`}));
    }catch(error){
      signal?.throwIfAborted();
      const publicCode=['phone_camera_image_unsupported','phone_camera_image_too_large','phone_camera_video_unsupported','phone_camera_video_too_large','phone_camera_source_stopped','phone_camera_storage_full','phone_camera_video_memory_unavailable','phone_camera_usb_busy','phone_camera_usb_device_changed','phone_camera_udp_port_unavailable'].includes(error?.message)?error.message:'phone_camera_runtime_unavailable';
      const known=['phone_camera_not_ready','phone_runtime_status_unavailable','phone_runtime_status_stale','phone_camera_worker_failed','phone_camera_result_invalid','phone_camera_payload_invalid','phone_stale_run','phone_stop_unconfirmed','phone_camera_input_rejected','phone_camera_cancelled','phone_camera_response_truncated'];
      try{cameraError(publicCode);}catch(wrapped){
        wrapped.cameraDiagnosticCode=known.includes(error?.message)?error.message:publicCode;
        wrapped.cameraAction=action;throw wrapped;
      }
    }
  }
  open(value){return this.#execute('open',value);}
  renew(value){return this.#execute('renew',value);}
  image(value){return this.#execute('image',value);}
  video(value){return this.#execute('video',value);}
  usb(value){return this.#execute('usb',value);}
  udp(value){return this.#execute('udp',value);}
  async usbNodeDevices({nodeId}){
    if(typeof this.#router.readPhoneUsbInventory!=='function')cameraError('phone_camera_unavailable');
    return this.#router.readPhoneUsbInventory({...this.#routes.usbNode(nodeId),correlationId:'phone-usb-inventory'});
  }
  async usbDevices(selected){
    if(this.capabilities(selected).usb!==true)cameraError('phone_camera_unavailable');
    return {...await this.usbNodeDevices(selected),runId:selected.runId,generation:selected.generation};
  }
  async browserOffer({grant,offerSdp,allowedAddresses,signal}){
    if(typeof offerSdp!=='string'||Buffer.byteLength(offerSdp)>65536||!Array.isArray(allowedAddresses)||allowedAddresses.length!==1)cameraError('phone_camera_unavailable');
    let normalized;
    try{normalized=browserCameraOffer(offerSdp,allowedAddresses[0]);}
    catch{cameraError('phone_camera_network_unavailable');}
    const raw=Buffer.from(normalized,'utf8');
    try{return await this.#execute('browser-offer',{grant,signal,peerAddress:allowedAddresses[0],
      metadata:{sizeBytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')},chunks:(async function*(){yield raw;})()});}
    finally{raw.fill(0);}
  }
  close(value){return this.#execute('close',value);}
  status(value){return this.#execute('status',value);}
}
