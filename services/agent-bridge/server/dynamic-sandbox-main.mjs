import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,chown,chmod,readdir,lstat} from 'node:fs/promises';
import {createPostgresDatabaseFromEnvironment} from '../../../packages/persistence/src/postgres-database.mjs';
import {AgentModelCredentialAuthority,loadAgentModelSigningKey} from '../../compute-gateway/src/agent-model-credential.mjs';
import {AgentModelAccessService} from '../src/agent-model-access-service.mjs';
import {generateSourceClientConfig,INTERNAL_SOURCE_GATEWAYS} from '../src/source-client-config.mjs';
import {DynamicSandboxController,dynamicSandboxIdentity} from '../src/dynamic-sandbox-controller.mjs';
import {createDynamicSandboxRuntime} from '../src/dynamic-sandbox-runtime.mjs';

const cfg=JSON.parse(await readFile('/run/config/agent-controller.json','utf8'));
if (!/^sha256:[a-f0-9]{64}$/.test(cfg.image) || !/^[a-z0-9_-]+$/.test(cfg.volume)
 || !Array.isArray(cfg.networks) || cfg.networks.length!==2 || cfg.networks.some(n=>!/^[a-z0-9_-]+$/.test(n))) throw Error('agent_controller_configuration_invalid');
const ROOT='/state';
const auth=(await readFile('/agent-control/dynamic-controller-token','utf8')).trim();
if (!/^[A-Za-z0-9_-]{32,4096}$/.test(auth)) throw Error('agent_controller_token_invalid');
const key=await loadAgentModelSigningKey('/run/secrets/agent-model-signing-key');
const authority=new AgentModelCredentialAuthority({signingKey:key});key.fill(0);
const database=await createPostgresDatabaseFromEnvironment(process.env);
async function docker(method,path,body) {
 return new Promise((resolve,reject)=>{
  const data=body===undefined?null:Buffer.from(JSON.stringify(body));
  const req=http.request({socketPath:'/var/run/docker.sock',method,path:'/v1.45'+path,
   headers:data?{'content-type':'application/json','content-length':data.length}:{},timeout:45000},res=>{
   const chunks=[];let bytes=0;res.on('data',b=>{bytes+=b.length;if(bytes>4*1024**2)req.destroy(Error('docker_response_too_large'));else chunks.push(b);});
   res.on('error',reject);res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let value;try{value=raw?JSON.parse(raw):null;}catch{return reject(Error('docker_response_invalid'));}
    if(res.statusCode>=400){const error=Error('docker_request_failed');error.status=res.statusCode;return reject(error);}resolve(value);});
  });req.on('timeout',()=>req.destroy(Error('docker_timeout')));req.on('error',reject);req.end(data);
 });
}
async function atomic(file,value,uid=65532,mode=0o400) {
 const temporary=file+'.next';await writeFile(temporary,value,{mode});await chown(temporary,uid,uid);await chmod(temporary,mode);await rename(temporary,file);
}
const storage={
 async prepare(id) {
  const base=ROOT+'/'+id.key;
  for(const relative of ['','runtime','runtime/secrets','runtime/xdg-config','runtime/xdg-config/opencode','runtime/source-config','runtime/source-config/apt','model','workspace','workspace/.teamaibox','workspace/.teamaibox/home','workspace/.teamaibox/data','workspace/.teamaibox/cache']) {
   const path=base+'/'+relative;await mkdir(path,{recursive:true,mode:0o700});
   if(!(await lstat(path)).isDirectory())throw Error('agent_storage_invalid');
   if(relative.startsWith('workspace') || relative.startsWith('runtime') || relative==='model')await chown(path,65532,65532);
  }
  for(const name of ['opencode-password','agent-bridge-token']) {
   const path=base+'/runtime/secrets/'+name;
   try {await writeFile(path,randomBytes(48).toString('base64url'),{flag:'wx',mode:0o400});}catch(e){if(e.code!=='EEXIST')throw e;}
   await chown(path,65532,65532);await chmod(path,0o400);
  }
  const source=generateSourceClientConfig(INTERNAL_SOURCE_GATEWAYS);
  await atomic(base+'/runtime/xdg-config/opencode/.gitignore','node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n',0,0o444);
  for(const [path,value] of [['pip.conf',source.pipConf],['npmrc',source.npmrc],['apt/apt.conf',source.aptConf],['apt/sources.list',source.aptSources]])await atomic(base+'/runtime/source-config/'+path,value,0,0o444);
  await atomic(base+'/owner.json',JSON.stringify({ownerIdentityId:id.ownerIdentityId,lastUsedAt:Date.now()}),0,0o600);
  return {token:(await readFile(base+'/runtime/secrets/agent-bridge-token','utf8')).trim()};
 },
 async credentials(id) {
  const base=ROOT+'/'+id.key;
  const service=new AgentModelAccessService({
   catalog:{async listApprovedAgentModels(){return [{alias:'agent.default',displayName:'Team AI Box Agent',contextTokens:32768,outputTokens:4096,approvedForAgent:true}];}},
   credentialIssuer:authority,sandboxProjector:{
    async projectConfig(input){await atomic(base+'/runtime/xdg-config/opencode/opencode.json',input.contents,0,0o444);},
    async projectSecret(input){await atomic(base+'/model/teamaibox-model-token',input.contents);}
   }});
  // Owner UUID is a stable sandbox scope, unique across this controller.
  await service.provision({ownerIdentityId:id.ownerIdentityId,sandboxId:id.ownerIdentityId,requestedAliases:['agent.default'],defaultAlias:'agent.default',ttlSeconds:300});
 },
 async touch(id,lastUsedAt){await atomic(ROOT+'/'+id.key+'/owner.json',JSON.stringify({ownerIdentityId:id.ownerIdentityId,lastUsedAt}),0,0o600);},
 async list(){const result=[];for(const key of await readdir(ROOT)){if(!/^[a-f0-9]{32}$/.test(key))continue;
  const value=JSON.parse(await readFile(ROOT+'/'+key+'/owner.json','utf8'));const id=dynamicSandboxIdentity(value.ownerIdentityId);if(id.key!==key)throw Error('agent_storage_owner_invalid');result.push({...id,lastUsedAt:value.lastUsedAt});}return result;},
};
const identities={
 async active(id){return (await database.query("SELECT id FROM iam.identities WHERE id=$1 AND status='active' AND identity_kind='local_user'",[id])).rows.length===1;},
 async busy(id){return (await database.query("SELECT 1 FROM platform.agent_prompts p JOIN platform.agent_session_bindings b ON b.id=p.binding_id WHERE b.owner_identity_id=$1 AND p.status IN ('admitted','submitting','accepted','running','reconcile_required') LIMIT 1",[id])).rows.length>0;},
};
const runtime=createDynamicSandboxRuntime({config:cfg,docker,
 availableMemory:async()=>Number((await readFile('/proc/meminfo','utf8')).match(/^MemAvailable:\s+(\d+)/m)?.[1])*1024,
 bridgeToken:async id=>(await readFile(ROOT+'/'+id.key+'/runtime/secrets/agent-bridge-token','utf8')).trim(),
});
await mkdir(ROOT,{recursive:true});const controller=new DynamicSandboxController({identities,runtime,storage});
let sweep=false;
const timer=setInterval(async()=>{if(sweep)return;sweep=true;try{await controller.reconcile();}catch{console.error('agent_reconcile_failed');}finally{sweep=false;}},60000);
function reply(res,status,value){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
const server=http.createServer(async(req,res)=>{
 if(req.url==='/health/live')return reply(res,200,{status:'ok'});
 const token=String(req.headers.authorization??'').replace(/^Bearer /,'');
 if(!/^[A-Za-z0-9_-]+$/.test(token)||token.length!==auth.length||!timingSafeEqual(Buffer.from(token),Buffer.from(auth)))return reply(res,403,{code:'forbidden'});
 const match=/^\/v1\/owners\/([a-f0-9-]{36})\/ensure$/.exec(req.url);
 if(req.method!=='POST'||!match)return reply(res,404,{code:'not_found'});
 try{reply(res,200,await controller.ensure(match[1]));}catch(e){console.error(JSON.stringify({event:'agent_provision_failed',code:/^agent_[a-z_]+$/.test(e.message)?e.message:'agent_runtime_failed'}));reply(res,503,{code:'agent_sandbox_unavailable'});}
});
server.listen(8080,'0.0.0.0');
process.once('SIGTERM',()=>{clearInterval(timer);server.close(async()=>{authority.close();await database.close();process.exit(0);});});
