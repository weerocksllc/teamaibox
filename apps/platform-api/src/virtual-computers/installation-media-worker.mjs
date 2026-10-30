import {installationOwner} from './installation-media-service.mjs';

const permanent=new Set(['computer_permission_required','file_not_found','file_version_not_found','file_root_not_found',
  'file_permission_denied','object_not_found','computer_media_source_changed','computer_media_integrity_mismatch','computer_media_source_invalid']);
// A restart resumes durable preparing/deleting rows. A lease is renewed during
// large streaming copies; losing it cancels this worker without touching VMs.
export class InstallationMediaWorker {
  #repo;#transfer;#directory;#active=null;#controller=null;#timer=null;#stopped=true;#epoch=0;
  constructor({repository,transfer,directory}){this.#repo=repository;this.#transfer=transfer;this.#directory=directory;}
  runOnce(){
    if(this.#active)return this.#active;
    this.#active=this.#run().finally(()=>{this.#active=null;});return this.#active;
  }
  async #run(){
    const epoch=this.#epoch,media=await this.#repo.claimNext({leaseMs:30000});
    if(!media)return {processed:0};
    if(epoch!==this.#epoch)return {processed:1,state:'retrying'};
    const controller=new AbortController();this.#controller=controller;let renewing=false;
    const timer=setInterval(async()=>{
      if(renewing||controller.signal.aborted)return;renewing=true;
      try{if(!await this.#repo.renew(media,{leaseMs:30000}))controller.abort();}catch{controller.abort();}finally{renewing=false;}
    },10000);
    try{
      let result;
      if(media.state==='deleting'){
        if(!await this.#repo.hasOtherObjectReferences(media))await this.#transfer.release(media);
        result=null;
      }else{
        const driveContext=await installationOwner(this.#directory,media.ownerId);
        result=await this.#transfer.prepare({media,driveContext,signal:controller.signal,onProgress:async bytes=>{
          if(!await this.#repo.progress(media,bytes))controller.abort();controller.signal.throwIfAborted();
        }});
      }
      controller.signal.throwIfAborted();
      const value=await this.#repo.complete(media,result);return {processed:1,state:value.state,id:media.id};
    }catch(error){
      if(!controller.signal.aborted){
        const fatal=permanent.has(error.code),code=fatal?error.code:'computer_media_transfer_retrying';
        await this.#repo.retry(media,code,{permanent:fatal});
        return {processed:1,state:fatal&&media.state==='preparing'?'failed':'retrying',id:media.id};
      }
      return {processed:1,state:'retrying',id:media.id};
    }finally{clearInterval(timer);this.#controller=null;}
  }
  start(){
    if(!this.#stopped)return;this.#stopped=false;
    const poll=async()=>{try{await this.runOnce();}catch{/* Resume after storage/database recovery. */}
      finally{if(!this.#stopped)this.#timer=setTimeout(poll,1000);}};
    this.#timer=setTimeout(poll,0);
  }
  async stop(){this.#epoch++;this.#stopped=true;clearTimeout(this.#timer);this.#controller?.abort();await this.#active;}
}
