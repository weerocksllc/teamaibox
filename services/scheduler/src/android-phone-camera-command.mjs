import {validateAndroidPhoneCommand} from './android-phone-command.mjs';
import {isIPv4} from 'node:net';
import {validatePhoneUdpPolicy} from './phone-udp-policy.mjs';

export const PHONE_CAMERA_MAXIMUM=Number.MAX_SAFE_INTEGER;
export const PHONE_CAMERA_VIDEO_MAXIMUM=Number.MAX_SAFE_INTEGER;
export const PHONE_CAMERA_END=Buffer.from('\nTEAMAIBOX-CAMERA-END\n');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validatePhoneCameraCommand(value,{now=Date.now()}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw TypeError('Invalid camera command');
  const {action,grantId,sourceId,sourceKind,sessionId,deadline,leaseExpiresAt,sizeBytes,sha256,peerAddress,loop,deviceId,attachmentId,udpPolicy,...phone}=value;
  validateAndroidPhoneCommand('inspect',phone);
  const upload=['image','video','browser-offer'].includes(action);
  if(!['open','renew','image','video','usb','udp','browser-offer','close','status'].includes(action)||![grantId,sourceId,sessionId].every(v=>typeof v==='string'&&UUID.test(v))
    ||!['image','browser','video','usb','udp'].includes(sourceKind)||['image','video','usb','udp'].includes(action)&&sourceKind!==action||action==='browser-offer'&&sourceKind!=='browser'
    ||phone.operationId!==grantId||!Number.isSafeInteger(deadline)||deadline<=now||deadline>now+(upload||['usb','udp'].includes(action)?15000:5000))throw TypeError('Invalid camera binding');
  if(action==='open'||action==='renew'){
    if(!Number.isSafeInteger(leaseExpiresAt)||leaseExpiresAt<=now||leaseExpiresAt>now+5000)throw TypeError('Invalid camera lease');
  }else if(Object.hasOwn(value,'leaseExpiresAt'))throw TypeError('Unexpected camera lease');
  if(upload){
    if(!Number.isSafeInteger(sizeBytes)||sizeBytes<1||sizeBytes>(action==='video'?PHONE_CAMERA_VIDEO_MAXIMUM:action==='image'?PHONE_CAMERA_MAXIMUM:65536)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw TypeError('Invalid camera input');
  }else if(Object.hasOwn(value,'sizeBytes')||Object.hasOwn(value,'sha256'))throw TypeError('Unexpected image metadata');
  if(action==='video'?typeof loop!=='boolean':Object.hasOwn(value,'loop'))throw TypeError('Invalid camera playback');
  if(action==='browser-offer'){
    if(typeof peerAddress!=='string'||!isIPv4(peerAddress)||!/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(peerAddress))throw TypeError('Invalid camera peer');
  }else if(Object.hasOwn(value,'peerAddress'))throw TypeError('Unexpected camera peer');
  if(action==='usb'){
    if(!UUID.test(deviceId??'')||typeof attachmentId!=='string'||!/^[a-f0-9]{64}$/.test(attachmentId))throw TypeError('Invalid USB camera selection');
  }else if(Object.hasOwn(value,'deviceId')||Object.hasOwn(value,'attachmentId'))throw TypeError('Unexpected USB camera selection');
  if(action==='udp')validatePhoneUdpPolicy(udpPolicy);
  else if(Object.hasOwn(value,'udpPolicy'))throw TypeError('Unexpected network camera policy');
  return Object.freeze(structuredClone(value));
}
export function phoneCameraGrant(p){return {id:p.grantId,sourceId:p.sourceId,sourceKind:p.sourceKind,
  phoneId:p.phoneId,ownerId:p.ownerId,runId:p.run.id,generation:p.generation,sessionId:p.sessionId};}
export function validatePhoneCameraResult(p,value){
  const grant=phoneCameraGrant(p),lease=['open','renew'].includes(p.action);
  const browser=p.action==='browser-offer';
  const keys=[...Object.keys(grant),'state','resourceScope',...(lease?['leaseExpiresAt']:p.action==='close'?['retainedFrameBytes']:browser?['answerSdp','containerAddress','nodeAddress','firstPort','lastPort']:[])];
  const states=p.action==='open'?['waiting']:['image','video','usb'].includes(p.action)?['receiving']:p.action==='close'?['stopped']:p.action==='status'?['waiting','receiving','stopped']:['waiting','receiving'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))
    ||Object.keys(grant).some(k=>value[k]!==grant[k])||value.resourceScope!=='phone-run'||!states.includes(value.state)
    ||lease&&value.leaseExpiresAt!==p.leaseExpiresAt||p.action==='close'&&value.retainedFrameBytes!==0)throw TypeError('Invalid camera acknowledgement');
  if(browser&&(typeof value.answerSdp!=='string'||!value.answerSdp.startsWith('v=0\r\n')||Buffer.byteLength(value.answerSdp)>65536
    ||!isIPv4(value.containerAddress)||!isIPv4(value.nodeAddress)||value.containerAddress===value.nodeAddress
    ||![20040,20140].includes(value.firstPort)||value.lastPort!==value.firstPort+9))throw TypeError('Invalid camera network');
  return Object.freeze(structuredClone(value));
}
