// Opt-in integrated React + platform authentication + real OpenCode containers.
// Only local, randomly named synthetic resources are created. No image pulls.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer as createTcpServer} from 'node:net';
import {createServer as createViteServer} from '../node_modules/vite/dist/node/index.js';
import {createWebBoundary} from '../server/web-boundary.mjs';
import {createPlatformApiServer} from '../../platform-api/server/platform-api.mjs';
import {NativeAssistantApi} from '../../platform-api/src/assistant/native-assistant-api.mjs';
import {AssistantHttpApi} from '../../platform-api/src/assistant/assistant-http-api.mjs';
import {LocalAuthentication} from '../../platform-api/src/identity/auth-service.mjs';
import {MemoryIdentityRepository} from '../../platform-api/src/identity/memory-repository.mjs';
import {PasswordHasher} from '../../platform-api/src/identity/password.mjs';
import {IdentityPreferencesService} from '../../platform-api/src/identity/preferences-service.mjs';
import {createNativeTransport} from '../../../services/agent-bridge/src/opencode-native-transport.mjs';
import {supportedLocaleCodes} from '../../../packages/ui-system/src/locale-registry.mjs';
import {OpenCodeBridgeClient} from '../../../services/agent-bridge/src/opencode-bridge-client.mjs';
import {runProjectExperience} from './project-experience-browser.mjs';
import {runRichMessages} from './rich-messages-browser.mjs';

const image=process.env.NATIVE_CANDIDATE_IMAGE,playwright=process.env.NATIVE_PLAYWRIGHT;
if(!image||!playwright)throw Error('Set local NATIVE_CANDIDATE_IMAGE and NATIVE_PLAYWRIGHT paths');
const {chromium}=await import(pathToFileURL(resolve(playwright)));
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:90000,maxBuffer:2**20}).trim();
docker('image','inspect',image);
const evidence=await mkdtemp(join(tmpdir(),'tab-native-react-'));
const label='com.teamaibox.native-browser-acceptance',run=randomUUID(),resources=[];
let vite,boundary,platform,browser,page;
const checks=[],errors=[];
const platformSockets=new Set();
const requestedPhase=process.env.NATIVE_BROWSER_PHASE??'all';
const phase=requestedPhase==='oauth-revoke'?'oauth':['raw-settings','project-settings','project-settings-recovery','tool-catalog','session-shell','git-changes','message-edit','message-layout','terminal-shell','session-index','session-index-layout','runtime-final','queue-view'].includes(requestedPhase)?'runtime-settings':requestedPhase;
const production=['rich-messages','product-route','oauth','extensions','customization','mcp-settings','context','interactions','lost-receipt','tools','files-revert','providers','appearance','sessions','composer','projects','runtime-settings','transfer','worktrees','channel-isolation'].includes(phase)||(phase==='project-experience'&&process.env.NATIVE_EXPERIENCE_PRODUCTION==='1');
assert.ok(['rich-messages','project-experience','all','terminal-layout','product-route','oauth','extensions','customization','mcp-settings','context','interactions','lost-receipt','tools','files-revert','providers','appearance','sessions','composer','projects','runtime-settings','transfer','worktrees','channel-isolation'].includes(phase));
try{
  const reserve=createTcpServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin=`https://127.0.0.1:${port}`;
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','basicConstraints=critical,CA:FALSE','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',join(evidence,'local.key'),'-out',join(evidence,'local.crt')],{stdio:'ignore'});
  const repository=new MemoryIdentityRepository(),hasher=new PasswordHasher({memory:8192,passes:2,parallelism:2,tagLength:32});
  const authentication=await LocalAuthentication.create({repository,hasher});
  const password=randomBytes(32).toString('base64url');
  const owner=(await authentication.bootstrapOwner({loginName:'synthetic-a',displayName:'Synthetic A',password})).identity;
  const first=await repository.findIdentity(owner.id);
  const second={...first,id:randomUUID(),loginName:'synthetic-b',normalizedLoginName:'synthetic-b',displayName:'Synthetic B'};
  await repository.insertIdentity(second);
  const routes=new Map();
  for(const identity of [owner,second]){
    const name='tab-native-react-'+randomUUID(),credential=randomBytes(48).toString('base64url');
    const resource={name,container:false,volume:false};resources.push(resource);
    docker('volume','create','--label',`${label}=${run}`,name);resource.volume=true;
    docker('run','--rm','--pull=never','--label',`${label}=${run}`,'--user','0:0','--network','none','--mount',`type=volume,source=${name},target=/workspace`,'--entrypoint','sh',image,'-c','mkdir -p /workspace/.teamaibox/config/opencode; chown -R 65532:65532 /workspace');
    if(['customization','providers','rich-messages'].includes(phase))docker('run','--rm','--pull=never','--label',`${label}=${run}`,'--user','65532:65532','--network','none','--read-only','--mount',`type=volume,source=${name},target=/workspace`,'--entrypoint','node',image,'--input-type=module','-e',"import {seedNativeExtensionRuntime} from '/opt/teamaibox/services/agent-bridge/src/native-extension-seed.mjs';await seedNativeExtensionRuntime('/opt/opencode/native-extensions','/workspace/.teamaibox/config/opencode');");
    docker('run','-d','--pull=never','--name',name,'--label',`${label}=${run}`,'--user','65532:65532','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--mount',`type=volume,source=${name},target=/workspace`,
      '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=256m','--tmpfs','/run/opencode-native:rw,nosuid,nodev,exec,size=64m,uid=65532,gid=65532,mode=0700','-p','127.0.0.1::4096',
      ...(phase==='oauth'?['-p','127.0.0.1::4101']:[]),
      ...(phase==='project-experience'?['-p','127.0.0.1::4102','--mount',`type=bind,source=${fileURLToPath(new URL('../../..',import.meta.url))},target=/source,readonly`]:[]),
      '-e','TMPDIR=/run/opencode-native','-e','XDG_CONFIG_HOME=/workspace/.teamaibox/config','-e','OPENCODE_CONFIG=',
      '-e','OPENCODE_PURE=0','-e','OPENCODE_DISABLE_DEFAULT_PLUGINS=0','-e','OPENCODE_DISABLE_PROJECT_CONFIG=0','-e','OPENCODE_DISABLE_EXTERNAL_SKILLS=0','-e','OPENCODE_PERMISSION={"*":"ask"}',
      '-e','OPENCODE_SERVER_PASSWORD='+credential,'--entrypoint','/opt/opencode/opencode',image,'serve','--hostname','0.0.0.0','--port','4096');resource.container=true;
    const native=createNativeTransport({origin:'http://127.0.0.1:'+docker('port',name,'4096/tcp').split(':').at(-1),authorization:async()=>'Basic '+Buffer.from('opencode:'+credential).toString('base64')});
    for(let n=0;n<40;n++){try{const r=await native.request('GET','/global/health',{signal:AbortSignal.timeout(2000)});const ready=r.ok;await r.body?.cancel();if(ready)break;}catch{}if(n===39)throw Error('native readiness');await new Promise(r=>setTimeout(r,250));}
    console.log('Synthetic native instance ready:',resources.length);
    docker('cp',fileURLToPath(new URL('../../../services/agent-bridge/test/fixtures/native-synthetic-services.mjs',import.meta.url)),name+':/workspace/synthetic-services.mjs');
    docker('exec','-d',name,'node','/workspace/synthetic-services.mjs');
    if(phase==='extensions'&&identity.id===owner.id){
      docker('exec',name,'node','-e',"const fs=require('fs');fs.mkdirSync('/workspace/.teamaibox/config/opencode/skills/synthetic-skill',{recursive:true});fs.writeFileSync('/workspace/.teamaibox/config/opencode/skills/synthetic-skill/SKILL.md','---\\nname: synthetic-skill\\ndescription: Synthetic browser skill\\n---\\nTAB_SKILL_ACCEPTED: summarize input.\\n');fs.writeFileSync('/workspace/instructions.md','TAB_INSTRUCTIONS_ACCEPTED: use synthetic data only.\\n');");
      docker('exec',name,'node','-e',"const fs=require('fs');fs.mkdirSync('/workspace/.teamaibox/config/opencode/skills/missing-dependency',{recursive:true});fs.writeFileSync('/workspace/.teamaibox/config/opencode/skills/missing-dependency/SKILL.md','---\\nname: missing-dependency\\ndescription: Requires tab-fixture-missing-tool inside this workspace\\n---\\nTAB_MISSING_DEP: run tab-fixture-missing-tool.\\n');");
    }
    if(['product-route','files-revert','projects','runtime-settings','worktrees'].includes(phase)){
      docker('exec',name,'node','-e',"const fs=require('fs');fs.mkdirSync('/workspace/project',{recursive:true});fs.writeFileSync('/workspace/project/example.txt','Original synthetic file\\n');");
      docker('exec','-w','/workspace/project',name,'git','init','-q');
      docker('exec','-w','/workspace/project',name,'git','add','example.txt');
      docker('exec','-w','/workspace/project',name,'git','-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic fixture');
      if(phase==='worktrees')docker('exec','-w','/workspace/project',name,'git','branch','-M','main');
    }
    if(phase==='projects')docker('exec',name,'node','-e',"const fs=require('fs');fs.mkdirSync('/workspace/blank',{recursive:true});fs.writeFileSync('/workspace/blank/retained.txt','Preserved synthetic content\\n');");
    const config={model:'synthetic/example',small_model:'synthetic/example',provider:{synthetic:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:4100/v1',apiKey:'synthetic-not-a-credential'},models:{example:{name:'Synthetic',limit:{context:32000,output:2000}}}}},mcp:{synthetic:{type:'local',command:['node','/workspace/synthetic-services.mjs','mcp'],enabled:true}}};
    if(requestedPhase==='tool-catalog'&&identity.id===owner.id)config.mcp.synthetic.command.push('resources');
    if(['extensions','customization','mcp-settings','context','lost-receipt','tools','files-revert','providers','sessions','composer','transfer','rich-messages'].includes(phase))config.mcp={};
    if(phase==='providers'&&identity.id===owner.id){
      docker('cp',fileURLToPath(new URL('../../../services/agent-bridge/test/fixtures/native-provider-plugin.mjs',import.meta.url)),name+':/workspace/synthetic-provider-plugin.mjs');
      config.plugin=['file:///workspace/synthetic-provider-plugin.mjs'];
    }
    if(phase==='customization'&&identity.id===owner.id){
      docker('exec',name,'node','-e',`require('fs').writeFileSync('/workspace/synthetic-plugin.mjs',${JSON.stringify("export default async()=>({'experimental.chat.system.transform':async(_input,output)=>output.system.push('TAB_PLUGIN_ACCEPTED')});")})`);
      config.agent={'disabled-fixture':{description:'Synthetic existing Agent',prompt:'Use synthetic data',mode:'primary'}};
    }
    if(phase==='oauth'&&identity.id===owner.id){
      docker('cp',fileURLToPath(new URL('../../../services/agent-bridge/test/fixtures/native-oauth-service.mjs',import.meta.url)),name+':/workspace/oauth-fixture.mjs');
      const authorizationOrigin='http://127.0.0.1:'+docker('port',name,'4101/tcp').split(':').at(-1);
      docker('exec','-d','-e','SYNTHETIC_AUTHORIZATION_ORIGIN='+authorizationOrigin,name,'node','/workspace/oauth-fixture.mjs');
      for(let attempt=0;attempt<20;attempt++){try{if((await fetch(authorizationOrigin+'/evidence',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}if(attempt===19)throw Error('OAuth fixture readiness');await new Promise(r=>setTimeout(r,100));}
      resource.authorizationOrigin=authorizationOrigin;
      config.mcp.syntheticOAuth={type:'remote',url:'http://127.0.0.1:4101/mcp',enabled:true};
    }
    const saved=await native.request('PATCH','/global/config',{body:JSON.stringify(config),signal:AbortSignal.timeout(30000)});assert.equal(saved.status,200);await saved.body.cancel();
    let client;
    if(phase==='project-experience'){
      const bridgeCredential=randomBytes(48).toString('base64url');
      docker('exec','-d','-e','SYNTHETIC_NATIVE_CREDENTIAL='+credential,'-e','SYNTHETIC_BRIDGE_CREDENTIAL='+bridgeCredential,name,'node','/source/apps/web/test/fixtures/assistant-workspace-bridge.mjs');
      const bridgeOrigin='http://127.0.0.1:'+docker('port',name,'4102/tcp').split(':').at(-1);
      client=new OpenCodeBridgeClient({origin:bridgeOrigin,tokenProvider:async()=>bridgeCredential});
      for(let attempt=0;attempt<30;attempt++){try{await client.health();break;}catch{if(attempt===29)throw Error('workspace bridge readiness');await new Promise(r=>setTimeout(r,250));}}
    }
    routes.set(identity.id,{ownerIdentityId:identity.id,native,client});
  }
  const nativeAssistantApi=new NativeAssistantApi({routes:{resolve:async owner=>{assert.ok(routes.has(owner));return routes.get(owner);}}});
  const legacyId=randomUUID(),legacyFile=randomUUID();let legacyMutations=0;
  const legacy={id:legacyId,title:'Synthetic earlier conversation',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{id:randomUUID(),role:'assistant',content:'Preserved synthetic history without replay',toolCalls:[],artifacts:[{referenceId:legacyFile,label:'Retained file',downloadPath:`/api/v1/assistant/artifacts/${legacyFile}/download`}]}],confirmations:[]};
  if(process.env.NATIVE_RESUME_ONLY==='1'){
    const response=await routes.get(owner.id).native.request('POST','/session',{body:JSON.stringify({title:'Existing synthetic native conversation'}),signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);legacy.nativeSession={id:(await response.json()).id,directory:'/workspace'};
  }
  const noLegacyMutation=()=>{legacyMutations++;throw Error('Historical data must remain read-only');};
  const assistantApi=new AssistantHttpApi({service:{listConversations:async id=>id===owner.id?[legacy]:[],getConversation:async(id,key)=>{assert.equal(id,owner.id);assert.equal(key,legacyId);return legacy;},createConversation:noLegacyMutation,submitMessage:noLegacyMutation,cancelRun:noLegacyMutation,decideConfirmation:noLegacyMutation,listEvents:noLegacyMutation,streamEvents:noLegacyMutation,artifactDownload:async()=>({})}});
  const applicationCatalogApi={matches:(method,path)=>method==='GET'&&path==='/api/v1/applications',handle:async()=>({kind:'json',status:200,body:{schemaVersion:1,applications:[{pluginKey:'official.assistant',installedVersion:'synthetic',lifecycleState:'enabled',authorized:true,route:{pathPrefix:'/apps/assistant',integration:'workbench'},dependencies:[],capabilities:[],models:[],health:{state:'healthy',observedAt:new Date().toISOString()},ui:{labelKey:'app.assistant.name',descriptionKey:null,iconKey:'sparkles',categoryKey:'ai-application',order:1,fallbackLabel:'AI Assistant',official:true,localization:null,themes:null},availability:'available',launchable:true,blockers:[]}]}})};
  platform=createPlatformApiServer({authentication,preferences:new IdentityPreferencesService({repository}),publicOrigin:origin,nativeAssistantApi,assistantApi,applicationCatalogApi,logger:{warn(){},error(){},info(){}}});
  platform.on('connection',socket=>{platformSockets.add(socket);socket.once('close',()=>platformSockets.delete(socket));});
  await new Promise(r=>platform.listen(0,'127.0.0.1',r));
  if(production){
    assert.ok(process.env.NATIVE_STATIC_ROOT,'product-route requires the real production build');
    boundary=await createWebBoundary({environment:{WEB_MODE:'release',WEB_HOST:'127.0.0.1',WEB_PORT:String(port),WEB_PUBLIC_ORIGIN:origin,WEB_DEPLOYMENT_SLOT:'edge',WEB_RELEASE_ID:'native-local',WEB_STATIC_ROOT:resolve(process.env.NATIVE_STATIC_ROOT),WEB_TLS_CERT_FILE:join(evidence,'local.crt'),WEB_TLS_KEY_FILE:join(evidence,'local.key'),PLATFORM_API_ORIGIN:`http://127.0.0.1:${platform.address().port}`}});
    await boundary.listen();
  }else{
    vite=await createViteServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port,strictPort:true,https:{key:await readFile(join(evidence,'local.key')),cert:await readFile(join(evidence,'local.crt'))},proxy:{'/api':{target:`http://127.0.0.1:${platform.address().port}`,ws:true,headers:{'x-forwarded-proto':'https'}}}},logLevel:'error'});
    await vite.listen();
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.NATIVE_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const login=async(name)=>{const response=await context.request.post(origin+'/api/auth/sign-in',{headers:{origin},data:{loginName:name,password}});assert.equal(response.status(),200);};
  await login('synthetic-a');
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  const externalRequests=[];
  await context.route(url=>url.hostname!=='127.0.0.1',route=>{externalRequests.push(route.request().url());return route.abort();});
  await page.goto(origin+(production?'/apps/assistant':'/test/fixtures/native-assistant.html'));
  await page.locator(['project-experience','rich-messages'].includes(phase)?'.assistant-project-home':'.assistant-compose-input').waitFor();
  if(requestedPhase==='rich-messages'){
    await runRichMessages({page,context,routes,owner,second,origin,checks,errors,evidence,docker,resources,login,externalRequests});
  }else if(requestedPhase==='project-experience'){
    await runProjectExperience({page,context,routes,owner,second,origin,checks,errors,evidence,docker,resources,login});
  }else if(requestedPhase==='session-index-layout'){
    await page.getByRole('button',{name:'Find conversations',exact:true}).click();const panel=page.locator('.native-session-index');await panel.getByText('No conversations found',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:1000});await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);
    for(const label of await panel.locator(':scope > label').all())assert.equal(await label.evaluate(node=>getComputedStyle(node).display),'flex');
    await page.screenshot({path:join(evidence,'native-session-filters-layout.png')});checks.push('Narrow native session filter labels and checkboxes align on one row with no overflow');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='session-index'){
    const native=routes.get(owner.id).native;
    const create=async(title,directory='/workspace')=>{const response=await native.request('POST',`/session?directory=${encodeURIComponent(directory)}`,{body:JSON.stringify({title})});assert.equal(response.status,200);return response.json();};
    const remote=await create('Across-project synthetic history','/workspace/project');const archived=await create('Archived synthetic history','/workspace/project');
    let response=await native.request('PATCH',`/session/${archived.id}`,{body:JSON.stringify({time:{archived:Date.now()}})});assert.equal(response.status,200);await response.body.cancel();
    const refreshOnly=process.env.NATIVE_INDEX_REFRESH_ONLY==='1';if(!refreshOnly)for(let i=0;i<52;i++)await create('Paged synthetic '+String(i).padStart(2,'0'));
    await page.getByRole('button',{name:'Find conversations',exact:true}).click();const panel=page.locator('.native-session-index');
    if(!refreshOnly){await panel.getByRole('button',{name:'Load more',exact:true}).waitFor();assert.equal(await panel.locator('li').count(),50);
    await panel.getByRole('button',{name:'Load more',exact:true}).click();await panel.getByRole('button',{name:remote.title,exact:true}).waitFor();assert.equal(await panel.locator('li').count(),53);
    const search=async text=>{await panel.getByRole('textbox',{name:'Search titles',exact:true}).fill(text);await panel.getByRole('button',{name:'Find conversations',exact:true}).click();};
    await search('Archived synthetic');await panel.getByText('No conversations found',{exact:true}).waitFor();await panel.getByRole('checkbox',{name:'Include archived',exact:true}).check();await panel.getByRole('button',{name:archived.title,exact:true}).waitFor();
    await panel.getByRole('checkbox',{name:'Current workspace',exact:true}).check();await panel.getByText('No conversations found',{exact:true}).waitFor();await panel.getByRole('checkbox',{name:'Current workspace',exact:true}).uncheck();await panel.getByRole('button',{name:archived.title,exact:true}).waitFor();
    }else{await panel.getByRole('checkbox',{name:'Include archived',exact:true}).check();await panel.getByRole('button',{name:archived.title,exact:true}).waitFor();}
    await page.setViewportSize({width:390,height:1000});await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);await page.screenshot({path:join(evidence,'native-session-index.png')});await panel.getByRole('button',{name:archived.title,exact:true}).click();
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')===id,archived.id);assert.equal(new URL(page.url()).searchParams.get('assistantDirectory'),'/workspace/project');await page.reload();await page.locator('.assistant-compose-input').waitFor();assert.equal(new URL(page.url()).searchParams.get('assistantSession'),archived.id);
    response=await routes.get(second.id).native.request('GET','/experimental/session?archived=true');assert.deepEqual(await response.json(),[]);
    assert.equal((await (await native.request('GET',`/session/${archived.id}`)).json()).time.archived>0,true);
    checks.push(refreshOnly?'Native archived original-session deep link/reload and narrow layout verified after static disconnect fix; prior search/pagination results reused':'Owner-wide native session search, 50-item cursor pagination, directory filter, archived discovery, narrow layout and original-session deep link/reload verified without history replay');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='runtime-final'){
    const native=routes.get(owner.id).native;await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await page.locator('.native-runtime-settings summary').getByText('Engine status',{exact:true}).click();const paths=page.locator('[data-native-status="paths"]');await paths.filter({hasText:'/workspace'}).waitFor();assert.deepEqual(JSON.parse(await paths.innerText()),await (await native.request('GET','/path')).json());await page.keyboard.press('Escape');
    docker('exec',resources[0].name,'node','-e',"require('fs').writeFileSync('/workspace/project/example.txt','Native exported patch\\n')");
    await page.getByRole('textbox',{name:'Working directory',exact:true}).fill('/workspace/project');await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();const git=page.locator('.native-git-changes');await git.locator('summary').getByText('Git changes',{exact:true}).click();
    const expected=await (await native.request('GET','/vcs/diff/raw?directory=/workspace/project')).text();assert.ok(expected.includes('Native exported patch'));
    const pending=page.waitForEvent('download');await git.getByRole('button',{name:'Download patch',exact:true}).click();const download=await pending;assert.equal(download.suggestedFilename(),'workspace.patch');assert.equal(await readFile(await download.path(),'utf8'),expected);
    assert.equal(docker('exec',resources[0].name,'node','-e',"process.stdout.write(require('fs').readFileSync('/workspace/project/example.txt','utf8'))"),'Native exported patch');
    await page.screenshot({path:join(evidence,'native-patch-export.png')});checks.push('Runtime path facts match native source; downloaded raw patch is byte-identical and leaves working files unchanged');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='queue-view'){
    await page.locator('.assistant-compose-input').fill('TAB_HOLD initial synthetic input');await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.assistant-stop'));
    await page.locator('.assistant-compose-input').fill('Follow-up synthetic input');await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('[data-native-pending]').getByText('Queued',{exact:true}).waitFor();const session=new URL(page.url()).searchParams.get('assistantSession');const before=await (await routes.get(owner.id).native.request('GET',`/session/${session}/message`)).json();const queued=before.find(item=>item.info.role==='user'&&item.parts.some(part=>part.text==='Follow-up synthetic input'));assert.ok(queued);assert.equal(await page.locator(`[data-native-pending="${queued.info.id}"]`).count(),1);
    assert.equal(await page.getByRole('button',{name:'Cancel queued input',exact:true}).count(),0);await page.screenshot({path:join(evidence,'native-queued-input.png')});await page.locator('.assistant-stop').click();await page.locator('.assistant-stop').waitFor({state:'detached'});
    await page.reload();await page.locator('.assistant-compose-input').waitFor();const after=await (await routes.get(owner.id).native.request('GET',`/session/${session}/message`)).json();assert.equal(after.filter(item=>item.info.role==='user'&&item.parts.some(part=>part.text==='Follow-up synthetic input')).length,1);assert.equal(after.filter(item=>item.info.id===queued.info.id).length,1);
    checks.push('Follow-up input shows native-history queued hint, Stop interrupts the run rather than pretending to cancel one input, and reload retains the same message without resend');assert.deepEqual(errors,[]);
  }else if(['message-edit','message-layout'].includes(requestedPhase)){
    const native=routes.get(owner.id).native;
    let response=await native.request('POST','/session',{body:'{}'});assert.equal(response.status,200);const session=await response.json();
    response=await native.request('POST',`/session/${session.id}/message`,{body:JSON.stringify({noReply:true,parts:[{type:'text',text:'First synthetic part'},{type:'text',text:'Second synthetic part'}]})});assert.equal(response.status,200);const original=await response.json();
    assert.equal(original.info.role,'user');
    await page.goto(origin+`/apps/assistant?assistantSession=${session.id}`);await page.locator('.assistant-compose-input').waitFor();
    const editor=page.locator(`[data-native-message="${original.info.id}"]`);await editor.getByRole('button',{name:'Edit message',exact:true}).click();
    if(requestedPhase==='message-layout'){
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:1000});const field=editor.getByRole('textbox',{name:'Text',exact:true});await field.scrollIntoViewIfNeeded();
        const rect=await field.boundingBox();assert.ok(rect&&rect.width>100&&rect.x>=0&&rect.x+rect.width<=width+1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.screenshot({path:join(evidence,`native-message-layout-${width}.png`)});
      }
      checks.push('Inline history editor has styled full-width text input, readable actions and no horizontal overflow on desktop and narrow screen');assert.deepEqual(errors,[]);
    }else{
    const textId=original.parts.find(part=>part.type==='text'&&part.text==='First synthetic part').id;
    await editor.getByRole('combobox',{name:'Message part',exact:true}).selectOption(textId);await editor.getByRole('textbox',{name:'Text',exact:true}).fill('Edited synthetic part');
    await editor.getByRole('button',{name:'Save',exact:true}).click();await editor.getByRole('group',{name:'Edit message',exact:true}).waitFor({state:'detached'});
    const endpoint=`/session/${session.id}/message/${original.info.id}`;
    let current=await (await native.request('GET',endpoint)).json();assert.deepEqual(current.parts.map(p=>p.id),original.parts.map(p=>p.id));assert.equal(current.parts.find(p=>p.id===textId).text,'Edited synthetic part');
    assert.deepEqual(current.info,original.info);const other=await routes.get(second.id).native.request('GET',endpoint);assert.equal(other.status,404);await other.body.cancel();
    await editor.getByRole('button',{name:'Edit message',exact:true}).click();await editor.getByRole('combobox',{name:'Message part',exact:true}).selectOption(textId);await editor.getByRole('textbox',{name:'Text',exact:true}).fill('Stale synthetic draft');
    response=await native.request('PATCH',endpoint+`/part/${textId}`,{body:JSON.stringify({...current.parts.find(p=>p.id===textId),text:'Concurrent synthetic edit'})});assert.equal(response.status,200);await response.body.cancel();
    await editor.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('The message changed. Reopen it before saving.',{exact:true}).waitFor();
    assert.equal(await editor.getByRole('textbox',{name:'Text',exact:true}).inputValue(),'Stale synthetic draft');current=await (await native.request('GET',endpoint)).json();assert.equal(current.parts.find(p=>p.id===textId).text,'Concurrent synthetic edit');
    await editor.getByRole('button',{name:'Cancel',exact:true}).click();await editor.getByRole('button',{name:'Edit message',exact:true}).click();await editor.getByRole('combobox',{name:'Message part',exact:true}).selectOption(textId);
    await editor.getByRole('button',{name:'Delete part',exact:true}).click();let confirm=editor.getByRole('group',{name:'Delete part',exact:true});await confirm.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await (await native.request('GET',endpoint)).json()).parts.length,original.parts.length);
    await editor.getByRole('button',{name:'Delete part',exact:true}).click();confirm=editor.getByRole('group',{name:'Delete part',exact:true});await confirm.getByRole('button',{name:'Confirm',exact:true}).click();await editor.getByRole('group',{name:'Edit message',exact:true}).waitFor({state:'detached'});
    current=await (await native.request('GET',endpoint)).json();assert.ok(!current.parts.some(p=>p.id===textId));assert.ok(current.parts.some(p=>p.text==='Second synthetic part'));
    // Native history must reject mutation during active work, not stop it implicitly.
    const held=native.request('POST',`/session/${session.id}/shell`,{body:JSON.stringify({agent:'build',command:'sleep 30'})});
    await page.waitForFunction(()=>document.querySelector('.assistant-stop'));
    assert.equal(await editor.getByRole('button',{name:'Edit message',exact:true}).isDisabled(),true);
    response=await native.request('POST',`/session/${session.id}/abort`,{body:'{}'});assert.equal(response.status,200);await response.body.cancel();await (await held).body.cancel();
    await page.locator('.assistant-stop').waitFor({state:'detached'});await editor.getByRole('button',{name:'Edit message',exact:true}).click();await editor.getByRole('button',{name:'Delete message',exact:true}).click();confirm=editor.getByRole('group',{name:'Delete message',exact:true});await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
    response=await native.request('GET',endpoint);assert.equal(response.status,200);await response.body.cancel();
    await editor.getByRole('button',{name:'Delete message',exact:true}).click();confirm=editor.getByRole('group',{name:'Delete message',exact:true});await page.screenshot({path:join(evidence,'native-message-edit.png')});await confirm.getByRole('button',{name:'Confirm',exact:true}).click();await editor.waitFor({state:'detached'});
    response=await native.request('GET',endpoint);assert.equal(response.status,404);await response.body.cancel();
    assert.ok((await (await native.request('GET',`/session/${session.id}/message`)).json()).length>0);
    checks.push('React native history text edit preserves IDs and metadata; stale write keeps draft; confirmed part/message deletion, cancellation, active-run lock and other-owner denial verified without prompt replay');assert.deepEqual(errors,[]);
    }
  }else if(requestedPhase==='terminal-shell'){
    const native=routes.get(owner.id).native;const shells=await (await native.request('GET','/pty/shells')).json();const chosen=shells.find(item=>item.acceptable);assert.ok(chosen);
    await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();const panel=page.locator('.native-workspace-tools');await panel.getByRole('button',{name:'Terminal',exact:true}).click();await panel.getByRole('combobox',{name:'Shell',exact:true}).selectOption(chosen.path);
    const pending=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/pty'));
    await panel.getByRole('button',{name:'+ Terminal',exact:true}).click();assert.equal((await pending).postDataJSON().command,chosen.path);
    const terminal=page.locator('.native-terminal textarea');await terminal.waitFor();await page.waitForFunction(()=>document.querySelector('.native-terminal-panel button')?.disabled);
    // xterm sends keyboard events, not DOM textarea value changes.
    await terminal.pressSequentially("printf 'SHELL_PICKER_READY\\n'",{delay:1});await terminal.press('Enter');await page.waitForFunction(()=>[...document.querySelectorAll('.xterm-rows > div')].some(row=>row.textContent.trim()==='SHELL_PICKER_READY'));
    const list=await (await native.request('GET','/pty')).json();assert.equal(list.length,1);assert.equal(list[0].command,chosen.path);const other=await routes.get(second.id).native.request('GET',`/pty/${list[0].id}`);assert.equal(other.status,404);await other.body.cancel();
    await page.screenshot({path:join(evidence,'native-terminal-shell.png')});const ended=page.waitForResponse(response=>response.request().method()==='DELETE'&&new URL(response.url()).pathname.endsWith(`/pty/${list[0].id}`));await panel.getByRole('button',{name:'End terminal',exact:true}).click();assert.equal((await ended).status(),200);
    assert.deepEqual(await (await native.request('GET','/pty')).json(),[]);checks.push('React shell picker lists native acceptable shells, passes exact executable to native PTY, receives output and ends only its own terminal');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='oauth-revoke'){
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();const row=page.locator('.native-extensions li').filter({has:page.locator('strong',{hasText:'syntheticOAuth'})});await row.waitFor();
    await row.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('.native-extensions li')].some(item=>item.querySelector('strong')?.textContent==='syntheticOAuth'&&item.textContent.includes('· connected')),{},{timeout:30000});
    const stored=name=>JSON.parse(docker('exec',name,'node','-e',"const fs=require('fs');const p='/workspace/.teamaibox/data/opencode/mcp-auth.json';process.stdout.write(JSON.stringify(fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{}))"));
    assert.ok(stored(resources[0].name).syntheticOAuth);const otherBefore=stored(resources[1].name);await row.getByRole('button',{name:'Disconnect account',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.native-extensions li')].some(item=>item.querySelector('strong')?.textContent==='syntheticOAuth'&&!item.textContent.includes('· connected')&&!item.querySelector('button')?.disabled));
    assert.equal(stored(resources[0].name).syntheticOAuth,undefined);assert.deepEqual(stored(resources[1].name),otherBefore);
    await page.reload();await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await row.waitFor();assert.equal(stored(resources[0].name).syntheticOAuth?.tokens,undefined);
    const state=await (await routes.get(owner.id).native.request('GET','/mcp')).json();assert.notEqual(state.syntheticOAuth.status,'connected');
    checks.push('React MCP Disconnect removes native OAuth credential, disconnects the owner, survives page reload and preserves other owner auth');assert.deepEqual(errors,[]);
  }else if(phase==='channel-isolation'){
    const nativeA=routes.get(owner.id).native;
    const sseOnly=process.env.NATIVE_CHANNEL_SSE_ONLY==='1';
    const sessionResponse=await nativeA.request('POST','/session',{body:JSON.stringify({title:'Owner A private synthetic session'})});assert.equal(sessionResponse.status,200);const sessionA=(await sessionResponse.json()).id;
    docker('exec',resources[0].name,'node','-e',"require('fs').writeFileSync('/workspace/private-owner-a.txt','PRIVATE_SYNTHETIC_A')");
    if(!sseOnly){
    await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();await page.getByRole('button',{name:'Terminal',exact:true}).click();
    const socketPromise=page.waitForEvent('websocket');await page.getByRole('button',{name:'+ Terminal',exact:true}).click();const socket=await socketPromise;
    await page.waitForFunction(()=>document.querySelector('.native-terminal-panel button:disabled'));
    const closed=socket.waitForEvent('close',{timeout:10000});
    const ptysA=await (await context.request.get(origin+'/api/v1/assistant/native/pty')).json();assert.equal(ptysA.length,1);
    const cookies=await context.cookies();assert.equal((await context.request.post(origin+'/api/auth/sign-out',{headers:{origin,'x-csrf-token':cookies.find(cookie=>cookie.name==='__Host-teamaibox-csrf').value}})).status(),200);
    await closed;await login('synthetic-b');await page.goto(origin+'/apps/assistant');await page.locator('.assistant-compose-input').waitFor();
    for(const path of [`/session/${sessionA}`,`/pty/${ptysA[0].id}`])assert.equal((await context.request.get(origin+'/api/v1/assistant/native'+path)).status(),404,path);
    checks.push('production native session/PTY cross-user denial and live PTY closes on logout');
    }else{await login('synthetic-b');await page.goto(origin+'/apps/assistant');await page.locator('.assistant-compose-input').waitFor();}
    // Native raw-file handler currently reports missing files as 500, not 404.
    // Verify actual namespace content rather than accepting any arbitrary error as isolation proof.
    docker('exec',resources[1].name,'node','-e',"require('fs').writeFileSync('/workspace/private-owner-a.txt','VISIBLE_SYNTHETIC_B')");
    const isolatedFile=await context.request.get(origin+'/api/v1/assistant/native/api/fs/read/private-owner-a.txt');assert.equal(isolatedFile.status(),200);assert.equal(await isolatedFile.text(),'VISIBLE_SYNTHETIC_B');
    // Observe B's actual authenticated SSE while both native engines emit new sessions.
    await page.evaluate(()=>{window.__channelEvents=[];window.__channelSource=new EventSource('/api/v1/assistant/native/event?directory=/workspace');window.__channelSource.onmessage=event=>window.__channelEvents.push(event.data);});
    await page.waitForFunction(()=>window.__channelEvents.some(value=>value.includes('server.connected')));
    const markerA='PRIVATE_SYNTHETIC_EVENT_A',markerB='VISIBLE_SYNTHETIC_EVENT_B';
    const a=await nativeA.request('POST','/session',{body:JSON.stringify({title:markerA})});assert.equal(a.status,200);await a.body?.cancel();
    const b=await routes.get(second.id).native.request('POST','/session',{body:JSON.stringify({title:markerB})});assert.equal(b.status,200);await b.body?.cancel();
    await page.waitForFunction(marker=>window.__channelEvents.some(value=>value.includes(marker)),markerB);
    assert.equal(await page.evaluate(marker=>window.__channelEvents.some(value=>value.includes(marker)),markerA),false);
    await page.evaluate(()=>window.__channelSource.close());
    checks.push('production authenticated native raw file and real SSE contain only current owner data');assert.deepEqual(errors,[]);
  }else if(phase==='transfer'){
    let file=process.env.NATIVE_TRANSFER_SOURCE_FILE,data,session;
    if(!file){
    await page.locator('.assistant-compose-input').fill('Synthetic transferable conversation.');
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    session=new URL(page.url()).searchParams.get('assistantSession');
    await page.getByRole('button',{name:'Import / export',exact:true}).click();
    const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download conversation',exact:true}).click();
    const download=await downloadPromise;file=join(evidence,'synthetic-conversation.json');await download.saveAs(file);
    data=JSON.parse(await readFile(file,'utf8'));assert.equal(data.info.id,session);assert.ok(data.messages.some(message=>message.parts.some(part=>part.text==='Synthetic transferable conversation.')));
    docker('cp',file,resources[0].name+':/workspace/conversation.json');
    // Existing-session import must not reassign or overwrite the current owner's history.
    await page.getByRole('textbox',{name:'JSON file in this workspace',exact:true}).fill('conversation.json');
    await page.getByRole('button',{name:'Import conversation',exact:true}).click();await page.getByRole('button',{name:'Import conversation',exact:true}).click();
    await page.locator('.precision-editor').getByText('This conversation already exists in your account. Open it from the conversation list.',{exact:true}).waitFor();
    checks.push('React native-record JSON download and duplicate-ID rejection');
    }else{data=JSON.parse(await readFile(file,'utf8'));session=data.info.id;}
    docker('cp',file,resources[1].name+':/workspace/conversation.json');
    const cookies=await context.cookies();await context.request.post(origin+'/api/auth/sign-out',{headers:{origin,'x-csrf-token':cookies.find(cookie=>cookie.name==='__Host-teamaibox-csrf').value}});await login('synthetic-b');
    await page.goto(origin+'/apps/assistant');await page.locator('.assistant-compose-input').waitFor();
    let prompts=0;page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/prompt_async'))prompts++;});
    await page.getByRole('button',{name:'Import / export',exact:true}).click();
    await page.getByRole('textbox',{name:'JSON file in this workspace',exact:true}).fill('conversation.json');
    await page.getByRole('button',{name:'Import conversation',exact:true}).click();await page.getByRole('button',{name:'Import conversation',exact:true}).click();
    await page.locator('.native-session-transfer output').getByText('OpenCode · ✓',{exact:true}).waitFor({timeout:45000});
    await page.locator('.native-session-transfer').getByRole('button',{name:data.info.title,exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic transferable conversation.',{exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('assistantSession'),session);assert.equal(prompts,0);
    const imported=await (await context.request.get(origin+`/api/v1/assistant/native/session/${session}/message`)).json();assert.deepEqual(imported,data.messages);
    const {data:ptys}=await (await context.request.get(origin+'/api/v1/assistant/native/api/pty')).json();assert.equal(ptys.length,1);assert.equal(ptys[0].status,'exited');assert.equal(ptys[0].exitCode,0);
    checks.push('React native CLI import into other synthetic owner preserves full messages and never replays prompts');assert.deepEqual(errors,[]);
  }else if(phase==='worktrees'){
    const open=async path=>{await page.locator('.native-project input').fill(path);await page.locator('.native-project').getByRole('button',{name:'Open workspace',exact:true}).click();await page.waitForFunction(value=>new URL(location.href).searchParams.get('assistantDirectory')===value,path);};
    await open('/workspace/project');await page.getByRole('button',{name:'Projects',exact:true}).click();
    const panel=page.locator('.native-worktrees');await panel.getByRole('textbox',{name:'Worktree name',exact:true}).fill('synthetic-copy');
    await panel.getByRole('button',{name:'Create worktree',exact:true}).click();
    await panel.getByRole('group',{name:'Create worktree',exact:true}).getByRole('button',{name:'Create worktree',exact:true}).click();
    const row=panel.locator('[data-worktree="synthetic-copy"]');await row.waitFor();
    const directory=await row.locator('code').innerText();assert.ok(directory.startsWith('/workspace/.teamaibox/data/opencode/worktree/'));
    for(let attempt=0;attempt<30;attempt++){
      if(docker('exec',resources[0].name,'node','-e',`process.stdout.write(String(require('fs').existsSync(${JSON.stringify(directory+'/example.txt')})))`)==='true')break;
      assert.ok(attempt<29,'native worktree background checkout completes');await new Promise(resolve=>setTimeout(resolve,250));
    }
    await row.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.waitForFunction(value=>new URL(location.href).searchParams.get('assistantDirectory')===value,directory);await page.reload();await page.locator('.assistant-compose-input').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('assistantDirectory'),directory);
    await open('/workspace/project');await page.getByRole('button',{name:'Projects',exact:true}).click();await row.waitFor();
    docker('exec',resources[0].name,'node','-e',`const fs=require('fs');fs.writeFileSync(${JSON.stringify(directory+'/example.txt')},'Changed synthetic copy');fs.writeFileSync(${JSON.stringify(directory+'/untracked.txt')},'Disposable synthetic file');`);
    await row.getByRole('button',{name:'Reset worktree',exact:true}).click();
    let confirm=panel.getByRole('group',{name:'Reset worktree',exact:true});assert.equal(await confirm.getByRole('button',{name:'Reset worktree',exact:true}).isDisabled(),true);
    await confirm.getByRole('textbox').fill('synthetic-copy');await confirm.getByRole('button',{name:'Reset worktree',exact:true}).click();await confirm.waitFor({state:'detached'});
    assert.equal(docker('exec',resources[0].name,'cat',directory+'/example.txt'),'Original synthetic file');
    assert.equal(docker('exec',resources[0].name,'node','-e',`process.stdout.write(String(require('fs').existsSync(${JSON.stringify(directory+'/untracked.txt')})))`),'false');
    await row.getByRole('button',{name:'Delete worktree',exact:true}).click();confirm=panel.getByRole('group',{name:'Delete worktree',exact:true});
    await confirm.getByRole('button',{name:'Cancel',exact:true}).click();await row.waitFor();
    await row.getByRole('button',{name:'Delete worktree',exact:true}).click();await confirm.getByRole('textbox').fill('synthetic-copy');await confirm.getByRole('button',{name:'Delete worktree',exact:true}).click();await row.waitFor({state:'detached'});
    assert.equal(docker('exec',resources[0].name,'node','-e',`process.stdout.write(String(require('fs').existsSync(${JSON.stringify(directory)})))`),'false');
    assert.equal(docker('exec','-w','/workspace/project',resources[0].name,'git','branch','--list','opencode/synthetic-copy'),'');
    assert.equal(docker('exec',resources[0].name,'cat','/workspace/project/example.txt'),'Original synthetic file');
    assert.equal(docker('exec',resources[1].name,'cat','/workspace/project/example.txt'),'Original synthetic file');
    checks.push('React native worktree create/open/reload, explicit reset with untracked removal, cancel and delete branch; primary and other owner files retained');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='git-changes'){
    await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();let panel=page.locator('.native-git-changes');await panel.locator('summary').getByText('Git changes',{exact:true}).click();
    await panel.getByText('Open a Git project to view changes.',{exact:true}).waitFor();await page.locator('.precision-editor').getByRole('button',{name:'Close',exact:true}).click();
    const name=resources[0].name;
    docker('exec','-w','/workspace/project',name,'git','branch','-M','main');docker('exec','-w','/workspace/project',name,'git','checkout','-qb','synthetic-feature');
    docker('exec',name,'node','-e',"const fs=require('fs');fs.writeFileSync('/workspace/project/example.txt','Committed synthetic feature\\n');");
    docker('exec','-w','/workspace/project',name,'git','add','example.txt');docker('exec','-w','/workspace/project',name,'git','-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic feature');
    docker('exec',name,'node','-e',"const fs=require('fs');fs.appendFileSync('/workspace/project/example.txt','Uncommitted synthetic edit\\n');fs.writeFileSync('/workspace/project/new.txt','New synthetic file\\n');");
    const before=docker('exec','-w','/workspace/project',name,'git','diff','HEAD');
    await page.locator('.native-project input').fill('/workspace/project');await page.locator('.native-project').getByRole('button',{name:'Open workspace',exact:true}).click();await page.waitForFunction(()=>new URL(location.href).searchParams.get('assistantDirectory')==='/workspace/project');
    await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();panel=page.locator('.native-git-changes');await panel.locator('summary').getByText('Git changes',{exact:true}).click();
    let row=panel.locator('[data-native-git-file="example.txt"]');await row.waitFor();await row.locator('summary').click();await row.getByText(/Uncommitted synthetic edit/).waitFor();
    await panel.locator('[data-native-git-file="new.txt"]').waitFor();assert.match(await panel.locator('code').innerText(),/synthetic-feature/);
    const native=routes.get(owner.id).native;let expected=await (await native.request('GET','/vcs/diff?mode=git&directory=/workspace/project')).json();
    assert.equal(await row.locator('pre').innerText(),expected.find(file=>file.file==='example.txt').patch);
    await panel.getByRole('combobox',{name:'Git changes',exact:true}).selectOption('branch');
    await page.waitForFunction(()=>document.querySelector('.native-git-changes code')?.textContent?.includes('→ main'));
    row=panel.locator('[data-native-git-file="example.txt"]');await row.waitFor();if(!await row.evaluate(element=>element.open))await row.locator('summary').click();
    expected=await (await native.request('GET','/vcs/diff?mode=branch&directory=/workspace/project')).json();assert.equal(await row.locator('pre').innerText(),expected.find(file=>file.file==='example.txt').patch);
    await page.screenshot({path:join(evidence,'native-git-changes.png')});
    await panel.getByRole('combobox',{name:'Git changes',exact:true}).selectOption('git');await panel.locator('[data-native-git-file="new.txt"]').waitFor();
    docker('exec',name,'node','-e',"require('fs').appendFileSync('/workspace/project/new.txt','Second synthetic line\\n')");
    await panel.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-native-git-file="new.txt"] summary')?.textContent?.includes('+2'));
    assert.equal(docker('exec','-w','/workspace/project',name,'git','diff','HEAD'),before);assert.equal(docker('exec',resources[1].name,'cat','/workspace/project/example.txt'),'Original synthetic file');
    const other=await (await routes.get(second.id).native.request('GET','/vcs/diff?mode=git&directory=/workspace/project')).json();assert.deepEqual(other,[]);
    checks.push('React native Git branch, uncommitted/branch diff, untracked file and refresh match native results; read-only views preserve tracked bytes and other-owner workspace; non-Git workspace gives prerequisite');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='raw-settings'){
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    const details=page.locator('details').filter({has:page.locator('summary').getByText('Assistant settings · JSON',{exact:true})});
    await details.locator('summary').click();const editor=details.getByRole('textbox',{name:'Assistant settings',exact:true});
    await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Assistant settings"]')?.value?.includes('synthetic'));
    const before=JSON.parse(await editor.inputValue());
    // An invalid draft must remain editable; it must not close the dialog or reach native persistence.
    let writes=0;page.on('request',request=>{if(request.method()==='PATCH'&&new URL(request.url()).pathname.endsWith('/global/config'))writes++;});
    await editor.fill('{');await details.getByRole('button',{name:'Save',exact:true}).click();await page.locator('.precision-editor__feedback[role="status"]').waitFor();
    assert.equal(await editor.inputValue(),'{');assert.equal(writes,0);
    await editor.fill(JSON.stringify({...before,command:{...before.command,'raw-settings-check':{template:'Synthetic command without execution',description:'Synthetic command from native JSON settings'}}}));
    await details.getByRole('button',{name:'Save',exact:true}).click();await page.locator('.precision-editor').waitFor({state:'detached'});
    await page.waitForFunction(()=>[...document.querySelectorAll('option')].some(option=>option.value==='raw-settings-check'));
    const saved=await (await context.request.get(origin+'/api/v1/assistant/native/global/config')).json();assert.equal(saved.command['raw-settings-check'].template,'Synthetic command without execution');assert.equal(saved.model,before.model);assert.deepEqual(saved.provider,before.provider);assert.equal(writes,1);
    const nativeOther=await routes.get(second.id).native.request('GET','/global/config');assert.equal((await nativeOther.json()).command?.['raw-settings-check'],undefined);
    checks.push('React native JSON settings retain invalid draft without write; valid save refreshes selectors, preserves model/provider and stays owner-scoped');
  }else if(requestedPhase==='session-shell'){
    await page.getByRole('button',{name:'New conversation',exact:true}).click();await page.waitForFunction(()=>new URL(location.href).searchParams.get('assistantSession'));
    const session=new URL(page.url()).searchParams.get('assistantSession');let prompts=0,shells=0;
    page.on('request',request=>{if(request.method()!=='POST')return;const path=new URL(request.url()).pathname;if(path.endsWith('/prompt_async')||path.endsWith('/command'))prompts++;if(path.endsWith('/shell'))shells++;});
    await page.getByRole('button',{name:'Shell command',exact:true}).click();let panel=page.locator('.native-session-shell');
    await panel.getByRole('textbox',{name:'Shell command',exact:true}).fill("printf 'SYNTHETIC_SHELL_OUTPUT\\n'; pwd");await panel.getByRole('button',{name:'Run command',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.native-session-shell pre')?.textContent?.includes('SYNTHETIC_SHELL_OUTPUT'));
    assert.match(await panel.locator('pre').innerText(),/\/workspace/);assert.equal(prompts,0);assert.equal(shells,1);
    const native=routes.get(owner.id).native;const messages=await (await native.request('GET',`/session/${session}/message`)).json();
    assert.ok(messages.some(message=>message.parts.some(part=>part.type==='tool'&&part.state?.output?.includes('SYNTHETIC_SHELL_OUTPUT'))));
    const other=await routes.get(second.id).native.request('GET',`/session/${session}`);assert.equal(other.status,404);await other.body.cancel();
    await page.screenshot({path:join(evidence,'native-session-shell.png')});checks.push('React shell command executes once in native session workspace, records actual output in same history and invokes no prompt/model; another owner cannot read it');
    await panel.getByRole('textbox',{name:'Shell command',exact:true}).fill("printf 'SYNTHETIC_SHELL_RUNNING\\n'; sleep 60");await panel.getByRole('button',{name:'Run command',exact:true}).click();
    await page.locator('.assistant-stop').waitFor();await page.locator('.precision-editor').getByRole('button',{name:'Close',exact:true}).click();
    await page.locator('.assistant-stop').click();await page.locator('.assistant-stop').waitFor({state:'detached'});
    const states=await (await native.request('GET','/session/status')).json();assert.ok(!states[session]||states[session].type==='idle');assert.equal(shells,2);assert.equal(prompts,0);
    checks.push('Closing shell dialog does not replay or cancel execution; explicit native Stop interrupts the same shell session');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='tool-catalog'){
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    const panel=page.locator('.native-tool-catalog');await panel.locator('summary').getByText('Tools and resources',{exact:true}).click();
    await panel.locator('[data-native-tool="read"]').waitFor();await panel.getByText('Synthetic catalog note',{exact:true}).waitFor();
    const native=routes.get(owner.id).native;
    const tools=await (await native.request('GET','/experimental/tool?provider=synthetic&model=example')).json();
    assert.deepEqual(await panel.locator('[data-native-tool]').evaluateAll(items=>items.map(item=>item.dataset.nativeTool)),tools.map(item=>item.id));
    const read=tools.find(item=>item.id==='read'),readDetails=panel.locator('[data-native-tool="read"]');await readDetails.locator('summary').getByText('read',{exact:true}).click();await readDetails.getByText(read.description,{exact:true}).waitFor();
    await readDetails.locator('summary').getByText('Parameters',{exact:true}).click();assert.deepEqual(JSON.parse(await readDetails.locator('pre').innerText()),read.parameters);
    const resources=await (await native.request('GET','/experimental/resource')).json();assert.deepEqual(await panel.locator('[data-native-resource]').evaluateAll(items=>items.map(item=>item.dataset.nativeResource)),Object.keys(resources));
    await panel.getByText('synthetic://notes/intro',{exact:true}).waitFor();const other=await (await routes.get(second.id).native.request('GET','/experimental/resource')).json();assert.equal(Object.keys(other).length,0);
    await panel.locator('summary').getByText('Experimental capabilities',{exact:true}).click();const flags=await (await native.request('GET','/experimental/capabilities')).json();assert.deepEqual(JSON.parse(await panel.locator('details').filter({has:page.locator('summary').getByText('Experimental capabilities',{exact:true})}).last().locator('pre').innerText()),flags);
    await page.screenshot({path:join(evidence,'native-tool-catalog.png')});checks.push('React selected-model native tool names/descriptions/schemas, actual MCP resource discovery and native capability flags match engine; other owner has no resource');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='project-settings-recovery'){
    const valid='{"command":{"repair-check":{"template":"Recovered synthetic configuration"}}}\n';docker('exec',resources[0].name,'node','-e',`require('fs').writeFileSync('/workspace/project/opencode.json',${JSON.stringify(valid)})`);
    await page.locator('.native-project input').fill('/workspace/project');await page.locator('.native-project').getByRole('button',{name:'Open workspace',exact:true}).click();await page.waitForFunction(()=>new URL(location.href).searchParams.get('assistantDirectory')==='/workspace/project');
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await page.locator('.native-runtime-settings summary').getByText('Workspace settings',{exact:true}).click();const panel=page.locator('.native-project-settings');
    await panel.getByRole('button',{name:'Edit configuration file',exact:true}).click();const editor=panel.getByRole('textbox',{name:'Configuration file',exact:true});await editor.waitFor();const loaded=await editor.inputValue();
    let writes=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/vcs/apply'))writes++;});
    await editor.fill('{"model":17}\n');await panel.getByRole('button',{name:'Review changes',exact:true}).click();
    await page.locator('.precision-editor__feedback[role="status"]').waitFor();assert.equal(await editor.inputValue(),'{"model":17}\n');assert.equal(await panel.getByRole('button',{name:'Save',exact:true}).isEnabled(),false);assert.equal(writes,0);
    assert.equal(docker('exec',resources[0].name,'cat','/workspace/project/opencode.json'),loaded.trim());
    const stillReady=await routes.get(owner.id).native.request('GET','/config?directory=/workspace/project');assert.equal(stillReady.status,200);await stillReady.body.cancel();
    const corrected=loaded.replace('Recovered synthetic configuration','Corrected synthetic configuration');await editor.fill(corrected);await panel.getByRole('button',{name:'Review changes',exact:true}).click();await panel.getByRole('button',{name:'Save',exact:true}).click();await panel.getByText('File saved. Reload to apply settings.',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'Reload workspace settings',exact:true}).click();await panel.getByText('Workspace settings reloaded.',{exact:true}).waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('option')].some(option=>option.value==='repair-check'));
    assert.equal(await page.locator('.precision-editor__feedback').count(),0);assert.equal(docker('exec',resources[0].name,'cat','/workspace/project/opencode.json'),corrected.trim());assert.equal(writes,1);
    await page.screenshot({path:join(evidence,'project-settings-recovered.png')});checks.push('Pinned native config schema rejects wrong value types before any write; draft is retained, workspace stays usable and corrected configuration saves/reloads without terminal or container reset');assert.deepEqual(errors,[]);
  }else if(requestedPhase==='project-settings'){
    const workspace=async path=>{await page.locator('.native-project input').fill(path);await page.locator('.native-project').getByRole('button',{name:'Open workspace',exact:true}).click();await page.waitForFunction(value=>(new URL(location.href).searchParams.get('assistantDirectory')??'/workspace')===value,path);};
    const settings=async()=>{await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await page.locator('.native-runtime-settings summary').getByText('Workspace settings',{exact:true}).click();return page.locator('.native-project-settings');};
    let brokenWrites=0,disposes=0;page.on('request',request=>{const path=new URL(request.url()).pathname;if(request.method()==='PATCH'&&path.endsWith('/native/config'))brokenWrites++;if(request.method()==='POST'&&path.endsWith('/instance/dispose'))disposes++;});
    await workspace('/workspace');let panel=await settings();await panel.getByRole('button',{name:'Edit configuration file',exact:true}).click();await panel.getByText('Initialize Git in Projects to edit workspace settings.',{exact:true}).waitFor();
    await page.locator('.precision-editor').getByRole('button',{name:'Close',exact:true}).click();
    await workspace('/workspace/project');panel=await settings();await panel.getByRole('button',{name:'Edit configuration file',exact:true}).click();
    const editor=panel.getByRole('textbox',{name:'Configuration file',exact:true});await editor.waitFor();assert.equal(await editor.inputValue(),'{}\n');
    await editor.fill('{');await panel.getByRole('button',{name:'Review changes',exact:true}).click();await page.locator('.precision-editor__feedback[role="status"]').waitFor();assert.equal(await editor.inputValue(),'{');assert.equal(await panel.getByRole('button',{name:'Save',exact:true}).isEnabled(),false);
    const source=JSON.stringify({command:{'project-check':{template:'Synthetic workspace command',description:'Workspace-only'}}},null,2)+'\n';await editor.fill(source);
    await panel.getByRole('button',{name:'Review changes',exact:true}).click();await panel.getByRole('button',{name:'Save',exact:true}).click();await panel.getByText('File saved. Reload to apply settings.',{exact:true}).waitFor();assert.equal(disposes,0);
    assert.equal(docker('exec',resources[0].name,'cat','/workspace/project/opencode.json'),source.trim());
    const native=routes.get(owner.id).native;let response=await native.request('POST','/pty?directory=/workspace/project',{body:JSON.stringify({cwd:'/workspace/project'})});assert.equal(response.status,200);const terminal=await response.json();
    await panel.getByRole('button',{name:'Reload workspace settings',exact:true}).click();await panel.getByText('Finish running sessions and close terminals before reloading.',{exact:true}).waitFor();assert.equal(disposes,0);
    response=await native.request('DELETE',`/pty/${terminal.id}?directory=/workspace/project`);assert.equal(response.status,200);await response.body.cancel();
    await panel.getByRole('button',{name:'Reload workspace settings',exact:true}).click();await panel.getByText('Workspace settings reloaded.',{exact:true}).waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('option')].some(option=>option.value==='project-check'));
    const effective=await (await native.request('GET','/config?directory=/workspace/project')).json();assert.equal(effective.command['project-check'].template,'Synthetic workspace command');assert.equal(effective.model,'synthetic/example');
    const other=await (await routes.get(second.id).native.request('GET','/config?directory=/workspace/project')).json();assert.equal(other.command?.['project-check'],undefined);
    // A changed source line must fail native patching, not overwrite another editor's work.
    const external=source.replace('Workspace-only','Concurrent editor');docker('exec',resources[0].name,'node','-e',`require('fs').writeFileSync('/workspace/project/opencode.json',${JSON.stringify(external)})`);
    await editor.fill(source.replace('Workspace-only','Stale editor'));await panel.getByRole('button',{name:'Review changes',exact:true}).click();
    await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/vcs/apply')&&response.status()>=400),panel.getByRole('button',{name:'Save',exact:true}).click()]);
    assert.equal(await editor.inputValue(),source.replace('Workspace-only','Stale editor'));assert.equal(docker('exec',resources[0].name,'cat','/workspace/project/opencode.json'),external.trim());
    checks.push('React project config creates native opencode.json, rejects invalid JSON and conflicting patch, separates save/reload, blocks reload with active PTY, refreshes command and retains managed model and other owner');
    await page.locator('.precision-editor').getByRole('button',{name:'Close',exact:true}).click();
    const jsonc='// Keep this synthetic comment\n{\n  "command": {"jsonc-check": {"template": "Original JSONC"}},\n}\n';docker('exec',resources[0].name,'node','-e',`const fs=require('fs');fs.writeFileSync('/workspace/project/opencode.jsonc',${JSON.stringify(jsonc)})`);
    panel=await settings();await panel.getByRole('button',{name:'Edit configuration file',exact:true}).click();await panel.getByRole('combobox',{name:'Configuration file',exact:true}).selectOption('opencode.jsonc');
    const jsoncEditor=panel.getByRole('textbox',{name:'Configuration file',exact:true});await page.waitForFunction(()=>document.querySelector('.native-project-settings textarea')?.value?.startsWith('// Keep'));
    await jsoncEditor.fill(jsonc.replace('Original JSONC','Updated JSONC'));await panel.getByRole('button',{name:'Review changes',exact:true}).click();await panel.getByRole('button',{name:'Save',exact:true}).click();await panel.getByText('File saved. Reload to apply settings.',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'Reload workspace settings',exact:true}).click();await panel.getByText('Workspace settings reloaded.',{exact:true}).waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('option')].some(option=>option.value==='jsonc-check'));
    assert.equal(docker('exec',resources[0].name,'cat','/workspace/project/opencode.jsonc'),jsonc.replace('Original JSONC','Updated JSONC').trim());assert.equal(brokenWrites,0);
    await page.screenshot({path:join(evidence,'project-settings.png')});checks.push('React project JSONC retains comments, trailing commas and sibling JSON settings; reload uses native config and never invokes broken PATCH /config');assert.deepEqual(errors,[]);
  }else if(phase==='runtime-settings'){
    await page.locator('.native-project input').fill('/workspace/project');await page.locator('.native-project').getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('assistantDirectory')==='/workspace/project');
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    const settings=page.locator('.native-runtime-settings');await settings.locator('summary').getByText('Engine status',{exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-native-status="runtime"]')?.textContent?.includes('1.19.5'));
    for(const [key,path]of [['runtime','/global/health'],['languageServers','/lsp'],['formatters','/formatter']]){
      const native=await (await context.request.get(origin+'/api/v1/assistant/native'+path+'?directory=/workspace/project')).json();
      assert.deepEqual(JSON.parse(await settings.locator(`[data-native-status="${key}"]`).innerText()),native);
    }
    await settings.locator('summary').getByText('Workspace settings',{exact:true}).click();
    await settings.locator('summary').getByText('Effective settings',{exact:true}).click();
    const effective=await (await context.request.get(origin+'/api/v1/assistant/native/config?directory=/workspace/project')).json();
    assert.deepEqual(JSON.parse(await settings.locator('details details pre').innerText()),effective);
    checks.push('React native runtime/LSP/formatter and read-only effective workspace settings match upstream');assert.deepEqual(errors,[]);
  }else if(phase==='projects'){
    const workspace=async path=>{await page.locator('.native-project input').fill(path);await page.locator('.native-project').getByRole('button',{name:'Open workspace',exact:true}).click();await page.waitForFunction(value=>new URL(location.href).searchParams.get('assistantDirectory')===value,path);};
    await workspace('/workspace/project');
    await page.getByRole('button',{name:'Projects',exact:true}).click();
    let dialog=page.locator('.precision-editor');await dialog.getByRole('textbox',{name:'Project name',exact:true}).fill('Synthetic project');
    await Promise.all([page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname.includes('/native/project/')&&response.status()===200),dialog.getByRole('button',{name:'Save',exact:true}).click()]);
    await dialog.getByRole('button',{name:'Synthetic project',exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await workspace('/workspace/blank');
    await page.getByRole('button',{name:'Projects',exact:true}).click();dialog=page.locator('.precision-editor');
    await dialog.getByRole('button',{name:'Initialize Git',exact:true}).click();
    await dialog.getByText('Initialize a Git repository in this workspace? Existing files are kept.',{exact:true}).waitFor();
    await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/project/git/init')&&response.status()===200),dialog.getByRole('button',{name:'Initialize Git',exact:true}).click()]);
    await dialog.getByRole('button',{name:'Initialize Git',exact:true}).waitFor({state:'detached'});
    assert.equal(docker('exec',resources[0].name,'cat','/workspace/blank/retained.txt'),'Preserved synthetic content');
    assert.equal(docker('exec','-w','/workspace/blank',resources[0].name,'git','rev-parse','--is-inside-work-tree'),'true');
    await dialog.getByRole('button',{name:'Synthetic project',exact:true}).click();
    await dialog.getByRole('button',{name:'/workspace/project',exact:true}).click();
    await dialog.waitFor({state:'detached'});assert.equal(new URL(page.url()).searchParams.get('assistantDirectory'),'/workspace/project');
    await page.reload();await page.locator('.assistant-compose-input').waitFor();
    await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();dialog=page.locator('.precision-editor');
    const search=dialog.locator('.native-file-search');
    await search.getByRole('textbox',{name:'Find files',exact:true}).fill('example');
    await search.getByRole('button',{name:'Search',exact:true}).click();
    await search.getByRole('button',{name:'example.txt',exact:true}).click();
    await dialog.locator('.native-file-layout article pre').getByText('Original synthetic file',{exact:false}).waitFor();
    await search.getByRole('combobox',{name:'Search',exact:true}).selectOption('text');
    await search.getByRole('textbox',{name:'Search file contents',exact:true}).fill('Original synthetic');
    await search.getByRole('button',{name:'Search',exact:true}).click();
    await search.getByRole('button',{name:/example\.txt:1/}).click();
    await page.setViewportSize({width:390,height:1000});await page.screenshot({path:join(evidence,'projects-search-mobile.png')});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const cookies=await context.cookies();const csrf=cookies.find(c=>c.name==='__Host-teamaibox-csrf')?.value;
    await context.request.post(origin+'/api/auth/sign-out',{headers:{origin,'x-csrf-token':csrf}});await login('synthetic-b');
    const other=await (await context.request.get(origin+'/api/v1/assistant/native/project')).json();assert.ok(!other.some(project=>project.name==='Synthetic project'));
    checks.push('production React project rename, native Git init with files retained, directory switching/reload, native file/text search and independent owner metadata');assert.deepEqual(errors,[]);
  }else if(phase==='interactions'){
    const fresh=async()=>{
      const prior=new URL(page.url()).searchParams.get('assistantSession');await page.getByRole('button',{name:'New conversation',exact:true}).click();
      await page.waitForFunction(previous=>{const id=new URL(location.href).searchParams.get('assistantSession');return id&&id!==previous;},prior);
      return new URL(page.url()).searchParams.get('assistantSession');
    };
    const send=async text=>{await page.locator('.assistant-compose-input').fill(text);await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();};
    for(const mode of ['answer','cancel']){
      const session=await fresh();await send('TAB_QUESTION: ask the synthetic question.');
      const form=page.locator('form.assistant-confirmation');await form.waitFor({timeout:30000});
      if(mode==='answer'){
        await form.getByRole('radio',{name:'Alpha First option',exact:true}).focus();await page.keyboard.press('Space');
        await form.getByRole('button',{name:'Send',exact:true}).click();
      }else{
        await page.reload();await form.waitFor();assert.equal(new URL(page.url()).searchParams.get('assistantSession'),session);
        await form.getByRole('button',{name:'Cancel',exact:true}).click();
      }
      await form.waitFor({state:'detached'});
      if(mode==='answer')await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
      else {
        // Native rejection ends this run; it does not promise another model turn.
        await page.locator('.assistant-transcript').getByText('question · error',{exact:true}).waitFor();
        await page.locator('.assistant-stop').waitFor({state:'detached'});
        const history=await (await context.request.get(origin+`/api/v1/assistant/native/session/${session}/message`)).json();
        assert.ok(history.flatMap(message=>message.parts).some(part=>part.tool==='question'&&part.state?.status==='error'));
      }
      assert.equal((await (await context.request.get(origin+'/api/v1/assistant/native/question')).json()).length,0);
    }
    checks.push('native question answered by keyboard; pending question survives same-session reload and cancels');
    for(const reply of ['Reject','Always allow']){
      await fresh();await send('Use the synthetic echo tool.');
      await page.getByRole('button',{name:reply,exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:reply,exact:true}).click();
      if(reply==='Always allow')await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
      else {await page.locator('.assistant-transcript').getByText(/echo · error/).waitFor();await page.locator('.assistant-stop').waitFor({state:'detached'});}
    }
    checks.push('React reject and always-allow controls resolve actual native permission IDs');
    const session=await fresh();await send('TAB_HOLD: hold this synthetic run.');
    await page.locator('.assistant-stop').waitFor();await page.locator('.assistant-stop').click();
    await page.locator('.assistant-stop').waitFor({state:'detached',timeout:15000});
    assert.equal(new URL(page.url()).searchParams.get('assistantSession'),session);
    assert.deepEqual(errors,[]);checks.push('stop aborts actual native running session without replacing it');
  }else if(phase==='composer'){
    if(!process.env.NATIVE_COMPOSER_LAYOUT_ONLY){
    const input=page.locator('.assistant-compose-input'),sent=[];
    page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/prompt_async'))sent.push(request.postDataJSON());});
    await input.fill('Synthetic IME composition');
    await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true});
    assert.equal(await input.inputValue(),'Synthetic IME composition');assert.equal(sent.length,0);
    await input.press('Shift+Enter');assert.ok((await input.inputValue()).includes('\n'));assert.equal(sent.length,0);
    await page.locator('.assistant-compose-row select').nth(0).selectOption('plan');
    await page.locator('.assistant-compose-row select').nth(1).selectOption('synthetic\nexample');
    await page.locator('.assistant-attach input').setInputFiles({name:'synthetic-note.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic attachment content')});
    await page.locator('.assistant-attachment').filter({hasText:'synthetic-note.txt'}).waitFor();
    await input.fill('TAB_HOLD: synthetic first turn');await input.press('Enter');
    await page.locator('.assistant-stop').waitFor();
    const session=new URL(page.url()).searchParams.get('assistantSession');
    await input.fill('Synthetic follow-up while running');await input.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.assistant-message--user').length>=2);
    await page.locator('.assistant-stop').waitFor({state:'detached',timeout:45000});
    assert.equal(sent.length,2);assert.equal(sent[0].agent,'plan');assert.deepEqual(sent[0].model,{providerID:'synthetic',modelID:'example'});
    assert.equal(sent[0].parts.find(part=>part.type==='file').filename,'synthetic-note.txt');
    const history=await (await context.request.get(origin+`/api/v1/assistant/native/session/${session}/message`)).json();
    const users=history.filter(message=>message.info.role==='user');assert.equal(users.length,2);
    assert.ok(users.some(message=>message.parts.some(part=>part.text?.includes('Synthetic attachment content'))));
    assert.ok(users.every(message=>message.info.agent==='plan'&&message.info.model.providerID==='synthetic'));
    assert.ok(history.some(message=>message.info.role==='assistant'&&message.info.parentID===users.at(-1).info.id));
    checks.push('IME does not submit; Shift+Enter newline; actual native text attachment/model/plan and running follow-up retain original session');
    }else{
      await page.getByRole('button',{name:'New conversation',exact:true}).click();
      await page.getByRole('button',{name:'Rename',exact:true}).click();
      await page.getByRole('textbox',{name:'Rename',exact:true}).fill('Synthetic long title to exercise narrow header geometry');
      await page.locator('.precision-editor').getByRole('button',{name:'Save',exact:true}).click();
    }
    await page.setViewportSize({width:390,height:1000});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    const header=await page.locator('.assistant-workspace__header').boundingBox();
    for(const button of await page.locator('.assistant-workspace__header>button').all()){
      const rect=await button.boundingBox();assert.ok(rect&&rect.y>=header.y&&rect.y+rect.height<=header.y+header.height&&rect.x>=0&&rect.x+rect.width<=391);
    }
    await page.screenshot({path:join(evidence,'composer-mobile.png')});
    checks.push('narrow header controls visible');assert.deepEqual(errors,[]);
  }else if(phase==='sessions'){
    await page.locator('.assistant-compose-input').fill('Synthetic session history.');
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    const parent=new URL(page.url()).searchParams.get('assistantSession');
    await page.getByRole('button',{name:'Rename',exact:true}).click();await page.getByRole('textbox',{name:'Rename',exact:true}).fill('Synthetic renamed conversation');
    await page.locator('.precision-editor').getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('heading',{name:'Synthetic renamed conversation',exact:true}).waitFor();
    await page.locator('.native-session-toolbar').getByRole('button',{name:'Branch conversation',exact:true}).click();
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')!==id,parent);
    const child=new URL(page.url()).searchParams.get('assistantSession');
    await page.locator('.assistant-transcript').getByText('Synthetic session history.',{exact:true}).waitFor();
    // Native fork copies history into an independent session, not a task child.
    const fork=await (await context.request.get(origin+`/api/v1/assistant/native/session/${child}`)).json();assert.equal(fork.parentID,undefined);
    await page.locator('.assistant-conversation-list button').filter({hasText:'Synthetic renamed conversation'}).filter({hasNotText:'fork'}).click();
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')===id,parent);
    await page.locator('.assistant-conversation-list button').filter({hasText:fork.title}).click();
    await page.getByRole('button',{name:'Delete conversation',exact:true}).click();await page.locator('.precision-editor').getByRole('button',{name:'Delete conversation',exact:true}).click();
    await page.waitForFunction(()=>!new URL(location.href).searchParams.has('assistantSession'));
    assert.equal((await context.request.get(origin+`/api/v1/assistant/native/session/${child}`)).status(),404);
    assert.equal((await context.request.get(origin+`/api/v1/assistant/native/session/${parent}`)).status(),200);
    await page.locator('.assistant-conversation-list button').filter({hasText:fork.title}).waitFor({state:'detached'});
    await page.locator('.assistant-conversation-list button').filter({hasText:'Synthetic renamed conversation'}).filter({hasNotText:'fork'}).click();
    await page.reload();await page.locator('.assistant-transcript').getByText('Synthetic session history.',{exact:true}).waitFor();
    for(const theme of ['light','dark']){
      await page.setViewportSize({width:1440,height:1000});await page.locator('.appearance-preferences--toolbar select').nth(1).selectOption(theme);
      await page.waitForFunction(value=>document.documentElement.dataset.theme===value,theme);
      await page.setViewportSize({width:390,height:1000});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      const body=await page.locator('.assistant-message__body').first().boundingBox();assert.ok(body&&body.width>250&&body.x>=0&&body.x+body.width<=391);
      const composer=await page.locator('.assistant-compose-input').boundingBox();assert.ok(composer&&composer.y+composer.height<=1000);
      await page.screenshot({path:join(evidence,`conversation-${theme}.png`)});
    }
    checks.push('native rename/independent fork/delete and retained original history; populated messages fit mobile light/dark');assert.deepEqual(errors,[]);
  }else if(phase==='appearance'){
    assert.equal(await page.locator('html').getAttribute('lang'),'en');
    for(const locale of process.env.NATIVE_APPEARANCE_LOCALES?.split(',')??supportedLocaleCodes){
      await page.setViewportSize({width:1440,height:1000});
      const preferences=page.locator('.appearance-preferences--toolbar select');
      await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/preferences/locale'&&response.request().method()==='PATCH'&&response.status()===200),preferences.nth(0).selectOption(locale)]);
      await page.waitForFunction(value=>document.documentElement.lang===value,locale);
      for(const theme of ['light','dark']){
        await page.setViewportSize({width:1440,height:1000});
        await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/preferences/theme'&&response.request().method()==='PATCH'&&response.status()===200),preferences.nth(1).selectOption(theme)]);
        await page.waitForFunction(value=>document.documentElement.dataset.theme===value,theme);
        for(const width of [1440,390]){
          await page.setViewportSize({width,height:1000});
          await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
          const rect=await page.locator('.assistant-compose-input').boundingBox();assert.ok(rect&&rect.y+rect.height<=1000&&rect.x>=0&&rect.x+rect.width<=width+1,`${locale}/${theme}/${width} input visible`);
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${locale}/${theme}/${width} overflow`);
          assert.equal(await page.locator('html').getAttribute('dir'),locale==='ar'?'rtl':'ltr');
          const newButton=await page.locator('.assistant-conversation-pane>.ui-button').first().boundingBox();assert.ok(newButton&&newButton.height<85,`${locale}/${theme}/${width} readable history action`);
        }
        if(locale==='en'||locale==='ar')await page.screenshot({path:join(evidence,`${locale}-${theme}-mobile.png`)});
      }
      await page.reload();await page.locator('.assistant-compose-input').waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'),locale);assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    }
    await page.locator('.assistant-compose-input').fill('private synthetic unsent draft');
    const cookies=await context.cookies();const csrf=cookies.find(c=>c.name==='__Host-teamaibox-csrf')?.value;
    assert.equal((await context.request.post(origin+'/api/auth/sign-out',{headers:{origin,'x-csrf-token':csrf}})).status(),200);
    await login('synthetic-b');await page.goto(origin+'/apps/assistant');await page.locator('.assistant-compose-input').waitFor();
    assert.equal(await page.locator('.assistant-compose-input').inputValue(),'');assert.equal((await page.locator('body').innerText()).includes('private synthetic unsent draft'),false);
    assert.deepEqual(externalRequests,[]);assert.deepEqual(errors,[]);
    checks.push(`${(process.env.NATIVE_APPEARANCE_LOCALES?.split(',')??supportedLocaleCodes).join(',')}: light/dark, RTL, narrow input/scroll geometry and saved appearance after reload; next account has no prior draft; no external assets`);
  }else if(phase==='providers'){
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    const panel=page.locator('.native-providers');await panel.getByLabel('Model provider',{exact:true}).selectOption('synthetic');
    const secret=randomBytes(32).toString('base64url');
    const ownsSecret=(resource,value)=>docker('exec','-e','SYNTHETIC_VALUE='+value,resource.name,'node','-e',"const fs=require('fs'),path=require('path');const p=path.join(process.env.XDG_DATA_HOME||path.join(process.env.HOME,'.local/share'),'opencode/auth.json');console.log(fs.existsSync(p)&&fs.readFileSync(p,'utf8').includes(process.env.SYNTHETIC_VALUE));")==='true';
    if(!process.env.NATIVE_PROVIDER_AUTO_ONLY){
    await panel.getByLabel('API key',{exact:true}).fill(secret);await panel.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.native-providers input[type=password]')?.value==='');
    assert.equal(ownsSecret(resources[0],secret),true);assert.equal(ownsSecret(resources[1],secret),false);
    await panel.getByRole('button',{name:'Disconnect account',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.native-providers button')?.disabled);assert.equal(ownsSecret(resources[0],secret),false);
    await panel.getByLabel('Sign in',{exact:true}).selectOption('0');await panel.getByLabel('Synthetic team',{exact:true}).fill('fixture');
    await panel.getByRole('button',{name:'Sign in',exact:true}).click();
    await panel.getByText('Enter the generated synthetic code.',{exact:true}).waitFor();
    const code=randomBytes(32).toString('base64url');await panel.getByLabel('Authorization code',{exact:true}).fill(code);
    await panel.getByRole('button',{name:'Save',exact:true}).click();await panel.getByLabel('Authorization code',{exact:true}).waitFor({state:'detached'});
    assert.equal(ownsSecret(resources[0],code),true);assert.equal(ownsSecret(resources[1],code),false);
    await panel.getByRole('button',{name:'Disconnect account',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.native-providers button')?.disabled);assert.equal(ownsSecret(resources[0],code),false);
    checks.push('React native Provider API-key save/remove and plugin OAuth code callback persist only in owner auth store');
    }
    await panel.getByLabel('Sign in',{exact:true}).selectOption('1');await panel.getByRole('button',{name:'Sign in',exact:true}).click();
    await panel.getByText('Synthetic automatic callback ready.',{exact:true}).waitFor();assert.equal(await panel.getByLabel('Authorization code',{exact:true}).count(),0);
    const callback=page.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/oauth/callback'));
    await panel.getByRole('button',{name:'Save',exact:true}).click();assert.deepEqual((await callback).postDataJSON(),{method:1});
    await panel.getByText('Synthetic automatic callback ready.',{exact:true}).waitFor({state:'detached'});
    const hasAuth=resource=>docker('exec',resource.name,'node','-e',"const fs=require('fs'),path=require('path');const p=path.join(process.env.XDG_DATA_HOME||path.join(process.env.HOME,'.local/share'),'opencode/auth.json');console.log(fs.existsSync(p)&&Boolean(JSON.parse(fs.readFileSync(p,'utf8')).synthetic));")==='true';
    assert.equal(hasAuth(resources[0]),true);assert.equal(hasAuth(resources[1]),false);
    await panel.getByRole('button',{name:'Disconnect account',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.native-providers button')?.disabled);
    assert.equal(hasAuth(resources[0]),false);checks.push('React native automatic provider callback omits code and retains only owner credential until disconnect');assert.deepEqual(errors,[]);
  }else if(phase==='files-revert'){
    await page.locator('.native-project input').fill('/workspace/project');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.locator('.assistant-compose-input').fill('TAB_EDIT');
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.getByRole('button',{name:'Allow once',exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:'Allow once',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    const read=async()=>await (await context.request.get(origin+'/api/v1/assistant/native/api/fs/read/example.txt?directory=/workspace/project')).text();
    assert.equal(await read(),'Changed by native tool\n');
    await page.getByRole('button',{name:'Changes',exact:true}).click();
    await page.locator('pre.native-detail').filter({hasText:'example.txt'}).waitFor();await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Revert to this message',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('TAB_EDIT',{exact:true}).waitFor({state:'detached'});
    assert.equal(await read(),'Original synthetic file\n');
    await page.getByRole('button',{name:'Undo revert',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('TAB_EDIT',{exact:true}).waitFor();assert.equal(await read(),'Changed by native tool\n');
    checks.push('native tool file diff, revert and undo restore bytes and React respects native history boundary');
    await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await page.getByRole('button',{name:'+ Terminal',exact:true}).click();
    const reconnect=page.getByRole('button',{name:'Reconnect',exact:true});await page.waitForFunction(()=>document.querySelector('.native-terminal-panel button')?.disabled);
    const terminals=await (await context.request.get(origin+'/api/v1/assistant/native/pty?directory=/workspace/project')).json();assert.equal(terminals.length,1);
    await page.locator('.xterm-helper-textarea').pressSequentially("printf 'before-reconnect\\n'\n");
    await page.waitForFunction(()=>[...document.querySelectorAll('.xterm-rows > div')].some(row=>row.textContent.trim()==='before-reconnect'));
    for(const socket of platformSockets)socket.destroy();
    await reconnect.waitFor();await page.waitForFunction(()=>document.querySelector('.native-terminal-panel button')?.disabled===false);await reconnect.click();
    await page.waitForFunction(()=>document.querySelector('.native-terminal-panel button')?.disabled);
    await page.locator('.xterm-helper-textarea').pressSequentially("printf 'after-reconnect\\n'\n");
    await page.waitForFunction(()=>[...document.querySelectorAll('.xterm-rows > div')].some(row=>row.textContent.trim()==='after-reconnect'));
    const after=await (await context.request.get(origin+'/api/v1/assistant/native/pty?directory=/workspace/project')).json();assert.equal(after[0].id,terminals[0].id);
    await page.getByRole('button',{name:'End terminal',exact:true}).click();
    checks.push('cut proxy connections and reconnect the same native PTY with keyboard output');assert.deepEqual(errors,[]);
  }else if(phase==='tools'){
    for(const marker of process.env.NATIVE_TOOLS_CHILD_ONLY==='1'?['TAB_CHILD']:['TAB_TODO','TAB_CHILD']){
      const prior=new URL(page.url()).searchParams.get('assistantSession');
      await page.getByRole('button',{name:'New conversation',exact:true}).click();
      await page.waitForFunction(previous=>{const id=new URL(location.href).searchParams.get('assistantSession');return id&&id!==previous;},prior);
      await page.locator('.assistant-compose-input').fill(marker);
      await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
      await page.getByRole('button',{name:'Allow once',exact:true}).waitFor({timeout:30000});
      await page.getByRole('button',{name:'Allow once',exact:true}).click();
      await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
      const tool=page.locator('details.native-part').filter({has:page.locator('summary',{hasText:marker==='TAB_TODO'?'todowrite · completed':'task · completed'})});
      await tool.locator('summary').click();
      const state=JSON.parse(await tool.locator('pre').textContent());assert.equal(state.status,'completed');assert.ok(state.output);assert.ok(state.input);
      if(marker==='TAB_TODO'){
        await page.locator('details.native-part').filter({has:page.locator('summary',{hasText:'Tasks'})}).locator('summary').click();
        await page.getByText('Synthetic native todo · in_progress · high',{exact:true}).waitFor();
      }else{
        const parent=new URL(page.url()).searchParams.get('assistantSession');
        const children=await (await context.request.get(origin+`/api/v1/assistant/native/session/${parent}/children`)).json();assert.equal(children.length,1);
        await page.locator('details.native-part').filter({has:page.locator('summary',{hasText:'Subsessions'})}).locator('summary').click();
        await page.getByRole('button',{name:children[0].title,exact:true}).last().click();
        await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')===id,children[0].id);
        await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor();
      }
    }
    checks.push(`${process.env.NATIVE_TOOLS_CHILD_ONLY==='1'?'child-session':'todo and child-session'} native tool calls show actual inputs/results; child opens its own history`);assert.deepEqual(errors,[]);
  }else if(phase==='lost-receipt'){
    let sends=0,accepted=false;
    await page.route('**/native/session/*/prompt_async?*',async route=>{
      sends++;const response=await route.fetch();assert.equal(response.status(),204);accepted=true;
      await route.abort('connectionreset');
    });
    await page.locator('.assistant-compose-input').fill('Synthetic lost receipt; do not resend.');
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.getByRole('button',{name:'Restore draft',exact:true}).waitFor();
    const session=new URL(page.url()).searchParams.get('assistantSession');assert.ok(session);assert.equal(accepted,true);
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    await page.getByRole('button',{name:'Restore draft',exact:true}).click();
    assert.equal(await page.locator('.assistant-compose-input').inputValue(),'Synthetic lost receipt; do not resend.');
    await page.reload();await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('assistantSession'),session);assert.equal(sends,1);
    const history=await (await context.request.get(origin+`/api/v1/assistant/native/session/${session}/message`)).json();
    assert.equal(history.filter(message=>message.info.role==='user').length,1);
    checks.push('lost accepted response retains recoverable draft; refresh reconnects same session with one prompt only');assert.deepEqual(errors,[]);
  }else if(phase==='context'){
    const wrongContext=[];page.on('request',request=>{if(new URL(request.url()).pathname.includes('/native/api/session/'))wrongContext.push(request.url());});
    await page.locator('.assistant-compose-input').fill('Explain this synthetic context.');
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    await page.getByRole('button',{name:'Context',exact:true}).click();
    await page.locator('.native-context details').waitFor();
    const tokens=JSON.parse(await page.locator('.native-context pre').textContent());assert.equal(tokens.input,12);assert.equal(tokens.output,6);
    assert.ok((await page.locator('.native-context').innerText()).includes('synthetic / example'));
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'Compact context',exact:true}).click();
    const session=new URL(page.url()).searchParams.get('assistantSession');let compacted=false;
    for(let n=0;n<40;n++){
      const messages=await (await context.request.get(origin+`/api/v1/assistant/native/session/${session}/message`)).json();
      if(messages.some(message=>message.info.summary===true&&message.parts.some(part=>part.type==='text'))){compacted=true;break;}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(compacted,'native compaction summary recorded');await page.getByRole('button',{name:'Context',exact:true}).click();
    await page.locator('.native-context').getByRole('heading',{name:'Compact context',exact:true}).waitFor();
    assert.deepEqual(wrongContext,[]);assert.deepEqual(errors,[]);
    checks.push('actual native v1 usage and compaction summary display without querying unrelated v2 context');
  }else if(phase==='customization'){
    const saved=()=>page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/global/config')&&response.request().method()==='PATCH'&&response.status()===200);
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    const custom=page.locator('.native-customization details').nth(0);
    await custom.locator('summary').click();
    await custom.getByRole('button',{name:'Command',exact:true}).click();
    await custom.locator('input[pattern]').fill('synthetic-command');
    await custom.locator('textarea').fill('TAB_COMMAND_ACCEPTED: $ARGUMENTS');
    let saving=saved();await custom.getByRole('button',{name:'Save',exact:true}).click();await saving;
    await custom.getByRole('button',{name:'Custom agent',exact:true}).click();
    await custom.getByRole('combobox',{name:'Name',exact:true}).selectOption('disabled-fixture');
    await custom.getByRole('checkbox',{name:'Enabled',exact:true}).uncheck();
    saving=saved();await custom.getByRole('button',{name:'Save',exact:true}).click();await saving;
    const plugins=page.locator('.native-customization details').nth(2);
    await plugins.locator('summary').click();await plugins.locator('textarea').fill('file:///workspace/synthetic-plugin.mjs');
    saving=saved();await plugins.getByRole('button',{name:'Save',exact:true}).click();await saving;
    await page.keyboard.press('Escape');
    await page.getByRole('combobox',{name:'Command',exact:true}).selectOption('synthetic-command');
    assert.equal(await page.getByRole('combobox',{name:'Default agent',exact:true}).locator('option[value="disabled-fixture"]').count(),0);
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    let evidenceValue=JSON.parse(docker('exec',resources[0].name,'node','-e',"fetch('http://127.0.0.1:4100/evidence').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"));
    for(const marker of ['TAB_PLUGIN_ACCEPTED','TAB_COMMAND_ACCEPTED'])assert.ok(evidenceValue.lastMarkers.includes(marker),marker);
    checks.push('production React command/plugin settings execute natively; disabled custom Agent leaves selector');
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    await plugins.locator('summary').click();await plugins.locator('textarea').fill('');
    saving=saved();await plugins.getByRole('button',{name:'Save',exact:true}).click();await saving;await page.keyboard.press('Escape');
    const prior=new URL(page.url()).searchParams.get('assistantSession');await page.getByRole('button',{name:'New conversation',exact:true}).click();
    await page.waitForFunction(previous=>new URL(location.href).searchParams.get('assistantSession')!==previous,prior);
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    evidenceValue=JSON.parse(docker('exec',resources[0].name,'node','-e',"fetch('http://127.0.0.1:4100/evidence').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"));
    assert.equal(evidenceValue.lastMarkers.includes('TAB_PLUGIN_ACCEPTED'),false);
    await page.reload();await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await plugins.locator('summary').click();assert.equal(await plugins.locator('textarea').inputValue(),'');
    checks.push('plugin removal persists after reload and stops contributing native instructions');assert.deepEqual(errors,[]);
  }else if(phase==='mcp-settings'){
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    const mcp=page.locator('.native-extensions');
    await mcp.locator('input[pattern]').fill('synthetic');
    await mcp.getByRole('textbox',{name:'Command (JSON)',exact:true}).fill('["node","/workspace/synthetic-services.mjs","mcp"]');
    await mcp.getByRole('button',{name:'Save',exact:true}).click();
    const row=mcp.locator('li').filter({has:page.locator('strong',{hasText:'synthetic'})});
    await page.waitForFunction(()=>document.querySelector('.native-extensions li')?.textContent.includes('· connected'));
    await page.keyboard.press('Escape');await page.locator('.assistant-compose-input').fill('Use the synthetic MCP echo.');
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.getByRole('button',{name:'Allow once',exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:'Allow once',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    assert.equal(docker('exec',resources[0].name,'cat','/workspace/synthetic-mcp-called'),'called');
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await row.getByRole('checkbox',{name:'synthetic',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.native-extensions li')?.textContent.includes('· disabled'));
    await page.reload();await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await row.waitFor();assert.equal(await row.getByRole('checkbox',{name:'synthetic',exact:true}).isChecked(),false);
    checks.push('React-created stdio MCP discovers and executes after native permission; disabling persists on reload');assert.deepEqual(errors,[]);
  }else if(phase==='extensions'){
    if(process.env.NATIVE_SKILL_FAILURE_ONLY!=='1'){
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    const custom=page.locator('.native-customization details').nth(0);
    await custom.locator('summary').click();
    await custom.locator('input[pattern]').fill('synthetic-agent');
    await custom.locator('textarea').fill('TAB_AGENT_ACCEPTED: use synthetic input.');
    const agentSaved=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/global/config')&&response.request().method()==='PATCH'&&response.status()===200);
    await custom.getByRole('button',{name:'Save',exact:true}).click();await agentSaved;
    const instructions=page.locator('.native-customization details').nth(1);
    await instructions.locator('summary').click();
    await instructions.locator('textarea').fill('/workspace/instructions.md');
    const saving=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/global/config')&&response.request().method()==='PATCH'&&response.status()===200);
    await instructions.getByRole('button',{name:'Save',exact:true}).click();await saving;
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Skills',exact:true}).click();
    await page.getByRole('heading',{name:'synthetic-skill',exact:true}).waitFor();
    await page.getByRole('button',{name:'Command /synthetic-skill',exact:true}).click();
    await page.getByRole('combobox',{name:'Default agent',exact:true}).selectOption('synthetic-agent');
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    const result=JSON.parse(docker('exec',resources[0].name,'node','-e',"fetch('http://127.0.0.1:4100/evidence').then(r=>r.json()).then(value=>console.log(JSON.stringify(value)))"));
    for(const marker of ['TAB_SKILL_ACCEPTED','TAB_AGENT_ACCEPTED','TAB_INSTRUCTIONS_ACCEPTED'])assert.ok(result.markers.includes(marker),marker);
    checks.push('production React native Skill selection executes with saved custom Agent and instructions');
    }
    const priorSession=new URL(page.url()).searchParams.get('assistantSession');
    await page.getByRole('button',{name:'New conversation',exact:true}).click();
    await page.waitForFunction(previous=>{const current=new URL(location.href).searchParams.get('assistantSession');return current&&current!==previous;},priorSession);
    await page.getByRole('button',{name:'Skills',exact:true}).click();
    await page.getByText('Requires tab-fixture-missing-tool inside this workspace',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Command /missing-dependency',exact:true}).click();
    await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
    await page.getByRole('button',{name:'Allow once',exact:true}).waitFor({timeout:30000});
    await page.getByRole('button',{name:'Allow once',exact:true}).click();
    await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
    const execution=page.locator('.assistant-transcript details').filter({has:page.locator('summary',{hasText:'bash'})});
    await execution.locator('summary').click();
    assert.match(await execution.innerText(),/not found|No such file/);
    checks.push('Skill dependency description and actual native missing-command output are visible');
    assert.deepEqual(errors,[]);
  }else if(phase==='oauth'){
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    const row=page.locator('.native-extensions li').filter({has:page.locator('strong',{hasText:'syntheticOAuth'})});
    await row.waitFor();
    const popupPromise=context.waitForEvent('page');
    await row.getByRole('button',{name:'Sign in',exact:true}).click();
    const popup=await popupPromise;
    await row.getByText('syntheticOAuth',{exact:true}).waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('.native-extensions li')].some(item=>item.querySelector('strong')?.textContent==='syntheticOAuth'&&item.textContent.includes('· connected')),{},{timeout:30000});
    if(!popup.isClosed())await popup.waitForEvent('close',{timeout:5000});
    assert.equal((await (await fetch(resources[0].authorizationOrigin+'/evidence')).json()).nativePkceExchange,true);
    checks.push('production React OAuth popup returns to same-origin callback and native PKCE completes');
    await page.reload();await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.native-extensions li')].some(item=>item.querySelector('strong')?.textContent==='syntheticOAuth'&&item.textContent.includes('· connected')));
    // Native config reload is asynchronous; assert its final state below, not
    // Playwright's immediate post-click checkbox state.
    await row.getByRole('checkbox',{name:'syntheticOAuth',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.native-extensions li')].some(item=>item.querySelector('strong')?.textContent==='syntheticOAuth'&&item.textContent.includes('· disabled')));
    await page.reload();await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    assert.equal(await row.getByRole('checkbox',{name:'syntheticOAuth',exact:true}).isChecked(),false);
    checks.push('native remote MCP credentials reload and disabled configuration persists');
    const cookies=await context.cookies();const csrf=cookies.find(c=>c.name==='__Host-teamaibox-csrf')?.value;
    assert.equal((await context.request.post(origin+'/api/auth/sign-out',{headers:{origin,'x-csrf-token':csrf}})).status(),200);
    await login('synthetic-b');await page.goto(origin+'/apps/assistant');
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
    await page.locator('.native-extensions').waitFor();
    assert.equal(await row.count(),0);
    const config=await (await context.request.get(origin+'/api/v1/assistant/native/global/config')).json();
    assert.equal(config.mcp?.syntheticOAuth,undefined);
    checks.push('second authenticated user cannot access first user MCP configuration');
    assert.deepEqual(errors,[]);
  }else if(phase==='product-route'){
    if(process.env.NATIVE_SKIP_HISTORY!=='1'){
    await page.getByRole('button',{name:'Earlier conversations',exact:true}).click();
    await page.getByRole('button',{name:legacy.title,exact:true}).click();
    await page.getByText(legacy.messages[0].content,{exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Retained file'}).getAttribute('href'),legacy.messages[0].artifacts[0].downloadPath);
    assert.equal(legacyMutations,0);
    if(process.env.NATIVE_RESUME_ONLY==='1'){
      await page.getByRole('button',{name:'Continue original conversation',exact:true}).click();
      await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')===id,legacy.nativeSession.id);
      const messages=await context.request.get(origin+`/api/v1/assistant/native/session/${legacy.nativeSession.id}/message`);
      assert.deepEqual(await messages.json(),[]);
      checks.push('legacy binding reattaches the same native session with no message replay');
    }else await page.keyboard.press('Escape');
    checks.push('actual App route preserves legacy history and file links without replay');
    }
    if(process.env.NATIVE_RESUME_ONLY!=='1'){
    await page.locator('.native-project input').fill('/workspace/project');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.getByRole('button',{name:'New conversation',exact:true}).click();
    await page.waitForFunction(()=>new URL(location.href).searchParams.has('assistantSession'));
    const before=new URL(page.url());await page.reload();await page.locator('.assistant-compose-input').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('assistantSession'),before.searchParams.get('assistantSession'));
    assert.equal(await page.locator('.native-project input').inputValue(),'/workspace/project');
    await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();
    await page.getByRole('button',{name:'example.txt',exact:true}).click();
    await page.getByRole('button',{name:'Edit file',exact:true}).click();
    await page.getByRole('textbox',{name:'Edit file',exact:true}).fill('Edited synthetic file\n');
    await page.getByRole('button',{name:'Review changes',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('button',{name:'Edit file',exact:true}).waitFor();
    const content=await context.request.get(origin+'/api/v1/assistant/native/api/fs/read/example.txt?directory=/workspace/project');
    assert.equal(await content.text(),'Edited synthetic file\n');
    checks.push('actual App deep link restores native workspace/session and edits file via native git apply');
    }
    assert.equal(legacyMutations,0);assert.deepEqual(errors,[]);
  }else{
  let session;
  if(phase==='all'){
  await page.locator('.assistant-compose-input').fill('Run the synthetic echo tool.');
  await page.locator('.assistant-workspace__composer').getByRole('button',{name:'Send',exact:true}).click();
  await page.getByRole('button',{name:'Allow once',exact:true}).waitFor({timeout:45000});
  await page.getByRole('button',{name:'Allow once',exact:true}).click();
  await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor({timeout:30000});
  checks.push('React send → native permission → real MCP tool → native response');
  session=new URL(page.url()).searchParams.get('assistantSession');assert.ok(session);
  await page.reload();await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('assistantSession'),session);checks.push('same native session survives page refresh without replay');
  }else{
    await page.getByRole('button',{name:'New conversation',exact:true}).click();
    await page.waitForFunction(()=>new URL(location.href).searchParams.has('assistantSession'));
    session=new URL(page.url()).searchParams.get('assistantSession');
  }
  await page.getByRole('button',{name:'Files / Terminal',exact:true}).click();
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.getByRole('button',{name:'+ Terminal',exact:true}).click();
  await page.locator('.xterm-helper-textarea').waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.native-terminal-panel button')].some(button=>button.disabled));
  await page.locator('.xterm-helper-textarea').pressSequentially("printf 'browser-terminal-ok\\n'\n");
  await page.waitForFunction(()=>[...document.querySelectorAll('.xterm-rows > div')].some(row=>row.textContent.trim()==='browser-terminal-ok'));
  assert.equal((await context.request.get(origin+'/api/v1/assistant/native/pty')).status(),200);checks.push('React xterm creates native terminal and accepts keyboard input');
  await page.getByRole('button',{name:'End terminal',exact:true}).click();
  await page.keyboard.press('Escape');
  for(const locale of ['en','zh-CN','ja','ar']){
    await page.getByLabel('Fixture language').selectOption(locale);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      const rect=await page.locator('.assistant-compose-input').boundingBox();assert.ok(rect&&rect.y+rect.height<=1000&&rect.x>=0&&rect.x+rect.width<=width+1,`${locale}/${width} composer visible`);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${locale}/${width} no horizontal overflow`);
    }
  }
  checks.push('English, Chinese, Japanese, Arabic composer/scroll geometry at desktop and mobile sizes');
  await page.getByLabel('Fixture language').selectOption('en');await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:join(evidence,'native-react.png')});
  await page.getByRole('button',{name:'Toggle assistant',exact:true}).click();
  const cookies=await context.cookies();const csrf=cookies.find(c=>c.name==='__Host-teamaibox-csrf')?.value;
  assert.equal((await context.request.post(origin+'/api/auth/sign-out',{headers:{origin,'x-csrf-token':csrf}})).status(),200);
  await login('synthetic-b');
  await page.goto(origin+'/test/fixtures/native-assistant.html');
  assert.deepEqual(await (await context.request.get(origin+'/api/v1/assistant/native/session')).json(),[]);
  assert.equal((await context.request.get(origin+`/api/v1/assistant/native/session/${session}`)).status(),404);
  assert.equal(await page.locator('.assistant-transcript').getByText('Synthetic native execution completed.',{exact:true}).count(),0);checks.push('second authenticated user cannot see first native session or transcript');
  assert.deepEqual(errors,[]);
  }
  console.log(JSON.stringify({checks,evidence}));
}catch(error){
  console.error(error);
  if(page&&!page.isClosed()){
    await writeFile(join(evidence,'failure-layout.json'),JSON.stringify(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].map(node=>({tag:node.tagName,class:node.className,rect:node.getBoundingClientRect().toJSON()})).filter(item=>item.rect.width&&item.rect.height&&(item.rect.right>innerWidth+1||item.rect.left< -1)).slice(0,80)})).catch(()=>null),null,2));
    await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});
    await writeFile(join(evidence,'failure-dom.txt'),await page.locator('body').innerText().catch(()=>''));
  }
  throw error;
}finally{
  await writeFile(join(evidence,'result.json'),JSON.stringify({checks,errors},null,2));
  for(const socket of platformSockets)socket.destroy();platform?.closeAllConnections();platform?.close();
  await boundary?.close();await vite?.close();await browser?.close();
  for(const resource of resources.reverse()){
    if(resource.container){assert.equal(docker('inspect','--format',`{{index .Config.Labels "${label}"}}`,resource.name),run);docker('stop','--time','10',resource.name);docker('rm',resource.name);}
    if(resource.volume){assert.equal(docker('volume','inspect','--format',`{{index .Labels "${label}"}}`,resource.name),run);docker('volume','rm',resource.name);}
  }
  console.log('Synthetic browser evidence:',evidence);
}
