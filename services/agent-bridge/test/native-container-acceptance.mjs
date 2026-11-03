// Explicit opt-in integration check. Only uniquely labelled synthetic volumes
// and containers are created. No appliance, model, account or existing volume
// is used. Supply two locally built image IDs; this script never pulls images.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';

const oldImage=process.env.NATIVE_PREVIOUS_IMAGE;
const newImage=process.env.NATIVE_CANDIDATE_IMAGE;
if(!oldImage||!newImage)throw Error('Set NATIVE_PREVIOUS_IMAGE and NATIVE_CANDIDATE_IMAGE to local image IDs');
const id='tab-native-'+randomUUID();
const label='com.teamaibox.native-acceptance='+id;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:90000,maxBuffer:4*1024**2}).trim();
for(const image of [oldImage,newImage])docker('image','inspect',image);
const containers=new Set(),volumes=[];
const password=randomBytes(48).toString('base64url');
const headers={authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),'content-type':'application/json'};
const report=[];
async function start(image,volume,suffix){
  const name=id+'-'+suffix;
  docker('run','-d','--pull=never','--name',name,'--label',label,'--user','65532:65532',
    '--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit','256',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=256m','-p','127.0.0.1::4096',
    '--mount',`type=volume,source=${volume},target=/workspace`,
    '-e','XDG_CONFIG_HOME=/workspace/.teamaibox/config',
    '-e','OPENCODE_CONFIG=', '-e','OPENCODE_PERMISSION={"*":"ask"}',
    '-e','OPENCODE_DISABLE_PROJECT_CONFIG=0','-e','OPENCODE_PURE=1',
    '-e','OPENCODE_DISABLE_EXTERNAL_SKILLS=0','-e','OPENCODE_SERVER_USERNAME=opencode',
    '-e','OPENCODE_SERVER_PASSWORD='+password,
    '--entrypoint','/opt/opencode/opencode',image,'serve','--hostname','0.0.0.0','--port','4096');
  containers.add(name);
  const port=docker('port',name,'4096/tcp').split(':').at(-1);
  const origin='http://127.0.0.1:'+port;
  const api=async(path,method='GET',body)=>{
    const response=await fetch(origin+path,{method,headers,signal:AbortSignal.timeout(20000),
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${(await response.text()).slice(0,600)}`);
    return response.status===204?null:response.json();
  };
  let healthy=false;
  for(let attempt=0;attempt<40;attempt++){
    try{await api('/global/health');healthy=true;break;}catch{await new Promise(r=>setTimeout(r,500));}
  }
  if(!healthy)throw Error('Native container did not become ready: '+docker('logs','--tail','20',name));
  return {name,origin,api};
}
function stop(value){docker('stop','--time','10',value.name);docker('rm',value.name);containers.delete(value.name);}
try{
  for(const suffix of ['a','b']){
    const volume=id+'-'+suffix;
    docker('volume','create','--label',label,volume);volumes.push(volume);
    docker('run','--rm','--pull=never','--label',label,'--user','0:0','--network','none',
      '--mount',`type=volume,source=${volume},target=/workspace`,'--entrypoint','sh',oldImage,'-c',
      'mkdir -p /workspace/.teamaibox/config/opencode /workspace/.teamaibox/data /workspace/.teamaibox/cache /workspace/.teamaibox/home; chown -R 65532:65532 /workspace');
  }
  const previous=await start(oldImage,volumes[0],'previous');
  assert.equal((await previous.api('/global/health')).version,'1.18.16');
  const session=await previous.api('/session','POST',{title:'Synthetic upgrade history'});
  await previous.api('/global/config','PATCH',{username:'Synthetic owner A',command:{sample:{template:'Return synthetic example',description:'Synthetic command'}}});
  const skill='---\nname: sample\ndescription: Synthetic test skill\n---\nReturn a synthetic example.\n';
  docker('exec',previous.name,'node','-e',`const fs=require('fs');fs.writeFileSync('/workspace/retained.txt','synthetic retained workspace');fs.mkdirSync('/workspace/.teamaibox/config/opencode/skills/sample',{recursive:true});fs.writeFileSync('/workspace/.teamaibox/config/opencode/skills/sample/SKILL.md',${JSON.stringify(skill)});`);
  stop(previous);
  report.push('1.18.16 synthetic session, native config, Skill and file persisted');
  const a=await start(newImage,volumes[0],'a');
  const b=await start(newImage,volumes[1],'b');
  assert.equal((await a.api('/global/health')).version,'1.19.5');
  assert.equal((await a.api('/session/'+session.id)).title,session.title);
  assert.equal((await a.api('/global/config')).username,'Synthetic owner A');
  assert.equal(docker('exec',a.name,'cat','/workspace/retained.txt'),'synthetic retained workspace');
  assert.ok((await a.api('/skill')).some(skill=>skill.name==='sample'));
  assert.ok(!(await b.api('/session')).some(s=>s.id===session.id));
  assert.notEqual((await b.api('/global/config')).username,'Synthetic owner A');
  assert.equal((await fetch(b.origin+'/session/'+session.id,{headers})).status,404);
  assert.equal((await fetch(a.origin+'/session')).status,401);
  report.push('1.19.5 reopens prior data; second native instance cannot see first user session/config');
  const created=await a.api('/session','POST',{title:'Native replacement check'});
  await a.api('/global/config','PATCH',{command:{retained:{template:'Retained command',description:'Synthetic persistence'}}});
  stop(a);
  const recreated=await start(newImage,volumes[0],'recreated');
  assert.equal((await recreated.api('/session/'+created.id)).title,created.title);
  assert.ok((await recreated.api('/global/config')).command.retained);
  assert.ok((await recreated.api('/skill')).some(skill=>skill.name==='sample'));
  report.push('Replacement container retains both old/new native sessions, user commands, Skills and workspace');
  console.log(JSON.stringify({passed:report},null,2));
}finally{
  for(const name of containers){
    const actual=docker('inspect','--format','{{index .Config.Labels "com.teamaibox.native-acceptance"}}',name);
    assert.equal(actual,id);docker('stop','--time','10',name);docker('rm',name);
  }
  for(const volume of volumes){
    assert.equal(docker('volume','inspect','--format','{{index .Labels "com.teamaibox.native-acceptance"}}',volume),id);
    docker('volume','rm',volume);
  }
}
