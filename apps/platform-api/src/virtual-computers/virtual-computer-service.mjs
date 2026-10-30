import {computerError,computerId,createInput,actionInput,requestKey,publicComputer} from './lifecycle.mjs';
import {policyUpdate,quotaUpdate,quotaQuery,publicPolicy} from './computer-administration.mjs';
import {profileImport,profilePublication,publicProfile} from './computer-profiles.mjs';
import {installationActionInput} from './installation-media.mjs';

export const publicComputerOperation = op => ({id:op.id,computerId:op.computerId,action:op.action,state:op.state,errorCode:op.errorCode??null});

/** No in-memory fallback or implicit lab backend. Production composition must
 * provide the existing directory, persistent repository and shared placement.
 */
export class VirtualComputerService {
  #repository; #directory; #policy; #capacity; #runtime;
  constructor({repository,directory,policyProvider,capacity=null,runtime=null}) {
    if(!['list','get','profiles','findRequest','getOperation','requestCreate','requestAction'].every(k=>typeof repository?.[k]==='function')
      || typeof directory?.authorization!=='function'||typeof policyProvider!=='function') throw TypeError('Computer service dependencies incomplete');
    if(capacity!==null&&typeof capacity.placement!=='function'||runtime!==null&&typeof runtime.execute!=='function') throw TypeError('Computer runtime dependencies incomplete');
    this.#repository=repository;this.#directory=directory;this.#policy=policyProvider;this.#capacity=capacity;this.#runtime=runtime;
  }
  async #owner(context,permission='computer:use') {
    if(!context?.identityId) computerError('invalid_session',401);
    const id=computerId(context.identityId),auth=await this.#directory.authorization(id);
    if(!auth?.permissions?.includes(permission)) computerError('computer_permission_required',403);
    return id;
  }
  async #ready(starting,ownerId) {
    const policy=await this.#policy(ownerId);
    if(!this.#capacity||!this.#runtime) computerError('computer_runtime_unavailable',503);
    if(starting&&policy.enabled!==true)computerError('computer_creation_paused',409);
    return policy;
  }
  async availability({context}) {
    const ownerId=await this.#owner(context);
    const policy=await this.#policy(ownerId),configured=Boolean(this.#capacity&&this.#runtime);
    return {ownerId,enabled:policy.enabled===true&&configured,closePageStopsComputer:false,
      reasonCode:!configured?'computer_runtime_unavailable':policy.enabled!==true?'computer_creation_paused':null,
      limits:{maximum:policy.maximum??{},storedPerUser:policy.storedPerUser??null,runningPerUser:policy.runningPerUser??null},
      systems:(await this.#repository.profiles()).map(({profile,create_enabled})=>({id:profile.id,name:profile.name,
        edition:profile.edition,minimum:profile.minimum,installable:profile.schemaVersion===2,osFamily:profile.osFamily??'windows',
        createEnabled:policy.enabled===true&&configured&&create_enabled,
        reasonCode:create_enabled?null:'computer_profile_unavailable'}))};
  }
  async list({context}) { return {data:(await this.#repository.list(await this.#owner(context))).map(publicComputer)}; }
  async get({context,computerId:id}) { return publicComputer(await this.#repository.get(await this.#owner(context),computerId(id))); }
  async getOperation({context,operationId}) { return publicComputerOperation(await this.#repository.getOperation(await this.#owner(context),computerId(operationId))); }
  async installation({context,computerId:id}) {
    const ownerId=await this.#owner(context);
    const installation=await this.#repository.getInstallation(ownerId,computerId(id));
    const computer=await this.#repository.get(ownerId,id),policy=await this.#policy(ownerId);
    const image=policy.runtimeUpdates?.[computer.profile.id]?.to??computer.profile.runtimeImage;
    return {supported:installation!==null,installation,computerRevision:computer.revision,
      canAdopt:installation===null&&computer.state==='stopped'&&computer.run===null&&policy.mediaRuntimeImages?.includes(image)===true,
      reasonCode:installation===null?'computer_installation_upgrade_required':null};
  }
  async installationAction({context,computerId:id,action,input,key}) {
    const ownerId=await this.#owner(context),selected=computerId(id),request=installationActionInput(action,input);requestKey(key);
    const policy=await this.#ready(false,ownerId);
    return publicComputerOperation(await this.#repository.requestInstallation({ownerId,computerId:selected,action,input:request,key,policy}));
  }
  async create({context,input,key}) {
    const ownerId=await this.#owner(context),request=createInput(input);requestKey(key);
    const prior=await this.#repository.findRequest(ownerId,'create',key,request);if(prior)return publicComputerOperation(prior);
    const policy=await this.#ready(true,ownerId);
    const placement=await this.#capacity.placement({ownerId,input:request,policy});
    return publicComputerOperation(await this.#repository.requestCreate({ownerId,input:request,key,placement,policy}));
  }
  async action({context,computerId:id,action,input,key}) {
    const ownerId=await this.#owner(context),selected=computerId(id),request=actionInput(action,input);requestKey(key);
    const prior=await this.#repository.findRequest(ownerId,action,key,{computerId:selected,...request});if(prior)return publicComputerOperation(prior);
    await this.#repository.get(ownerId,selected); // ownership first; administrator is not a guest owner
    const policy=await this.#ready(action==='start',ownerId);
    return publicComputerOperation(await this.#repository.requestAction({ownerId,computerId:selected,action,input:request,key,policy}));
  }
  async resolveDesktop({context,computerId:id}) {
    const c=await this.#repository.get(await this.#owner(context),computerId(id));
    if(!['running','stopping'].includes(c.state)||!c.run?.containerId) computerError('computer_runtime_unavailable',503);
    return {...c,runId:c.run.id};
  }
  async administration({context}) {
    await this.#owner(context,'computer:manage');
    return {policy:publicPolicy(await this.#policy()),contentAccessGranted:false,
      systems:(await this.#repository.profiles()).map(publicProfile),
      nodes:this.#capacity?.status?await this.#capacity.status():[]};
  }
  async setPolicy({context,input}) {
    const actor=await this.#owner(context,'computer:manage'),update=policyUpdate(input);
    if(!this.#repository.setPolicy)computerError('computer_runtime_unavailable',503);
    await this.#repository.setPolicy(actor,update);return this.administration({context});
  }
  async administrationQuotas({context,query}) {
    await this.#owner(context,'computer:manage');
    return this.#repository.administrationQuotas(quotaQuery(query),await this.#policy());
  }
  async setQuota({context,ownerId,input}) {
    const actor=await this.#owner(context,'computer:manage');
    return this.#repository.setQuota(actor,computerId(ownerId),quotaUpdate(input));
  }
  async importProfile({context,input}){
    await this.#owner(context,'computer:manage');
    return publicProfile(await this.#repository.importProfile(profileImport(input)));
  }
  async publishProfile({context,profileId,input}){
    await this.#owner(context,'computer:manage');
    if(!/^[a-z0-9][a-z0-9._-]*$/.test(profileId??''))computerError('computer_input_invalid',400);
    const update=profilePublication(input),policy=await this.#policy();
    return publicProfile(await this.#repository.publishProfile(profileId,update,async profile=>{
      if(!this.#capacity?.checkProfile)computerError('computer_profile_not_installed');
      await this.#capacity.checkProfile(profile,policy);
    }));
  }
}
