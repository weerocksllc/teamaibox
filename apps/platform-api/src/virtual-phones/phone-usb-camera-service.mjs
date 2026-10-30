import {identifier,integer,failPhone} from './contracts.mjs';
import {cameraError} from './phone-camera-contracts.mjs';
import {usbCameraSelection,usbCameraPolicyInput} from './phone-usb-camera-policy.mjs';

// Inventory is metadata, never a preview. The selected node comes from the
// persisted running phone, not a browser nodeId, IP address or host pathname.
export class PhoneUsbCameraService {
  #repository;#directory;#policy;#runtime;
  constructor({repository,directory,policy,runtime}){
    if(!repository?.assertSelected||!directory?.authorization||!['listAllowed','listPolicies','configure'].every(k=>typeof policy?.[k]==='function')
      ||!['usbDevices','usbNodeDevices'].every(k=>typeof runtime?.[k]==='function'))throw TypeError('USB camera directory is not configured');
    this.#repository=repository;this.#directory=directory;this.#policy=policy;this.#runtime=runtime;
  }
  async #actor(context,permission){
    const actorId=identifier(context?.identityId);identifier(context?.sessionId);
    if(!(await this.#directory.authorization(actorId))?.permissions?.includes(permission))failPhone('phone_permission_required');
    return actorId;
  }
  #inventory(value,nodeId){
    if(value?.nodeId!==nodeId||!Array.isArray(value.data))cameraError('phone_camera_runtime_unavailable');
    const ids=new Set();
    return value.data.map(d=>{
      identifier(d?.deviceId);
      if(ids.has(d.deviceId)||typeof d.name!=='string'||!d.name||/[\u0000-\u001f\u007f]/.test(d.name)
        ||typeof d.attachmentId!=='string'||! /^[a-f0-9]{64}$/.test(d.attachmentId)
        ||!Array.isArray(d.formats)||d.formats.some(f=>typeof f!=='string'||! /^[ -~]{4}$/.test(f)))cameraError('phone_camera_runtime_unavailable');
      ids.add(d.deviceId);
      // Strip all unneeded runtime metadata even if a future adapter adds it.
      return {deviceId:d.deviceId,attachmentId:d.attachmentId,name:d.name,formats:d.formats.filter(f=>['MJPG','YUYV'].includes(f))};
    }).filter(d=>d.formats.length);
  }
  async devices({context,phoneId,generation}){
    const ownerId=await this.#actor(context,'phone:use');
    const selected=await this.#repository.assertSelected({ownerId,sessionId:context.sessionId,
      phoneId:identifier(phoneId),generation:integer(generation,1,Number.MAX_SAFE_INTEGER)});
    const data=await this.allowedDevices(selected);
    return {object:'list',phoneId:selected.phoneId,runId:selected.runId,generation:selected.generation,data};
  }
  async allowedDevices(selected){
    if(selected.cameraCapability!=='verified')cameraError('phone_camera_unavailable');
    const allowed=new Set(await this.#policy.listAllowed(selected));
    if(!allowed.size)return [];
    const live=await this.#runtime.usbDevices(selected);
    if(live?.runId!==selected.runId||live.generation!==selected.generation)failPhone('phone_stale_run');
    return this.#inventory(live,selected.nodeId).filter(d=>allowed.has(d.deviceId));
  }
  async select(selected,source){
    const selection=usbCameraSelection(source);
    if(!(await this.#policy.listAllowed(selected)).includes(selection.deviceId))cameraError('phone_camera_usb_permission_required');
    const device=(await this.allowedDevices(selected)).find(d=>d.deviceId===selection.deviceId&&d.attachmentId===selection.attachmentId);
    if(!device)cameraError('phone_camera_usb_device_changed');
    return selection;
  }
  async administration({context,nodeId}){
    await this.#actor(context,'phone:manage');identifier(nodeId);
    const data=this.#inventory(await this.#runtime.usbNodeDevices({nodeId}),nodeId);
    const policies=await this.#policy.listPolicies({nodeId}),seen=new Set(data.map(d=>d.deviceId));
    return {object:'list',nodeId,data:[...data.map(d=>({...d,connected:true,
      ...(policies.find(p=>p.deviceId===d.deviceId)??{enabled:false,revision:0,ownerIds:[]})})),
      ...policies.filter(p=>!seen.has(p.deviceId)).map(p=>({...p,connected:false,name:'未连接的摄像头'}))]};
  }
  async configure({context,nodeId,deviceId,input}){
    const actorId=await this.#actor(context,'phone:manage');identifier(nodeId);identifier(deviceId);
    const policy=usbCameraPolicyInput(input);
    // Enabling requires a device discovered on this exact managed node. A
    // detached device can still be revoked without waiting for hardware.
    if(policy.enabled&&!this.#inventory(await this.#runtime.usbNodeDevices({nodeId}),nodeId).some(d=>d.deviceId===deviceId))cameraError('phone_camera_usb_device_changed');
    return this.#policy.configure({nodeId,deviceId,actorId,input:policy});
  }
}
