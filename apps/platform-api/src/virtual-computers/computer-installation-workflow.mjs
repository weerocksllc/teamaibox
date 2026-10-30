/** Advances only explicitly requested create-and-install jobs. Intent lives in
 * PostgreSQL, not a browser timer. Each step uses the existing durable queue;
 * a transport retry never creates another computer or restarts an installer. */
export class ComputerInstallationWorkflow {
  constructor({repository,directory,policyProvider}) {
    this.repository=repository;this.directory=directory;this.policyProvider=policyProvider;
  }
  async runOnce() {
    for(const computer of await this.repository.installationFollowups()) {
      const {id,ownerId}=computer;
      const installation=await this.repository.getInstallation(ownerId,id);
      if(!installation?.autoStart)continue;
      const finish=code=>this.repository.finishInstallationFollowup(ownerId,id,installation.revision,code);
      try {
        const auth=await this.directory.authorization(ownerId);
        if(!auth?.permissions?.includes('computer:use')){await finish('computer_permission_required');continue;}
        if(computer.state==='running'){await finish(null);continue;}
        if(computer.state!=='stopped') {
          if(['error','deleted','unavailable'].includes(computer.state))await finish(computer.errorCode??'computer_runtime_unavailable');
          continue;
        }
        if(installation.errorCode||!installation.desiredMediaId) {
          await finish(installation.errorCode??'computer_media_not_ready');continue;
        }
        if(installation.operationId)continue;
        const base={ownerId,computerId:id,automatic:true};
        if(installation.desiredMediaId!==installation.observedMediaId) {
          await this.repository.requestInstallation({...base,action:'mount',key:`${id}:install:mount`,
            input:{expectedRevision:installation.revision,mediaId:installation.desiredMediaId,allowUnverified:true}});
        } else if(installation.boot?.state!=='pending') {
          // A consumed/armed request must never be automatically re-armed.
          if(installation.boot){await finish('computer_installation_boot_unconfirmed');continue;}
          await this.repository.requestInstallation({...base,action:'boot-disc',key:`${id}:install:boot`,
            input:{expectedRevision:installation.revision}});
        } else {
          await this.repository.requestAction({...base,action:'start',key:`${id}:install:start`,
            input:{expectedRevision:computer.revision},policy:await this.policyProvider(ownerId)});
          // Keep autoStart until the queue finishes. On a lost reply, the
          // persisted starting/run state is the authority, not another start.
        }
      } catch(error) {
        if(['computer_state_conflict','computer_operation_pending'].includes(error.code))continue;
        if(['computer_permission_required','computer_creation_paused','computer_running_quota',
          'computer_media_not_ready','computer_installation_upgrade_required','computer_profile_unavailable',
          'computer_capacity_unavailable','computer_storage_unavailable','computer_installation_boot_unconfirmed'].includes(error.code)) {
          await finish(error.code);continue;
        }
        throw error; // Database/transport failure: retain intent and retry later.
      }
    }
  }
}
