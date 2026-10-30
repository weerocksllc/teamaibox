import {validateAndroidPhoneCommand} from "./android-phone-command.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validatePhoneMediaCommand(action,value,{now=Date.now()}={}) {
  if(!value || typeof value!=="object" || Array.isArray(value) || !["open","renew","close"].includes(action))throw TypeError("Invalid phone media command");
  const {grantId,sessionId,kind,leaseExpiresAt,...phone}=value;
  validateAndroidPhoneCommand("inspect",phone);
  if(!UUID.test(grantId??"") || !UUID.test(sessionId??"") || phone.operationId!==grantId || !["control","adb"].includes(kind)
     || action==="close" && Object.hasOwn(value,"leaseExpiresAt")
     || action!=="close" && (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt<=now || leaseExpiresAt>now+5000))throw TypeError("Invalid phone media lease");
  return Object.freeze(structuredClone(value));
}
export function phoneMediaGrant(p) {
  return {id:p.grantId,phoneId:p.phoneId,ownerId:p.ownerId,runId:p.run.id,generation:p.generation,sessionId:p.sessionId,kind:p.kind};
}
export function validatePhoneMediaResult(action,p,value) {
  const expected=phoneMediaGrant(p),keys=[...Object.keys(expected),...(action==="close"?["peerClosed"]:["peerOpen","leaseExpiresAt"])];
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==keys.length
    || !keys.every(k=>Object.hasOwn(value,k)) || Object.keys(expected).some(k=>expected[k]!==value[k])
    || (action==="close" ? value.peerClosed!==true : value.peerOpen!==true || value.leaseExpiresAt!==p.leaseExpiresAt))throw TypeError("Invalid phone media acknowledgement");
  return Object.freeze(structuredClone(value));
}
