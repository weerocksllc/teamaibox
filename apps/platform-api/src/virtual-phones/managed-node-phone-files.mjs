import {phoneApprovedNodes} from '../../../../services/scheduler/src/phone-approved-nodes.mjs';
import {installedPhoneRuntime} from '../../../../services/scheduler/src/phone-rom.mjs';
import {validatePhoneFileCommand} from '../../../../services/scheduler/src/android-phone-file-command.mjs';
import {PHONE_SPEC,PHONE_ERRORS,failPhone} from './contracts.mjs';

export class ManagedNodePhoneFiles {
  idleTimeoutMilliseconds=30000;
  #router;#nodes;
  constructor({nodeAgentRouter,approvedNodes}) {
    if(typeof nodeAgentRouter?.transferPhoneFile!=='function')throw TypeError('Phone file route unavailable');
    this.#router=nodeAgentRouter;this.#nodes=phoneApprovedNodes(approvedNodes);
  }
  async #transfer({phone,run,action,metadata,name,transferId,deadline,chunks,signal}) {
    const node=this.#nodes.get(phone.nodeId);
    const installed=installedPhoneRuntime(node,phone,run.imageDigest);
    if(!node||!installed||node.poolId!==phone.poolId||!Number.isSafeInteger(run.nodeGeneration)||run.nodeGeneration<node.nodeGeneration||installed.imageDigest!==run.imageDigest)failPhone('phone_node_unavailable');
    if(run.phoneId!==phone.id||run.ownerId!==phone.ownerId||run.nodeId!==phone.nodeId||run.generation!==phone.generation
      ||phone.specId!==PHONE_SPEC.id||phone.storageBytes!==PHONE_SPEC.storageBytes||phone.baseBuildId!==PHONE_SPEC.buildId)failPhone('phone_stale_run');
    const payload=validatePhoneFileCommand({phoneId:phone.id,ownerId:phone.ownerId,volumeId:phone.volumeId,poolId:phone.poolId,
      baseBuildId:phone.baseBuildId,operationId:transferId,generation:phone.generation,run:{id:run.id,reservationId:run.reservationId,
        imageDigest:run.imageDigest,memoryBytes:run.memoryBytes,cpuMillis:run.cpuMillis},action,deadline,
      ...(['upload','install'].includes(action)?{name:metadata.name,sizeBytes:metadata.sizeBytes,sha256:metadata.sha256}:action==='download'?{name}:{})});
    try{return await this.#router.transferPhoneFile({nodeId:node.nodeId,nodeGeneration:run.nodeGeneration,payload,chunks,signal,correlationId:`phone-file:${transferId}`});}
    catch(error){if(Object.hasOwn(PHONE_ERRORS,error?.message))failPhone(error.message);if(error?.code&&Object.hasOwn(PHONE_ERRORS,error.code))throw error;failPhone('phone_runtime_unavailable');}
  }
  receive(value){return this.#transfer(value);}
  send(value){return this.#transfer({...value,action:'download'});}
  list(value){return this.#transfer({...value,action:'list'});}
}
