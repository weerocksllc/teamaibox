// Opt-in native engine acceptance using a local image and synthetic services.
// Does not pull images, contact model providers or use appliance credentials.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {createNativeTransport} from '../src/opencode-native-transport.mjs';
import {createOpenCodeAdapter} from '../src/opencode-adapter-registry.mjs';
import {OPEN_CODE_V119_COMPATIBILITY} from '../src/opencode-adapter-v1-19.mjs';
import {nativeInstanceBusy} from '../src/opencode-native-activity.mjs';
const image=process.env.NATIVE_CANDIDATE_IMAGE;
const check=process.env.NATIVE_ACCEPTANCE_CHECK??'all';
assert.ok(['all','mcp','mcp-privacy','box-extension','pty','managed','oauth','contracts','v2','v2-activity','extensions','plugins'].includes(check),'Unknown acceptance check');
if(!image)throw Error('NATIVE_CANDIDATE_IMAGE must name a local image');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:90000,maxBuffer:1024**2}).trim();
docker('image','inspect',image);
const id='tab-native-cap-'+randomUUID(),label='com.teamaibox.native-acceptance';
const password=randomBytes(48).toString('base64url');
const headers={authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),'content-type':'application/json'};
let created=false,volume=false,proxy;
try{
  docker('volume','create','--label',`${label}=${id}`,id);volume=true;
  docker('run','--rm','--pull=never','--label',`${label}=${id}`,'--user','0:0','--network','none','--mount',`type=volume,source=${id},target=/workspace`,'--entrypoint','sh',image,'-c','mkdir -p /workspace/.teamaibox/config/opencode; chown -R 65532:65532 /workspace');
  if(check==='plugins')docker('run','--rm','--pull=never','--label',`${label}=${id}`,'--user','65532:65532','--network','none','--read-only','--mount',`type=volume,source=${id},target=/workspace`,'--entrypoint','node',image,'--input-type=module','-e',"import {seedNativeExtensionRuntime} from '/opt/teamaibox/services/agent-bridge/src/native-extension-seed.mjs'; await seedNativeExtensionRuntime('/opt/opencode/native-extensions','/workspace/.teamaibox/config/opencode');");
  docker('run','-d','--pull=never','--name',id,'--label',`${label}=${id}`,'--user','65532:65532','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--mount',`type=volume,source=${id},target=/workspace`,'--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=256m','--tmpfs','/run/opencode-native:rw,nosuid,nodev,exec,size=64m,uid=65532,gid=65532,mode=0700','--tmpfs','/run/teamaibox:rw,noexec,nosuid,nodev,size=1m,uid=0,gid=0,mode=0755','-e','TMPDIR=/run/opencode-native','-p','127.0.0.1::4096',
    '-e','XDG_CONFIG_HOME=/workspace/.teamaibox/config','-e','OPENCODE_CONFIG=','-e','OPENCODE_PURE=0','-e','OPENCODE_DISABLE_DEFAULT_PLUGINS=0','-e','OPENCODE_DISABLE_PROJECT_CONFIG=0','-e','OPENCODE_DISABLE_EXTERNAL_SKILLS=0',
    '-e','OPENCODE_PERMISSION={"*":"ask"}','-e','OPENCODE_SERVER_PASSWORD='+password,'--entrypoint','/opt/opencode/opencode',image,'serve','--hostname','0.0.0.0','--port','4096');created=true;
  let origin='http://127.0.0.1:'+docker('port',id,'4096/tcp').split(':').at(-1);
  const api=async(path,method='GET',body)=>{
    const response=await fetch(origin+path,{method,headers:{...headers,...(path.endsWith('/connect-token')?{'x-opencode-ticket':'1'}:{})},signal:AbortSignal.timeout(path==='/global/health'?2000:30000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.ok(response.ok,`${method} ${path}: ${response.status} ${response.ok?'':(await response.text()).slice(0,1200)}`);return response.status===204?null:response.json();
  };
  let ready=false;for(let attempt=0;attempt<30;attempt++){try{await api('/global/health');ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
  assert.ok(ready,'native engine readiness');
  const adapter=createOpenCodeAdapter({...OPEN_CODE_V119_COMPATIBILITY,origin,credentialProvider:async()=>({username:'opencode',password})});
  assert.equal((await adapter.health()).version,'1.19.5');
  if(check==='box-extension'){
    const canary=randomBytes(48).toString('base64url');
    docker('cp',fileURLToPath(new URL('../../../examples/assistant/box-status-mcp',import.meta.url)),id+':/workspace/box-status');
    docker('cp',fileURLToPath(new URL('./fixtures/native-synthetic-services.mjs',import.meta.url)),id+':/workspace/synthetic-services.mjs');
    docker('exec',id,'node','-e',`require('fs').writeFileSync('/workspace/box-status-token',${JSON.stringify(canary)},{mode:0o600})`);
    docker('exec','-d','-e','BOX_FIXTURE_TOKEN='+canary,'-e','SYNTHETIC_SECRET_CANARY='+canary,id,'node','/workspace/synthetic-services.mjs');
    await api('/global/config','PATCH',{model:'tab-local-fixture/example',small_model:'tab-local-fixture/example',provider:{'tab-local-fixture':{npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:4100/v1',apiKey:'synthetic-not-a-credential'},models:{example:{name:'Synthetic',limit:{context:32000,output:2000}}}}},
      mcp:{box:{type:'local',command:['node','/workspace/box-status/server.mjs'],enabled:true,environment:{BOX_API_ORIGIN:'http://127.0.0.1:4102',BOX_API_TOKEN_FILE:'/workspace/box-status-token'}}}});
    assert.equal((await api('/mcp')).box.status,'connected');
    for(const mode of ['reject','once','revoked']){
      if(mode==='revoked')docker('exec',id,'node','-e',"fetch('http://127.0.0.1:4102/revoke',{method:'POST'}).then(r=>{if(!r.ok)process.exit(1)})");
      const session=await api('/session','POST',{title:'Synthetic box permission '+mode});
      const prompt=api(`/session/${session.id}/message`,'POST',{model:{providerID:'tab-local-fixture',modelID:'example'},parts:[{type:'text',text:'Read synthetic box status.'}]});
      let failure;const settled=prompt.catch(error=>{failure=error;return null;});let replied=false;
      for(let n=0;n<60;n++){
        const permission=(await api('/permission')).find(row=>row.sessionID===session.id);
        if(permission){await api(`/permission/${permission.id}/reply`,'POST',{reply:mode==='reject'?'reject':'once'});replied=true;break;}
        if(failure)throw failure;await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.ok(replied,'native box tool permission observed');await settled;if(failure)throw failure;
      const history=JSON.stringify(await api(`/session/${session.id}/message`));assert.equal(history.includes(canary),false);
      const evidence=JSON.parse(docker('exec',id,'node','-e',"fetch('http://127.0.0.1:4100/evidence').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"));
      assert.equal(evidence.boxCalls,mode==='reject'?0:mode==='once'?1:2);assert.equal(evidence.sensitiveLeak,false);
      if(mode==='once')assert.ok(history.includes('Synthetic design service'));
      if(mode==='revoked')assert.ok(history.includes('Status is unavailable.'));
    }
    console.log('PASS standard SDK example: native rejection makes no API call; once grant reads filtered status; revoked API access fails without leaking credentials');
  }
  if(check==='plugins'){
    console.log('Native plugin fixture: engine ready, bundled SDK initialized without network');
    docker('cp',fileURLToPath(new URL('./fixtures/native-synthetic-services.mjs',import.meta.url)),id+':/workspace/synthetic-services.mjs');
    docker('exec','-d',id,'node','/workspace/synthetic-services.mjs');
    const plugin="export default async()=>({'experimental.chat.system.transform':async(_input,output)=>{output.system.push('TAB_PLUGIN_ACCEPTED: synthetic plugin instruction.');}});\n";
    docker('exec',id,'node','-e',`require('fs').writeFileSync('/workspace/synthetic-plugin.mjs',${JSON.stringify(plugin)})`);
    await api('/global/config','PATCH',{
      model:'tab-local-fixture/example',small_model:'tab-local-fixture/example',provider:{'tab-local-fixture':{npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:4100/v1',apiKey:'synthetic-not-a-credential'},models:{example:{name:'Synthetic',limit:{context:32000,output:2000}}}}},
      plugin:['file:///workspace/synthetic-plugin.mjs'],
    });
    for(const enabled of [true,false]){
      console.log('Native plugin fixture: enabled='+enabled);
      if(!enabled)await api('/global/config','PATCH',{plugin:[]});
      const session=await api('/session','POST',{title:'Synthetic plugin '+enabled});
      await api(`/session/${session.id}/message`,'POST',{model:{providerID:'tab-local-fixture',modelID:'example'},parts:[{type:'text',text:'Reply to this local acceptance input.'}]});
      const evidence=JSON.parse(docker('exec',id,'node','-e',"fetch('http://127.0.0.1:4100/evidence').then(r=>r.json()).then(value=>console.log(JSON.stringify(value)))"));
      assert.equal(evidence.lastMarkers.includes('TAB_PLUGIN_ACCEPTED'),enabled);
    }
    console.log('PASS native plugin hook is applied then removed through native configuration');
  }
  if(check==='extensions'){
    docker('cp',fileURLToPath(new URL('./fixtures/native-synthetic-services.mjs',import.meta.url)),id+':/workspace/synthetic-services.mjs');
    docker('exec','-d',id,'node','/workspace/synthetic-services.mjs');
    const seed={
      '/workspace/.teamaibox/config/opencode/skills/synthetic-skill/SKILL.md':'---\nname: synthetic-skill\ndescription: Synthetic local acceptance skill\n---\nTAB_SKILL_ACCEPTED: summarize the supplied input.\n',
      '/workspace/synthetic-instructions.md':'TAB_INSTRUCTIONS_ACCEPTED: use only synthetic acceptance data.\n',
    };
    docker('exec',id,'node','-e',`const fs=require('fs'),path=require('path');for(const [file,text] of Object.entries(${JSON.stringify(seed)})){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}`);
    await api('/global/config','PATCH',{
      model:'tab-local-fixture/example',small_model:'tab-local-fixture/example',provider:{'tab-local-fixture':{npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:4100/v1',apiKey:'synthetic-not-a-credential'},models:{example:{name:'Synthetic',limit:{context:32000,output:2000}}}}},
      instructions:['/workspace/synthetic-instructions.md'],
      agent:{'synthetic-agent':{description:'Synthetic local agent',prompt:'TAB_AGENT_ACCEPTED: respond to the synthetic request.',mode:'primary'}},
      command:{'synthetic-command':{template:'TAB_COMMAND_ACCEPTED: $ARGUMENTS',description:'Synthetic command'}},
    });
    assert.ok((await api('/skill')).some(skill=>skill.name==='synthetic-skill'&&skill.content.includes('TAB_SKILL_ACCEPTED')));
    assert.ok((await api('/command')).some(command=>command.name==='synthetic-skill'&&command.source==='skill'));
    assert.ok((await api('/agent')).some(agent=>agent.name==='synthetic-agent'));
    for(const command of ['synthetic-skill','synthetic-command']){
      const session=await api('/session','POST',{title:'Synthetic native extension '+command});
      const result=await api(`/session/${session.id}/command`,'POST',{command,arguments:'Local acceptance',agent:'synthetic-agent',model:'tab-local-fixture/example'});
      assert.ok(result.parts?.some(part=>part.type==='text'&&part.text==='Synthetic native execution completed.'));
    }
    const evidence=JSON.parse(docker('exec',id,'node','-e',"fetch('http://127.0.0.1:4100/evidence').then(r=>r.json()).then(value=>console.log(JSON.stringify(value)))"));
    for(const marker of ['TAB_SKILL_ACCEPTED','TAB_AGENT_ACCEPTED','TAB_INSTRUCTIONS_ACCEPTED','TAB_COMMAND_ACCEPTED'])assert.ok(evidence.markers.includes(marker),marker);
    await api('/global/config','PATCH',{agent:{'synthetic-agent':{disable:true}}});
    assert.equal((await api('/agent')).some(agent=>agent.name==='synthetic-agent'),false);
    console.log('PASS native Skill/command execution, custom Agent and project instructions reach the model; disabled Agent disappears');
  }
  if(check==='oauth'||check==='all'){
    docker('cp',fileURLToPath(new URL('./fixtures/native-oauth-service.mjs',import.meta.url)),id+':/workspace/synthetic-oauth.mjs');
    docker('exec','-d',id,'node','/workspace/synthetic-oauth.mjs');
    docker('exec',id,'node','--input-type=module','-e',"for(let n=0;n<30;n++){try{const r=await fetch('http://127.0.0.1:4101/evidence');if(r.ok)break;}catch{}if(n===29)throw Error('Synthetic OAuth service did not start');await new Promise(r=>setTimeout(r,100));}");
    await api('/global/config','PATCH',{mcp:{syntheticOAuth:{type:'remote',url:'http://127.0.0.1:4101/mcp',oauth:{redirectUri:'https://appliance.test/assistant/oauth/callback'},enabled:true}}});
    const started=await api('/mcp/syntheticOAuth/auth','POST');
    assert.match(started.oauthState,/^[a-f0-9]{64}$/);
    const authorization=new URL(started.authorizationUrl);assert.equal(authorization.searchParams.get('state'),started.oauthState);
    const returned=docker('exec',id,'node','-e',`fetch(${JSON.stringify(authorization.href)},{redirect:'manual'}).then(r=>console.log(r.headers.get('location')))`);
    const callback=new URL(returned);assert.equal(callback.origin,'https://appliance.test');assert.equal(callback.pathname,'/assistant/oauth/callback');assert.equal(callback.searchParams.get('state'),started.oauthState);
    assert.equal((await api('/mcp/syntheticOAuth/auth/callback','POST',{code:callback.searchParams.get('code')})).status,'connected');
    assert.equal(JSON.parse(docker('exec',id,'node','-e',"fetch('http://127.0.0.1:4101/evidence').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))")).nativePkceExchange,true);
    await api('/mcp/syntheticOAuth/auth','DELETE');
    console.log('PASS native remote MCP OAuth discovery, HTTPS product callback URI and native PKCE token exchange');
  }
  if(check==='contracts'){
    const session=await api('/session','POST',{title:'Synthetic versioned session boundary'});
    const response=await fetch(origin+`/api/session/${session.id}/context`,{headers});
    console.log('Native v1 session / v2 context status:',response.status);
    console.log('Native v2 context result:',(await response.text()).slice(0,1000));
    const detail=await fetch(origin+`/api/session/${session.id}`,{headers});
    console.log('Native v2 session metadata:',detail.status,(await detail.text()).slice(0,1200));
    const input=await fetch(origin+`/api/session/${session.id}/prompt`,{method:'POST',headers,body:JSON.stringify({id:'msg_'+randomUUID().replaceAll('-',''),prompt:{text:'Synthetic deferred contract input'},delivery:'queue',resume:false})});
    console.log('Native v2 admission on v1 session:',input.status,(await input.text()).slice(0,1600));
    console.log('Native v1 history after admission:',JSON.stringify(await api(`/session/${session.id}/message`)).slice(0,1600));
  }
  if(check==='v2'||check==='v2-activity'){
    docker('cp',fileURLToPath(new URL('./fixtures/native-synthetic-services.mjs',import.meta.url)),id+':/workspace/synthetic-services.mjs');
    docker('exec','-d',id,'node','/workspace/synthetic-services.mjs');
    // Do not collide with the real models.dev provider named "synthetic": its
    // v2 catalog requires that provider's native integration authentication.
    const providerID='tab-local-fixture';
    await api('/global/config','PATCH',{model:`${providerID}/example`,small_model:`${providerID}/example`,provider:{[providerID]:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:4100/v1',apiKey:'synthetic-not-a-credential'},models:{example:{name:'Synthetic',limit:{context:32000,output:2000}}}}}});
    console.log('v2 model discovery before reopen:',JSON.stringify(await api('/api/model')).slice(0,2000));
    docker('restart','--time','10',id);
    origin='http://127.0.0.1:'+docker('port',id,'4096/tcp').split(':').at(-1);
    docker('exec','-d',id,'node','/workspace/synthetic-services.mjs');
    for(let attempt=0;attempt<30;attempt++){try{await api('/global/health');break;}catch{if(attempt===29)throw Error('Candidate did not restart');await new Promise(r=>setTimeout(r,200));}}
    console.log('v2 model discovery after reopen:',JSON.stringify(await api('/api/model')).slice(0,2000));
    const session=await api('/session','POST',{title:'Synthetic v2 execution boundary'});
    await api(`/api/session/${session.id}/model`,'POST',{model:{providerID,id:'example'}});
    console.log('Admission:',JSON.stringify(await api(`/api/session/${session.id}/prompt`,'POST',{id:'msg_'+randomUUID().replaceAll('-',''),prompt:{text:check==='v2-activity'?'TAB_HOLD: synthetic activity probe':'Synthetic queue input'},delivery:'queue'})));
    if(check==='v2-activity'){
      const activity=createNativeTransport({origin,authorization:async()=>headers.authorization});
      let observed=false;
      for(let n=0;n<30;n++){if(Object.keys((await api('/api/session/active')).data).length){observed=true;break;}await new Promise(r=>setTimeout(r,100));}
      assert.ok(observed,'native v2 running observed');
      assert.equal(await nativeInstanceBusy(activity),true,'native v2 execution prevents idle stop even with idle v1 statuses');
      console.log('PASS actual v2 execution participates in product idle protection');
    }
    for(let attempt=0;attempt<20;attempt++){
      const history=await api(`/api/session/${session.id}/history`);
      if(JSON.stringify(history).includes('Synthetic native execution completed.')){
        console.log('v2 history:',JSON.stringify(history).slice(0,8000));
        console.log('v1 history:',JSON.stringify(await api(`/session/${session.id}/message`)).slice(0,8000));break;
      }
      if(attempt===19)throw Error('v2 native execution did not complete: '+JSON.stringify(history).slice(0,5000));
      await new Promise(r=>setTimeout(r,500));
    }
  }
  if(check==='managed'||check==='all'){
    const managed={model:'managed/example',share:'disabled',enabled_providers:['managed'],provider:{managed:{npm:'@ai-sdk/openai-compatible',models:{example:{name:'Managed model'}},options:{baseURL:'http://127.0.0.1:4100/v1'}}}};
    docker('exec','--user','0:0',id,'node','-e',`const fs=require('fs');fs.mkdirSync('/run/teamaibox/xdg-config/opencode',{recursive:true,mode:0o755});fs.writeFileSync('/run/teamaibox/xdg-config/opencode/opencode.json',${JSON.stringify(JSON.stringify(managed))},{mode:0o444});`);
    await api('/global/config','PATCH',{username:'Synthetic preferences',model:'unapproved/example',command:{retained:{template:'Synthetic native command'}},mcp:{disabledSample:{type:'local',command:['node','nonexistent-disabled-server'],enabled:false}}});
    const effective=await api('/config');
    assert.equal(effective.model,'managed/example');assert.equal(effective.username,'Synthetic preferences');
    assert.equal(effective.command.retained.template,'Synthetic native command');assert.equal(effective.mcp.disabledSample.enabled,false);
    assert.equal((await api('/global/config')).model,'unapproved/example');
    console.log('PASS native managed config precedence with persistent user commands and disabled MCP');
    // Only the fixture-owned managed file is removed before independent cases.
    docker('exec','--user','0:0',id,'node','-e',"require('fs').unlinkSync('/run/teamaibox/xdg-config/opencode/opencode.json')");
  }
  if(check==='mcp'||check==='mcp-privacy'||check==='all'){
  const privacy=check==='mcp-privacy',canary=randomBytes(48).toString('base64url');
  const eventAbort=new AbortController();let eventLeak=false,eventRead;
  if(privacy){
    const events=await fetch(origin+'/event',{headers,signal:eventAbort.signal});assert.ok(events.ok);
    eventRead=(async()=>{let tail='';try{for await(const chunk of events.body){const text=tail+new TextDecoder().decode(chunk);if(text.includes(canary))eventLeak=true;tail=text.slice(-canary.length);}}catch(error){if(!eventAbort.signal.aborted)throw error;}})();
  }
  docker('cp',fileURLToPath(new URL('./fixtures/native-synthetic-services.mjs',import.meta.url)),id+':/workspace/synthetic-services.mjs');
  docker('exec','-d',...(privacy?['-e','SYNTHETIC_SECRET_CANARY='+canary]:[]),id,'node','/workspace/synthetic-services.mjs');
  await api('/global/config','PATCH',{
    model:'synthetic/example',small_model:'synthetic/example',
    provider:{synthetic:{npm:'@ai-sdk/openai-compatible',name:'Synthetic local provider',options:{baseURL:'http://127.0.0.1:4100/v1',apiKey:'synthetic-not-a-credential'},models:{example:{name:'Synthetic',limit:{context:32000,output:2000}}}}},
    mcp:{synthetic:{type:'local',command:['node','/workspace/synthetic-services.mjs','mcp'],enabled:true,...(privacy?{environment:{SYNTHETIC_TOOL_TOKEN:canary}}:{})}},
  });
  assert.equal((await api('/mcp')).synthetic.status,'connected');
  const session=await adapter.createSession({directory:'/workspace',title:'Synthetic native MCP permission'});
  const prompt=adapter.prompt({directory:'/workspace',sessionId:session.id,messageId:'msg_'+randomUUID().replaceAll('-',''),model:{providerId:'synthetic',modelId:'example'},parts:[{type:'text',text:'Use the synthetic echo tool.'}]});
  // Attach a handler immediately; failures are asserted below after polling.
  let promptError;const result=prompt.catch(error=>{promptError=error;return null;});
  let permission,completed=false;
  for(let attempt=0;attempt<60;attempt++){
    const pending=await api('/permission');
    if(!permission){
      const match=pending.find(item=>item.sessionID===session.id);
      if(match){assert.match(match.permission,/synthetic/);permission=match.id;await api(`/permission/${match.id}/reply`,'POST',{reply:'once'});}
    }
    const messages=await api(`/session/${session.id}/message`);
    if(messages.some(message=>message.parts?.some(part=>part.type==='tool'&&part.state?.status==='completed'))){completed=true;break;}
    const error=messages.find(message=>message.info?.error)?.info.error;
    assert.equal(error,undefined,JSON.stringify(error));
    await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(permission,'native permission request observed');assert.ok(completed,'native MCP tool completed');
  assert.ok((await result)?.info?.id);assert.equal(promptError,undefined);
  assert.ok(Array.isArray(await adapter.diff({directory:'/workspace',sessionId:session.id})));
  assert.equal(docker('exec',id,'cat','/workspace/synthetic-mcp-called'),'called');
  if(privacy){
    const evidence=JSON.parse(docker('exec',id,'node','-e',"fetch('http://127.0.0.1:4100/evidence').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"));
    eventAbort.abort();await eventRead;
    assert.equal(evidence.sensitiveLeak,false,'MCP environment credential is not model input');assert.equal(eventLeak,false,'native events do not contain credential');
    assert.equal(JSON.stringify(await api(`/session/${session.id}/message`)).includes(canary),false,'native history does not contain credential');
    assert.equal(docker('logs',id).includes(canary),false,'container console does not contain credential');
    const logs=docker('exec',id,'sh','-c','find /workspace -path "*/opencode/log/*.log" -type f -exec cat {} \\;');
    assert.equal(logs.includes(canary),false,'native log files do not contain credential');
    console.log('PASS synthetic MCP secret absent from model input, event stream, transcript and native logs');
  }
  console.log('PASS native MCP discovery, native once-permission and real synthetic MCP tool call');
  }
  if(check==='pty'||check==='all'){
  const pty=await api('/pty','POST',{command:'sh',cwd:'/workspace',title:'Synthetic terminal'});
  const native=createNativeTransport({origin,authorization:async()=>headers.authorization});
  const tokenResponse=await native.request('POST',`/pty/${pty.id}/connect-token`,{body:'{}'});
  assert.equal(tokenResponse.status,200);const token=await tokenResponse.json();
  proxy=http.createServer();
  proxy.on('upgrade',(request,socket,head)=>void native.upgrade(request.url,request,socket,head).catch(()=>socket.destroy()));
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const url=new URL(`/pty/${pty.id}/connect`,'http://127.0.0.1:'+proxy.address().port);url.protocol='ws:';url.searchParams.set('ticket',token.ticket);
  // Native auth is intentionally kept off browser URLs. Use its short-lived ticket.
  const socket=new WebSocket(url);socket.binaryType='arraybuffer';
  let output='';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.close();reject(Error('Native PTY output timed out'));},15000);
    socket.onopen=()=>socket.send("printf 'synthetic-terminal-ok\\n'\n");
    socket.onerror=()=>{clearTimeout(timer);reject(Error('Native PTY connection failed'));};
    socket.onmessage=event=>{if(typeof event.data==='string')output+=event.data;if(output.includes('synthetic-terminal-ok')){clearTimeout(timer);resolve();}};
  });
  socket.close();await api(`/pty/${pty.id}`,'DELETE');
  console.log('PASS native PTY short-lived ticket, authenticated product transport and output');
  }
}catch(error){
  if(created){
    console.error(docker('logs','--tail','60',id));
    console.error(docker('exec',id,'sh','-c','find /workspace -path "*/opencode/log/*.log" -type f -exec tail -n 30 {} \\;'));
  }
  throw error;
}finally{
  proxy?.close();
  if(created){assert.equal(docker('inspect','--format',`{{index .Config.Labels "${label}"}}`,id),id);docker('stop','--time','10',id);docker('rm',id);}
  if(volume){assert.equal(docker('volume','inspect','--format',`{{index .Labels "${label}"}}`,id),id);docker('volume','rm',id);}
}
