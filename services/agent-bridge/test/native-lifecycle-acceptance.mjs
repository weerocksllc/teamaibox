// Opt-in: exact production runtime/container entrypoint, synthetic identities
// and storage only. No image pulls or appliance data. The small local Docker VM
// uses explicit synthetic capacity telemetry; this is NOT host-capacity proof.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,chown,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {DynamicSandboxController,dynamicSandboxIdentity} from '../src/dynamic-sandbox-controller.mjs';
import {createDynamicSandboxRuntime} from '../src/dynamic-sandbox-runtime.mjs';
import {agentOpenCodeConfig} from '../src/agent-model-access-service.mjs';

const label='com.teamaibox.native-lifecycle';
const cli=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024**2}).trim();
if(process.env.NATIVE_LIFECYCLE_CHILD==='1'){
  const cfg=JSON.parse(process.env.NATIVE_LIFECYCLE_CONFIG);
  const owners=JSON.parse(process.env.NATIVE_LIFECYCLE_OWNERS);
  const records=new Map();let now=1000;
  async function docker(method,path,body){
    return new Promise((resolve,reject)=>{
      const raw=body===undefined?undefined:JSON.stringify(body);
      const req=http.request({socketPath:'/var/run/docker.sock',path:'/v1.45'+path,method,
        headers:raw?{'content-type':'application/json','content-length':Buffer.byteLength(raw)}:{},timeout:45000},res=>{
        let result='';res.setEncoding('utf8');res.on('data',part=>result+=part);res.on('error',reject);
        res.on('end',()=>{if(res.statusCode>=400){const error=Error(`Docker ${method} ${path} failed: ${res.statusCode} ${result.slice(0,200)}`);error.status=res.statusCode;reject(error);}else{try{resolve(result?JSON.parse(result):null);}catch(error){reject(error);}}});
      });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Docker timeout')));req.end(raw);
    });
  }
  const root=id=>'/state/'+id.key;
  const storage={
    async prepare(id){
      if(records.has(id.key))return records.get(id.key);
      const token=randomBytes(48).toString('base64url');
      for(const path of ['workspace','runtime','runtime/secrets','runtime/xdg-config','runtime/xdg-config/opencode','model']){
        const target=root(id)+'/'+path;await mkdir(target,{recursive:true,mode:0o700});await chown(target,65532,65532);
      }
      for(const [name,value] of [['agent-bridge-token',token],['opencode-password',randomBytes(48).toString('base64url')]]){
        const path=root(id)+'/runtime/secrets/'+name;await writeFile(path,value,{mode:0o400});await chown(path,65532,65532);
      }
      const record={...id,token,lastUsedAt:now};records.set(id.key,record);return record;
    },
    async credentials(id){
      const config=agentOpenCodeConfig([{alias:'agent.default',displayName:'Synthetic managed model',contextTokens:32768,outputTokens:4096}], 'agent.default');
      await writeFile(root(id)+'/runtime/xdg-config/opencode/opencode.json',JSON.stringify(config),{mode:0o444});
      const path=root(id)+'/model/teamaibox-model-token';await writeFile(path,randomBytes(48).toString('base64url'),{mode:0o400});await chown(path,65532,65532);
    },
    async touch(id,time){records.get(id.key).lastUsedAt=time;},async list(){return [...records.values()];},
  };
  const runtime=createDynamicSandboxRuntime({config:cfg,docker,availableMemory:async()=>128*1024**3,
    bridgeToken:async id=>records.get(id.key).token});
  const controller=new DynamicSandboxController({storage,runtime,clock:()=>now,idleMilliseconds:100,
    identities:{active:async id=>owners.includes(id),busy:async()=>false}});
  const call=async(route,path,method='GET',body)=>{
    const response=await fetch(route.origin+'/native'+path,{method,headers:{authorization:'Bearer '+route.token,'content-type':'application/json'},
      signal:AbortSignal.timeout(20000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.ok(response.ok,`${method} ${path}: ${response.status} ${response.ok?'':(await response.text()).slice(0,400)}`);
    return response.status===204?null:response.json();
  };
  console.log('Lifecycle fixture uses synthetic capacity only; exact production Docker restrictions and entrypoint remain unchanged.');
  if(process.env.NATIVE_LIFECYCLE_CASE==='oauth'){
    const service=spawn(process.execPath,['/source/services/agent-bridge/test/fixtures/native-oauth-service.mjs'],{
      stdio:'inherit',env:{...process.env,SYNTHETIC_RESOURCE_ORIGIN:'http://oauth-fixture:4101'},
    });
    try{
      for(let n=0;n<30;n++){try{if((await fetch('http://oauth-fixture:4101/evidence')).ok)break;}catch{}if(n===29)throw Error('OAuth fixture readiness');await new Promise(r=>setTimeout(r,100));}
      const a=await controller.ensure(owners[0]);
      await call(a,'/global/config','PATCH',{mcp:{retainedOAuth:{type:'remote',url:'http://oauth-fixture:4101/mcp',oauth:{redirectUri:'https://appliance.test/assistant/oauth/callback'},enabled:true}}});
      const started=await call(a,'/mcp/retainedOAuth/auth','POST');
      const authorization=await fetch(started.authorizationUrl,{redirect:'manual'});
      const returned=new URL(authorization.headers.get('location'));assert.equal(returned.searchParams.get('state'),started.oauthState);
      assert.equal((await call(a,'/mcp/retainedOAuth/auth/callback','POST',{code:returned.searchParams.get('code')})).status,'connected');
      const filename=root(a)+'/workspace/.teamaibox/data/opencode/mcp-auth.json';
      const authBefore=await readFile(filename,'utf8');
      await runtime.stop(a,await runtime.inspect(a));await docker('DELETE','/containers/'+a.name);
      const replacement=await controller.ensure(owners[0]);
      assert.equal((await call(replacement,'/mcp')).retainedOAuth.status,'connected');
      assert.equal(await readFile(filename,'utf8'),authBefore);
      await call(replacement,'/mcp/retainedOAuth/auth','DELETE');
      const authRemoved=await readFile(filename,'utf8');assert.notEqual(authRemoved,authBefore);
      console.log('PASS exact-entry replacement retains native MCP OAuth token and reconnects without login; native revoke removes auth');
    }finally{service.kill('SIGTERM');}
  }else{
  const [a,again]=await Promise.all([controller.ensure(owners[0]),controller.ensure(owners[0])]);
  assert.equal(a.origin,again.origin);assert.equal(a.token,again.token);
  const b=await controller.ensure(owners[1]);assert.notEqual(a.origin,b.origin);
  console.log('PASS production controller concurrent same-owner reuse and two non-root instances');
  const inspected=await runtime.inspect(a);runtime.assertOwned(a,inspected);
  assert.throws(()=>runtime.assertOwned(b,inspected),/identity_conflict/);
  assert.equal((await fetch(a.origin+'/native/session',{headers:{authorization:'Bearer '+b.token}})).status,401);
  assert.equal((await call(a,'/global/health')).version,'1.19.5');
  const session=await call(a,'/session','POST',{title:'Synthetic full-entry retained history'});
  await call(a,'/global/config','PATCH',{username:'Synthetic owner',command:{retained:{template:'Synthetic retained command'}},mcp:{retained:{type:'local',command:['node','missing-disabled-fixture'],enabled:false}}});
  assert.equal((await call(a,'/config')).model,'teamaibox/agent.default');
  assert.equal((await call(b,'/session')).some(row=>row.id===session.id),false);
  const secret=randomBytes(48).toString('base64url');
  await call(a,'/auth/tab-fixture','PUT',{type:'api',key:secret});
  const authPath=root(a)+'/workspace/.teamaibox/data/opencode/auth.json';
  const authBefore=await readFile(authPath,'utf8');assert.ok(authBefore.includes(secret));
  const workspace=root(a)+'/workspace';
  await writeFile(workspace+'/retained.txt','Synthetic retained file');
  const skill=workspace+'/.teamaibox/config/opencode/skills/retained';await mkdir(skill,{recursive:true});
  await writeFile(skill+'/SKILL.md','---\nname: retained\ndescription: Synthetic retained Skill\n---\nUse synthetic input.\n');
  const sdkPath=workspace+'/.teamaibox/config/opencode/node_modules/@opencode-ai/plugin/package.json';
  assert.equal(JSON.parse(await readFile(sdkPath)).version,'1.19.5');
  const sdkTime=(await stat(sdkPath)).mtimeMs;
  console.log('PASS full entry initializes native SDK offline, managed config and owner-isolated native state');
  const pty=await call(a,'/pty','POST',{command:'sh',cwd:'/workspace',title:'Synthetic idle retention'});
  now+=1000;await controller.reconcile();
  assert.equal((await runtime.inspect(a)).running,true,'native terminal prevents idle reclamation');
  assert.equal((await runtime.inspect(b)).running,false,'idle second owner stops');
  await call(a,`/pty/${pty.id}`,'DELETE');
  await controller.reconcile();assert.equal((await runtime.inspect(a)).running,false);
  await docker('DELETE','/containers/'+a.name);
  const replacement=await controller.ensure(owners[0]);
  assert.notEqual((await runtime.inspect(replacement)).raw.Id,inspected.raw.Id);
  assert.equal((await call(replacement,`/session/${session.id}`)).title,session.title);
  assert.equal((await call(replacement,'/global/config')).mcp.retained.enabled,false);
  assert.ok((await call(replacement,'/skill')).some(row=>row.name==='retained'));
  assert.equal(await readFile(authPath,'utf8'),authBefore);
  assert.equal(await readFile(workspace+'/retained.txt','utf8'),'Synthetic retained file');
  assert.equal((await stat(sdkPath)).mtimeMs,sdkTime,'restart leaves existing native SDK intact');
  console.log('PASS native activity blocks idle stop; replacement retains sessions, auth, MCP, Skills, files and SDK');
  }
}else{
  const image=process.env.NATIVE_CANDIDATE_IMAGE;if(!image)throw Error('Set NATIVE_CANDIDATE_IMAGE to a local full AgentSandbox image');
  const imageId=cli('image','inspect','--format','{{.Id}}',image);
  const id='tab-native-life-'+randomUUID(),owners=[randomUUID(),randomUUID()];
  const networks=[id+'-a',id+'-b'];let volume=false,runner=false;const madeNetworks=[];
  const source=fileURLToPath(new URL('../../../',import.meta.url));
  try{
    cli('volume','create','--label',`${label}=${id}`,id);volume=true;
    for(const name of networks){cli('network','create','--internal','--label',`${label}=${id}`,name);madeNetworks.push(name);}
    cli('create','--name',id,'--label',`${label}=${id}`,'--pull=never','--user','0:0','--network',networks[0],'--network-alias','oauth-fixture',
      '--mount',`type=volume,source=${id},target=/state`,'--mount',`type=bind,source=${source},target=/source,readonly`,
      '--mount',`type=bind,source=${process.env.NATIVE_DOCKER_SOCKET??'/var/run/docker.sock'},target=/var/run/docker.sock`,
      '-e','NATIVE_LIFECYCLE_CHILD=1','-e','NATIVE_LIFECYCLE_CONFIG='+JSON.stringify({image:imageId,volume:id,networks}),
      '-e','NATIVE_LIFECYCLE_CASE='+(process.env.NATIVE_LIFECYCLE_CASE??'state'),
      '-e','NATIVE_LIFECYCLE_OWNERS='+JSON.stringify(owners),'--entrypoint','node',image,
      '/source/services/agent-bridge/test/native-lifecycle-acceptance.mjs');runner=true;
    cli('start',id);
    let exit;
    for(let i=0;i<300;i++){
      const state=JSON.parse(cli('inspect','--format','{{json .State}}',id));
      if(!state.Running){exit=state.ExitCode;break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    console.log(cli('logs',id));assert.equal(exit,0,'production lifecycle fixture exit');
  }finally{
    for(const owner of owners){const identity=dynamicSandboxIdentity(owner);let found;
      try{found=JSON.parse(cli('inspect',identity.name))[0];}catch{continue;}
      assert.equal(found.Config.Labels['com.teamaibox.dynamic-agent-owner'],owner);assert.equal(found.Image,imageId);
      console.log(`Synthetic instance ${identity.key.slice(0,8)} logs:`,cli('logs','--tail','12',identity.name));
      cli('stop','--time','10',identity.name);cli('rm',identity.name);
    }
    if(runner){assert.equal(cli('inspect','--format',`{{index .Config.Labels "${label}"}}`,id),id);cli('stop','--time','10',id);cli('rm',id);}
    for(const name of madeNetworks){assert.equal(cli('network','inspect','--format',`{{index .Labels "${label}"}}`,name),id);cli('network','rm',name);}
    if(volume){assert.equal(cli('volume','inspect','--format',`{{index .Labels "${label}"}}`,id),id);cli('volume','rm',id);}
  }
}
