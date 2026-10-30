import {identifier,integer,record,failPhone} from './contracts.mjs';
import {cameraError,cameraStartInput,cameraGrant,cameraPublicState,sameCameraBinding} from './phone-camera-contracts.mjs';

/** Camera input is separate from display/ADB peers. All source work stays in
 * the selected phone's existing cgroup. An unconfigured adapter grants nothing.
 * PostgreSQL owns exclusivity; this map only tracks work this process can renew.
 */
export class PhoneCameraService {
  #repository;#directory;#objects;#runtime;#usb;#udp;#owned=new Map();#ready=new Set();#jobs=new Map();#browser=new Map();#timer;#now;
  constructor({repository,directory,objectTransfer,runtime,usbService=null,udpService=null,now=()=>Date.now()}){
    if(!['assertSelected','reserve','activate','current','get','active','beginStop','confirmStopped','listStates'].every(k=>typeof repository?.[k]==='function')
      ||typeof directory?.authorization!=='function'||typeof objectTransfer?.withInput!=='function'
      ||!['capabilities','open','image','renew','close','status'].every(k=>typeof runtime?.[k]==='function')
      ||runtime.maximumLeaseMilliseconds!==5000||runtime.resourceScope!=='phone-run')throw TypeError('Camera requires owner/run-scoped, expiring input within phone resources');
    if(usbService&&!['devices','select','administration','configure'].every(k=>typeof usbService[k]==='function'))throw TypeError('USB camera control incomplete');
    if(udpService&&!['sources','select','administration','configure'].every(k=>typeof udpService[k]==='function'))throw TypeError('Network camera control incomplete');
    this.#repository=repository;this.#directory=directory;this.#objects=objectTransfer;this.#runtime=runtime;this.#usb=usbService;this.#udp=udpService;this.#now=now;
  }
  usbDevices(args){if(!this.#usb)cameraError('phone_camera_unavailable');return this.#usb.devices(args);}
  usbAdministration(args){if(!this.#usb)cameraError('phone_camera_unavailable');return this.#usb.administration(args);}
  configureUsbCamera(args){if(!this.#usb)cameraError('phone_camera_unavailable');return this.#usb.configure(args);}
  udpSources(args){if(!this.#udp)cameraError('phone_camera_unavailable');return this.#udp.sources(args);}
  udpAdministration(args){if(!this.#udp)cameraError('phone_camera_unavailable');return this.#udp.administration(args);}
  configureUdpCamera(args){if(!this.#udp)cameraError('phone_camera_unavailable');return this.#udp.configure(args);}
  async #owner(context){
    const ownerId=identifier(context?.identityId),sessionId=identifier(context?.sessionId);
    const current=await this.#directory.authorization(ownerId);
    if(!current?.permissions?.includes('phone:use'))failPhone('phone_permission_required');
    return {ownerId,sessionId};
  }
  async #selected(context,phoneId,generation){
    const owner=await this.#owner(context);
    return this.#repository.assertSelected({...owner,phoneId:identifier(phoneId),generation:integer(generation,1,Number.MAX_SAFE_INTEGER)});
  }
  #lease(){return this.#now()+4000;}
  #reply(value,result,states){
    if(!sameCameraBinding(value,result)||!states.includes(result.state)||result.resourceScope!=='phone-run')cameraError('phone_camera_runtime_unavailable');
  }
  async #check(value){
    const row=await this.#repository.get(value.id);
    if(!row?.authorized||!['starting','active'].includes(row.state)||!sameCameraBinding(row,value))cameraError('phone_camera_source_stopped');
    await this.#owner({identityId:value.ownerId,sessionId:value.sessionId});return row;
  }
  async #close(value){
    this.#owned.get(value.id)?.abort();this.#owned.delete(value.id);this.#ready.delete(value.id);
    this.#browser.delete(value.id);
    const result=await this.#runtime.close({grant:cameraGrant(value)});
    this.#reply(value,result,['stopped']);
    if(result.retainedFrameBytes!==0)cameraError('phone_camera_runtime_unavailable');
    await this.#repository.confirmStopped(value);
  }
  async #stop(value){
    for(const row of await this.#repository.beginStop({ownerId:value.ownerId,phoneId:value.phoneId,id:value.id}))await this.#close(row);
  }
  async listStates({context,phones}){
    const {ownerId}=await this.#owner(context);
    if(!Array.isArray(phones))failPhone('phone_input_invalid');
    return this.#repository.listStates({ownerId,phones:phones.map(p=>({id:identifier(p.id),generation:integer(p.generation,0,Number.MAX_SAFE_INTEGER)}))});
  }
  async status({context,phoneId,generation}){
    const selected=await this.#selected(context,phoneId,generation);
    const caps=await this.#runtime.capabilities(selected);
    const value=await this.#repository.current({ownerId:selected.ownerId,phoneId:selected.phoneId});
    const capabilities={image:caps?.image===true&&selected.cameraCapability==='verified',
      browser:caps?.browser===true&&typeof this.#runtime.browserOffer==='function'&&selected.cameraCapability==='verified',
      usb:caps?.usb===true&&Boolean(this.#usb)&&typeof this.#runtime.usb==='function'&&selected.cameraCapability==='verified',
      video:caps?.video===true&&typeof this.#runtime.video==='function'&&selected.cameraCapability==='verified',
      udp:caps?.udp===true&&Boolean(this.#udp)&&typeof this.#runtime.udp==='function'&&selected.cameraCapability==='verified'};
    if(!value)return {object:'virtual_phone.camera',phoneId:selected.phoneId,generation,state:'stopped',capabilities};
    if(!value.authorized||value.runId!==selected.runId){await this.#stop(value);return {...cameraPublicState({...value,state:'stopped'}),capabilities};}
    if(value.state==='active'){
      const live=await this.#runtime.status({grant:cameraGrant(value)});
      this.#reply(value,live,['receiving','waiting','stopped']);
      if(live.state==='stopped'){await this.#stop(value);return {...cameraPublicState({...value,state:'stopped'}),capabilities};}
      return {...cameraPublicState(value),inputState:live.state,capabilities};
    }
    return {...cameraPublicState(value),capabilities};
  }
  async start({context,phoneId,input,signal}){
    const spec=cameraStartInput(input),selected=await this.#selected(context,phoneId,spec.expectedGeneration);
    const capabilities=await this.#runtime.capabilities(selected);
    if(selected.cameraCapability!=='verified'||capabilities?.[spec.sourceKind]!==true
      ||spec.sourceKind==='browser'&&typeof this.#runtime.browserOffer!=='function'
      ||spec.sourceKind==='video'&&typeof this.#runtime.video!=='function'
      ||spec.sourceKind==='usb'&&(!this.#usb||typeof this.#runtime.usb!=='function')
      ||spec.sourceKind==='udp'&&(!this.#udp||typeof this.#runtime.udp!=='function'))cameraError('phone_camera_unavailable');
    if(spec.sourceKind==='usb')await this.#usb.select(selected,spec.source);
    if(spec.sourceKind==='udp')await this.#udp.select(selected,spec.source);
    signal?.throwIfAborted();
    const value=await this.#repository.reserve({...selected,...spec});
    // Retries never start a second producer, including after a process restart.
    if(!value.created){
      if(!this.#owned.has(value.id)||!['starting','active'].includes(value.state))cameraError('phone_camera_source_stopped');
      if(value.sourceKind==='browser'&&(!this.#browser.has(value.id)||this.#browser.get(value.id).until<=this.#now())){
        await this.#stop(value);cameraError('phone_camera_source_stopped');
      }
      return cameraPublicState(value);
    }
    const controller=new AbortController();this.#owned.set(value.id,controller);
    if(value.sourceKind==='browser')this.#browser.set(value.id,{until:this.#now()+4000,offered:false});
    const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    // File preparation has no total-duration ceiling. The transfer enforces an
    // idle timeout, while this source still loses its short lease on revocation.
    const timeout=['image','video'].includes(value.sourceKind)?null:setTimeout(()=>controller.abort(Error('phone_camera_start_timeout')),15000);timeout?.unref();
    let checking=false;
    const timer=setInterval(async()=>{if(checking||controller.signal.aborted)return;checking=true;
      try{await this.#check(value);}catch(error){controller.abort(error);}finally{checking=false;}},1000);timer.unref();
    try{
      controller.signal.throwIfAborted();
      const grant=cameraGrant(value),leaseExpiresAt=this.#lease();
      const opened=await this.#runtime.open({grant,leaseExpiresAt,signal:controller.signal});
      this.#reply(value,opened,['waiting']);if(opened.leaseExpiresAt!==leaseExpiresAt)cameraError('phone_camera_runtime_unavailable');
      this.#ready.add(value.id);controller.signal.throwIfAborted();
      // The protected object service checks the owner namespace and exact bytes.
      // Conversion occurs inside the same capped phone, never in this API process.
      if(['image','video'].includes(value.sourceKind)){
        await this.#objects.withInput({ownerId:value.ownerId,input:spec.source.file,signal:controller.signal},async({metadata,chunks})=>{
          const loaded=await this.#runtime[value.sourceKind]({grant,metadata,chunks,signal:controller.signal,
            ...(value.sourceKind==='video'?{loop:spec.source.loop}:{})});
          this.#reply(value,loaded,['receiving']);
        });
      }
      if(value.sourceKind==='usb'){
        await this.#check(value);
        const loaded=await this.#runtime.usb({grant,source:spec.source,policyRevision:value.usbPolicyRevision,signal:controller.signal});
        this.#reply(value,loaded,['receiving']);
      }
      if(value.sourceKind==='udp'){
        await this.#check(value);
        const loaded=await this.#runtime.udp({grant,policy:value.udpPolicy,signal:controller.signal});
        this.#reply(value,loaded,['waiting','receiving']);
      }
      controller.signal.throwIfAborted();await this.#check(value);
      const activated=await this.#repository.activate(value);return cameraPublicState(activated);
    }catch(error){
      controller.abort();
      // Even ambiguous open must revoke the same lease. Failed close remains
      // durable stopping; the runtime's independent five-second expiry applies.
      try{await this.#stop(value);}catch{}
      throw error;
    }finally{clearTimeout(timeout);clearInterval(timer);signal?.removeEventListener('abort',abort);}
  }
  async stop({context,phoneId,input}){
    record(input,['expectedGeneration','sourceId']);const selected=await this.#selected(context,phoneId,input.expectedGeneration);
    const sourceId=identifier(input.sourceId),current=await this.#repository.current({ownerId:selected.ownerId,phoneId:selected.phoneId});
    if(current&&current.sourceId!==sourceId)failPhone('phone_state_conflict');
    if(current)await this.#stop(current);
    return {object:'virtual_phone.camera',phoneId:selected.phoneId,sourceId,state:'stopped'};
  }
  async #browserInput(context,phoneId,input){
    const selected=await this.#selected(context,phoneId,input.expectedGeneration),sourceId=identifier(input.sourceId);
    const value=await this.#repository.current({ownerId:selected.ownerId,phoneId:selected.phoneId});
    if(!value||value.sourceId!==sourceId||value.sourceKind!=='browser'||value.sessionId!==selected.sessionId
      ||value.runId!==selected.runId||value.generation!==selected.generation)cameraError('phone_camera_source_stopped');
    await this.#check(value);
    const capture=this.#browser.get(value.id);
    if(!capture||capture.until<=this.#now()||!this.#owned.has(value.id)){
      await this.#stop(value);cameraError('phone_camera_source_stopped');
    }
    return {value,capture};
  }
  async keepBrowserAlive({context,phoneId,input}){
    record(input,['expectedGeneration','sourceId']);
    const {value,capture}=await this.#browserInput(context,phoneId,input);
    // In-memory only: this is not a DB write/audit event per video frame.
    // A page cannot revive an expired source or renew another login's capture.
    capture.until=this.#now()+4000;
    return {sourceId:value.sourceId,expiresInMilliseconds:4000};
  }
  async browserOffer({context,phoneId,input,allowedAddresses,signal}){
    record(input,['expectedGeneration','sourceId','offerSdp']);
    if(typeof input.offerSdp!=='string'||Buffer.byteLength(input.offerSdp)>65536||!input.offerSdp)failPhone('phone_input_invalid');
    // These addresses must come from the trusted HTTP signalling boundary,
    // never from the source config/SDP/request body. No permissive default.
    if(!Array.isArray(allowedAddresses)||allowedAddresses.length!==1
      ||typeof allowedAddresses[0]!=='string')cameraError('phone_camera_unavailable');
    const {value,capture}=await this.#browserInput(context,phoneId,input);
    if(capture.offered)failPhone('phone_operation_conflict');
    capture.offered=true;
    const controller=this.#owned.get(value.id);
    try{
      const result=await this.#runtime.browserOffer({grant:cameraGrant(value),offerSdp:input.offerSdp,
        allowedAddresses,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
      this.#reply(value,result,['waiting','receiving']);
      await this.#browserInput(context,phoneId,input);
      if(typeof result.answerSdp!=='string'||!result.answerSdp||Buffer.byteLength(result.answerSdp)>65536)cameraError('phone_camera_runtime_unavailable');
      return {sourceId:value.sourceId,answerSdp:result.answerSdp};
    }catch(error){
      try{await this.#stop(value);}catch{}
      throw error;
    }
  }
  async revokePhoneAccess({ownerId,phoneId,runId=null,loginSessionId=null}){
    for(const row of await this.#repository.beginStop({ownerId:identifier(ownerId),phoneId:identifier(phoneId),runId,sessionId:loginSessionId}))await this.#close(row);
    return {phoneId,runId,accessRevoked:true};
  }
  async #reconcileOne(value){
      const controller=this.#owned.get(value.id);
      const capture=this.#browser.get(value.id);
      if(!value.authorized||!controller||controller.signal.aborted
        ||value.sourceKind==='browser'&&(!capture||capture.until<=this.#now())
        ||!(await this.#directory.authorization(value.ownerId))?.permissions?.includes('phone:use')){
        await this.#stop(value);return;
      }
      // Renew while bounded image transfer runs too; a slow object read must
      // not require a longer authorization lease on the node.
      if(!this.#ready.has(value.id))return;
      const leaseExpiresAt=this.#lease();
      try{
        const result=await this.#runtime.renew({grant:cameraGrant(value),leaseExpiresAt,signal:controller.signal});
        this.#reply(value,result,['waiting','receiving']);
        if(result.leaseExpiresAt!==leaseExpiresAt)cameraError('phone_camera_runtime_unavailable');
        await this.#check(value);
      }catch(error){await this.#stop(value);throw error;}
  }
  #job(value){
    if(this.#jobs.has(value.id))return this.#jobs.get(value.id);
    const work=this.#reconcileOne(value).finally(()=>this.#jobs.delete(value.id));
    this.#jobs.set(value.id,work);return work;
  }
  async reconcile(){
    // One finite batch of existing inputs, independent of static assets/UI reads.
    const results=await Promise.allSettled((await this.#repository.active()).map(value=>this.#job(value)));
    // One unavailable node/source must not prevent another phone's short lease
    // from being renewed. Still surface errors; never count a failed stop as done.
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  }
  startReconciler({onError=()=>{}}={}){
    if(this.#timer)return;let busy=false;
    this.#timer=setInterval(async()=>{if(busy)return;busy=true;
      try{for(const value of await this.#repository.active())if(!this.#jobs.has(value.id))void this.#job(value).catch(onError);}
      catch(error){onError(error);}finally{busy=false;}
    },1000);this.#timer.unref();
  }
  stopReconciler(){clearInterval(this.#timer);this.#timer=null;for(const controller of this.#owned.values())controller.abort();}
}
