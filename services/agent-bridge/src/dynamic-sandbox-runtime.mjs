import {sandboxMemoryAdmission} from './sandbox-memory-admission.mjs';
import {createNativeTransport} from './opencode-native-transport.mjs';
import {nativeInstanceBusy} from './opencode-native-activity.mjs';
import {dynamicSandboxIdentity} from './dynamic-sandbox-controller.mjs';

// Same runtime used by the controller service and isolated local acceptance.
// Inject I/O, not a replacement execution engine or a relaxed container policy.
export function createDynamicSandboxRuntime({config:cfg,docker,availableMemory,bridgeToken}) {
const LABEL='com.teamaibox.dynamic-agent-owner', memory=8*1024**3;
let starting=Promise.resolve();
const runtime={
 async busy(id,current){this.assertOwned(id,current);return nativeInstanceBusy(createNativeTransport({
  origin:id.origin,prefix:'/native',authorization:async()=>`Bearer ${await bridgeToken(id)}`,
 }));},
 async inspect(id){try{const v=await docker('GET','/containers/'+id.name+'/json');return {running:v.State.Running,raw:v};}catch(e){if(e.status===404)return null;throw e;}},
 assertOwned(id,current){const v=current.raw,h=v.HostConfig;
  if(v.Config.Labels?.[LABEL]!==id.ownerIdentityId || v.Image!==cfg.image || v.Config.User!=='65532:65532'
   || !h.ReadonlyRootfs || h.Privileged || h.Memory!==memory || h.MemorySwap!==memory
   || h.CapDrop?.join()!=='ALL' || h.Devices?.length || h.Binds?.length)throw Error('agent_container_identity_conflict');
  for(const [path,kind] of [['/workspace','workspace'],['/run/teamaibox','runtime'],['/run/secrets','model']]) {
   const m=h.Mounts?.find(m=>m.Target===path);
   if(m?.Type!=='volume'||m.Source!==cfg.volume||m.VolumeOptions?.Subpath!==id.key+'/'+kind||Boolean(m.ReadOnly)!==(kind!=='workspace'))throw Error('agent_workspace_identity_conflict');
  }
 },
 async admit(){},
 async start(id,current){
  let release;const previous=starting;starting=new Promise(r=>release=r);await previous;
  try {
   const available=await availableMemory();
   const running=await docker('GET','/containers/json?filters='+encodeURIComponent(JSON.stringify({label:[LABEL],status:['running']})));
   const observations=[];
   for(const row of running) {
    const owned=dynamicSandboxIdentity(row.Labels?.[LABEL]);
    const inspected=await this.inspect(owned);this.assertOwned(owned,inspected);
    const stats=await docker('GET','/containers/'+inspected.raw.Id+'/stats?stream=false&one-shot=true');
    observations.push({limitBytes:memory,usageBytes:stats.memory_stats?.usage,
      reclaimableBytes:stats.memory_stats?.stats?.inactive_file??stats.memory_stats?.stats?.total_inactive_file});
   }
   const admission=sandboxMemoryAdmission({availableBytes:available,requestedBytes:memory,running:observations});
   if(!admission.eligible)throw Error('agent_capacity_unavailable');
   if(!current) {
    await docker('POST','/containers/create?name='+id.name,{
     Image:cfg.image,User:'65532:65532',WorkingDir:'/workspace',Labels:{[LABEL]:id.ownerIdentityId},
     HostConfig:{ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],Init:true,
      Memory:memory,MemorySwap:memory,MemoryReservation:1024**3,NanoCpus:4e9,PidsLimit:512,RestartPolicy:{Name:'no'},
      NetworkMode:cfg.networks[0],Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=1g','/run/opencode-native':'rw,nosuid,nodev,exec,size=64m,uid=65532,gid=65532,mode=0700'},
      Mounts:[['/workspace','workspace'],['/run/teamaibox','runtime'],['/run/secrets','model']].map(([Target,kind])=>({Type:'volume',Source:cfg.volume,Target,ReadOnly:kind!=='workspace',VolumeOptions:{Subpath:id.key+'/'+kind,NoCopy:true}}))},
     NetworkingConfig:{EndpointsConfig:{[cfg.networks[0]]:{Aliases:[id.name]},[cfg.networks[1]]:{Aliases:[id.name]}}},
    });
   }
   await docker('POST','/containers/'+id.name+'/start');return await this.inspect(id);
  } finally {release();}
 },
 async healthy(id){const deadline=Date.now()+60000;while(Date.now()<deadline){const v=await this.inspect(id);this.assertOwned(id,v);
  if(!v.running)throw Error('agent_start_failed');if(v.raw.State.Health?.Status==='healthy')return;await new Promise(r=>setTimeout(r,500));}throw Error('agent_start_timeout');},
 async stop(id,current){this.assertOwned(id,current);await docker('POST','/containers/'+id.name+'/stop?t=10');},
};
return runtime;
}
