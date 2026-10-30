import {randomUUID} from 'node:crypto';
import {failPhone,identifier,integer,record} from './contracts.mjs';
import {phoneTransferInput,phoneTransferName} from './phone-object-transfer.mjs';

const sameRun=(a,b)=>['id','phoneId','ownerId','generation','nodeId','nodeGeneration','imageDigest'].every(k=>a?.[k]===b?.[k]);

/** Fixed file/APK operations, separate from the owner's optional ADB grant.
 * The runtime adapter must enforce the exact run, a single transfer per phone,
 * the deadline and the encrypted exchange directory. A missing adapter never
 * falls back to Docker exec, an arbitrary shell, or a permanent debug grant.
 */
export class PhoneFileService {
  #repository;#directory;#sessions;#objects;#runtime;#active=new Set();
  constructor({repository,directory,sessions,objectTransfer,runtime}) {
    if(!['get','currentRun'].every(k=>typeof repository?.[k]==='function')
      ||typeof directory?.authorization!=='function'||typeof sessions?.assertLogin!=='function'
      ||!['withInput','storeOutput'].every(k=>typeof objectTransfer?.[k]==='function')
      ||!['receive','send','list'].every(k=>typeof runtime?.[k]==='function')) {
      throw TypeError('Phone file service requires a bounded, run-scoped runtime and protected objects');
    }
    this.#repository=repository;this.#directory=directory;this.#sessions=sessions;this.#objects=objectTransfer;this.#runtime=runtime;
  }
  async #selected(context,phoneId,expectedGeneration) {
    const ownerId=identifier(context?.identityId),sessionId=identifier(context?.sessionId);
    const authorization=await this.#directory.authorization(ownerId);
    if(!authorization?.permissions?.includes('phone:use'))failPhone('phone_permission_required');
    await this.#sessions.assertLogin({ownerId,sessionId});
    const phone=await this.#repository.get(ownerId,identifier(phoneId));
    if(phone.ownerId!==ownerId||phone.id!==phoneId)failPhone('phone_not_found');
    const run=await this.#repository.currentRun(ownerId,phoneId);
    if(phone.state!=='running'||phone.generation!==expectedGeneration||!run||run.state!=='running'
      ||run.phoneId!==phoneId||run.ownerId!==ownerId||run.generation!==expectedGeneration)failPhone('phone_stale_run');
    return {phone,run};
  }
  async #scope({context,phoneId,generation,signal},action) {
    phoneId=identifier(phoneId);integer(generation,1,Number.MAX_SAFE_INTEGER);
    const selected=await this.#selected(context,phoneId,generation);
    if(this.#active.has(phoneId))failPhone('phone_operation_conflict');
    this.#active.add(phoneId);
    // Deadline only authorizes starting the signed command. Active transfers
    // use progress/idle detection, caller cancellation and live ownership checks.
    const controller=new AbortController(),deadline=Date.now()+119000;
    const abort=()=>controller.abort(signal?.reason);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let checking=false;
    const check=async()=>{
      const current=await this.#selected(context,phoneId,generation);
      if(!sameRun(current.run,selected.run))failPhone('phone_stale_run');
    };
    const timer=setInterval(async()=>{
      if(checking||controller.signal.aborted)return;checking=true;
      try{await check();}catch(error){controller.abort(error);}finally{checking=false;}
    },1000);timer.unref();
    try {
      controller.signal.throwIfAborted();
      const result=await action({...structuredClone(selected),transferId:randomUUID(),deadline,signal:controller.signal});
      controller.signal.throwIfAborted();await check();return result;
    } finally {
      controller.abort();clearInterval(timer);signal?.removeEventListener('abort',abort);this.#active.delete(phoneId);
    }
  }
  #binding(value,selected) {
    if(value?.phoneId!==selected.phone.id||value?.runId!==selected.run.id||value?.generation!==selected.run.generation)failPhone('phone_stale_run');
  }
  async upload({context,phoneId,input,signal,install=false}) {
    record(input,['expectedGeneration','file']);const file=phoneTransferInput(input.file);
    return this.#scope({context,phoneId,generation:input.expectedGeneration,signal},async selected=>
      this.#objects.withInput({ownerId:selected.phone.ownerId,input:file,signal:selected.signal},async({metadata,chunks})=>{
        const value=await this.#runtime.receive({...selected,action:install?'install':'upload',metadata,chunks});
        this.#binding(value,selected);
        if(value.sizeBytes!==metadata.sizeBytes||value.sha256!==metadata.sha256)failPhone('phone_object_invalid');
        if(install) {
          if(value.installed!==true)failPhone('phone_install_failed');
          return {object:'virtual_phone.installation',phoneId:selected.phone.id,installed:true,name:metadata.name};
        }
        if(value.name!==metadata.name||value.stored!==true)failPhone('phone_object_invalid');
        return {object:'virtual_phone.file',phoneId:selected.phone.id,name:value.name,sizeBytes:value.sizeBytes,sha256:value.sha256};
      }));
  }
  async list({context,phoneId,generation,signal}) {
    return this.#scope({context,phoneId,generation,signal},async selected=>{
      const value=await this.#runtime.list(selected);this.#binding(value,selected);
      if(!Array.isArray(value.files))failPhone('phone_object_invalid');
      const names=new Set();const files=value.files.map(file=>{
        record(file,['name','sizeBytes']);const name=phoneTransferName(file.name);
        if(names.has(name))failPhone('phone_object_invalid');names.add(name);
        return {name,sizeBytes:integer(file.sizeBytes,0,Number.MAX_SAFE_INTEGER)};
      });
      return {object:'list',phoneId:selected.phone.id,data:files,directory:'Download/TeamAIBox'};
    });
  }
  async download({context,phoneId,input,signal}) {
    record(input,['expectedGeneration','name']);const name=phoneTransferName(input.name);
    return this.#scope({context,phoneId,generation:input.expectedGeneration,signal},async selected=>{
      const value=await this.#runtime.send({...selected,name});this.#binding(value,selected);
      if(value.name!==name)failPhone('phone_object_invalid');
      const object=await this.#objects.storeOutput({ownerId:selected.phone.ownerId,phoneId:selected.phone.id,name,
        sizeBytes:value.sizeBytes,sha256:value.sha256,chunks:value.chunks,signal:selected.signal});
      return {object:'virtual_phone.file_export',phoneId:selected.phone.id,name,
        objectId:object.objectId,objectVersion:object.version,sizeBytes:object.size,sha256:object.integrity?.digest};
    });
  }
}
