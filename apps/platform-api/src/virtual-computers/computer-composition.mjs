import {PostgresComputerCapacity} from '../../../../services/scheduler/src/postgres-computer-capacity.mjs';
import {ManagedNodeComputerBaselineProvider} from '../../../../services/scheduler/src/managed-node-computer-baseline-provider.mjs';
import {PostgresComputerRepository} from './postgres-computer-repository.mjs';
import {ManagedComputerRuntime} from './managed-computer-runtime.mjs';
import {VirtualComputerService} from './virtual-computer-service.mjs';
import {VirtualComputerHttpApi} from './virtual-computer-http-api.mjs';
import {ComputerOperationWorker} from './computer-operation-worker.mjs';
import {ComputerStateReconciler} from './computer-state-reconciler.mjs';
import {ComputerDesktopAccess} from './desktop-access.mjs';
import {MonitorSharing} from './monitor-sharing.mjs';
import {readFileSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {ManagedDesktopBackends} from './managed-desktop-backend.mjs';
import {GuacamoleDesktopProvider} from './guacamole-desktop-provider.mjs';
import {PostgresInstallationMediaRepository} from './postgres-installation-media-repository.mjs';
import {InstallationObjectTransfer} from './installation-object-transfer.mjs';
import {InstallationMediaService} from './installation-media-service.mjs';
import {InstallationMediaWorker} from './installation-media-worker.mjs';
import {ComputerInstallationWorkflow} from './computer-installation-workflow.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=/^sha256:[a-f0-9]{64}$/;
const object=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const nonnegative=v=>Number.isSafeInteger(v)&&v>=0;
const policyKeys=['qemuOverheadBytes','gatewayOverheadBytes','storageReserveBytes','storageOverheadBytes','maximumSampleAgeMs'];

// Installed node policy, not browser input. No default guest quantity/disk cap:
// Explicit account count policies are separate from runtime resource sharing.
export function computerConfiguration(environment) {
  const raw=environment.PLATFORM_VIRTUAL_COMPUTERS_CONFIG_JSON;
  if(raw===undefined)return null;
  let c;
  try{c=JSON.parse(raw);}catch{throw TypeError('Invalid virtual computer configuration');}
  if(typeof raw!=='string'||!object(c,['version','enabled','installedNodes','policy','desktop'])||c.version!==1
    ||typeof c.enabled!=='boolean'||!Array.isArray(c.installedNodes)||!c.installedNodes.length
    ||!object(c.policy,['maximum','storedPerUser','runningPerUser','runtimeUpdates','mediaRuntimeImages']))throw TypeError('Invalid virtual computer configuration');
  if(c.policy.mediaRuntimeImages!==undefined&&(!Array.isArray(c.policy.mediaRuntimeImages)||c.policy.mediaRuntimeImages.some(v=>!digest.test(v))))throw TypeError('Invalid installation runtime capability');
  if(c.policy.runtimeUpdates!==undefined){
    const updates=c.policy.runtimeUpdates;
    if(!updates||typeof updates!=='object'||Array.isArray(updates))throw TypeError('Invalid computer runtime updates');
    for(const [id,update] of Object.entries(updates)){
      const from=Array.isArray(update?.from)?update.from:[update?.from];
      if(!/^[a-z0-9][a-z0-9._-]*$/.test(id)||!object(update,['from','to'])
        ||!from.length||from.some(value=>!digest.test(value??''))||new Set(from).size!==from.length
        ||!digest.test(update.to??'')||from.includes(update.to))throw TypeError('Invalid computer runtime update');
    }
  }
  for(const key of ['storedPerUser','runningPerUser'])if(c.policy[key]!=null&&!nonnegative(c.policy[key]))throw TypeError('Invalid computer quota');
  if(c.policy.maximum!=null&&(!object(c.policy.maximum,['vcpus','memoryGiB','diskGiB'])
    ||Object.values(c.policy.maximum).some(v=>!Number.isSafeInteger(v)||v<=0)))throw TypeError('Invalid computer resource maximum');
  const ids=new Set();
  if(c.desktop!==undefined&&(!object(c.desktop,['guacamoleOrigin','jsonSecretFile'])
    ||typeof c.desktop.guacamoleOrigin!=='string'||typeof c.desktop.jsonSecretFile!=='string'||!isAbsolute(c.desktop.jsonSecretFile)))throw TypeError('Invalid installed desktop configuration');
  for(const n of c.installedNodes){
    if(!object(n,['nodeId','poolId','profileIds','policy'])||!uuid.test(n.nodeId)||ids.has(n.nodeId)
      ||typeof n.poolId!=='string'||!n.poolId||!Array.isArray(n.profileIds)||!n.profileIds.length
      ||n.profileIds.some(id=>typeof id!=='string'||!/^[a-z0-9][a-z0-9._-]*$/.test(id))
      ||new Set(n.profileIds).size!==n.profileIds.length||!object(n.policy,[...policyKeys,'hostReserveBytes','cpuReserve'])
      ||policyKeys.some(key=>!nonnegative(n.policy[key]))||n.policy.maximumSampleAgeMs===0
      ||n.policy.storageOverheadBytes===0
      ||n.policy.qemuOverheadBytes+n.policy.gatewayOverheadBytes===0)throw TypeError('Invalid installed computer node');
    // Read old installations without enforcing retired reserve settings.
    delete n.policy.hostReserveBytes; delete n.policy.cpuReserve;
    n.policy.storageReserveBytes=0;
    ids.add(n.nodeId);
  }
  return c;
}

/** Optional composition inside the existing Platform API. An ordinary API
 * upgrade without the installed config neither reads the new tables nor
 * touches guest containers. Starting/stopping this worker affects only queue
 * consumption; durable disks, runs and resource reservations stay in place. */
export function computersFromEnvironment({environment,database,directory,nodeAgentRouter,desktopProvider=null,objectService=null,teamDrive=null}) {
  const config=computerConfiguration(environment);
  if(config===null)return null;
  let backends;
  if(!desktopProvider&&config.desktop){
    const file=config.desktop.jsonSecretFile,stat=lstatSync(file);
    if(!stat.isFile()||stat.size>64||stat.mode&0o007)throw TypeError('Invalid installed desktop secret file');
    const text=readFileSync(file,'utf8').trim();if(!/^[a-f0-9]{32}$/.test(text))throw TypeError('Invalid installed desktop secret');
    const key=Buffer.from(text,'hex');
    try{backends=new ManagedDesktopBackends({nodeAgentRouter,guacamoleOrigin:config.desktop.guacamoleOrigin,jsonSecret:key});}
    finally{key.fill(0);}
    desktopProvider=new GuacamoleDesktopProvider({backendForComputer:input=>backends.forComputer(input)});
  }
  if(config.enabled&&typeof desktopProvider?.connect!=='function')throw TypeError('Computer desktop transport must be installed before enabling creation');
  const repository=new PostgresComputerRepository({database});
  const capacity=new PostgresComputerCapacity({database,localNodeId:environment.PLATFORM_APPLIANCE_NODE_ID,installedNodes:config.installedNodes,
    baselineProvider:new ManagedNodeComputerBaselineProvider({database,nodeAgentRouter})});
  const mediaRepository=objectService&&teamDrive?new PostgresInstallationMediaRepository({database}):null;
  const transfer=mediaRepository?new InstallationObjectTransfer({objectService,teamDrive}):null;
  const runtime=new ManagedComputerRuntime({repository,capacity,nodeRouter:nodeAgentRouter,timeoutMilliseconds:120000,mediaRepository,mediaTransfer:transfer});
  const service=new VirtualComputerService({repository,directory,capacity,runtime,
    policyProvider:async ownerId=>repository.policy(structuredClone({...config.policy,enabled:config.enabled}),ownerId)});
  let mediaService=null,mediaWorker=null;
  if(objectService&&teamDrive){
    mediaService=new InstallationMediaService({repository:mediaRepository,directory,transfer});
    mediaWorker=new InstallationMediaWorker({repository:mediaRepository,directory,transfer});
  }
  const api=new VirtualComputerHttpApi({service,mediaService});
  const installationWorkflow=mediaService?new ComputerInstallationWorkflow({repository,directory,
    policyProvider:ownerId=>repository.policy(structuredClone({...config.policy,enabled:config.enabled}),ownerId)}):null;
  const worker=new ComputerOperationWorker({repository,runtime,releaseResources:input=>capacity.releaseResources(input),leaseMs:30000,pollMs:1000,
    followup:installationWorkflow?()=>installationWorkflow.runOnce():null});
  const reconciler=new ComputerStateReconciler({repository,nodeRouter:nodeAgentRouter});
  const sharing=new MonitorSharing({database,directory,repository});
  const desktop=desktopProvider?new ComputerDesktopAccess({resolveOwnedComputer:input=>service.resolveDesktop(input),provider:desktopProvider,sharing}):null;
  return {api,desktop,service,worker,reconciler,mediaService,mediaWorker,
    start:()=>{worker.start();reconciler.start();mediaWorker?.start();},
    async close(){desktop?.close();backends?.close();await Promise.all([worker.stop(),reconciler.stop(),mediaWorker?.stop()]);}};
}
