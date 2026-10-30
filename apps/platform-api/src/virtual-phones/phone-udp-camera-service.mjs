import {identifier,integer,failPhone} from './contracts.mjs';
import {udpCameraPolicyInput,udpCameraSelection,udpCameraError} from './phone-udp-camera-policy.mjs';

export class PhoneUdpCameraService {
  #repository;#directory;#policy;#nodeAddresses;
  constructor({repository,directory,policy,nodeAddresses}){
    if(!repository?.assertSelected||!directory?.authorization||!policy?.list||!policy?.configure||typeof nodeAddresses!=='function')
      throw TypeError('Network camera policy is not configured');
    this.#repository=repository;this.#directory=directory;this.#policy=policy;this.#nodeAddresses=nodeAddresses;
  }
  async #actor(context,permission){
    const actorId=identifier(context?.identityId);identifier(context?.sessionId);
    if(!(await this.#directory.authorization(actorId))?.permissions?.includes(permission))failPhone('phone_permission_required');
    return actorId;
  }
  async sources({context,phoneId,generation}){
    const ownerId=await this.#actor(context,'phone:use');
    const selected=await this.#repository.assertSelected({ownerId,sessionId:context.sessionId,phoneId:identifier(phoneId),generation:integer(generation,1,Number.MAX_SAFE_INTEGER)});
    if(selected.cameraCapability!=='verified')udpCameraError('unavailable');
    const rows=await this.#policy.list({nodeId:selected.nodeId,ownerId});
    return {object:'list',phoneId:selected.phoneId,runId:selected.runId,generation:selected.generation,data:rows.map(p=>({
      policyId:p.id,policyRevision:p.revision,name:p.name,listenAddress:p.listenAddress,listenPort:p.listenPort,
      allowedSources:p.allowedSources,externalInputEncrypted:false,format:'UDP/MPEG-TS/H.264'}))};
  }
  async select(selected,source){
    const s=udpCameraSelection(source),rows=await this.#policy.list({nodeId:selected.nodeId,ownerId:selected.ownerId});
    const p=rows.find(p=>p.id===s.policyId&&p.revision===s.policyRevision&&p.enabled);
    if(!p)udpCameraError('permission_required');
    return s;
  }
  async administration({context,nodeId}){
    await this.#actor(context,'phone:manage');identifier(nodeId);
    return {object:'list',nodeId,addresses:await this.#nodeAddresses(nodeId),data:await this.#policy.list({nodeId})};
  }
  async configure({context,nodeId,policyId,input}){
    const actorId=await this.#actor(context,'phone:manage');identifier(nodeId);identifier(policyId);const v=udpCameraPolicyInput(input);
    // The listener may bind only an address belonging to the selected node,
    // never a wildcard or another box. Revocation does not need a live node.
    if(v.enabled&&!(await this.#nodeAddresses(nodeId)).includes(v.listenAddress))udpCameraError('unavailable');
    return this.#policy.configure({nodeId,policyId,actorId,input:v});
  }
}
