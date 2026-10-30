import {PlatformError} from '../../../../packages/observability/src/index.mjs';
import {identifier,integer,record,requestFingerprint} from './contracts.mjs';
import {phoneTransferInput} from './phone-object-transfer.mjs';
import {usbCameraSelection} from './phone-usb-camera-policy.mjs';
import {udpCameraSelection} from './phone-udp-camera-policy.mjs';

export const CAMERA_INPUT = Object.freeze({width:640,height:480,maximumFps:15,maximumImageBytes:Number.MAX_SAFE_INTEGER,
  maximumVideoBytes:Number.MAX_SAFE_INTEGER,
  maximumFrameBytes:640*480*2,maximumLeaseMilliseconds:5000,resourceScope:'phone-run'});
const errors={
  phone_camera_unavailable:[409,'这部手机的系统版本暂不支持摄像头输入。'],
  phone_camera_source_unsupported:[422,'此摄像头来源尚未开放。'],
  phone_camera_source_stopped:[409,'摄像头输入已停止，请重新启用。'],
  phone_camera_image_unsupported:[422,'图片格式不支持或图片已损坏，请使用 JPEG、PNG 或 WebP。'],
  phone_camera_image_too_large:[422,'图片大小无效。'],
  phone_camera_video_unsupported:[422,'请使用可正常解码的 H.264 MP4 视频。'],
  phone_camera_video_too_large:[422,'视频大小无效。'],
  phone_camera_storage_full:[409,'这部手机的数据空间不足，无法保存摄像头输入文件。请释放空间或增加存储配额。'],
  phone_camera_video_memory_unavailable:[503,'这部手机当前可用内存不足以解码此视频，请释放内存或增加手机资源。'],
  phone_camera_runtime_unavailable:[503,'摄像头输入服务暂不可用，未继续使用旧画面。'],
  phone_camera_network_unavailable:[409,'摄像头连接无法建立，请检查浏览器与盒子的网络连接。'],
  phone_camera_usb_permission_required:[403,'你没有使用这台 USB 摄像头的权限，请联系管理员。'],
  phone_camera_usb_busy:[409,'这台摄像头正在使用中，请稍后重试或选择其他摄像头。'],
  phone_camera_usb_device_changed:[409,'摄像头已拔出或重新插入，请刷新设备列表后重新选择。'],
  phone_camera_udp_port_unavailable:[409,'网络摄像头端口无法使用，可能已被占用，请联系管理员检查。'],
};
export function cameraError(code){const error=errors[code];if(!error)throw TypeError('Unknown camera error');throw new PlatformError(code,error[1],{status:error[0]});}
export function cameraStartInput(input){
  record(input,['expectedGeneration','requestId','source']);
  const expectedGeneration=integer(input.expectedGeneration,1,Number.MAX_SAFE_INTEGER),sourceId=identifier(input.requestId);
  let source;
  if(input.source?.kind==='udp'){
    source=udpCameraSelection(input.source);
  }else if(input.source?.kind==='usb'){
    source=usbCameraSelection(input.source);
  }else if(input.source?.kind==='browser'){
    record(input.source,['kind','continueWithoutViewer']);
    if(input.source.continueWithoutViewer!==false)cameraError('phone_camera_source_unsupported');
    // No SDP, camera label, candidate address or microphone choice persists in
    // the source record. Runtime capability still gates this adapter closed.
    source={kind:'browser',continueWithoutViewer:false};
  }else if(input.source?.kind==='video'){
    record(input.source,['kind','file','loop','continueWithoutViewer']);
    if(input.source.continueWithoutViewer!==true||typeof input.source.loop!=='boolean')cameraError('phone_camera_source_unsupported');
    source={kind:'video',file:phoneTransferInput(input.source.file,CAMERA_INPUT.maximumVideoBytes),loop:input.source.loop,continueWithoutViewer:true};
  }else{
    record(input.source,['kind','file','continueWithoutViewer']);
    if(input.source.kind!=='image'||input.source.continueWithoutViewer!==true)cameraError('phone_camera_source_unsupported');
    source={kind:'image',file:phoneTransferInput(input.source.file,CAMERA_INPUT.maximumImageBytes),continueWithoutViewer:true};
  }
  return {expectedGeneration,sourceId,source,sourceKind:source.kind,fingerprint:requestFingerprint({expectedGeneration,sourceId,source})};
}
export const cameraBindingKeys=Object.freeze(['id','sourceId','sourceKind','phoneId','ownerId','runId','generation','sessionId']);
export function cameraGrant(value){return Object.fromEntries(cameraBindingKeys.map(key=>[key,value[key]]));}
export const sameCameraBinding=(a,b)=>cameraBindingKeys.every(key=>a?.[key]===b?.[key]);
// Public state is a projection. Never disclose a lease, object reference, image,
// session identifier, node URL or decoder output through the status endpoint.
export function cameraPublicState(value){return {object:'virtual_phone.camera',phoneId:value.phoneId,runId:value.runId,
  generation:value.generation,sourceId:value.sourceId,sourceKind:value.sourceKind,state:value.state,
  ...(value.sourceKind==='udp'?{policyId:value.source?.policyId,policyRevision:value.source?.policyRevision}:{}),
  continueWithoutViewer:value.source?.continueWithoutViewer===true,...(value.sourceKind==='video'?{loop:value.source?.loop===true}:{}),errorCode:value.errorCode??null,
  format:{width:640,height:480,maximumFps:15},resourceScope:'phone-run'};}
