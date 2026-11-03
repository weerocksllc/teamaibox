// Opt-in offline startup of an already-built local image. Only disposable
// tmpfs state is used; no pulls, credentials, user volumes or appliance access.
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const image=process.env.NATIVE_CANDIDATE_IMAGE;
if(!image)throw Error('Set NATIVE_CANDIDATE_IMAGE to an existing local image');
execFileSync('docker',['image','inspect',image],{stdio:'ignore'});
const program=String.raw`
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {seedNativeExtensionRuntime} from '/opt/teamaibox/services/agent-bridge/src/native-extension-seed.mjs';
const root='/workspace/.teamaibox/config/opencode';
await seedNativeExtensionRuntime('/opt/opencode/native-extensions',root);
// A local plugin resolves the SDK from its own package ancestry. The bundle
// does not pretend to install dependencies for arbitrary external directories.
await writeFile(root+'/offline-plugin.mjs',
  'import {tool} from "@opencode-ai/plugin"; export default async()=>({tool:{offline:tool({description:"Offline synthetic tool",args:{},execute:async()=>"ok"})}})');
await writeFile(root+'/opencode.json',JSON.stringify({plugin:['file://'+root+'/offline-plugin.mjs'],command:{offline:{template:'Synthetic offline command'}}}));
const password=randomBytes(48).toString('base64url');
const child=spawn('/opt/opencode/opencode',['serve','--hostname','127.0.0.1','--port','4096'],{
  env:{...process.env,OPENCODE_CONFIG:'',OPENCODE_SERVER_PASSWORD:password},stdio:'ignore',
});
const exited=new Promise(resolve=>child.once('exit',resolve));
const headers={authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')};
const get=async path=>{
  const response=await fetch('http://127.0.0.1:4096'+path,{headers,signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,path);return response.json();
};
try{
  let ready=false;
  for(let attempt=0;attempt<60;attempt++){
    try{assert.equal((await get('/global/health')).version,'1.19.5');ready=true;break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(ready,'offline native startup');
  assert.ok((await get('/command')).some(item=>item.name==='offline'),'native command');
  assert.ok((await get('/experimental/tool/ids')).includes('offline'),'bundled SDK plugin');
  console.log(JSON.stringify({network:'none',version:'1.19.5',bundledSdkPlugin:true,nativeCommand:true}));
}finally{child.kill('SIGTERM');await exited;}
`;
execFileSync('docker',['run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL',
  '--security-opt=no-new-privileges','--label','com.teamaibox.native-offline='+randomUUID(),
  '--tmpfs','/workspace:rw,nosuid,nodev,size=128m,uid=65532,gid=65532',
  '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m',
  '--tmpfs','/run/opencode-native:rw,nosuid,nodev,exec,size=64m,uid=65532,gid=65532',
  '--entrypoint','node',image,'--input-type=module','-e',program],{stdio:'inherit',timeout:90000});
